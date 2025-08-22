# Architecture

```mermaid
flowchart LR
  A[Lovable UI] -->|URL submit| B[n8n Webhook]
  B -->|fan-out 5 devices| C[Render.com (Node+Playwright)]
  C -->|JSON + PNG| B
  B -->|aggregate + score| D[(Supabase)]
  A <-- read results -- D
Sequence (per device):

n8n → /render with { url, device }

Render svc: navigate → pre-hide audit → hide overlays → clean audit → clean screenshot → return JSON

n8n: aggregate device results → compute overall score → write runs + run_devices to Supabase

UI reads from Supabase and renders per-device cards + total score

Render svc key traits

Shared Chromium, 1 context per request

Bearer auth, SSRF guard, network abort for trackers/video

Debug knobs: debugRects, debugHeatmap, debugOverlay

pgsql
Kopieren
Bearbeiten

---

### `DB.sql`
```sql
-- Enable UUIDs (Supabase/Postgres)
create extension if not exists "pgcrypto";

-- Pages
create table if not exists pages (
  id uuid primary key default gen_random_uuid(),
  url text not null unique,
  created_at timestamptz not null default now()
);

-- Runs
create table if not exists runs (
  id uuid primary key default gen_random_uuid(),
  page_id uuid not null references pages(id) on delete cascade,
  created_at timestamptz not null default now(),
  overall_score int,
  notes jsonb
);

create index if not exists runs_page_id_idx on runs(page_id);

-- Per-device results
create table if not exists run_devices (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references runs(id) on delete cascade,
  device text not null,
  score int,

  fold_pct int,
  cta boolean,
  min_font int,
  small_taps int,

  overlay_pct int,
  overlay_blockers int,

  screenshot_base64 text,
  timings jsonb,
  raw jsonb,

  created_at timestamptz not null default now()
);

create index if not exists run_devices_run_id_idx on run_devices(run_id);
create index if not exists run_devices_device_idx on run_devices(device);
