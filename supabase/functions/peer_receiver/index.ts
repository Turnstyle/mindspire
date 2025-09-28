import { jwtVerify } from "jose";
import { z } from "zod";
import { jsonResponse } from "../_shared/http.ts";
import { getSupabaseAdminClient } from "../_shared/supabaseClient.ts";
import { logEvent } from "../_shared/logger.ts";
import { getRequiredEnv } from "../_shared/env.ts";

const BodySchema = z.object({
  type: z.string(),
  invite_id: z.string().optional(),
  decision: z.string().optional(),
  notes: z.string().optional(),
  payload: z.record(z.unknown()).optional(),
});

async function verifyJwt(token: string) {
  const secret = getRequiredEnv("PEER_JWT_SECRET");
  const encoder = new TextEncoder();
  const { payload } = await jwtVerify(token, encoder.encode(secret));
  return payload;
}

Deno.serve(async (req) => {
  const supabase = getSupabaseAdminClient();

  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, { status: 405 });
  }

  const authHeader = req.headers.get("authorization") ??
    req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    await logEvent(supabase, "warn", "peer_receiver:missing_token");
    return jsonResponse({ error: "Unauthorized" }, { status: 401 });
  }

  const token = authHeader.slice("Bearer ".length).trim();

  let jwtPayload: Record<string, unknown>;
  try {
    jwtPayload = await verifyJwt(token);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await logEvent(supabase, "warn", "peer_receiver:token_invalid", {
      error: message,
    });
    return jsonResponse({ error: "Unauthorized" }, { status: 401 });
  }

  let body: z.infer<typeof BodySchema>;
  try {
    const json = await req.json();
    body = BodySchema.parse(json);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await logEvent(supabase, "warn", "peer_receiver:invalid_body", {
      error: message,
    });
    return jsonResponse({ error: "Invalid body" }, { status: 400 });
  }

  await logEvent(supabase, "info", "peer_receiver:received", {
    body,
    jwtPayload,
  });

  return jsonResponse({ status: "ok" });
});
