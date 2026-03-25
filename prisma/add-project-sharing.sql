-- Add project sharing support
-- - Adds `is_public` flag to field_configs
-- - Adds indexes for public hash lookups
-- - Adds a public lookup function by content hash
-- - Adds a view for publicly visible configs

BEGIN;

ALTER TABLE public.field_configs
  ADD COLUMN IF NOT EXISTS is_public boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.field_configs.is_public IS
  'When true, this config can be fetched via public content-hash sharing.';

-- Fast lookup path for shared projects
CREATE INDEX IF NOT EXISTS field_configs_public_hash_idx
  ON public.field_configs (content_hash)
  WHERE is_public = true;

-- Optional helper index for public upload lookups
CREATE INDEX IF NOT EXISTS field_configs_public_upload_idx
  ON public.field_configs (upload_id)
  WHERE is_public = true;

-- Public hash lookup helper (returns at most one latest shared config)
CREATE OR REPLACE FUNCTION public.get_public_field_config_by_hash(p_content_hash text)
RETURNS TABLE (
  upload_id uuid,
  content_hash varchar,
  payload jsonb,
  background_image text,
  updated_at timestamptz
)
LANGUAGE sql
STABLE
AS $$
  SELECT
    fc.upload_id,
    fc.content_hash,
    fc.payload,
    fc.background_image,
    fc.updated_at
  FROM public.field_configs fc
  WHERE fc.content_hash = trim(p_content_hash)
    AND fc.is_public = true
  ORDER BY fc.updated_at DESC
  LIMIT 1;
$$;

-- Public view for shared configs only
CREATE OR REPLACE VIEW public.public_field_configs AS
SELECT
  fc.upload_id,
  fc.content_hash,
  fc.updated_at,
  fc.background_image
FROM public.field_configs fc
WHERE fc.is_public = true;

-- Grants for Supabase anon/authenticated clients (safe: view/function only expose public rows)
GRANT SELECT ON public.public_field_configs TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_public_field_config_by_hash(text) TO anon, authenticated;

COMMIT;

-- Verification
SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'field_configs'
  AND column_name = 'is_public';

SELECT indexname, indexdef
FROM pg_indexes
WHERE schemaname = 'public'
  AND indexname IN ('field_configs_public_hash_idx', 'field_configs_public_upload_idx');

SELECT proname
FROM pg_proc
WHERE pronamespace = 'public'::regnamespace
  AND proname = 'get_public_field_config_by_hash';
