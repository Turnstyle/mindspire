-- Migration to set up cron job for poll_gmail function
-- Runs poll_gmail every 10 minutes to capture new invites and digest replies

CREATE EXTENSION IF NOT EXISTS pg_cron;

DO $$
BEGIN
  PERFORM cron.unschedule('mindspire-poll-gmail-10min');
EXCEPTION WHEN OTHERS THEN
  NULL;
END
$$;

DO $migration$
DECLARE
  service_role_key TEXT;
  job_sql TEXT;
BEGIN
  service_role_key := 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imh6cm1tdW5sZ2NqZ2hqcmpvdXhhIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc1OTA0MjQzOSwiZXhwIjoyMDc0NjE4NDM5fQ.9zCUHFbjePZcqIHsKpAx5Rm8e5b3osoBLiik7eUUxeE';

  job_sql := 'SELECT net.http_post(
    url := ''https://hzrmmunlgcjghjrjouxa.supabase.co/functions/v1/poll_gmail'',
    headers := jsonb_build_object(
      ''Content-Type'', ''application/json'',
      ''Authorization'', ''Bearer ' || service_role_key || ''',
      ''apikey'', ''' || service_role_key || '''
    ),
    body := ''{"dryRun":false}''
  );';

  PERFORM cron.schedule(
    'mindspire-poll-gmail-10min',
    '*/10 * * * *',
    job_sql
  );
END
$migration$;

INSERT INTO logs (level, message, context)
VALUES (
  'INFO',
  'Created cron job for poll_gmail',
  jsonb_build_object(
    'job_name', 'mindspire-poll-gmail-10min',
    'schedule', '*/10 * * * *',
    'created_at', now()
  )
);
