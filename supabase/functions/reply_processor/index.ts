import { z } from "zod";
import { jsonResponse } from "../_shared/http.ts";
import { getSupabaseAdminClient } from "../_shared/supabaseClient.ts";
import { logEvent } from "../_shared/logger.ts";
import { callGeminiJson } from "../_shared/google.ts";
import { getOptionalEnv } from "../_shared/env.ts";

const BodySchema = z.object({
  userId: z.string().uuid(),
  emailText: z.string().min(1),
  gmailMessageId: z.string().optional(),
  gmailThreadId: z.string().optional(),
  dryRun: z.boolean().optional(),
});

const GeminiReplySchema = z.object({
  id: z.string().min(1),
  decision: z.enum(["yes", "no", "maybe"]),
  notes: z.string().optional(),
});

const DecisionToStatus: Record<"yes" | "no" | "maybe", string> = {
  yes: "approved",
  no: "declined",
  maybe: "pending",
};

function buildReplyPrompt(emailText: string): string {
  return `Extract the invite decision and optional notes from this email reply.
Return strict JSON with fields: id (string), decision (yes|no|maybe), notes (string, optional).
Email:
"""
${emailText}
"""`;
}

async function notifyPeer(body: Record<string, unknown>, dryRun: boolean) {
  const webhook = getOptionalEnv("PEER_WEBHOOK_URL");
  if (!webhook) {
    return;
  }

  if (dryRun) {
    console.info("PEER_WEBHOOK_URL configured but skipped due to dryRun", {
      body,
    });
    return;
  }

  const response = await fetch(webhook, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Peer webhook failed: ${response.status} ${text}`);
  }
}

Deno.serve(async (req) => {
  const supabase = getSupabaseAdminClient();

  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, { status: 405 });
  }

  let body: z.infer<typeof BodySchema>;
  try {
    const json = await req.json();
    body = BodySchema.parse(json);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await logEvent(supabase, "warn", "reply_processor:invalid_body", {
      error: message,
    });
    return jsonResponse({ error: "Invalid request body" }, { status: 400 });
  }

  await logEvent(supabase, "info", "reply_processor:start", {
    userId: body.userId,
    gmailMessageId: body.gmailMessageId,
    dryRun: body.dryRun ?? false,
  });

  let parsedReply: z.infer<typeof GeminiReplySchema>;
  try {
    const prompt = buildReplyPrompt(body.emailText);
    parsedReply = await callGeminiJson(prompt, GeminiReplySchema);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await logEvent(supabase, "error", "reply_processor:gemini_failed", {
      userId: body.userId,
      error: message,
    });
    return jsonResponse({ error: "Failed to parse reply" }, { status: 502 });
  }

  if (body.dryRun) {
    await logEvent(supabase, "info", "reply_processor:dry_run", {
      userId: body.userId,
      parsedReply,
    });
    return jsonResponse({ message: "Dry run", parsedReply });
  }

  const status = DecisionToStatus[parsedReply.decision];

  const { data: invite, error: inviteError } = await supabase
    .from("invite")
    .select("id, parsed, status, user_id")
    .eq("user_id", body.userId)
    .contains("parsed", { invite_id: parsedReply.id })
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (inviteError) {
    await logEvent(supabase, "error", "reply_processor:invite_lookup_failed", {
      userId: body.userId,
      inviteId: parsedReply.id,
      error: inviteError.message,
    });
    return jsonResponse({ error: "Invite lookup failed" }, { status: 500 });
  }

  if (!invite) {
    await logEvent(supabase, "warn", "reply_processor:invite_not_found", {
      userId: body.userId,
      inviteId: parsedReply.id,
    });
    return jsonResponse({ error: "Invite not found" }, { status: 404 });
  }

  const updatedFields: Record<string, unknown> = {
    status,
    notes: parsedReply.notes ?? null,
  };

  const { error: updateError } = await supabase
    .from("invite")
    .update(updatedFields)
    .eq("id", invite.id);

  if (updateError) {
    await logEvent(supabase, "error", "reply_processor:update_failed", {
      userId: body.userId,
      inviteId: invite.id,
      error: updateError.message,
    });
    return jsonResponse({ error: "Failed to update invite" }, { status: 500 });
  }

  try {
    await notifyPeer({
      type: "invite_decision",
      user_id: body.userId,
      invite_id: parsedReply.id,
      decision: parsedReply.decision,
      notes: parsedReply.notes ?? null,
      gmail_message_id: body.gmailMessageId ?? null,
      gmail_thread_id: body.gmailThreadId ?? null,
    }, false);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await logEvent(supabase, "error", "reply_processor:peer_notify_failed", {
      userId: body.userId,
      inviteId: parsedReply.id,
      error: message,
    });
  }

  await logEvent(supabase, "info", "reply_processor:completed", {
    userId: body.userId,
    inviteId: invite.id,
    decision: parsedReply.decision,
  });

  return jsonResponse({
    message: "Invite updated",
    inviteId: invite.id,
    decision: parsedReply.decision,
  });
});
