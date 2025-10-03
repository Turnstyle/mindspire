import { z } from "zod";
import { jsonResponse } from "../_shared/http.ts";
import { getSupabaseAdminClient } from "../_shared/supabaseClient.ts";
import { logEvent } from "../_shared/logger.ts";
import { getSecret, upsertSecret } from "../_shared/vault.ts";
import { callGeminiJson, refreshAccessToken } from "../_shared/google.ts";

interface CredentialRow {
  id: string;
  user_id: string;
  google_access_token_vault_id: string | null;
  google_refresh_token_vault_id: string | null;
  needs_reauth: boolean;
  last_history_id?: string | null;
}

interface UserRow {
  id: string;
  email: string;
  tz: string;
  partner_user_id: string | null;
}

class GoogleAuthError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
  }
}

const MessagePartSchema: z.ZodType<{
  mimeType?: string;
  filename?: string;
  body?: { data?: string; size?: number };
  parts?: Array<z.infer<typeof MessagePartSchema>>;
}> = z.lazy(() =>
  z.object({
    mimeType: z.string().optional(),
    filename: z.string().optional(),
    body: z.object({
      data: z.string().optional(),
      size: z.number().optional(),
    }).optional(),
    parts: z.array(MessagePartSchema).optional(),
  })
);

const MessageSchema = z.object({
  id: z.string(),
  threadId: z.string(),
  snippet: z.string().optional(),
  payload: z.object({
    mimeType: z.string(),
    body: z.object({
      data: z.string().optional(),
      size: z.number().optional(),
    }).optional(),
    parts: z.array(MessagePartSchema).optional(),
    headers: z.array(z.object({
      name: z.string(),
      value: z.string(),
    })).optional(),
  }),
});

const HistoryResponseSchema = z.object({
  history: z.array(z.object({
    id: z.string(),
    messages: z.array(z.object({
      id: z.string(),
      threadId: z.string(),
    })).optional(),
  })).optional(),
  historyId: z.string().optional(),
});

const GeminiInviteSchema = z.object({
  invite_id: z.string().min(1),
  inviter: z.string().optional(),
  inviter_email: z.string().email().optional(),
  title: z.string().min(1),
  summary: z.string().min(1),
  location: z.string().optional(),
  proposed_times: z.array(z.object({
    start: z.string().min(4),
    end: z.string().optional(),
    timezone: z.string().optional(),
  })).default([]),
  follow_up_actions: z.array(z.string()).default([]),
  confidence: z.number().min(0).max(1).optional(),
});

const BodySchema = z.object({
  userId: z.string().uuid().optional(),
  dryRun: z.boolean().optional(),
});

function extractRecipientEmails(
  headers: Array<{ name: string; value: string }> | undefined,
): Set<string> {
  const recipients = new Set<string>();
  if (!headers) return recipients;

  const targetHeaders = ["to", "cc", "bcc"];
  const emailRegex = /([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})/gi;

  for (const header of headers) {
    if (!targetHeaders.includes(header.name.toLowerCase())) continue;
    const matches = header.value?.match(emailRegex) ?? [];
    for (const match of matches) {
      recipients.add(match.toLowerCase());
    }
  }

  return recipients;
}

export function decodeBase64Url(input: string | undefined): string {
  if (!input) return "";
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(
    normalized.length + (4 - normalized.length % 4) % 4,
    "=",
  );
  try {
    return new TextDecoder("utf-8").decode(
      Uint8Array.from(atob(padded), (c) => c.charCodeAt(0)),
    );
  } catch (_error) {
    return "";
  }
}

export function extractPlainText(
  payload: z.infer<typeof MessageSchema>["payload"],
): string {
  if (payload.body?.data) {
    return decodeBase64Url(payload.body.data);
  }

  if (payload.parts) {
    for (const part of payload.parts) {
      if (part.mimeType === "text/plain" && part.body?.data) {
        const text = decodeBase64Url(part.body.data);
        if (text.trim()) return text;
      }
    }

    return payload.parts
      .map((part) => part.body?.data ? decodeBase64Url(part.body.data) : "")
      .filter(Boolean)
      .join("\n");
  }

  return "";
}

async function gmailFetch(
  accessToken: string,
  url: string,
  init: RequestInit = {},
): Promise<Response> {
  const response = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });

  if (response.status === 401 || response.status === 403) {
    throw new GoogleAuthError("Unauthorized", response.status);
  }

  return response;
}

