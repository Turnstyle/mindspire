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
- `invite_link` – Generates a Google OAuth link you can share with a partner so
  their successful sign-in links both users together.

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
TOKEN_ENCRYPTION_KEY=32-character-secret
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
3. Start functions locally (imports are resolved via the project import map):
   `supabase functions serve --env-file .env --import-map supabase/functions/import_map.json --no-verify-jwt`.
4. Invoke a function, e.g.:
   ```bash
   curl -X POST http://localhost:54321/functions/v1/poll_gmail \
     -H 'Content-Type: application/json' \
     -d '{"dryRun": true}'
   ```

## Generating an OAuth Invite Link

With functions serving locally, request an invite link for an existing app
user. Supply either their Supabase user ID or email (the function falls back to
email lookup):

```bash
curl "http://localhost:54321/functions/v1/invite_link?email=turner@example.com"
```

The response contains `inviteUrl`, which you can share directly. Add
`&format=html` to receive a ready-to-share landing page, or include
`&redirect=https://app.example.com/welcome` to control the post-OAuth redirect.

## Verifying Google OAuth Configuration

1. Open the [Google Cloud Console OAuth credentials page](https://console.cloud.google.com/apis/credentials/oauthclient) while
   logged into the `Mindspire` project.
2. Select the existing OAuth 2.0 Web client (the one whose client ID is stored
   in `.env`).
3. Under **Authorized redirect URIs**, ensure
   `https://<PROJECT_REF>.supabase.co/functions/v1/auth_callback` is listed. Add
   any local dev callback you use (e.g., `http://localhost:54321/functions/v1/auth_callback`).
4. Save changes, then copy the client ID / secret into `.env` and Supabase
   project secrets if they differ.

## Forwarding Gmail Replies to `reply_processor`

1. Sign into Gmail with the account that receives Mindspire replies.
2. Click the gear icon → **See all settings** → **Forwarding and POP/IMAP**.
3. Click **Add a forwarding address** and provide an inbox that can bridge to
   HTTP (e.g., an Inbucket address, Mailgun route, or Zapier/Make webhook).
   Complete the verification email loop so Gmail trusts the address.
4. Create a Gmail filter (`Settings` → `Filters and Blocked Addresses` → `Create
   a new filter`) that matches the Mindspire reply prefix (e.g., subject
   contains `Mindspire digest` or sent to your digest alias).
5. In the filter actions, check **Forward it to** and choose the verified
   address. Optionally add a label like `Mindspire/replies` for auditing.
6. In the bridging inbox, configure an outbound webhook that POSTs to
   `https://<PROJECT_REF>.supabase.co/functions/v1/reply_processor` with the JSON
   body `{ "userId": "<uuid>", "emailText": "<raw body>", "gmailMessageId": "..." }`.
   Include your Supabase service-role or a trusted JWT in an `Authorization`
   header when calling the function.
7. Send a test reply to confirm the pipeline updates the `invite` record and
   posts to Slack via the peer webhook.

## Testing

Unit tests exercise helper utilities and run via Deno:

```bash
deno test --allow-env --import-map supabase/functions/import_map.json supabase/functions/_tests
```

The sandbox blocks npm/jsr downloads, so run tests on a machine with open
network access.

## Deployment

Deploy edge functions with:

```bash
supabase functions deploy auth_callback poll_gmail send_digest reply_processor peer_receiver invite_link
```

Double-check Supabase project secrets before promoting to production.
