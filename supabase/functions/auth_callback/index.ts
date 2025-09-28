import { z } from "zod";
import {
  htmlResponse,
  jsonResponse,
  redirectResponse,
} from "../_shared/http.ts";
import { getSupabaseAdminClient } from "../_shared/supabaseClient.ts";
import { logEvent } from "../_shared/logger.ts";
import { getOptionalEnv, getRequiredEnv } from "../_shared/env.ts";
import { upsertSecret } from "../_shared/vault.ts";

interface OAuthState {
  userId?: string;
  partnerUserId?: string;
  redirectTo?: string;
  inviterEmail?: string;
}

const RawTokenSchema = z.object({
  access_token: z.string(),
  refresh_token: z.string().optional(),
  expires_in: z.union([z.number(), z.string()]).optional(),
  scope: z.string().optional(),
  token_type: z.string(),
  id_token: z.string().optional(),
});

const TokenSchema = RawTokenSchema.transform(
  (value: z.infer<typeof RawTokenSchema>) => ({
    ...value,
    expires_in: typeof value.expires_in === "string"
      ? Number.parseInt(value.expires_in, 10)
      : value.expires_in,
  }),
);

const GmailProfileSchema = z.object({
  emailAddress: z.string().email(),
});

const CalendarTimezoneSchema = z.object({
  value: z.string(),
});

const OAuthStateSchema = z
  .object({
    userId: z.string().uuid().optional(),
    partnerUserId: z.string().uuid().optional(),
    redirectTo: z.string().url().optional(),
    inviterEmail: z.string().email().optional(),
  })
  .partial();

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GMAIL_PROFILE_URL =
  "https://gmail.googleapis.com/gmail/v1/users/me/profile";
const CALENDAR_TIMEZONE_URL =
  "https://www.googleapis.com/calendar/v3/users/me/settings/timezone";

function decodeState(rawState: string | null): OAuthState | undefined {
  if (!rawState) return undefined;

  const attempts: Array<() => string> = [
    () => decodeURIComponent(rawState),
    () => atob(rawState),
  ];

  for (const attempt of attempts) {
    try {
      const decoded = attempt();
      const parsed = JSON.parse(decoded);
      const result = OAuthStateSchema.parse(parsed);
      return result;
    } catch (_error) {
      continue;
    }
  }

  return undefined;
}

async function exchangeCodeForTokens(code: string) {
  const body = new URLSearchParams({
    code,
    client_id: getRequiredEnv("GOOGLE_CLIENT_ID"),
    client_secret: getRequiredEnv("GOOGLE_CLIENT_SECRET"),
    redirect_uri: getOptionalEnv("GOOGLE_REDIRECT_URI") ??
      `${getRequiredEnv("SUPABASE_URL")}/functions/v1/auth_callback`,
    grant_type: "authorization_code",
  });

  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });

  if (!response.ok) {
    const errorPayload = await response.text();
    throw new Error(
      `Token exchange failed: ${response.status} ${errorPayload}`,
    );
  }

  const json = await response.json();
  return TokenSchema.parse(json);
}

async function fetchGmailProfile(accessToken: string) {
  const response = await fetch(GMAIL_PROFILE_URL, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!response.ok) {
    const errorPayload = await response.text();
    throw new Error(
      `Failed to fetch Gmail profile: ${response.status} ${errorPayload}`,
    );
  }

  const json = await response.json();
  return GmailProfileSchema.parse(json);
}

async function fetchCalendarTimezone(accessToken: string) {
  const response = await fetch(CALENDAR_TIMEZONE_URL, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!response.ok) {
    const errorPayload = await response.text();
    throw new Error(
      `Failed to fetch Calendar timezone: ${response.status} ${errorPayload}`,
    );
  }

  const json = await response.json();
  return CalendarTimezoneSchema.parse(json);
}

