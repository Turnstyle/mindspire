-- Ensure Gmail history cursor storage is available
ALTER TABLE user_credentials
  ADD COLUMN IF NOT EXISTS last_history_id TEXT;

-- Structured logging table for edge functions
CREATE TABLE IF NOT EXISTS logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  level TEXT NOT NULL,
  message TEXT NOT NULL,
  context JSONB
);

CREATE INDEX IF NOT EXISTS logs_created_at_idx ON logs (created_at DESC);

-- Helpful indexes for invite digestion and lookups
CREATE INDEX IF NOT EXISTS invite_user_id_status_created_idx
  ON invite (user_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS digest_user_id_sent_at_idx
  ON digest (user_id, sent_at DESC);
