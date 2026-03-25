-- Fix: allow multiple draft projects per user
-- Error addressed:
-- duplicate key value violates unique constraint "field_configs_one_draft_per_user_uidx"

BEGIN;

-- If this was created as a UNIQUE INDEX, drop it.
DROP INDEX IF EXISTS public.field_configs_one_draft_per_user_uidx;

-- If this was created as a table-level UNIQUE CONSTRAINT, drop it too.
ALTER TABLE public.field_configs
  DROP CONSTRAINT IF EXISTS field_configs_one_draft_per_user_uidx;

COMMIT;

-- Verify it is gone (should return zero rows)
SELECT schemaname, indexname
FROM pg_indexes
WHERE schemaname = 'public'
  AND indexname = 'field_configs_one_draft_per_user_uidx';

SELECT conname
FROM pg_constraint
WHERE conname = 'field_configs_one_draft_per_user_uidx';
