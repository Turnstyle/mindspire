import { importPKCS8, SignJWT } from "jose";
import type { KeyLike } from "jose";
import { z } from "zod";
import { getOptionalEnv, getRequiredEnv } from "./env.ts";

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

const RefreshSchema = z.object({
  access_token: z.string(),
  expires_in: z.number(),
  scope: z.string().optional(),
  token_type: z.string(),
  id_token: z.string().optional(),
});

const ServiceAccountTokenSchema = z.object({
  access_token: z.string(),
  expires_in: z.number(),
  token_type: z.string(),
});

const GeminiResponseSchema = z.object({
  candidates: z.array(z.object({
    content: z.object({
      parts: z.array(z.object({ text: z.string().min(1) })).min(1),
    }),
  })).min(1),
});

let cachedPrivateKey: KeyLike | null = null;

async function getPrivateKey(): Promise<KeyLike> {
  if (cachedPrivateKey) return cachedPrivateKey;

  const privateKeyPem = getRequiredEnv("GOOGLE_PRIVATE_KEY").replaceAll(
    "\\n",
    "\n",
  );
  cachedPrivateKey = await importPKCS8(privateKeyPem, "RS256");
  return cachedPrivateKey;
}

export async function refreshAccessToken(
  refreshToken: string,
): Promise<z.infer<typeof RefreshSchema>> {
  const body = new URLSearchParams({
    refresh_token: refreshToken,
    client_id: getRequiredEnv("GOOGLE_CLIENT_ID"),
    client_secret: getRequiredEnv("GOOGLE_CLIENT_SECRET"),
    grant_type: "refresh_token",
  });

  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to refresh token: ${response.status} ${errorText}`);
  }

  const json = await response.json();
  return RefreshSchema.parse(json);
}

async function requestServiceAccountToken(scopes: string[]): Promise<string> {
  const serviceAccountEmail = getRequiredEnv("GOOGLE_SERVICE_ACCOUNT_EMAIL");
  const now = Math.floor(Date.now() / 1000);

  const jwt = await new SignJWT({ scope: scopes.join(" ") })
    .setProtectedHeader({ alg: "RS256", typ: "JWT" })
    .setIssuer(serviceAccountEmail)
    .setSubject(serviceAccountEmail)
    .setAudience(GOOGLE_TOKEN_URL)
    .setExpirationTime(now + 3600)
    .setIssuedAt(now)
    .sign(await getPrivateKey());

  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion: jwt,
  });

  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `Failed to obtain service account token: ${response.status} ${errorText}`,
    );
  }

  const json = await response.json();
  const parsed = ServiceAccountTokenSchema.parse(json);
  return parsed.access_token;
}

interface GeminiOptions {
  model?: string;
  location?: string;
  projectId?: string;
  temperature?: number;
  maxOutputTokens?: number;
}

export async function callGeminiJson<T>(
  prompt: string,
  schema: z.ZodSchema<T>,
  options: GeminiOptions = {},
): Promise<T> {
  const projectId = options.projectId ?? getRequiredEnv("GOOGLE_PROJECT_ID");
  const location = options.location ??
    getOptionalEnv("GOOGLE_VERTEX_LOCATION", "us-central1");
  const model = options.model ?? getOptionalEnv(
    "GOOGLE_GEMINI_MODEL",
    "gemini-2.5-flash-lite",
  );

  const accessToken = await requestServiceAccountToken([
    "https://www.googleapis.com/auth/cloud-platform",
  ]);

  const url =
    `https://${location}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${location}/publishers/google/models/${model}:generateContent`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      contents: [
        {
          role: "user",
          parts: [{ text: prompt }],
        },
      ],
      generationConfig: {
        temperature: options.temperature ?? 0,
        maxOutputTokens: options.maxOutputTokens ?? 1024,
        responseMimeType: "application/json",
      },
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Gemini request failed: ${response.status} ${errorText}`);
  }

  const json = await response.json();
  const parsed = GeminiResponseSchema.parse(json);
  const text = parsed.candidates[0]?.content.parts[0]?.text;

  if (!text) {
    throw new Error("Gemini response did not contain text content");
  }

  try {
    const raw = JSON.parse(text);
    return schema.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown";
    throw new Error(`Failed to parse Gemini JSON: ${message}`);
  }
}
