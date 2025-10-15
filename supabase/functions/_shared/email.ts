import { getOptionalEnv } from "./env.ts";
import { logEvent } from "./logger.ts";
import { getSupabaseAdminClient } from "./supabaseClient.ts";

interface ResendEmailOptions {
  to: string;
  subject: string;
  text: string;
  html?: string;
  fromOverride?: string;
}

function buildHtmlFromText(text: string): string {
  const escaped = text.replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");

  return `<pre style="font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; font-size: 14px; white-space: pre-wrap; line-height: 1.5;">${escaped}</pre>`;
}

export async function sendEmailViaResend(options: ResendEmailOptions) {
  const apiKey = getOptionalEnv("RESEND_API_KEY");
  if (!apiKey) {
    throw new Error("RESEND_API_KEY is not configured");
  }

  const fromAddress = options.fromOverride ??
    getOptionalEnv("RESEND_FROM") ??
    "Mindspire Digest <onboarding@resend.dev>";

  const payload = {
    from: fromAddress,
    to: options.to,
    subject: options.subject,
    text: options.text,
    html: options.html ?? buildHtmlFromText(options.text),
  };

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const body = await response.text();
    await logEvent(getSupabaseAdminClient(), "error", "email:resend_failed", {
      status: response.status,
      body,
    });
    throw new Error(`Resend request failed: ${response.status}`);
  }

  await logEvent(getSupabaseAdminClient(), "info", "email:resend_sent", {
    to: options.to,
  });
}
