-- Auto-delete data sharing rows 3 days after creation.
-- Intended for Supabase/Postgres with pg_cron enabled.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pg_cron;

-- Speeds up retention deletes.
CREATE INDEX IF NOT EXISTS data_sharing_created_at_idx
  ON public.data_sharing (created_at);

-- Cleanup function used by cron.
CREATE OR REPLACE FUNCTION public.cleanup_expired_data_sharing()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  deleted_count integer;
BEGIN
  DELETE FROM public.data_sharing
  WHERE created_at < now() - interval '3 days';

  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$;

-- Avoid duplicate scheduled jobs if this script is re-run.
DO $$
DECLARE
  existing_job_id bigint;
BEGIN
  SELECT jobid INTO existing_job_id
  FROM cron.job
  WHERE jobname = 'data_sharing_retention_3d'
  LIMIT 1;

  IF existing_job_id IS NOT NULL THEN
    PERFORM cron.unschedule(existing_job_id);
  END IF;
END;
$$;

-- Run hourly at minute 15.
SELECT cron.schedule(
  'data_sharing_retention_3d',
  '15 * * * *',
  $$SELECT public.cleanup_expired_data_sharing();$$
);

COMMIT;

-- Verification
SELECT jobid, jobname, schedule, command
FROM cron.job
WHERE jobname = 'data_sharing_retention_3d';

-- Optional one-shot manual cleanup (if cron is unavailable):
-- DELETE FROM public.data_sharing
-- WHERE created_at < now() - interval '3 days';