async function fetchMessage(accessToken: string, messageId: string) {
  const url =
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}?format=full`;
  const response = await gmailFetch(accessToken, url);

  if (!response.ok) {
    throw new Error(`Failed to fetch message ${messageId}: ${response.status}`);
  }

  const json = await response.json();
  return MessageSchema.parse(json);
}

async function fetchHistory(
  accessToken: string,
  startHistoryId?: string | null,
) {
  const params = new URLSearchParams({
    labelId: "INBOX",
    maxResults: "25",
  });

  if (startHistoryId) {
    params.set("startHistoryId", startHistoryId);
  }

  const url =
    `https://gmail.googleapis.com/gmail/v1/users/me/history?${params.toString()}`;
  const response = await gmailFetch(accessToken, url);

  if (response.status === 404) {
    throw new GoogleAuthError("History expired", 404);
  }

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to fetch history: ${response.status} ${text}`);
  }

  const json = await response.json();
  return HistoryResponseSchema.parse(json);
}

export function buildInvitePrompt(
  emailText: string,
  userEmail: string,
): string {
  return `You are an assistant that extracts calendar invitation proposals from Gmail messages for the user ${userEmail}.
Return a compact JSON object with this exact shape:
{
  "invite_id": "short reference id for digest like 1A (stick to alphanumeric)",
  "inviter": "name of the person proposing the event",
  "inviter_email": "email of the inviter if present",
  "title": "short title for the event",
  "summary": "one sentence summary",
  "location": "event location if present",
  "proposed_times": [
    {"start": "ISO8601", "end": "ISO8601 or omitted", "timezone": "IANA timezone if known"}
  ],
  "follow_up_actions": ["list of tasks, optional"],
  "confidence": number between 0 and 1
}

