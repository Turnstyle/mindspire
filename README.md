# Mindspire

Mindspire is a Supabase-backed MVP that coordinates two AI calendar agents.

## Supabase Edge Functions

- `auth_callback` – Handles Google OAuth callback, stores tokens in Vault, links
  peers, and logs results.
- `poll_gmail` – Polls Gmail History, parses invites with Gemini, and persists
  pending invites.
- `send_digest` – Sends a 7 AM local digest summarizing pending invites.
- `reply_processor` – Parses human replies with Gemini, updates invite
  decisions, and notifies peers.
- `peer_receiver` – Lightweight MCP-style endpoint for peer notifications
  secured with JWT.

Shared utilities live in `supabase/functions/_shared`.

## Environment

Create a `.env` file (not committed) with the following keys:

```
SUPABASE_URL=
SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
GOOGLE_API_KEY=
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_SERVICE_ACCOUNT_EMAIL=
GOOGLE_PRIVATE_KEY=
GOOGLE_PROJECT_ID=
GOOGLE_VERTEX_LOCATION=us-central1
GOOGLE_GEMINI_MODEL=gemini-2.5-flash-lite
DIGEST_WEBHOOK_URL=... (temporary webhook or logging sink)
PEER_WEBHOOK_URL=...
PEER_JWT_SECRET=...
```

## Database Setup

Run the SQL in `supabase/migrations/20240928_add_logs_and_indexes.sql` after
creating the core tables:

```sql
ALTER TABLE user_credentials ADD COLUMN IF NOT EXISTS last_history_id TEXT;
CREATE TABLE IF NOT EXISTS logs (...);
CREATE INDEX ...;
```

Ensure the Supabase project has a Vault and the RPC functions
`vault_create_secret`, `vault_update_secret`, and `vault_get_secret` exposed to
the service role.

## Local Development

1. Install [Supabase CLI](https://supabase.com/docs/guides/cli) and Docker
   Desktop.
2. Run `supabase start` within the repository.
3. Start functions locally:
   `supabase functions serve --env-file .env --no-verify-jwt`.
4. Invoke a function, e.g.:
   ```bash
   curl -X POST http://localhost:54321/functions/v1/poll_gmail \
     -H 'Content-Type: application/json' \
     -d '{"dryRun": true}'
   ```

## Testing

Unit tests exercise helper utilities and run via Deno:

```bash
deno test --config supabase/functions/deno.json supabase/functions/_tests
```

The sandbox blocks npm/jsr downloads, so run tests on a machine with open
network access.

## Deployment

Deploy edge functions with:

```bash
supabase functions deploy auth_callback poll_gmail send_digest reply_processor peer_receiver
```

Double-check Supabase project secrets before promoting to production.
