import type { SupabaseClient } from "@supabase/supabase-js";
import { getRequiredEnv } from "./env.ts";

const TABLE = "user_token";
const KEY = "TOKEN_ENCRYPTION_KEY";
const encoder = new TextEncoder();
const decoder = new TextDecoder();
let cachedKey: CryptoKey | null = null;

function base64Encode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function base64Decode(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

async function getCryptoKey(): Promise<CryptoKey> {
  if (cachedKey) return cachedKey;
  const secret = getRequiredEnv(KEY);
  const keyBytes = encoder.encode(secret);
  if (keyBytes.length !== 32) {
    throw new Error(
      `${KEY} must be 32 characters (found ${keyBytes.length}).`,
    );
  }

  cachedKey = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    "AES-GCM",
    false,
    ["encrypt", "decrypt"],
  );
  return cachedKey;
}

async function encrypt(value: string): Promise<string> {
  const key = await getCryptoKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = encoder.encode(value);
  const cipherBuffer = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, data);
  const cipherBytes = new Uint8Array(cipherBuffer);
  const combined = new Uint8Array(iv.length + cipherBytes.length);
  combined.set(iv, 0);
  combined.set(cipherBytes, iv.length);
  return base64Encode(combined);
}

async function decrypt(value: string | null): Promise<string | null> {
  if (!value) return null;
  const key = await getCryptoKey();
  const combined = base64Decode(value);
  const iv = combined.slice(0, 12);
  const ciphertext = combined.slice(12);
  const plainBuffer = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
  return decoder.decode(plainBuffer);
}

export interface TokenPair {
  accessToken: string | null;
  refreshToken: string | null;
}

async function upsertRow(
  client: SupabaseClient,
  userId: string,
  tokens: { accessToken?: string | null; refreshToken?: string | null },
): Promise<void> {
  const payload: Record<string, unknown> = { user_id: userId };

  if (tokens.accessToken !== undefined) {
    payload.access_token = tokens.accessToken ? await encrypt(tokens.accessToken) : null;
  }

  if (tokens.refreshToken !== undefined) {
    payload.refresh_token = tokens.refreshToken
      ? await encrypt(tokens.refreshToken)
      : null;
  }

  const { error } = await client.from(TABLE).upsert(payload, {
    onConflict: "user_id",
  });

  if (error) {
    throw new Error(`Failed to persist tokens: ${error.message}`);
  }
}

export async function storeTokenPair(
  client: SupabaseClient,
  userId: string,
  tokens: { accessToken: string; refreshToken: string | null },
): Promise<void> {
  await upsertRow(client, userId, tokens);
}

export async function storeAccessToken(
  client: SupabaseClient,
  userId: string,
  accessToken: string,
): Promise<void> {
  await upsertRow(client, userId, { accessToken });
}

export async function storeRefreshToken(
  client: SupabaseClient,
  userId: string,
  refreshToken: string | null,
): Promise<void> {
  await upsertRow(client, userId, { refreshToken });
}

export async function getTokenPair(
  client: SupabaseClient,
  userId: string,
): Promise<TokenPair> {
  const { data, error } = await client
    .from(TABLE)
    .select("access_token, refresh_token")
    .eq("user_id", userId)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to load tokens: ${error.message}`);
  }

  const accessToken = await decrypt(data?.access_token ?? null);
  const refreshToken = await decrypt(data?.refresh_token ?? null);
  return { accessToken, refreshToken };
}
