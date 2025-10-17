import { z } from "zod";
import { jsonResponse } from "../_shared/http.ts";
import { callGeminiJson } from "../_shared/google.ts";
import {
  buildHtmlGuardrailPrompt,
  buildResponseAnalyzerPrompt,
} from "../_shared/prompts.ts";
import { logEvent } from "../_shared/logger.ts";
import { getSupabaseAdminClient } from "../_shared/supabaseClient.ts";
import { getRequiredEnv } from "../_shared/env.ts";

const InputSchema = z.object({
  userId: z.string().uuid(),
  emailText: z.string(),
  emailHtml: z.string().optional(),
  originalDigest: z.string().optional(),
  gmailMessageId: z.string().optional(),
  gmailThreadId: z.string().optional(),
  dryRun: z.boolean().optional(),
});

const HtmlGuardrailSchema = z.object({
  struck_through_items: z.array(z.string()),
  formatting_notes: z.string(),
});

const ResponseDecisionSchema = z.object({
  invite_id: z.string().min(1),
  decision: z.enum(["yes", "no", "maybe"]),
  notes: z.string().optional(),
  confidence: z.number().min(0).max(1).optional(),
});

const ResponseDecisionArraySchema = z.array(ResponseDecisionSchema);

const DEFAULT_GUARDRAIL = {
  struck_through_items: [] as string[],
  formatting_notes: "",
};

type AnalyzerDecision = z.infer<typeof ResponseDecisionSchema> & {
  resolved_invite_id?: string;
  raw_reference?: string;
};

