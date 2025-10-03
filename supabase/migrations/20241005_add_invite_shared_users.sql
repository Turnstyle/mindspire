-- Support shared invites across multiple users
ALTER TABLE invite
  ADD COLUMN IF NOT EXISTS shared_user_ids TEXT[] DEFAULT '{}'::TEXT[];

CREATE INDEX IF NOT EXISTS invite_shared_user_ids_idx
  ON invite USING GIN (shared_user_ids);
