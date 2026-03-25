BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

UPDATE public.field_configs
SET upload_id = gen_random_uuid()
WHERE upload_id IS NULL;

WITH numbered AS (
  SELECT id, row_number() OVER (ORDER BY created_at, id) AS rn
  FROM public.field_configs
  WHERE content_hash IS NULL OR content_hash !~ '^[0-9]{8}$'
)
UPDATE public.field_configs f
SET content_hash = lpad((10000000 + n.rn)::text, 8, '0')
FROM numbered n
WHERE f.id = n.id;

ALTER TABLE public.field_configs
  ALTER COLUMN upload_id SET NOT NULL,
  ALTER COLUMN content_hash TYPE varchar(8),
  ALTER COLUMN content_hash SET NOT NULL;

ALTER TABLE public.field_configs
  DROP CONSTRAINT IF EXISTS field_configs_content_hash_format_chk;

ALTER TABLE public.field_configs
  ADD CONSTRAINT field_configs_content_hash_format_chk
  CHECK (content_hash ~ '^[0-9]{8}$');

CREATE UNIQUE INDEX IF NOT EXISTS field_configs_upload_id_key
  ON public.field_configs (upload_id);

CREATE UNIQUE INDEX IF NOT EXISTS field_configs_content_hash_key
  ON public.field_configs (content_hash);

COMMIT;