export async function replyPreprocessorHandler(req: Request): Promise<Response> {
  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, { status: 405 });
  }

  const supabase = getSupabaseAdminClient();

  let input: z.infer<typeof InputSchema>;
  try {
    input = InputSchema.parse(await req.json());
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await logEvent(supabase, "warn", "reply_preprocessor:invalid_input", {
      error: message,
    });
    return jsonResponse({ error: "Invalid input" }, { status: 400 });
  }

  await logEvent(supabase, "info", "reply_preprocessor:start", {
    userId: input.userId,
    hasHtml: Boolean(input.emailHtml?.trim()),
    dryRun: input.dryRun ?? false,
  });

  let guardrailFindings: z.infer<typeof HtmlGuardrailSchema> = {
    ...DEFAULT_GUARDRAIL,
  };

  if (input.emailHtml && input.emailHtml.trim()) {
    try {
      const guardrailPrompt = buildHtmlGuardrailPrompt(input.emailHtml);
      guardrailFindings = await callGeminiJson(
        guardrailPrompt,
        HtmlGuardrailSchema,
        { maxOutputTokens: 512 },
      );
      await logEvent(supabase, "info", "reply_preprocessor:guardrail_complete", {
        userId: input.userId,
        struck: guardrailFindings.struck_through_items,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await logEvent(supabase, "warn", "reply_preprocessor:guardrail_failed", {
        userId: input.userId,
        error: message,
      });
      guardrailFindings = { ...DEFAULT_GUARDRAIL };
    }
  }

  let digestContext = input.originalDigest ?? "";
  let letterMapping: Record<string, string> = {};
  if (!digestContext) {
    try {
      const digestResult = await supabase
        .from("digest")
        .select("items, letter_mapping")
        .eq("user_id", input.userId)
        .order("sent_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      let digestData = digestResult.data as
        | { items?: unknown; letter_mapping?: Record<string, unknown> | null }
        | null;

      if (digestResult.error) {
        const missingLetterMapping = typeof digestResult.error.message === "string" &&
          digestResult.error.message.includes("letter_mapping");

        if (missingLetterMapping) {
          const fallback = await supabase
            .from("digest")
            .select("items")
            .eq("user_id", input.userId)
            .order("sent_at", { ascending: false })
            .limit(1)
            .maybeSingle();

          if (fallback.error) {
            await logEvent(supabase, "error", "reply_preprocessor:digest_lookup_failed", {
              userId: input.userId,
              error: fallback.error.message,
            });
          } else {
            digestData = fallback.data
              ? { items: fallback.data.items, letter_mapping: {} }
              : null;
          }
        } else {
          await logEvent(supabase, "error", "reply_preprocessor:digest_lookup_failed", {
            userId: input.userId,
            error: digestResult.error.message,
          });
        }
      }

      if (digestData) {
        const digestDetails = reconstructDigestContext(
          digestData.items,
          digestData.letter_mapping ?? {},
        );
        digestContext = digestDetails.text;
        letterMapping = digestDetails.letterToInviteId;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await logEvent(supabase, "error", "reply_preprocessor:digest_lookup_error", {
        userId: input.userId,
        error: message,
      });
    }
  }

  let decisions: AnalyzerDecision[] = [];
  try {
    const analyzerPrompt = buildResponseAnalyzerPrompt(
      input.emailText,
      guardrailFindings,
      digestContext,
    );
    const rawDecisions = await callGeminiJson(
      analyzerPrompt,
      ResponseDecisionArraySchema,
      { maxOutputTokens: 2048 },
    );
    decisions = rawDecisions.map((decision) => {
      const resolvedInviteId = resolveInviteId(
        decision.invite_id,
        letterMapping,
      );
      const rawConfidence = typeof decision.confidence === "number"
        ? decision.confidence
        : 0.99;
      const clamped = Math.max(0, Math.min(1, rawConfidence));
      return {
        ...decision,
        raw_reference: decision.invite_id,
        resolved_invite_id: resolvedInviteId,
        confidence: parseFloat(clamped.toFixed(2)),
      } as AnalyzerDecision;
    });
    await logEvent(supabase, "info", "reply_preprocessor:analysis_complete", {
      userId: input.userId,
      decisionCount: decisions.length,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await logEvent(supabase, "error", "reply_preprocessor:analysis_failed", {
      userId: input.userId,
      error: message,
    });
    return jsonResponse({ error: "Failed to analyze response" }, { status: 502 });
  }

  if (input.dryRun) {
    return jsonResponse({
      message: "Dry run",
      guardrailFindings,
      decisions,
    });
  }

  const supabaseUrl = getRequiredEnv("SUPABASE_URL");
  const authHeader =
    req.headers.get("Authorization") ??
    `Bearer ${getRequiredEnv("SUPABASE_SERVICE_ROLE_KEY")}`;

  const results: Array<Record<string, unknown>> = [];

  for (const decision of decisions) {
    try {
      const resolvedInviteId = decision.resolved_invite_id ?? decision.invite_id;
      const originalReference = decision.raw_reference ?? decision.invite_id;
      const forwardPayload: Record<string, unknown> = {
        userId: input.userId,
        emailText: formatDecisionText(decision, resolvedInviteId, originalReference),
        gmailMessageId: input.gmailMessageId ?? null,
        gmailThreadId: input.gmailThreadId ?? null,
        dryRun: false,
        preprocessedInviteId: resolvedInviteId,
        preprocessedDecision: decision.decision,
      };

      forwardPayload.preprocessorConfidence = decision.confidence;
      const htmlFormattingDetected = Boolean(
        guardrailFindings.struck_through_items.length > 0 ||
          guardrailFindings.formatting_notes.trim().length > 0,
      );
      forwardPayload.htmlFormattingDetected = htmlFormattingDetected;
      if (decision.notes && decision.notes.trim()) {
        forwardPayload.preprocessedNotes = decision.notes.trim();
      }
      if (originalReference !== resolvedInviteId) {
        forwardPayload.preprocessedOriginalRef = originalReference;
      }

      const response = await fetch(
        `${supabaseUrl}/functions/v1/reply_processor`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: authHeader,
          },
          body: JSON.stringify(forwardPayload),
        },
      );

      const payload = await safeJson(response);
      const payloadRecord = (payload && typeof payload === "object")
        ? payload as Record<string, unknown>
        : null;

      if (!response.ok) {
        const payloadError = payloadRecord && typeof payloadRecord.error === "string"
          ? payloadRecord.error
          : null;
        results.push({
          invite_id: decision.invite_id,
          error: payloadError ?? `reply_processor: HTTP ${response.status}`,
        });
        continue;
      }

      results.push({
        invite_id: decision.invite_id,
        result: payloadRecord ?? payload,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      results.push({
        invite_id: decision.invite_id,
        error: message,
      });
    }
  }

  return jsonResponse({
    message: "Preprocessing complete",
    decisionsProcessed: decisions.length,
    guardrailFindings,
    results,
  });
}

function formatDecisionText(
  decision: AnalyzerDecision,
  resolvedInviteId: string,
  originalReference: string,
): string {
  const lines = [
    `Invite ${resolvedInviteId}`,
    `Decision: ${decision.decision}`,
  ];

  if (decision.notes && decision.notes.trim()) {
    lines.push(`Notes: ${decision.notes.trim()}`);
  }

  lines.push(`Confidence: ${decision.confidence?.toFixed(2) ?? "0.99"}`);

  if (originalReference !== resolvedInviteId) {
    lines.push(`Original Reference: ${originalReference}`);
  }

  return lines.join("\n");
}

export function reconstructDigestContext(
  items: unknown,
  storedMapping: Record<string, unknown>,
): { text: string; letterToInviteId: Record<string, string> } {
  const normalizedStored = new Map<string, string>();
  if (storedMapping && typeof storedMapping === "object" && !Array.isArray(storedMapping)) {
    for (const [rawKey, rawValue] of Object.entries(storedMapping)) {
      if (typeof rawKey === "string" && typeof rawValue === "string") {
        const key = rawKey.trim().toUpperCase();
        const value = rawValue.trim();
        if (key && value) {
          normalizedStored.set(key, value);
        }
      }
    }
  }

  const lines: string[] = [];
  const letterMap: Record<string, string> = {};

  if (!Array.isArray(items)) {
    normalizedStored.forEach((value, key) => {
      letterMap[key] = value;
    });
    return { text: "", letterToInviteId: letterMap };
  }

  items.forEach((item, index) => {
    const letter = String.fromCharCode(65 + index);
    const letterKey = letter.toUpperCase();
    const inviteKey = `INVITE ${letterKey}`;

    if (item && typeof item === "object") {
      const record = item as Record<string, unknown>;
      const rawInviteId = typeof record.invite_id === "string"
        ? record.invite_id.trim()
        : "";
      const storedInvite = normalizedStored.get(letterKey) ??
        normalizedStored.get(inviteKey) ??
        "";
      const inviteId = rawInviteId || storedInvite || letterKey;
      const summary = typeof record.summary === "string"
        ? record.summary
        : JSON.stringify(record);

      letterMap[letterKey] = inviteId;
      letterMap[inviteKey] = inviteId;
      lines.push(`${letter}. ${inviteId}: ${summary}`);
    } else {
      const storedInvite = normalizedStored.get(letterKey) ??
        normalizedStored.get(inviteKey) ??
        letterKey;
      letterMap[letterKey] = storedInvite;
      letterMap[inviteKey] = storedInvite;
      lines.push(`${letter}. ${String(item)}`);
    }
  });

  normalizedStored.forEach((value, key) => {
    if (!letterMap[key]) {
      letterMap[key] = value;
    }
  });

  return {
    text: lines.join("\n\n"),
    letterToInviteId: letterMap,
  };
}

function resolveInviteId(
  rawInviteId: string,
  letterMap: Record<string, string>,
): string {
  const trimmed = rawInviteId.trim();
  if (!trimmed) return trimmed;

  const direct = letterMap[trimmed.toUpperCase()];
  if (direct) return direct;

  const singleLetterMatch = trimmed.match(/^[A-Za-z]$/);
  if (singleLetterMatch) {
    const letter = singleLetterMatch[0].toUpperCase();
    return letterMap[letter] ?? trimmed;
  }

  const invitePrefixMatch = trimmed.match(/^Invite\s+([A-Za-z])$/i);
  if (invitePrefixMatch) {
    const letter = invitePrefixMatch[1].toUpperCase();
    return letterMap[letter] ?? trimmed;
  }

  return trimmed;
}

async function safeJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch (_error) {
    return null;
  }
}

if (import.meta.main) {
  Deno.serve(replyPreprocessorHandler);
}