export async function authCallbackHandler(req: Request): Promise<Response> {
  const supabase = getSupabaseAdminClient();
  const url = new URL(req.url);
  const authError = url.searchParams.get("error");

  if (authError) {
    const errorDescription = url.searchParams.get("error_description") ??
      authError;
    await logEvent(supabase, "warn", "auth_callback:authorization_error", {
      error: errorDescription,
    });
    return htmlResponse(
      `<html><body><h2>Authorization failed</h2><p>${errorDescription}</p></body></html>`,
      { status: 400 },
    );
  }

  const code = url.searchParams.get("code");
  if (!code) {
    await logEvent(supabase, "warn", "auth_callback:missing_code");
    return htmlResponse(
      "<html><body><p>Missing authorization code.</p></body></html>",
      {
        status: 400,
      },
    );
  }

  const oauthState = decodeState(url.searchParams.get("state")) ?? {};

  try {
    await logEvent(supabase, "info", "auth_callback:exchange_start", {
      state: oauthState,
    });

    const tokens = await exchangeCodeForTokens(code);
    const { emailAddress } = await fetchGmailProfile(tokens.access_token);
    const timezoneSetting = await fetchCalendarTimezone(tokens.access_token);

    const { data: existingUser, error: userFetchError } = await supabase
      .from("app_user")
      .select("*")
      .eq("email", emailAddress)
      .maybeSingle();

    if (userFetchError) {
      throw new Error(`Failed to load user: ${userFetchError.message}`);
    }

    const now = new Date().toISOString();

    let userId = existingUser?.id as string | undefined;

    if (!existingUser) {
      const { data: newUser, error: insertError } = await supabase
        .from("app_user")
        .insert({
          email: emailAddress,
          tz: timezoneSetting.value,
          created_at: now,
        })
        .select("*")
        .single();

      if (insertError) {
        throw new Error(`Failed to create user: ${insertError.message}`);
      }

      userId = newUser.id as string;
    } else {
      userId = existingUser.id as string;

      if (existingUser.tz !== timezoneSetting.value) {
        const { error: tzUpdateError } = await supabase
          .from("app_user")
          .update({ tz: timezoneSetting.value })
          .eq("id", userId);

        if (tzUpdateError) {
          throw new Error(
            `Failed to update timezone: ${tzUpdateError.message}`,
          );
        }
      }
    }

    if (!userId) {
      throw new Error("User id is undefined after upsert");
    }

    if (oauthState.partnerUserId) {
      const { error: partnerLinkError } = await supabase
        .from("app_user")
        .update({ partner_user_id: oauthState.partnerUserId })
        .eq("id", userId);

      if (partnerLinkError) {
        throw new Error(
          `Failed to set partner_user_id: ${partnerLinkError.message}`,
        );
      }

      const { error: reciprocalLinkError } = await supabase
        .from("app_user")
        .update({ partner_user_id: userId })
        .eq("id", oauthState.partnerUserId);

      if (reciprocalLinkError) {
        throw new Error(
          `Failed to set reciprocal partner_user_id: ${reciprocalLinkError.message}`,
        );
      }
    }

    const { data: existingCredentials, error: credentialsFetchError } =
      await supabase
        .from("user_credentials")
        .select("*")
        .eq("user_id", userId)
        .maybeSingle();

    if (credentialsFetchError) {
      throw new Error(
        `Failed to fetch credentials: ${credentialsFetchError.message}`,
      );
    }

    const accessTokenPath = `mindspire/${userId}/google/access`;
    const refreshTokenPath = `mindspire/${userId}/google/refresh`;

    const accessTokenVaultId = await upsertSecret(
      supabase,
      accessTokenPath,
      tokens.access_token,
    );

    let refreshTokenVaultId = existingCredentials
      ?.google_refresh_token_vault_id as
        | string
        | undefined;

    if (tokens.refresh_token) {
      refreshTokenVaultId = await upsertSecret(
        supabase,
        refreshTokenPath,
        tokens.refresh_token,
      );
    }

    if (!refreshTokenVaultId) {
      await logEvent(supabase, "warn", "auth_callback:missing_refresh_token", {
        userId,
      });
    }

    const credentialsPayload = {
      id: existingCredentials?.id ?? userId,
      user_id: userId,
      google_access_token_vault_id: accessTokenVaultId,
      google_refresh_token_vault_id: refreshTokenVaultId,
      needs_reauth: !refreshTokenVaultId,
    };

    const { error: credentialsUpsertError } = await supabase
      .from("user_credentials")
      .upsert(credentialsPayload, { onConflict: "id" });

    if (credentialsUpsertError) {
      throw new Error("Failed to upsert credentials");
    }

    await logEvent(supabase, "info", "auth_callback:success", {
      userId,
      email: emailAddress,
    });

    if (oauthState.redirectTo) {
      return redirectResponse(oauthState.redirectTo);
    }

    return htmlResponse(
      "<html><body><h2>Connected!</h2><p>You can close this window now.</p></body></html>",
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    await logEvent(supabase, "error", "auth_callback:failure", {
      error: message,
    });

    return jsonResponse({ error: message }, { status: 500 });
  }
}

if (import.meta.main) {
  Deno.serve(authCallbackHandler);
}
