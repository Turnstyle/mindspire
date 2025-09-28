# **Mindspire MVP: Final Blueprint for Dual-Agent AI Calendar Synchronization**

## **Executive Summary**

This blueprint delivers a 3-day MVP for two AI agents coordinating events via Gmail parsing, calendar checks, and a 7 AM digest (timezone-aware). It uses Supabase (Deno Edge Functions, Realtime, Vault), minimal LangChain.js, Vertex AI (Gemini 2.5 Flash-Lite), and Google APIs (read-only). Features: Realtime/History API polling, HTTP MCP, Codex prompts, Zod validation, Gemini-only reply parsing (ID, decision, notes), error handling, logging, and guardrails (read-only, human approval). No frontend, no scaling.

## **I. Foundational Architecture: Supabase Backend**

### **A. Edge Functions: Deno Runtime**

TypeScript Edge Functions. Test: `supabase functions serve`. Deploy: Supabase CLI/GitHub Actions.

**deno.json:**
```json
{
  "imports": {
    "langchain/core": "npm:@langchain/core@^0.3.0",
    "@langchain/google-genai": "npm:@langchain/google-genai@^0.2.0",
    "@langchain/community": "npm:@langchain/community@^0.3.0",
    "@supabase/supabase-js": "npm:@supabase/supabase-js@^2.45.0",
    "zod": "npm:zod@^4.1.11",
    "jose": "npm:jose@^5.9.3",
    "luxon": "npm:luxon@^3.5.0"
  }
}
```
**Codex Prompt:** "Generate TypeScript/Deno Edge Function with single endpoint for actions (poll_gmail, send_digest, reply_processor, peer_receiver), using deno.json imports, with try-catch and logging."

**Bundle Check:** Run `deno info` to ensure <5MB for fast cold starts.

### **B. Scheduling: pg_cron and Realtime**

Two global pg_cron jobs:
- Poller: `*/5 * * * *` – Triggers Realtime/History API.
- Digester: `*/5 * * * *` – Sweeps users at 7 AM local time (via tz, luxon).

**Digest Job SQL:**
```sql
SELECT cron.schedule(
  'mvp-digest',
  '*/5 * * * *',
  $$
  SELECT net.http_post(
    url:='https://<PROJECT_REF>.supabase.co/functions/v1/send-digest',
    headers:='{"Content-Type": "application/json", "Authorization": "Bearer <ANON_KEY>"}'::jsonb,
    body:='{"action": "sweep"}'::jsonb
  )
  $$
);
```
**Polling:** Realtime with Gmail History API (historyId updates), retry/skip on user failure.

