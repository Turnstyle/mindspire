import { DateTime } from "luxon";
import { z } from "zod";
import { jsonResponse } from "../_shared/http.ts";
import { getSupabaseAdminClient } from "../_shared/supabaseClient.ts";
import { logEvent } from "../_shared/logger.ts";
import { getOptionalEnv } from "../_shared/env.ts";
import { SmtpClient } from "smtp";

const InviteSchema = z.object({
  invite_id: z.string().min(1),
  inviter: z.string().optional(),
  inviter_email: z.string().email().optional(),
  title: z.string().min(1),
  summary: z.string().min(1),
  location: z.string().optional(),
  proposed_times: z.array(z.object({
    start: z.string().optional(),
    end: z.string().optional(),
    timezone: z.string().optional(),
  })).default([]),
  follow_up_actions: z.array(z.string()).default([]),
  confidence: z.number().min(0).max(1).optional(),
});

const BodySchema = z.object({
  dryRun: z.boolean().optional(),
  userId: z.string().uuid().optional(),
  now: z.string().optional(),
});

interface UserRecord {
  id: string;
  email: string;
  tz: string;
  partner_user_id: string | null;
}

interface InviteRecord {
  id: string;
  parsed: unknown;
  created_at: string;
  gmail_thread_id: string;
  gmail_message_id: string;
  source_subject: string | null;
  user_id: string;
  shared_user_ids: string[] | null;
}

export function shouldSendDigest(now: DateTime, timezone: string): boolean {
  if (!timezone) return false;

  const local = now.setZone(timezone);
  if (!local.isValid) return false;

  return local.hour === 7;
}

export function formatTimeRange(
  start?: string,
  end?: string,
  timezone?: string,
): string {
  if (!start) return "";
  try {
    const zone = timezone ?? "UTC";
    const startDt = DateTime.fromISO(start, { zone });
    const endDt = end ? DateTime.fromISO(end, { zone }) : null;

    if (!startDt.isValid) return "";

    if (endDt && endDt.isValid) {
      return `${startDt.toFormat("ccc MMM d h:mm a")} – ${
        endDt.toFormat("h:mm a ZZZZ")
      }`;
    }

    return `${startDt.toFormat("ccc MMM d h:mm a ZZZZ")}`;
  } catch (_error) {
    return "";
  }
}

function buildThreadLink(threadId: string): string {
  return `https://mail.google.com/mail/u/0/#inbox/${threadId}`;
}

export function buildDigestBody(
  user: UserRecord,
  invites: Array<
    { record: InviteRecord; parsed: z.infer<typeof InviteSchema> }
  >,
  ownerEmailLookup: Map<string, string>,
): { text: string; items: Array<Record<string, unknown>> } {
  const lines: string[] = [];
  const items: Array<Record<string, unknown>> = [];

  lines.push(`Good morning ${user.email},`);
  lines.push("");
  lines.push("Here's your Mindspire digest:");
  lines.push("");

  invites.forEach(({ record, parsed }, index) => {
    const times = parsed.proposed_times
      .map((slot) => formatTimeRange(slot.start, slot.end, slot.timezone))
      .filter((value) => Boolean(value));

    const header = `${String.fromCharCode(65 + index)}. ${parsed.title}`;
    lines.push(header);

    const meta: string[] = [];
    if (parsed.inviter) meta.push(`From: ${parsed.inviter}`);
    if (times.length > 0) meta.push(`When: ${times.join(" | ")}`);
    if (parsed.location) meta.push(`Where: ${parsed.location}`);

    if (meta.length > 0) {
      lines.push(`   ${meta.join(" · ")}`);
    }

    const ownerEmail = ownerEmailLookup.get(record.user_id);
    if (record.user_id !== user.id && ownerEmail) {
      lines.push(`   Owner: ${ownerEmail}`);
    }

    lines.push(`   ${parsed.summary}`);

    if (parsed.follow_up_actions.length > 0) {
      lines.push(`   Next steps: ${parsed.follow_up_actions.join(", ")}`);
    }

    lines.push(`   Email thread: ${buildThreadLink(record.gmail_thread_id)}`);

    lines.push("");

    items.push({
      invite_id: parsed.invite_id,
      gmail_thread_id: record.gmail_thread_id,
      gmail_message_id: record.gmail_message_id,
      created_at: record.created_at,
      summary: parsed.summary,
    });
  });

  lines.push("Reply yes/no/maybe with notes to act on these invites.");

  return { text: lines.join("\n"), items };
}

