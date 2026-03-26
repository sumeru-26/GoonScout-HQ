BEGIN;

-- 1) Sequence for deterministic 8-digit numeric codes (10000000..99999999)
CREATE SEQUENCE IF NOT EXISTS public.field_config_share_code_seq;

-- Start sequence at 10000000 on next nextval()
SELECT setval('public.field_config_share_code_seq', 9999999, true);

-- 2) Function that returns next unique 8-digit numeric code as text
CREATE OR REPLACE FUNCTION public.next_field_config_code_8()
RETURNS text
LANGUAGE plpgsql
VOLATILE
AS $$
DECLARE
  n bigint;
BEGIN
  n := nextval('public.field_config_share_code_seq');

  IF n > 99999999 THEN
    RAISE EXCEPTION '8-digit code space exhausted for field_configs.content_hash';
  END IF;

  RETURN n::text;
END;
$$;

-- 3) Backfill existing rows with unique numeric 8-digit values
WITH codes AS (
  SELECT
    id,
    public.next_field_config_code_8() AS code
  FROM public.field_configs
)
UPDATE public.field_configs f
SET content_hash = c.code
FROM codes c
WHERE f.id = c.id;

-- 4) Enforce numeric format + uniqueness + default generator
ALTER TABLE public.field_configs
  ALTER COLUMN content_hash TYPE varchar(8),
  ALTER COLUMN content_hash SET NOT NULL,
  ALTER COLUMN content_hash SET DEFAULT public.next_field_config_code_8();

ALTER TABLE public.field_configs
  DROP CONSTRAINT IF EXISTS field_configs_content_hash_format_chk;

ALTER TABLE public.field_configs
  ADD CONSTRAINT field_configs_content_hash_format_chk
  CHECK (content_hash ~ '^[0-9]{8}$');

CREATE UNIQUE INDEX IF NOT EXISTS field_configs_content_hash_key
  ON public.field_configs (content_hash);

COMMIT;