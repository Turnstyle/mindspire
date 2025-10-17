import { assertEquals, assertStringIncludes } from "@std/assert";
import { DateTime } from "luxon";
import {
  buildDigestBody,
  formatTimeRange,
  shouldSendDigest,
} from "../send_digest/index.ts";

Deno.test("shouldSendDigest returns true at 7am local", () => {
  const now = DateTime.fromISO("2024-08-10T12:00:00Z"); // 7am CDT (UTC-5)
  const result = shouldSendDigest(now, "America/Chicago");
  assertEquals(result, true);
});

Deno.test("shouldSendDigest returns false off-hour", () => {
  const now = DateTime.fromISO("2024-08-10T13:00:00Z");
  const result = shouldSendDigest(now, "America/Chicago");
  assertEquals(result, false);
});

Deno.test("formatTimeRange formats start/end spans", () => {
  const start = "2024-08-10T15:00:00Z";
  const end = "2024-08-10T16:30:00Z";
  const formatted = formatTimeRange(start, end, "America/New_York");
  assertStringIncludes(formatted, "Sat Aug");
  assertStringIncludes(formatted, "11:00 AM");
  assertStringIncludes(formatted, "12:30 PM EDT");
});

Deno.test("buildDigestBody composes items", () => {
  const user = {
    id: "u1",
    email: "alex@example.com",
    tz: "America/New_York",
    partner_user_id: "u2",
  };
  const parsed = {
    invite_id: "1A",
    title: "Dinner with Sam",
    summary: "Coordinate dinner plans",
    inviter: "Sam",
    inviter_email: "sam@example.com",
    location: "Downtown Bistro",
    proposed_times: [
      {
        start: "2024-08-11T23:00:00Z",
        end: "2024-08-12T00:00:00Z",
        timezone: "America/New_York",
      },
    ],
    follow_up_actions: ["Confirm headcount"],
    confidence: 0.9,
  };

  const invites = [{
    record: {
      id: "invite-1",
      parsed,
      created_at: "2024-08-10T00:00:00Z",
      gmail_thread_id: "thread-1",
      gmail_message_id: "message-1",
      source_subject: "Dinner?",
      user_id: "u2",
      shared_user_ids: ["u1"],
    },
    parsed,
  }];

  const ownerLookup = new Map<string, string>([
    ["u1", "alex@example.com"],
    ["u2", "julie@example.com"],
  ]);

  const digest = buildDigestBody(user, invites, ownerLookup);
  assertStringIncludes(digest.text, "Dinner with Sam");
  assertStringIncludes(digest.text, "Confirm headcount");
  assertStringIncludes(digest.text, "Owner: julie@example.com");
  assertStringIncludes(digest.text, "Email thread:");
  assertEquals(digest.items.length, 1);
  assertEquals(digest.items[0].invite_id, "1A");
  assertEquals(digest.items[0].letter, "A");
  assertEquals(digest.letterMapping.A, "1A");
  assertEquals(digest.letterMapping["INVITE A"], "1A");
});