async function deliverDigest(
  email: string,
  body: string,
  dryRun: boolean,
) {
  const webhook = getOptionalEnv("DIGEST_WEBHOOK_URL");
  if (webhook) {
    const payload = webhook.includes("hooks.slack.com")
      ? { text: `*Mindspire digest for ${email}*\n\n${body}` }
      : { email, body };

    const response = await fetch(webhook, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Digest webhook failed: ${response.status} ${text}`);
    }

    await logEvent(getSupabaseAdminClient(), "info", "send_digest:slack_posted", {
      email,
    });
  } else if (!dryRun) {
    console.warn("DIGEST_WEBHOOK_URL not configured; skipping Slack post", { email });
  }

  await maybeSendEmail(email, body, dryRun);
}

async function maybeSendEmail(email: string, body: string, dryRun: boolean) {
  if (dryRun) return;

  const host = getOptionalEnv("SMTP_HOST");
  const portValue = getOptionalEnv("SMTP_PORT") ?? "465";
  const username = getOptionalEnv("SMTP_USER");
  const password = getOptionalEnv("SMTP_PASS");

  if (!host || !username || !password) {
    return;
  }

  const port = Number.parseInt(portValue, 10);
  if (Number.isNaN(port)) {
    console.warn("Invalid SMTP_PORT; skipping email send", { portValue });
    return;
  }

  const fromAddress = getOptionalEnv("SMTP_FROM") ?? username;
  const client = new SmtpClient();

  try {
    await client.connectTLS({
      hostname: host,
      port,
      username,
      password,
    });

    await client.send({
      from: fromAddress,
      to: email,
      subject: "Your Mindspire digest",
      content: body,
    });

    await logEvent(getSupabaseAdminClient(), "info", "send_digest:email_sent", {
      email,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await logEvent(getSupabaseAdminClient(), "error", "send_digest:email_failed", {
      email,
      error: message,
    });
  } finally {
    try {
      await client.close();
    } catch (_) {
      // ignore close errors
    }
  }
}

export async function sendDigestHandler(req: Request): Promise<Response> {
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

  const dryRun = Boolean(body.dryRun);
  const now = body.now ? DateTime.fromISO(body.now) : DateTime.utc();

  await logEvent(supabase, "info", "send_digest:start", {
    dryRun,
    now: now.toISO(),
    targetUserId: body.userId,
  });

  const { data: users, error: usersError } = await supabase
    .from("app_user")
    .select("id, email, tz, partner_user_id")
    .order("id");

  if (usersError) {
    await logEvent(supabase, "error", "send_digest:user_load_failed", {
      error: usersError.message,
    });
    return jsonResponse({ error: "Failed to load users" }, { status: 500 });
  }

  const userRecords = users ?? [];

  const ownerEmailLookup = new Map<string, string>(
    userRecords.map((entry) => [entry.id, entry.email] as [string, string]),
  );

  const filteredUsers = userRecords.filter((user) =>
    body.userId ? user.id === body.userId : true
  );

  if (filteredUsers.length === 0) {
    return jsonResponse({ message: "No eligible users" });
  }

  let processed = 0;
  let sent = 0;

  for (const user of filteredUsers) {
    processed += 1;

    if (!shouldSendDigest(now, user.tz)) {
      continue;
    }

    const { data: lastDigest, error: lastDigestError } = await supabase
      .from("digest")
      .select("sent_at")
      .eq("user_id", user.id)
      .order("sent_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (lastDigestError) {
      await logEvent(supabase, "error", "send_digest:last_digest_failed", {
        userId: user.id,
        error: lastDigestError.message,
      });
      continue;
    }

    if (lastDigest?.sent_at) {
      const lastSent = DateTime.fromISO(lastDigest.sent_at).setZone(user.tz);
      if (lastSent.isValid && lastSent.hasSame(now.setZone(user.tz), "day")) {
        continue;
      }
    }

    const participationFilter =
      `user_id.eq.${user.id},shared_user_ids.cs.{"${user.id}"}`;

    const { data: invites, error: invitesError } = await supabase
      .from("invite")
      .select(
        "id, parsed, created_at, gmail_thread_id, gmail_message_id, source_subject, user_id, shared_user_ids",
      )
      .eq("status", "pending")
      .or(participationFilter)
      .order("created_at", { ascending: true });

    if (invitesError) {
      await logEvent(supabase, "error", "send_digest:invite_load_failed", {
        userId: user.id,
        error: invitesError.message,
      });
      continue;
    }

    const parsedInvites: Array<
      { record: InviteRecord; parsed: z.infer<typeof InviteSchema> }
    > = [];

    for (const invite of invites ?? []) {
      const parsed = InviteSchema.safeParse(invite.parsed);
      if (!parsed.success) {
        await logEvent(supabase, "warn", "send_digest:invite_parse_failed", {
          userId: user.id,
          inviteId: invite.id,
          issues: parsed.error.issues,
        });
        continue;
      }

      parsedInvites.push({
        record: invite as InviteRecord,
        parsed: parsed.data,
      });
    }

    if (parsedInvites.length === 0) {
      continue;
    }

    const digestBody = buildDigestBody(user, parsedInvites, ownerEmailLookup);

    if (!dryRun) {
      try {
        await deliverDigest(user.email, digestBody.text, dryRun);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await logEvent(supabase, "error", "send_digest:delivery_failed", {
          userId: user.id,
          error: message,
        });
        continue;
      }

      const digestToken = crypto.randomUUID();

      const { error: digestInsertError } = await supabase
        .from("digest")
        .insert({
          user_id: user.id,
          sent_at: now.toUTC().toISO(),
          token: digestToken,
          items: digestBody.items,
        });

      if (digestInsertError) {
        await logEvent(supabase, "error", "send_digest:digest_insert_failed", {
          userId: user.id,
          error: digestInsertError.message,
        });
        continue;
      }
    }

    await logEvent(supabase, "info", "send_digest:sent", {
      userId: user.id,
      dryRun,
      invites: parsedInvites.length,
    });
    sent += 1;
  }

  return jsonResponse({
    message: "Digest sweep complete",
    usersProcessed: processed,
    digestsSent: sent,
    dryRun,
  });
}

if (import.meta.main) {
  Deno.serve(sendDigestHandler);
}
