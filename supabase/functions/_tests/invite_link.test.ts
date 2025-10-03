import { assertEquals, assertStringIncludes } from "@std/assert";
import { buildInviteLink } from "../invite_link/index.ts";

function withEnv(vars: Record<string, string>, fn: () => void) {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(vars)) {
    previous.set(key, Deno.env.get(key));
    Deno.env.set(key, value);
  }

  try {
    fn();
  } finally {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) {
        Deno.env.delete(key);
      } else {
        Deno.env.set(key, value);
      }
    }
  }
}

Deno.test("buildInviteLink encodes partner state", () => {
  withEnv({
    GOOGLE_CLIENT_ID: "client-123",
    SUPABASE_URL: "https://example.supabase.co",
  }, () => {
    const url = buildInviteLink("user-abc", {
      inviterEmail: "alex@example.com",
    });

    assertStringIncludes(url, "https://accounts.google.com/o/oauth2/v2/auth");

    const parsed = new URL(url);
    assertEquals(parsed.searchParams.get("client_id"), "client-123");
    assertEquals(
      parsed.searchParams.get("redirect_uri"),
      "https://example.supabase.co/functions/v1/auth_callback",
    );

    const stateParam = parsed.searchParams.get("state");
    if (!stateParam) throw new Error("state missing");
    const state = JSON.parse(decodeURIComponent(stateParam));

    assertEquals(state.partnerUserId, "user-abc");
    assertEquals(state.inviterEmail, "alex@example.com");
  });
});

Deno.test("buildInviteLink uses custom redirect when provided", () => {
  withEnv({
    GOOGLE_CLIENT_ID: "client-123",
    SUPABASE_URL: "https://example.supabase.co",
    GOOGLE_REDIRECT_URI: "https://custom.example.com/oauth",
    GOOGLE_OAUTH_SCOPES: "scope-a scope-b",
  }, () => {
    const url = buildInviteLink("user-xyz", { redirectTo: "https://return.example.com" });
    const parsed = new URL(url);

    assertEquals(parsed.searchParams.get("redirect_uri"), "https://custom.example.com/oauth");
    assertEquals(parsed.searchParams.get("scope"), "scope-a scope-b");

    const stateParam = parsed.searchParams.get("state");
    if (!stateParam) throw new Error("state missing");
    const state = JSON.parse(decodeURIComponent(stateParam));
    assertEquals(state.redirectTo, "https://return.example.com");
  });
});
