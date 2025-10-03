import { z } from "zod";
import { htmlResponse, jsonResponse } from "../_shared/http.ts";
import { getSupabaseAdminClient } from "../_shared/supabaseClient.ts";
import { logEvent } from "../_shared/logger.ts";
import { getOptionalEnv, getRequiredEnv } from "../_shared/env.ts";

const GOOGLE_OAUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const DEFAULT_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/calendar.settings.readonly",
];

const QuerySchema = z.object({
  email: z.string().email().optional(),
  userId: z.string().uuid().optional(),
  redirect: z.string().url().optional(),
  format: z.enum(["html", "json"]).optional(),
});

const BodySchema = z.object({
  email: z.string().email().optional(),
  userId: z.string().uuid().optional(),
  redirect: z.string().url().optional(),
  format: z.enum(["html", "json"]).optional(),
});

interface InviteLinkInput {
  userId?: string;
  email?: string;
  redirect?: string;
  format?: "html" | "json";
}

function encodeState(state: Record<string, unknown>): string {
  return encodeURIComponent(JSON.stringify(state));
}

export function buildInviteLink(
  partnerUserId: string,
  options: { inviterEmail?: string; redirectTo?: string } = {},
): string {
  const clientId = getRequiredEnv("GOOGLE_CLIENT_ID");
  const redirectUri = getOptionalEnv("GOOGLE_REDIRECT_URI") ??
    `${getRequiredEnv("SUPABASE_URL")}/functions/v1/auth_callback`;
  const scopes = getOptionalEnv("GOOGLE_OAUTH_SCOPES") ??
    DEFAULT_SCOPES.join(" ");

  const state: Record<string, unknown> = { partnerUserId };
  if (options.inviterEmail) {
    state.inviterEmail = options.inviterEmail;
  }
  if (options.redirectTo) {
    state.redirectTo = options.redirectTo;
  }

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    access_type: "offline",
    include_granted_scopes: "true",
    prompt: "consent",
    scope: scopes,
    state: encodeState(state),
  });

  return `${GOOGLE_OAUTH_URL}?${params.toString()}`;
}

async function resolveUserId(
  supabase: ReturnType<typeof getSupabaseAdminClient>,
  input: InviteLinkInput,
): Promise<{ userId: string; inviterEmail?: string } | null> {
  if (input.userId) {
    const { data, error } = await supabase
      .from("app_user")
      .select("id, email")
      .eq("id", input.userId)
      .maybeSingle();

    if (error) {
      throw new Error(`Failed to look up user: ${error.message}`);
    }

    if (!data?.id) {
      return null;
    }

    return { userId: data.id, inviterEmail: data.email ?? input.email }; // prefer DB email, fall back to provided
  }

  if (!input.email) {
    return null;
  }

  const { data, error } = await supabase
    .from("app_user")
    .select("id, email")
    .eq("email", input.email)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to look up user: ${error.message}`);
  }

  if (!data?.id) {
    return null;
  }

  return { userId: data.id, inviterEmail: data.email ?? undefined };
}

function renderHtml(inviteUrl: string, inviterEmail?: string): string {
  const intro = inviterEmail
    ? `<p>${inviterEmail} invited you to connect Mindspire. Click below to grant access:</p>`
    : `<p>Click below to grant Mindspire access to your Gmail and Calendar data:</p>`;

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Mindspire Invite</title>
    <style>
      body { font-family: Arial, sans-serif; margin: 3rem auto; max-width: 480px; color: #1f2933; }
      a.button { display: inline-block; padding: 0.8rem 1.6rem; background: #2563eb; color: #fff; border-radius: 0.375rem; text-decoration: none; font-weight: 600; }
      .box { border: 1px solid #cbd5e1; padding: 2rem; border-radius: 0.5rem; box-shadow: 0 12px 30px rgba(15, 23, 42, 0.08); }
    </style>
  </head>
  <body>
    <div class="box">
      <h1>Mindspire Invite</h1>
      ${intro}
      <p><a class="button" href="${inviteUrl}">Connect with Google</a></p>
      <p style="font-size: 0.9rem; color: #475569">You will be redirected to Google to grant read-only access.</p>
    </div>
  </body>
</html>`;
}

export async function inviteLinkHandler(req: Request): Promise<Response> {
  if (req.method !== "GET" && req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, { status: 405 });
  }

  const supabase = getSupabaseAdminClient();

  let input: InviteLinkInput = {};

  try {
    if (req.method === "GET") {
      const url = new URL(req.url);
      input = QuerySchema.parse(Object.fromEntries(url.searchParams));
    } else {
      const json = await req.json();
      input = BodySchema.parse(json);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await logEvent(supabase, "warn", "invite_link:invalid_input", { message });
    return jsonResponse({ error: "Invalid input", message }, { status: 400 });
  }

  let userContext: { userId: string; inviterEmail?: string } | null = null;

  try {
    userContext = await resolveUserId(supabase, input);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await logEvent(supabase, "error", "invite_link:user_lookup_failed", {
      message,
      email: input.email,
      userId: input.userId,
    });
    return jsonResponse({ error: "Failed to look up user" }, { status: 500 });
  }

  if (!userContext) {
    await logEvent(supabase, "warn", "invite_link:user_not_found", {
      email: input.email,
      userId: input.userId,
    });
    return jsonResponse({ error: "User not found" }, { status: 404 });
  }

  const inviteUrl = buildInviteLink(userContext.userId, {
    inviterEmail: userContext.inviterEmail,
    redirectTo: input.redirect,
  });

  await logEvent(supabase, "info", "invite_link:generated", {
    userId: userContext.userId,
    inviterEmail: userContext.inviterEmail,
  });

  if (input.format === "html") {
    return htmlResponse(renderHtml(inviteUrl, userContext.inviterEmail));
  }

  return jsonResponse({ inviteUrl });
}

if (import.meta.main) {
  Deno.serve(inviteLinkHandler);
}
