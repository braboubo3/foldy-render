-- Enable UUIDs (Supabase/Postgres)
create extension if not exists "pgcrypto";

-- Runs (one per submitted URL)
create table if not exists runs (
  id uuid primary key default gen_random_uuid(),
  url text not null,
  status text not null default 'pending', -- pending|complete|failed
  overall_score int,
  psi_json jsonb,
  created_at timestamptz not null default now()
);
create index if not exists runs_url_idx on runs(url);

-- Per-device results
create table if not exists run_devices (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references runs(id) on delete cascade,
  device text not null,
  device_score int,

  fold_pct int,
  cta boolean,
  max_font int,
  min_font int,
  small_taps int,

  overlay_pct int,
  overlay_blockers int,

  screenshot_url text,   -- Supabase Storage path or signed URL
  timings jsonb,
  raw jsonb,

  created_at timestamptz not null default now()
);
create index if not exists run_devices_run_id_idx on run_devices(run_id);
create index if not exists run_devices_device_idx on run_devices(device);
