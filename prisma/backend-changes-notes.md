# Backend Changes Overview

## New `field_configs` columns
- `background_location` (text): Stores a reference key (or ID-like key) for predefined field images.
- `field_mapping` (jsonb): Stores compact mapping output used for QR/data compression.

## New `field_backgrounds` table
- Purpose: Central catalog of selectable background images.
- Columns:
  - `id` UUID primary key
  - `key` unique text identifier
  - `name` display name
  - `image_url` source URL/path

## Project manager scout type
- `project_manager_entries.scout_type` added with allowed values:
  - `match`
  - `qualitative`
  - `pit`

## How images are resolved
- Editor stores selected key in `field_configs.background_location`.
- Client can resolve this via predefined list or by querying `field_backgrounds`.
- Legacy `background_image` remains for backward compatibility and fallback.

## Compact mapping JSON
When a project is completed, backend writes `field_mapping` as:

```json
{
  "mapping": {
    "0": "auto.scores",
    "1": "teleop.scores",
    "2": "auto.fuel",
    "3": "teleop.fuel"
  }
}
```

Behavior:
- Toggle tags are mapped without `auto.` / `teleop.` prefixes.
- Other tag assets get `auto.` and `teleop.` variants.
