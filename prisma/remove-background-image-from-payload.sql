-- Keep background images only in public.field_configs.background_image
-- and remove background image text from public.field_configs.payload.
-- Safe to run multiple times.

BEGIN;

-- 1) Extract a background image value from legacy payload shapes.
CREATE OR REPLACE FUNCTION public.extract_background_image_from_payload(p_payload jsonb)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  value_text text;
BEGIN
  IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' THEN
    RETURN NULL;
  END IF;

  value_text := NULLIF(BTRIM(p_payload ->> 'backgroundImage'), '');
  IF value_text IS NOT NULL THEN
    RETURN value_text;
  END IF;

  IF jsonb_typeof(p_payload -> 'editorState') = 'object' THEN
    value_text := NULLIF(BTRIM((p_payload -> 'editorState') ->> 'backgroundImage'), '');
    IF value_text IS NOT NULL THEN
      RETURN value_text;
    END IF;
  END IF;

  IF jsonb_typeof(p_payload -> 'background') = 'object' THEN
    value_text := NULLIF(BTRIM((p_payload -> 'background') ->> 'fallbackImage'), '');
    IF value_text IS NOT NULL THEN
      RETURN value_text;
    END IF;
  END IF;

  RETURN NULL;
END;
$$;

-- 2) Remove background image keys from payload JSON.
CREATE OR REPLACE FUNCTION public.strip_background_image_from_payload(p_payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  next_payload jsonb;
BEGIN
  next_payload := COALESCE(p_payload, '{}'::jsonb);

  IF jsonb_typeof(next_payload) <> 'object' THEN
    RETURN next_payload;
  END IF;

  next_payload := next_payload - 'backgroundImage';

  IF jsonb_typeof(next_payload -> 'editorState') = 'object' THEN
    next_payload := jsonb_set(
      next_payload,
      '{editorState}',
      (next_payload -> 'editorState') - 'backgroundImage',
      true
    );
  END IF;

  IF jsonb_typeof(next_payload -> 'background') = 'object' THEN
    next_payload := jsonb_set(
      next_payload,
      '{background}',
      (next_payload -> 'background') - 'fallbackImage',
      true
    );
  END IF;

  RETURN jsonb_strip_nulls(next_payload);
END;
$$;

-- 3) Backfill existing rows:
--    - Keep existing background_image when present.
--    - Otherwise copy from payload legacy keys.
--    - Strip those keys from payload.
UPDATE public.field_configs
SET
  background_image = COALESCE(
    NULLIF(BTRIM(background_image), ''),
    public.extract_background_image_from_payload(payload)
  ),
  payload = public.strip_background_image_from_payload(payload)
WHERE payload IS NOT NULL;

-- 4) Enforce rule for future writes.
CREATE OR REPLACE FUNCTION public.field_configs_normalize_background_image()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  extracted text;
BEGIN
  extracted := public.extract_background_image_from_payload(NEW.payload);

  NEW.background_image := COALESCE(
    NULLIF(BTRIM(NEW.background_image), ''),
    extracted,
    NULL
  );

  NEW.payload := public.strip_background_image_from_payload(NEW.payload);

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_field_configs_normalize_background_image
  ON public.field_configs;

CREATE TRIGGER trg_field_configs_normalize_background_image
BEFORE INSERT OR UPDATE OF payload, background_image
ON public.field_configs
FOR EACH ROW
EXECUTE FUNCTION public.field_configs_normalize_background_image();

COMMIT;

-- Optional verification queries:
-- 1) Rows that still contain a legacy payload background image key (should be 0)
-- SELECT COUNT(*)
-- FROM public.field_configs
-- WHERE payload ? 'backgroundImage'
--    OR (jsonb_typeof(payload -> 'editorState') = 'object' AND (payload -> 'editorState') ? 'backgroundImage')
--    OR (jsonb_typeof(payload -> 'background') = 'object' AND (payload -> 'background') ? 'fallbackImage');

-- 2) Quick sanity preview
-- SELECT upload_id, background_image, payload
-- FROM public.field_configs
-- ORDER BY updated_at DESC
-- LIMIT 10;
