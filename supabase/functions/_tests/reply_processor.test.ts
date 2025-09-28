import { assertEquals } from "@std/assert";
import { buildReplyPrompt } from "../reply_processor/index.ts";

Deno.test("buildReplyPrompt includes email text", () => {
  const email = "Sure, let's do it";
  const prompt = buildReplyPrompt(email);
  assertEquals(prompt.includes(email), true);
  assertEquals(prompt.includes("decision"), true);
});
