# **Mindspire MVP: Updated Plan for Dual-Agent AI Calendar Synchronization**

## **Executive Summary**

This updated plan refines the 3-day MVP for two AI agents coordinating calendar events via Gmail and Slack. It uses Supabase (Deno Edge Functions, Realtime, Vault), minimal LangChain.js, Vertex AI (Gemini 2.5 Flash-Lite), and Google APIs (read-only). Current status: backend built, Slack digests working, Gmail SMTP pending. Next steps: enable email digests, build OAuth invite flow, capture replies, and test fully. No frontend, focused on 2 users.

## **I. Current Setup**

### **A. Infrastructure**
- **Supabase:** Project “Mindspire” (ref: hzrmmunlgcjghjrjouxa) active, tables (app_user, user_credentials, invite, digest) created, extensions (pg_cron, pg_net, vault) enabled, CLI linked, migrations deployed.
- **GCP:** Project “Mindspire” (ID: mindsspire-473507), APIs (Gmail, Calendar, Vertex AI) enabled, OAuth consent screen set, client ID/secret generated, Gemini 2.5 Flash-Lite deployed.
- **GitHub:** Repo “Mindspire” initialized, supabase folder pushed with config.toml and functions.

### **B. Code Status**
- **Edge Functions:** auth_callback, poll_gmail, send_digest, reply_processor, peer_receiver built with helpers (logging, OAuth, Vault).
- **Slack Webhooks:** DIGEST_WEBHOOK_URL and PEER_WEBHOOK_URL active, posting to #mindspire channel.
- **Secrets:** .env and Supabase secrets include Google (client ID, secret, service account), Slack URLs, PEER_JWT_SECRET.

## **II. What’s Working**
- **Digest to Slack:** Sends formatted text (e.g., *Mindspire digest for turner@example.com*) at 7 AM per timezone.
- **Local Testing:** Deno 2.5.2 runs tests, supabase functions serve works.
- **Remote Test:** Functions return 200, but no eligible users yet.

## **III. What’s Next**

### **A. Enable Gmail SMTP for Digests**
- **Task:** Add email sending alongside Slack.
- **Action:** Use Gmail app password (e.g., qdak iczt bewc tovm) with SMTP vars.
- **Steps Done:** Password generated.
- **Steps Remaining:** Add to .env/Supabase secrets, update send_digest code.

### **B. Build OAuth Invite Flow**
- **Task:** Create a link for Julie to grant access.
- **Action:** Generate OAuth URL in a function or page.
- **Steps Remaining:** Code and test the invite UI/link.

### **C. Capture Human Replies**
- **Task:** Process reply emails (e.g., “1A yes, pizza by 5pm”).
- **Action:** Set up Gmail forwarding to a function.
- **Steps Remaining:** Configure forwarding, connect to reply_processor.

### **D. Test Full Loop**
- **Task:** Validate end-to-end flow.
- **Action:** Seed invite, send digest, reply, check updates.
- **Steps Remaining:** Run test plan with mock data.

### **E. Deploy and Monitor**
- **Task:** Deploy functions, test remotely.
- **Action:** Use Supabase CLI to deploy, monitor Slack/logs.
- **Steps Remaining:** Final deployment and live test.

## **IV. User Stories**
- **As a busy spouse, I get a 7 AM digest (email + Slack) with invites to decide on.**
- **As a decision-maker, I reply with notes (e.g., “1A yes, pizza by 5pm”), and it’s tracked.**
- **As a coordinated couple, Julie sees my decision via Slack.**
- **As a non-tech user, I click a link to set up Mindspire easily.**

## **V. Next Actions for AI Agent**
- Update send_digest to send Gmail SMTP emails with SMTP_HOST=smtp.gmail.com, SMTP_PORT=465, SMTP_USER=your.email@gmail.com, SMTP_PASS=qdak iczt bewc tovm, alongside Slack.
- Generate OAuth invite flow code (e.g., HTML page with link).
- Set up reply capture with Gmail forwarding to a function.
- Provide a full test plan with mock data.
- Deploy functions remotely and report status.