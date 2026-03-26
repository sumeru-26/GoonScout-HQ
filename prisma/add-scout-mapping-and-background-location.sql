-- Adds scout type support, compact field mapping, and predefined background references.

alter table public.field_configs
  add column if not exists background_location text,
  add column if not exists field_mapping jsonb;

create table if not exists public.field_backgrounds (
  id uuid primary key default gen_random_uuid(),
  key text not null unique,
  name text not null,
  image_url text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.project_manager_entries
  add column if not exists scout_type text not null default 'match';

do $$
begin
  begin
    alter table public.project_manager_entries
      add constraint project_manager_entries_scout_type_chk
      check (scout_type in ('match', 'qualitative', 'pit'));
  exception
    when duplicate_object then
      null;
  end;
end
$$;

create index if not exists field_configs_background_location_idx
  on public.field_configs (background_location);
