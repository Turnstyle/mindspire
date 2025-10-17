-- Adds metadata columns for reply preprocessor insights

ALTER TABLE invite
  ADD COLUMN IF NOT EXISTS preprocessor_confidence DECIMAL(3, 2),
  ADD COLUMN IF NOT EXISTS html_formatting_detected BOOLEAN DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS invite_preprocessor_confidence_idx
  ON invite (preprocessor_confidence)
  WHERE preprocessor_confidence IS NOT NULL;
