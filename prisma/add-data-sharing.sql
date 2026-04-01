-- Add Data Sharing table for 6-digit project sync codes
-- Supports create code, upload, and download of match/qual/pit JSON arrays.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS public.data_sharing (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  share_code varchar(6) NOT NULL UNIQUE,
  match_data jsonb NOT NULL DEFAULT '[]'::jsonb,
  qual_data jsonb NOT NULL DEFAULT '[]'::jsonb,
  pit_data jsonb NOT NULL DEFAULT '[]'::jsonb,
  CONSTRAINT data_sharing_share_code_digits_chk CHECK (share_code ~ '^[0-9]{6}$'),
  CONSTRAINT data_sharing_match_data_array_chk CHECK (jsonb_typeof(match_data) = 'array'),
  CONSTRAINT data_sharing_qual_data_array_chk CHECK (jsonb_typeof(qual_data) = 'array'),
  CONSTRAINT data_sharing_pit_data_array_chk CHECK (jsonb_typeof(pit_data) = 'array')
);

CREATE OR REPLACE FUNCTION public.set_data_sharing_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS data_sharing_set_updated_at ON public.data_sharing;
CREATE TRIGGER data_sharing_set_updated_at
BEFORE UPDATE ON public.data_sharing
FOR EACH ROW
EXECUTE FUNCTION public.set_data_sharing_updated_at();

CREATE INDEX IF NOT EXISTS data_sharing_share_code_idx
  ON public.data_sharing (share_code);

CREATE INDEX IF NOT EXISTS data_sharing_updated_at_idx
  ON public.data_sharing (updated_at DESC);

ALTER TABLE public.data_sharing ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS data_sharing_select_all ON public.data_sharing;
CREATE POLICY data_sharing_select_all
ON public.data_sharing
FOR SELECT
TO anon, authenticated
USING (true);

DROP POLICY IF EXISTS data_sharing_insert_all ON public.data_sharing;
CREATE POLICY data_sharing_insert_all
ON public.data_sharing
FOR INSERT
TO anon, authenticated
WITH CHECK (true);

DROP POLICY IF EXISTS data_sharing_update_all ON public.data_sharing;
CREATE POLICY data_sharing_update_all
ON public.data_sharing
FOR UPDATE
TO anon, authenticated
USING (true)
WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE ON public.data_sharing TO anon, authenticated;

COMMIT;

-- Verification
SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'data_sharing'
ORDER BY ordinal_position;

SELECT conname
FROM pg_constraint
WHERE conrelid = 'public.data_sharing'::regclass
ORDER BY conname;

SELECT indexname, indexdef
FROM pg_indexes
WHERE schemaname = 'public'
  AND tablename = 'data_sharing'
ORDER BY indexname;
