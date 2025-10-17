import { assertEquals } from "@std/assert";
import { buildInvitePrompt } from "../poll_gmail/index.ts";
import {
  decodeBase64Url,
  extractPlainText,
} from "../_shared/gmail.ts";

Deno.test("decodeBase64Url decodes url-safe base64", () => {
  const original = "Hello, Mindspire!";
  const encoded = "SGVsbG8sIE1pbmRzcGlyZSE";
  assertEquals(decodeBase64Url(encoded), original);
});

Deno.test("extractPlainText prefers text/plain part", () => {
  const payload = {
    mimeType: "multipart/alternative",
    parts: [
      {
        mimeType: "text/html",
        body: { data: "PGRpdj5IZWxsbzwvZGl2Pi" },
      },
      {
        mimeType: "text/plain",
        body: { data: "SGVsbG8gd29ybGQ=" },
      },
    ],
  } as Parameters<typeof extractPlainText>[0];

  const text = extractPlainText(payload);
  assertEquals(text.trim(), "Hello world");
});

Deno.test("buildInvitePrompt embeds user email", () => {
  const prompt = buildInvitePrompt("Let's meet tomorrow", "alex@example.com");
  assertEquals(prompt.includes("alex@example.com"), true);
  assertEquals(prompt.includes("Let's meet tomorrow"), true);
});