If no event proposal is present, respond with {"invite_id": "", "title": "", "summary": ""}.
Email:
"""
${emailText}
"""`;
}

async function parseInviteWithGemini(
  emailText: string,
  userEmail: string,
) {
  const prompt = buildInvitePrompt(emailText, userEmail);
  return await callGeminiJson(prompt, GeminiInviteSchema);
}

async function updateAccessToken(
  supabase: ReturnType<typeof getSupabaseAdminClient>,
  userId: string,
  refreshToken: string,
): Promise<string> {
  const refreshed = await refreshAccessToken(refreshToken);
  const accessTokenPath = `mindspire/${userId}/google/access`;
  await upsertSecret(supabase, accessTokenPath, refreshed.access_token);
  await logEvent(supabase, "info", "poll_gmail:token_refreshed", {
    userId,
    scopes: refreshed.scope,
  });
  return refreshed.access_token;
}

async function ensureAccessToken(
  supabase: ReturnType<typeof getSupabaseAdminClient>,
  userId: string,
  refreshToken: string,
  currentAccessToken: string | null,
): Promise<string> {
  if (currentAccessToken) return currentAccessToken;
  return await updateAccessToken(supabase, userId, refreshToken);
}

async function flagReauth(
  supabase: ReturnType<typeof getSupabaseAdminClient>,
  credentialId: string,
  reason: string,
) {
  const { error } = await supabase
    .from("user_credentials")
    .update({ needs_reauth: true })
    .eq("id", credentialId);

  if (error) {
    await logEvent(supabase, "error", "poll_gmail:flag_reauth_failed", {
      credentialId,
      reason,
      error: error.message,
    });
  } else {
    await logEvent(supabase, "warn", "poll_gmail:flagged_reauth", {
      credentialId,
      reason,
    });
  }
}

async function processUser(
  supabase: ReturnType<typeof getSupabaseAdminClient>,
  user: UserRow,
  credential: CredentialRow,
  dryRun: boolean,
  userMap: Map<string, UserRow>,
) {
  const accessTokenPath = `mindspire/${user.id}/google/access`;
  const refreshTokenPath = `mindspire/${user.id}/google/refresh`;

  const refreshToken = await getSecret(supabase, refreshTokenPath);
  if (!refreshToken) {
    await logEvent(supabase, "error", "poll_gmail:missing_refresh_token", {
      userId: user.id,
    });
    await flagReauth(supabase, credential.id, "Refresh token missing");
    return;
  }

  let accessToken = await getSecret(supabase, accessTokenPath);
  accessToken = await ensureAccessToken(
    supabase,
    user.id,
    refreshToken,
    accessToken,
  );

  let historyResponse: z.infer<typeof HistoryResponseSchema> | null = null;
  let requiresCursorReset = false;

  try {
    historyResponse = await fetchHistory(
      accessToken,
      credential.last_history_id,
    );
  } catch (error) {
    if (error instanceof GoogleAuthError && error.status === 401) {
      accessToken = await updateAccessToken(supabase, user.id, refreshToken);
      historyResponse = await fetchHistory(
        accessToken,
        credential.last_history_id,
      );
    } else if (error instanceof GoogleAuthError && error.status === 404) {
      requiresCursorReset = true;
    } else {
      throw error;
    }
  }

  if (requiresCursorReset) {
    const profileResponse = await gmailFetch(
      accessToken,
      "https://gmail.googleapis.com/gmail/v1/users/me/profile",
    );

    if (!profileResponse.ok) {
      const text = await profileResponse.text();
      throw new Error(
        `Failed to fetch profile for cursor reset: ${profileResponse.status} ${text}`,
      );
    }

    const profileJson = await profileResponse.json();
    const newHistoryId = profileJson?.historyId;

    await supabase
      .from("user_credentials")
      .update({ last_history_id: newHistoryId ?? null })
      .eq("id", credential.id);

    await logEvent(supabase, "warn", "poll_gmail:history_reset", {
      userId: user.id,
      historyId: newHistoryId,
    });

    return;
  }

  if (!historyResponse) return;

  const historyItems = historyResponse.history ?? [];
  const messageMap = new Map<string, { id: string; threadId: string }>();

  for (const history of historyItems) {
    if (!history.messages) continue;
    for (const message of history.messages) {
      messageMap.set(message.id, {
        id: message.id,
        threadId: message.threadId,
      });
    }
  }

  if (messageMap.size === 0) {
    if (
      historyResponse.historyId &&
      historyResponse.historyId !== credential.last_history_id
    ) {
      await supabase
        .from("user_credentials")
        .update({ last_history_id: historyResponse.historyId })
        .eq("id", credential.id);
    }
    return;
  }

  const partner = user.partner_user_id
    ? userMap.get(user.partner_user_id) ?? null
    : null;

  for (const { id: messageId, threadId } of messageMap.values()) {
    try {
      const message = await fetchMessage(accessToken, messageId);
      let emailText = extractPlainText(message.payload);
      if (!emailText.trim()) {
        emailText = message.snippet ?? "";
      }

      if (!emailText.trim()) {
        continue;
      }

      const invite = await parseInviteWithGemini(emailText, user.email);
      if (!invite.invite_id || !invite.title || !invite.summary) {
        continue;
      }

      const subject = message.payload.headers?.find((header) =>
        header.name.toLowerCase() === "subject"
      )?.value ?? invite.title;

      const recipients = extractRecipientEmails(message.payload.headers);
      const sharedUserIds = new Set<string>();
      if (partner && recipients.has(partner.email.toLowerCase())) {
        sharedUserIds.add(partner.id);
      }
      // The owner is implicit via user_id; ensure we never persist duplicates.
      sharedUserIds.delete(user.id);

      if (dryRun) {
        await logEvent(supabase, "info", "poll_gmail:dry_run_invite", {
          userId: user.id,
          messageId,
          invite,
        });
        continue;
      }

      const { data: existingInvite, error: existingError } = await supabase
        .from("invite")
        .select("id")
        .eq("gmail_message_id", messageId)
        .maybeSingle();

      if (existingError) {
        throw new Error(
          `Failed to check existing invite: ${existingError.message}`,
        );
      }

      if (existingInvite) {
        await logEvent(supabase, "debug", "poll_gmail:invite_exists", {
          inviteId: existingInvite.id,
          messageId,
        });
        continue;
      }

      const { data: relatedInvite, error: relatedError } = await supabase
        .from("invite")
        .select("id, user_id, shared_user_ids")
        .eq("gmail_thread_id", threadId)
        .limit(1)
        .maybeSingle();

      if (relatedError) {
        throw new Error(
          `Failed to look up related invite: ${relatedError.message}`,
        );
      }

      if (relatedInvite) {
        const mergedShared = new Set(relatedInvite.shared_user_ids ?? []);
        if (relatedInvite.user_id !== user.id) {
          mergedShared.add(user.id);
        }
        for (const sharedId of sharedUserIds) {
          mergedShared.add(sharedId);
        }

        if (mergedShared.size !==
          (relatedInvite.shared_user_ids?.length ?? 0)
        ) {
          const { error: updateError } = await supabase
            .from("invite")
            .update({ shared_user_ids: Array.from(mergedShared) })
            .eq("id", relatedInvite.id);

          if (updateError) {
            throw new Error(
              `Failed to update shared invite: ${updateError.message}`,
            );
          }

          await logEvent(supabase, "info", "poll_gmail:invite_shared_updated", {
            inviteId: relatedInvite.id,
            messageId,
            addedUserId: user.id,
          });
        }

        continue;
      }

      const { error: insertError } = await supabase
        .from("invite")
        .insert({
          user_id: user.id,
          gmail_thread_id: threadId,
          gmail_message_id: messageId,
          source_subject: subject,
          parsed: invite,
          shared_user_ids: Array.from(sharedUserIds),
          status: "pending",
        });

      if (insertError) {
        throw new Error(`Failed to insert invite: ${insertError.message}`);
      }

      await logEvent(supabase, "info", "poll_gmail:invite_created", {
        userId: user.id,
        messageId,
        inviteId: invite.invite_id,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await logEvent(supabase, "error", "poll_gmail:message_failure", {
        userId: user.id,
        messageId,
        error: message,
      });
    }
  }

  if (
    historyResponse.historyId &&
    historyResponse.historyId !== credential.last_history_id
  ) {
    const { error: cursorUpdateError } = await supabase
      .from("user_credentials")
      .update({ last_history_id: historyResponse.historyId })
      .eq("id", credential.id);

    if (cursorUpdateError) {
      await logEvent(supabase, "error", "poll_gmail:cursor_update_failed", {
        userId: user.id,
        historyId: historyResponse.historyId,
        error: cursorUpdateError.message,
      });
    }
  }
}

export async function pollGmailHandler(req: Request): Promise<Response> {
  const supabase = getSupabaseAdminClient();

  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, { status: 405 });
  }

  let body: z.infer<typeof BodySchema> = {};
  try {
    const json = await req.json();
    body = BodySchema.parse(json);
  } catch (_error) {
    body = {};
  }

  await logEvent(supabase, "info", "poll_gmail:start", body);

  const { data: credentials, error: credentialsError } = await supabase
    .from("user_credentials")
    .select(
      "id, user_id, google_access_token_vault_id, google_refresh_token_vault_id, needs_reauth, last_history_id",
    )
    .eq("needs_reauth", false)
    .order("user_id");

  if (credentialsError) {
    await logEvent(supabase, "error", "poll_gmail:credentials_load_failed", {
      error: credentialsError.message,
    });
    return jsonResponse({ error: "Failed to load credentials" }, {
      status: 500,
    });
  }

  const filteredCredentials = body.userId
    ? (credentials ?? []).filter((c) => c.user_id === body.userId)
    : credentials ?? [];

  if (filteredCredentials.length === 0) {
    return jsonResponse({ message: "No eligible users" });
  }

  const userIds = filteredCredentials.map((credential) => credential.user_id);
  const { data: users, error: usersError } = await supabase
    .from("app_user")
    .select("id, email, tz, partner_user_id")
    .in("id", userIds);

  if (usersError) {
    await logEvent(supabase, "error", "poll_gmail:users_load_failed", {
      error: usersError.message,
    });
    return jsonResponse({ error: "Failed to load users" }, { status: 500 });
  }

  const userMap = new Map(
    (users ?? []).map((user) => [user.id, user] as [string, UserRow]),
  );

  const missingPartnerIds = new Set<string>();
  for (const user of userMap.values()) {
    if (user.partner_user_id && !userMap.has(user.partner_user_id)) {
      missingPartnerIds.add(user.partner_user_id);
    }
  }

  if (missingPartnerIds.size > 0) {
    const { data: partners } = await supabase
      .from("app_user")
      .select("id, email, tz, partner_user_id")
      .in("id", Array.from(missingPartnerIds));

    for (const partner of partners ?? []) {
      userMap.set(partner.id, partner as UserRow);
    }
  }

  for (const credential of filteredCredentials) {
    const user = userMap.get(credential.user_id);
    if (!user) {
      await logEvent(supabase, "warn", "poll_gmail:user_missing", {
        userId: credential.user_id,
      });
      continue;
    }

    try {
      await processUser(
        supabase,
        user,
        credential as CredentialRow,
        !!body.dryRun,
        userMap,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await logEvent(supabase, "error", "poll_gmail:user_failure", {
        userId: user.id,
        error: message,
      });
    }
  }

  return jsonResponse({
    message: "Poll complete",
    usersProcessed: filteredCredentials.length,
  });
}

if (import.meta.main) {
  Deno.serve(pollGmailHandler);
}
