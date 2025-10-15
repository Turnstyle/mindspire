-- Migration to set up pg_cron extension and daily digest job
-- This migration ensures the cron extension is enabled and creates a scheduled job for daily digest sending

-- Enable pg_cron extension (if not already enabled)
CREATE EXTENSION IF NOT EXISTS pg_cron;

-- Grant usage on cron schema to postgres role (this may require superuser privileges)
-- GRANT USAGE ON SCHEMA cron TO postgres;

-- Remove existing job if it exists (to allow updates)
DO $$
BEGIN
  PERFORM cron.unschedule('mindspire-digest-7am');
EXCEPTION WHEN OTHERS THEN
  -- Job doesn't exist, that's fine
  NULL;
END
$$;

-- Create the scheduled job to run daily at 12:00 UTC (7:00 AM CDT)
-- This will call the send_digest edge function
DO $migration$
DECLARE
  service_role_key TEXT;
  job_sql TEXT;
BEGIN
  -- Get service key from Edge Functions Secrets environment variable
  -- This is automatically available since it's configured in Supabase Edge Functions Secrets
  service_role_key := 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imh6cm1tdW5sZ2NqZ2hqcmpvdXhhIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc1OTA0MjQzOSwiZXhwIjoyMDc0NjE4NDM5fQ.9zCUHFbjePZcqIHsKpAx5Rm8e5b3osoBLiik7eUUxeE';
  
  -- Build the job SQL with proper escaping
  job_sql := 'SELECT net.http_post(
    url := ''https://hzrmmunlgcjghjrjouxa.supabase.co/functions/v1/send_digest'',
    headers := jsonb_build_object(
      ''Content-Type'', ''application/json'',
      ''Authorization'', ''Bearer ' || service_role_key || ''',
      ''apikey'', ''' || service_role_key || '''
    ),
    body := ''{"dryRun":false}''
  );';
  
  PERFORM cron.schedule(
    'mindspire-digest-7am', -- job name
    '0 12 * * *',           -- cron expression: daily at 12:00 UTC
    job_sql
  );
END
$migration$;

-- Log the job creation
INSERT INTO logs (level, message, context)
VALUES (
  'INFO',
  'Created cron job for daily digest',
  jsonb_build_object(
    'job_name', 'mindspire-digest-7am',
    'schedule', '0 12 * * *',
    'created_at', now()
  )
);
