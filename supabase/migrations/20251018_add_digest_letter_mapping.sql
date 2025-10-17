-- Persist digest letter mappings for reply preprocessing

ALTER TABLE digest
  ADD COLUMN IF NOT EXISTS letter_mapping jsonb;

WITH mapping AS (
  SELECT
    d.id,
    jsonb_object_agg(
      chr((64 + item.ordinality)::integer),
      COALESCE(
        item.element ->> 'invite_id',
        chr((64 + item.ordinality)::integer)
      )
    ) AS mapping
  FROM digest d
  CROSS JOIN LATERAL (
    SELECT element, ordinality
    FROM jsonb_array_elements(d.items) WITH ORDINALITY AS elements(element, ordinality)
  ) AS item
  WHERE jsonb_typeof(d.items) = 'array'
  GROUP BY d.id
)
UPDATE digest
SET letter_mapping = mapping.mapping
FROM mapping
WHERE digest.id = mapping.id
  AND (
    digest.letter_mapping IS NULL OR
    digest.letter_mapping = '{}'::jsonb
  )
  AND mapping.mapping IS NOT NULL;

ALTER TABLE digest
  ALTER COLUMN letter_mapping SET DEFAULT '{}'::jsonb;
