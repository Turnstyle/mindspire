# Mindspire MVP Status — 13 Oct 2025

## Executive Summary

Mindspire’s Supabase-centric backend continues to power Gmail invite extraction, digest delivery, and reply reconciliation. Since yesterday we hardened the invite onboarding path with explicit CORS handling, verified the endpoint as public, and preserved the new reauth alerting. Focus shifts to operational signals and LLM output safeguards now that onboarding is stable again.

## Current Implementation Snapshot

### Infrastructure
- Supabase project (`hzrmmunlgcjghjrjouxa`) with core tables (`app_user`, `user_credentials`, `invite`, `digest`, `user_token`, `logs`) alongside pg_cron and pg_net extensions. (Vault helpers remain available but unused for now.)
- Supabase Edge Functions (Deno 2.x) with shared helpers for env access, logging, Supabase admin client, Vault, token storage, Gemini utilities, and the new `_shared/cors.ts` constants.
- Google Cloud project `mindspire-473507` (Vertex AI + Gmail/Calendar APIs) providing Gemini parsing and OAuth credentials.

### Edge Functions
- `auth_callback`: Completes OAuth, stores encrypted tokens (`user_token`), syncs timezone, manages partner linkage.
- `invite_link`: Generates invite URLs, now replies to `OPTIONS`, injects CORS headers on HTML/JSON responses, and is configured (`verify_jwt=false`) for public access.
- `poll_gmail`: Polls Gmail history with pagination, refreshes/rotates tokens, flags `needs_reauth`, and emits Slack alerts when reauth is required.
- `reply_processor`: Uses Gemini to parse human replies into invite decisions, updates invites, and pushes webhook events to Peer.
- `send_digest`: Sends 7 AM digests via Slack/SMTP, records digest rows, and skips users processed earlier the same day.
- `peer_receiver`: Validates Peer JWT payloads, logs context, returns simple acknowledgements.

### Shared Modules & Tests
- `_shared/tokenStore.ts` encrypts OAuth tokens with AES-GCM before persisting in `user_token`.
- `_shared/google.ts` encapsulates refresh/service-account token flows and Gemini schema validation with Zod.
- `_tests/*` covers invite link generation, Gmail parsing helpers, reply prompt, and digest formatting utilities (`deno test --allow-env`).

## Recent Updates (12 → 13 Oct)
1. Added `_shared/cors.ts` and wired invite_link to respond to preflight requests while attaching permissive headers on every response.
2. Set `[functions.invite_link] verify_jwt = false` in `supabase/config.toml`, eliminating the stray 401s Safari users observed.
3. Confirmed the reauth notification pipeline (Slack webhook fallback) and pagination changes remain green via `deno test --allow-env`.

## Safari Invite-Link Incident Recap
- **Symptoms:** Julie previously saw raw HTML markup and `{ "code": 401, "message": "Missing authorization header" }` while opening the invite link on iOS Safari.
- **Root Causes (per Supabase docs & Perplexity search):** default JWT verification for Edge Functions, missing CORS preflight handling, and browser quirks displaying source when `Content-Type`/headers are absent.
- **Fixes Implemented:** added CORS handling, ensured `htmlResponse` is served with CORS headers, and disabled JWT verification for this public endpoint. Query string format remains `...?format=html` without extra `?`.


## References
- Supabase docs consulted: `functions/cors`, `functions/function-configuration`, `functions/status-codes` (JWT requirements & CORS guidance).
- Prior notes replaced by this status: `Mindspire_MVP_Status_12-Oct-2025.markdown`, `Mindspire - report from Perplexity 12-Oct-2025.md`.
