import type { SupabaseClient } from "@supabase/supabase-js";

export type LogLevel = "debug" | "info" | "warn" | "error";

interface LogPayload {
  level: LogLevel;
  message: string;
  context?: Record<string, unknown>;
}

export async function logEvent(
  client: SupabaseClient,
  level: LogLevel,
  message: string,
  context?: Record<string, unknown>,
): Promise<void> {
  try {
    await client.from("logs").insert({
      level,
      message,
      context,
      created_at: new Date().toISOString(),
    });
  } catch (error) {
    console.error("[logEvent] fallback", { level, message, context, error });
  }
}

export function buildLogContext(
  payload: LogPayload,
  extras?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    level: payload.level,
    message: payload.message,
    ...(payload.context ?? {}),
    ...(extras ?? {}),
  };
}
