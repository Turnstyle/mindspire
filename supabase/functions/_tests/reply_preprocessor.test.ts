import { assertEquals, assertMatch } from "@std/assert";
import {
  buildHtmlGuardrailPrompt,
  buildResponseAnalyzerPrompt,
} from "../_shared/prompts.ts";
import { reconstructDigestContext } from "../reply_preprocessor/index.ts";

Deno.test("HTML Guardrail Prompt includes strikethrough detection instructions", () => {
  const html = "<strike>A</strike>";
  const prompt = buildHtmlGuardrailPrompt(html);
  assertMatch(prompt, /strikethrough/i);
  assertMatch(prompt, /<strike>A<\/strike>/);
});

Deno.test("Response Analyzer Prompt includes 100+ examples", () => {
  const prompt = buildResponseAnalyzerPrompt(
    "A & B no",
    { struck_through_items: [], formatting_notes: "" },
    "A. Invite summary",
  );
  const exampleCount = (prompt.match(/- "/g) || []).length;
  assertEquals(exampleCount >= 100, true);
});

Deno.test("reconstructDigestContext preserves stored mapping when invite ids missing", () => {
  const items = [
    { summary: "Alpha summary" },
    { summary: "Beta summary" },
  ];
  const storedMapping = {
    A: "INVITE-123",
    "INVITE B": "INVITE-456",
  };
  const context = reconstructDigestContext(items, storedMapping);
  assertEquals(context.letterToInviteId.A, "INVITE-123");
  assertEquals(context.letterToInviteId["INVITE B"], "INVITE-456");
  assertMatch(context.text, /INVITE-123/);
});