**History API Code Snippet:**
```typescript
async function pollGmailHistory(userId: string, accessToken: string, lastHistoryId: string) {
  const response = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/history?startHistoryId=${lastHistoryId}&labelId=INBOX`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  if (!response.ok) throw new Error("History API failed");
  const data = await response.json();
  // Process new messages from data.history
  if (data.history) {
    for (const history of data.history) {
      for (const message of history.messages) {
        // Fetch and parse message
      }
    }
  }
  return data.historyId; // Update lastHistoryId in DB
}
```
**Codex Prompt:** "Write SQL for pg_cron digest sweep; add TypeScript for Gmail History API polling, timezone-aware digest with luxon, and retry/skip error handling."

### **C. Secure Credentials: Vault**

Store OAuth tokens in Vault. Schema:
```sql
CREATE TABLE app_user (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT UNIQUE NOT NULL,
  partner_user_id UUID REFERENCES app_user(id),
  tz TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE TABLE user_credentials (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  google_access_token_vault_id UUID NOT NULL,
  google_refresh_token_vault_id UUID NOT NULL,
  needs_reauth BOOLEAN DEFAULT FALSE
);
CREATE TABLE invite (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  gmail_thread_id TEXT NOT NULL,
  gmail_message_id TEXT NOT NULL,
  source_subject TEXT,
  parsed JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', -- pending/approved/declined
  notes TEXT DEFAULT NULL, -- e.g., "get pizza by 5pm"
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE TABLE digest (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  sent_at TIMESTAMPTZ NOT NULL,
  token TEXT NOT NULL,
  items JSONB NOT NULL
);
```
**OAuth Flow:** User1 signs up, completes OAuth, gets shareable link. User2 clicks, completes OAuth, sets partner_user_id. Fetch tz via Calendar settings.readonly.

**Codex Prompt:** "Generate TypeScript Edge Function for Google OAuth callback, store tokens in Vault, set partner_user_id, fetch timezone, with error logging."

### **D. MCP Lite: HTTP Endpoints**

POST with JWT. Payload: `{type: "invite_decision", id: "1A", decision: "yes", notes: "pizza by 5pm"}`. Thread replies via gmail_thread_id, parse with Gemini 2.5 Flash-Lite.

**Codex Prompt:** "Create Deno Edge Function for HTTP POST sender/receiver with Supabase JWT, Gmail threading, Gemini 2.5 Flash-Lite reply parsing (ID, decision, notes), and error logging."

## **II. Intelligence Core: LangChain.js and Gemini**

### **A. EventProcessingChain**

Minimal LangChain Runnables:
1. Input: Email text (History API).
2. Gemini Parse: JSON (title, proposer, times, location).
3. Zod Validate: LLM/API outputs; retry on fail.
4. Calendar Check: Freebusy query.
5. Digest Format: Summary (e.g., “1A: Julie dinner Tue—free?”).
6. Output: Digest text + data.

**Codex Prompt:** "Build TypeScript/Deno LangChain.js chain: Email → Gemini parse → Zod validate → Calendar freebusy → Digest, with try-catch and logging."

### **B. Gemini via Vertex AI**

Service account JSON (Vault). Few-shot prompt (2-3 examples). Use for event parsing and reply parsing (extract ID, decision: yes/no/maybe, notes from nuanced text).

**Reply Prompt Example:** "From this email reply, extract invite ID (e.g., 1A), decision (yes, no, or maybe), and summarize notes (e.g., logistics). Return JSON: {id: string, decision: string, notes: string}."

**Codex Prompt:** "Generate Deno code for Gemini 2.5 Flash-Lite via Vertex AI with few-shot prompt for event/reply parsing (ID, decision, notes), jose JWT fallback, and error logging."

## **III. Data and Communication Protocols**

### **A. Google APIs and OAuth**

Scopes: `gmail.readonly`, `calendar.readonly`, `calendar.settings.readonly`. History API for polling, freebusy for checks. Handle `invalid_grant` with `needs_reauth` and re-auth email.

**Codex Prompt:** "Write TypeScript function to refresh OAuth token via fetch or jose, catch invalid_grant, update DB, log errors."

### **B. MCP Lite**

JSON POSTs with extracted data (ID, decision, notes), JWT-secured, threaded via Gmail.

**Codex Prompt:** "Implement fetch-based MCP-like JSON sender/receiver with JWT, Gmail threading, Gemini parsing, and logging."

## **IV. Pitfalls and Improvements**

### **A. Bug-Proofing**

- OAuth: Re-auth email on `invalid_grant`.
- Rate Limits: Backoff for 429s.
- LLM: Zod for LLM/API outputs; log failures.
- Bundle: Check <5MB with `deno info`.
- 546 Error: Circuit breakers.
- Timezone: Use luxon for edge cases.
- Logging: Structured logs for all API calls.
- Reply Parsing: Gemini primary for nuanced extraction (ID, decision, notes).

### **B. 3-Day Workflow**

- **Day 1:** Schema, Vault, OAuth flow.
- **Day 2:** Polling, parsing, digest logic.
- **Day 3:** Reply processor (Gemini parsing), MCP, deploy.

**Codex Setup (.cursor/index.mdc):**
```markdown
Mindspire MVP:
- Supabase Edge Functions (Deno)
- Minimal LangChain.js
- Google APIs (read-only)
Constraints:
- Strict TypeScript
- Async/await, error handling, logging
- Bundle <5MB
- Zod for LLM/API outputs
- Gemini for reply parsing (ID, decision, notes)
```

### **C. Deferrals**

No RAG, PII redaction, queues, or nuanced statuses beyond yes/no/maybe + notes for MVP.

## **V. Conclusion**

This 3-day MVP uses Codex-driven code, Realtime/History API polling, timezone-aware digests, Gemini reply parsing for nuanced responses, and robust error handling/logging. Deploy to Supabase, test with two users.

#### **Key Works Cited**
1. Supabase Docs: Edge Functions, Vault, Realtime.
2. LangChain.js Docs: Runnables, Google Integrations.
3. Google APIs: Gmail History, Calendar Freebusy, Settings.
4. Luxon Docs: Timezone Handling.