import { z } from "zod";
import { jsonResponse } from "../_shared/http.ts";
import { getSupabaseAdminClient } from "../_shared/supabaseClient.ts";
import { logEvent, Logger } from "../_shared/logger.ts";
import {
  getTokenPair,
  storeTokenPair,
} from "../_shared/tokenStore.ts";
import { callGeminiJson, refreshAccessToken } from "../_shared/google.ts";
import { getOptionalEnv, getRequiredEnv } from "../_shared/env.ts";
import { extractPlainText, extractHtml } from "../_shared/gmail.ts";

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

interface MessageReference {
  id: string;
  threadId: string;
  labelIds?: string[] | null;
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
  labelIds: z.array(z.string()).optional(),
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

const MessageListSchema = z.object({
  messages: z.array(z.object({
    id: z.string(),
    threadId: z.string(),
    labelIds: z.array(z.string()).optional(),
  })).optional(),
  nextPageToken: z.string().optional(),
  resultSizeEstimate: z.number().optional(),
});

const ThreadSchema = z.object({
  id: z.string(),
  historyId: z.string().optional(),
  messages: z.array(MessageSchema).optional(),
  snippet: z.string().optional(),
});

const HistoryMessageSchema = z.object({
  id: z.string(),
  threadId: z.string(),
  labelIds: z.array(z.string()).optional(),
});

const HistoryResponseSchema = z.object({
  history: z.array(z.object({
    id: z.string(),
    messages: z.array(z.object({
      id: z.string(),
      threadId: z.string(),
    })).optional(),
    messagesAdded: z.array(z.object({
      message: HistoryMessageSchema,
    })).optional(),
  })).optional(),
  historyId: z.string().optional(),
  nextPageToken: z.string().optional(),
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
  backfillDays: z.number().min(0).max(30).optional(),
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

function getHeaderValue(
  headers: Array<{ name: string; value: string }> | undefined,
  target: string,
): string {
  if (!headers) return "";
  const lowerTarget = target.toLowerCase();
  const match = headers.find((header) => header.name.toLowerCase() === lowerTarget);
  return match?.value ?? "";
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

async function fetchThread(accessToken: string, threadId: string) {
  const url =
    `https://gmail.googleapis.com/gmail/v1/users/me/threads/${threadId}?format=full`;
  const response = await gmailFetch(accessToken, url);

  if (!response.ok) {
    throw new Error(`Failed to fetch thread ${threadId}: ${response.status}`);
  }

  const json = await response.json();
  return ThreadSchema.parse(json);
}

async function fetchHistory(
  accessToken: string,
  startHistoryId?: string | null,
  pageToken?: string,
) {
  const params = new URLSearchParams({
    maxResults: "100",
  });

  if (startHistoryId) {
    params.set("startHistoryId", startHistoryId);
  }

  if (pageToken) {
    params.set("pageToken", pageToken);
  }

  params.set("historyTypes", "messageAdded");

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

function shouldFlagReauth(error: unknown): boolean {
  if (error instanceof GoogleAuthError) {
    return error.status === 400 || error.status === 401;
  }

  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return message.includes("invalid_grant") || message.includes("invalid_client") || message.includes("status 400") || message.includes("status 401");
}

async function sendReauthNotification(
  supabase: ReturnType<typeof getSupabaseAdminClient>,
  userId: string | null,
  userEmail: string | null,
  reason: string,
) {
  if (!userId) return;

  const webhook = getOptionalEnv("REAUTH_WEBHOOK_URL") ??
    getOptionalEnv("DIGEST_WEBHOOK_URL");
  if (!webhook) return;

  const message = userEmail
    ? `:warning: Mindspire needs Google reauth for ${userEmail} (${userId}). Reason: ${reason}`
    : `:warning: Mindspire needs Google reauth for user ${userId}. Reason: ${reason}`;

  const payload = webhook.includes("hooks.slack.com")
    ? { text: message }
    : { message, userId, email: userEmail, reason };

  try {
    const response = await fetch(webhook, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const text = await response.text();
      await logEvent(supabase, "error", "poll_gmail:reauth_notification_failed", {
        userId,
        email: userEmail,
        reason,
        status: response.status,
        body: text,
      });
    } else {
      await logEvent(supabase, "info", "poll_gmail:reauth_notification_sent", {
        userId,
        email: userEmail,
      });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await logEvent(supabase, "error", "poll_gmail:reauth_notification_error", {
      userId,
      email: userEmail,
      reason,
      error: message,
    });
  }
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

interface DigestReplyParams {
  supabase: ReturnType<typeof getSupabaseAdminClient>;
  userId: string;
  emailText: string;
  emailHtml: string;
  gmailMessageId: string;
  gmailThreadId: string;
  dryRun: boolean;
}

async function forwardDigestReply({
  supabase,
  userId,
  emailText,
  emailHtml,
  gmailMessageId,
  gmailThreadId,
  dryRun,
}: DigestReplyParams) {
  const supabaseUrl = getRequiredEnv("SUPABASE_URL");
  const serviceRoleKey = getRequiredEnv("SUPABASE_SERVICE_ROLE_KEY");

  const response = await fetch(
    `${supabaseUrl}/functions/v1/reply_preprocessor`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${serviceRoleKey}`,
        apikey: serviceRoleKey,
      },
      body: JSON.stringify({
        userId,
        emailText,
        emailHtml,
        gmailMessageId,
        gmailThreadId,
        dryRun,
      }),
    },
  );

  const payload = await safeParseJson(response);

  if (!response.ok) {
    await logEvent(supabase, "error", "poll_gmail:reply_preprocessor_failed", {
      userId,
      gmailMessageId,
      status: response.status,
      body: payload,
    });
    throw new Error(
      `reply_preprocessor returned ${response.status}`,
    );
  }

  await logEvent(supabase, "info", "poll_gmail:reply_preprocessor_success", {
    userId,
    gmailMessageId,
    dryRun,
    decisionsProcessed: typeof payload === "object" && payload !== null
      ? (payload as Record<string, unknown>).decisionsProcessed ?? null
      : null,
  });
}

async function safeParseJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch (_error) {
    return null;
  }
}

async function updateAccessToken(
  supabase: ReturnType<typeof getSupabaseAdminClient>,
  userId: string,
  credentialId: string,
  refreshToken: string,
): Promise<{ accessToken: string; refreshToken: string }> {
  try {
    const refreshed = await refreshAccessToken(refreshToken);
    const nextRefreshToken = refreshed.refresh_token ?? refreshToken;
    await storeTokenPair(supabase, userId, {
      accessToken: refreshed.access_token,
      refreshToken: nextRefreshToken,
    });
    await logEvent(supabase, "info", "poll_gmail:token_refreshed", {
      userId,
      scopes: refreshed.scope,
    });
    return {
      accessToken: refreshed.access_token,
      refreshToken: nextRefreshToken,
    };
  } catch (error) {
    if (shouldFlagReauth(error)) {
      const message = error instanceof Error ? error.message : String(error);
      await flagReauth(
        supabase,
        credentialId,
        `Refresh token refresh failed: ${message}`,
        { userId },
      );
    }
    throw error;
  }
}

async function ensureAccessToken(
  supabase: ReturnType<typeof getSupabaseAdminClient>,
  userId: string,
  credentialId: string,
  refreshToken: string,
  currentAccessToken: string | null,
): Promise<{ accessToken: string; refreshToken: string }> {
  if (currentAccessToken) {
    return { accessToken: currentAccessToken, refreshToken };
  }
  return await updateAccessToken(supabase, userId, credentialId, refreshToken);
}

interface ReauthContext {
  userId?: string;
  userEmail?: string;
}

async function flagReauth(
  supabase: ReturnType<typeof getSupabaseAdminClient>,
  credentialId: string,
  reason: string,
  context: ReauthContext = {},
) {
  let resolvedUserId = context.userId ?? null;
  let resolvedEmail = context.userEmail ?? null;

  const { data: credentialRow, error: credentialFetchError } = await supabase
    .from("user_credentials")
    .select("user_id, needs_reauth")
    .eq("id", credentialId)
    .maybeSingle();

  if (credentialFetchError) {
    await logEvent(supabase, "error", "poll_gmail:flag_reauth_lookup_failed", {
      credentialId,
      reason,
      error: credentialFetchError.message,
    });
    return;
  }

  if (!credentialRow) {
    await logEvent(supabase, "warn", "poll_gmail:flag_reauth_missing_credential", {
      credentialId,
      reason,
    });
    return;
  }

  if (credentialRow.needs_reauth) {
    await logEvent(supabase, "debug", "poll_gmail:flag_reauth_already_set", {
      credentialId,
      reason,
    });
    return;
  }

  if (!resolvedUserId && credentialRow.user_id) {
    resolvedUserId = credentialRow.user_id as string;
  }

  const { error: updateError } = await supabase
    .from("user_credentials")
    .update({ needs_reauth: true })
    .eq("id", credentialId);

  if (updateError) {
    await logEvent(supabase, "error", "poll_gmail:flag_reauth_failed", {
      credentialId,
      reason,
      error: updateError.message,
    });
    return;
  }

  if (!resolvedEmail && resolvedUserId) {
    const { data: userRow, error: userFetchError } = await supabase
      .from("app_user")
      .select("email")
      .eq("id", resolvedUserId)
      .maybeSingle();

    if (userFetchError) {
      await logEvent(supabase, "error", "poll_gmail:flag_reauth_user_lookup_failed", {
        credentialId,
        userId: resolvedUserId,
        reason,
        error: userFetchError.message,
      });
    }

    if (userRow?.email) {
      resolvedEmail = userRow.email as string;
    }
  }

  await logEvent(supabase, "warn", "poll_gmail:flagged_reauth", {
    credentialId,
    reason,
    userId: resolvedUserId,
    email: resolvedEmail,
  });

  await sendReauthNotification(
    supabase,
    resolvedUserId,
    resolvedEmail ?? null,
    reason,
  );
}

// Search Gmail messages for backfill functionality
async function listRecentMessageIds(
  accessToken: string,
  days: number,
  logger?: Logger,
): Promise<Map<string, MessageReference>> {
  const messageMap = new Map<string, MessageReference>();
  if (days <= 0) {
    logger?.warn('Invalid days parameter for Gmail search', {
      source: 'gmail_api',
      action: 'INVALID_DAYS_PARAM',
      payload: { days }
    });
    return messageMap;
  }

  const queryParts = [
    `newer_than:${days}d`,
    // Removed "label:inbox" to search ALL_MAIL instead of just INBOX
  ];
  let pageToken: string | undefined;
  let totalMessages = 0;
  let pageCount = 0;

  logger?.info('Starting Gmail API message search', {
    source: 'gmail_api',
    action: 'GMAIL_SEARCH_START',
    payload: {
      query: queryParts.join(" "),
      days,
      searchScope: 'ALL_MAIL'
    }
  });

  do {
    pageCount++;
    const params = new URLSearchParams({
      q: queryParts.join(" "),
      maxResults: "100",
    });
    params.set("fields", "messages(id,threadId,labelIds),nextPageToken");
    if (pageToken) {
      params.set("pageToken", pageToken);
    }

    const url = `https://gmail.googleapis.com/gmail/v1/users/me/messages?${params.toString()}`;

    logger?.info('Making Gmail API request', {
      source: 'gmail_api',
      action: 'GMAIL_API_REQUEST',
      payload: {
        url,
        pageToken: pageToken || null,
        pageNumber: pageCount
      }
    });

    const startTime = Date.now();
    const response = await gmailFetch(accessToken, url);
    const durationMs = Date.now() - startTime;

    logger?.info('Gmail API response received', {
      source: 'gmail_api',
      action: 'GMAIL_API_RESPONSE',
      success: response.ok,
      durationMs,
      payload: {
        status: response.status,
        statusText: response.statusText,
        pageNumber: pageCount
      }
    });

    if (!response.ok) {
      const text = await response.text();
      logger?.error('Gmail API request failed', new Error(`Failed to list messages: ${response.status} ${text}`), {
        source: 'gmail_api',
        action: 'GMAIL_API_ERROR',
        durationMs,
        payload: {
          status: response.status,
          responseBody: text,
          url
        }
      });
      throw new Error(`Failed to list messages: ${response.status} ${text}`);
    }

    const json = await response.json();
    const parsed = MessageListSchema.parse(json);

    const pageMessageCount = parsed.messages?.length || 0;
    totalMessages += pageMessageCount;

    logger?.info('Gmail API response parsed', {
      source: 'gmail_api',
      action: 'GMAIL_RESPONSE_PARSED',
      success: true,
      payload: {
        pageMessageCount,
        totalMessagesFound: totalMessages,
        hasNextPage: !!parsed.nextPageToken,
        pageNumber: pageCount
      }
    });

    if (parsed.messages) {
      for (const message of parsed.messages) {
        messageMap.set(message.id, {
          id: message.id,
          threadId: message.threadId,
          labelIds: message.labelIds ?? [],
        });
      }
    }

    pageToken = parsed.nextPageToken ?? undefined;
  } while (pageToken);

  logger?.info('Gmail API search completed', {
    source: 'gmail_api',
    action: 'GMAIL_SEARCH_COMPLETE',
    success: true,
    payload: {
      totalMessagesFound: totalMessages,
      totalPagesProcessed: pageCount,
      query: queryParts.join(" "),
      searchDays: days
    }
  });

  return messageMap;
}

async function processUser(
  supabase: ReturnType<typeof getSupabaseAdminClient>,
  user: UserRow,
  credential: CredentialRow,
  dryRun: boolean,
  userMap: Map<string, UserRow>,
  correlationId?: string,
  backfillDays?: number,
) {
  const logger = new Logger('poll_gmail', correlationId);
  
  logger.info('Starting user processing', {
    source: 'poll_gmail',
    action: 'USER_PROCESSING_START',
    payload: {
      userId: user.id,
      userEmail: user.email,
      dryRun,
      backfillDays
    }
  });

  const tokens = await getTokenPair(supabase, user.id).catch(() => ({
    accessToken: null,
    refreshToken: null,
  }));

  const refreshToken = tokens.refreshToken;
  if (!refreshToken) {
    logger.error('Missing refresh token for user', new Error('Refresh token missing'), {
      source: 'token_management',
      action: 'MISSING_REFRESH_TOKEN',
      payload: { userId: user.id }
    });
    await logEvent(supabase, "error", "poll_gmail:missing_refresh_token", {
      userId: user.id,
    });
    await flagReauth(
      supabase,
      credential.id,
      "Refresh token missing",
      { userId: user.id, userEmail: user.email },
    );
    return;
  }

  const ensured = await ensureAccessToken(
    supabase,
    user.id,
    credential.id,
    refreshToken,
    tokens.accessToken,
  );
  let accessToken = ensured.accessToken;
  let activeRefreshToken = ensured.refreshToken;

  let historyMessages: Map<string, MessageReference> | null = null;
  let latestHistoryId: string | null = credential.last_history_id ?? null;
  let requiresCursorReset = false;

  const loadHistoryMessages = async () => {
    const messageMap = new Map<string, MessageReference>();
    let pageToken: string | undefined;

    do {
      const page = await fetchHistory(
        accessToken,
        credential.last_history_id,
        pageToken,
      );

      if (page.history) {
        for (const history of page.history) {
          if (history.messagesAdded) {
            for (const entry of history.messagesAdded) {
              const historyMessage = entry.message;
              if (!historyMessage) continue;
              if (historyMessage.id === historyMessage.threadId) {
                continue;
              }
              const labels = historyMessage.labelIds ?? [];
              if (labels.includes("DRAFT") || labels.includes("CHAT")) {
                continue;
              }

              if (!messageMap.has(historyMessage.id)) {
                messageMap.set(historyMessage.id, {
                  id: historyMessage.id,
                  threadId: historyMessage.threadId,
                  labelIds: labels,
                });
              }
            }
          }

          if (history.messages) {
            for (const message of history.messages) {
              if (message.id === message.threadId) {
                continue;
              }
              if (!messageMap.has(message.id)) {
                messageMap.set(message.id, {
                  id: message.id,
                  threadId: message.threadId,
                });
              }
            }
          }
        }
      }

      if (page.historyId) {
        latestHistoryId = page.historyId;
      }

      pageToken = page.nextPageToken ?? undefined;
    } while (pageToken);

    return messageMap;
  };

  try {
    historyMessages = await loadHistoryMessages();
  } catch (error) {
    if (error instanceof GoogleAuthError && error.status === 401) {
      logger.warn('Token refresh needed for history loading', {
        source: 'token_management',
        action: 'TOKEN_REFRESH_HISTORY',
        payload: { userId: user.id, errorStatus: 401 }
      });
      const refreshed = await updateAccessToken(
        supabase,
        user.id,
        credential.id,
        activeRefreshToken,
      );
      accessToken = refreshed.accessToken;
      activeRefreshToken = refreshed.refreshToken;
      historyMessages = await loadHistoryMessages();
    } else if (error instanceof GoogleAuthError && error.status === 404) {
      logger.warn('History expired, cursor reset required', {
        source: 'gmail_api',
        action: 'HISTORY_EXPIRED',
        payload: { userId: user.id, errorStatus: 404 }
      });
      requiresCursorReset = true;
    } else {
      throw error;
    }
  }

  // Add backfill functionality when needed
  if (backfillDays && backfillDays > 0) {
    logger.info('Starting backfill process', {
      source: 'gmail_api',
      action: 'BACKFILL_START',
      payload: { userId: user.id, backfillDays }
    });
    try {
      const backfillMessages = await listRecentMessageIds(accessToken, backfillDays, logger);
      logger.info('Backfill process completed successfully', {
        source: 'gmail_api', 
        action: 'BACKFILL_SUCCESS',
        payload: { 
          userId: user.id, 
          backfillDays, 
          messagesFound: backfillMessages.size 
        }
      });
      // Merge backfill messages with history messages
      if (historyMessages) {
        for (const [id, message] of backfillMessages) {
          historyMessages.set(id, message);
        }
      } else {
        historyMessages = backfillMessages;
      }
    } catch (error) {
      logger.error('Backfill process failed', error as Error, {
        source: 'gmail_api',
        action: 'BACKFILL_FAILURE',
        payload: { userId: user.id, backfillDays }
      });
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

  if (!historyMessages) return;

  if (historyMessages.size === 0) {
    if (latestHistoryId && latestHistoryId !== credential.last_history_id) {
      await supabase
        .from("user_credentials")
        .update({ last_history_id: latestHistoryId })
        .eq("id", credential.id);
    }
    return;
  }

  const partner = user.partner_user_id
    ? userMap.get(user.partner_user_id) ?? null
    : null;

  for (const { id: messageId, threadId, labelIds } of historyMessages.values()) {
    try {
      let message: z.infer<typeof MessageSchema>;
      try {
        message = await fetchMessage(accessToken, messageId);
      } catch (error) {
        const isNotFound = error instanceof Error &&
          error.message.includes("404");
        if (!isNotFound) {
          throw error;
        }

        try {
          const thread = await fetchThread(accessToken, threadId);
          const fallback = thread.messages?.find((msg) =>
            msg.id === messageId
          ) ??
            thread.messages?.find((msg) =>
              (msg.labelIds ?? []).includes("SENT")
            );

          if (!fallback) {
            await logEvent(supabase, "warn", "poll_gmail:thread_fallback_missing", {
              userId: user.id,
              messageId,
              threadId,
            });
            continue;
          }

          message = fallback;
          await logEvent(supabase, "info", "poll_gmail:thread_fallback_used", {
            userId: user.id,
            messageId,
            threadId,
            labelIds: message.labelIds ?? [],
          });
        } catch (threadError) {
          const message = threadError instanceof Error
            ? threadError.message
            : String(threadError);
          await logEvent(supabase, "error", "poll_gmail:thread_fetch_failed", {
            userId: user.id,
            messageId,
            threadId,
            labelIds,
            error: message,
          });
          continue;
        }
      }
      let emailText = extractPlainText(message.payload);
      const emailHtml = extractHtml(message.payload);

      const combinedLabelSet = new Set<string>([
        ...(labelIds ?? []),
        ...((message.labelIds ?? [])),
      ]);

      if (combinedLabelSet.has("DRAFT") || combinedLabelSet.has("CHAT")) {
        await logEvent(supabase, "debug", "poll_gmail:skipped_draft_or_chat", {
          userId: user.id,
          messageId,
          labels: Array.from(combinedLabelSet),
        });
        continue;
      }

      if (!emailText.trim()) {
        if (message.snippet?.trim()) {
          emailText = message.snippet;
        } else if (emailHtml.trim()) {
          emailText = emailHtml;
        }
      }

      const subjectRaw = getHeaderValue(message.payload.headers, "subject");
      const fromRaw = getHeaderValue(message.payload.headers, "from").toLowerCase();
      const toRaw = getHeaderValue(message.payload.headers, "to").toLowerCase();
      const userEmailLower = user.email.toLowerCase();
      const isFromUser = fromRaw.includes(userEmailLower);
      const isDigestReply = subjectRaw.toLowerCase().includes("mindspire digest");
      const isDigestRecipient = toRaw.includes("notifications@send.mind-spire.xyz");
      const isSentMessage = combinedLabelSet.has("SENT");

      if (isFromUser && isSentMessage) {
        await logEvent(supabase, "info", "poll_gmail:user_sent_message", {
          userId: user.id,
          messageId,
          threadId,
          subject: subjectRaw,
          to: toRaw,
          labels: Array.from(combinedLabelSet),
          digestReplyCandidate: isDigestReply || isDigestRecipient,
        });
      }

      if ((isDigestReply || isDigestRecipient) && isFromUser && isSentMessage) {
        await forwardDigestReply({
          supabase,
          userId: user.id,
          emailText,
          emailHtml,
          gmailMessageId: messageId,
          gmailThreadId: threadId,
          dryRun,
        });
        continue;
      }

      if (!emailText.trim()) {
        continue;
      }

      if (isFromUser) {
        continue;
      }

      const invite = await parseInviteWithGemini(emailText, user.email);
      if (!invite.invite_id || !invite.title || !invite.summary) {
        continue;
      }

      const subject = subjectRaw || invite.title;

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

  if (latestHistoryId && latestHistoryId !== credential.last_history_id) {
    const { error: cursorUpdateError } = await supabase
      .from("user_credentials")
      .update({ last_history_id: latestHistoryId })
      .eq("id", credential.id);

    if (cursorUpdateError) {
      await logEvent(supabase, "error", "poll_gmail:cursor_update_failed", {
        userId: user.id,
        historyId: latestHistoryId,
        error: cursorUpdateError.message,
      });
    }
  }
}

export async function pollGmailHandler(req: Request): Promise<Response> {
  const supabase = getSupabaseAdminClient();
  const correlationId = crypto.randomUUID();
  const logger = new Logger('poll_gmail', correlationId);

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

  logger.info('Poll Gmail handler started', {
    source: 'poll_gmail',
    action: 'HANDLER_START',
    payload: { 
      method: req.method,
      userId: body.userId,
      dryRun: body.dryRun,
      backfillDays: body.backfillDays
    }
  });

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
        correlationId,
        body.backfillDays,
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
