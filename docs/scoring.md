# scoring.md (v1.1) — Mobile Actionability Score (MAS) + PSI (blended)

## Why this score
We want one number that answers: **“Can a mobile visitor see, read, and tap the primary action on the first screen — and does performance get in the way?”**  
We split it into two axes and then blend them:

- **MAS (Mobile Actionability Score)** — first-viewport UX quality (CTA visibility, text legibility, tap target size, basic mobile config).
- **PSI sub-score** — Core Web Vitals condensed to **0–100** (LCP / INP (or TBT) / CLS).

Final displayed score = **70% MAS + 30% PSI**. MAS leads (our USP is first-viewport UX). PSI still moves the needle when performance undermines actionability.

---

## What it tells users (value)
- A **single Actionability score** per run, easy to report and track over time.
- A **four-lever breakdown** (Visibility / Touchability / Legibility / Friction) that maps 1:1 to concrete fixes.
- **Performance context** (PSI) so slow/unstable pages can’t masquerade as “good” just because the fold looks fine.
- **Consent overlays are neutral** in MAS by default; if they cause instability/latency, that shows up via PSI (CLS/INP).

---

## Inputs and standards behind them
**Device-level (first viewport only, “clean” view after hiding overlays):**
- `firstCtaInFold` — is a primary CTA visible in the first screen.
- `foldCoveragePct` — percentage of **meaningful** content occupying the fold.
- `minFontPx`, `maxFontPx` — smallest and largest computed font sizes in the fold.
- `smallTapTargets` — count of labeled interactive elements with hit area **< 44×44 CSS px**.
- `hasViewportMeta` — presence of `<meta name="viewport">`.

**Performance (from PageSpeed Insights / CWV):**
- `lcp_ms`, `inp_ms` (or fallback `tbt_ms`), `cls`.

**Standards alignment (used to set thresholds):**
- **Touchability:** Apple HIG **≥ 44×44 pt**, Material **≥ 48×48 dp**; WCAG 2.2 “Target Size (Minimum)” **≥ 24×24 CSS px** (with spacing option).  
- **Legibility:** No px mandate in WCAG; common mobile practice floors body text at **14–16 px**. iOS Safari auto-zooms inputs **< 16 px** on focus (we surface as advisory).  
- **Performance thresholds:** Core Web Vitals — **LCP ≤ 2.5 s (good), ≥ 4.0 s (poor)**; **INP ≤ 200 ms (good), ≥ 500 ms (poor)**; **CLS ≤ 0.10 (good), ≥ 0.25 (poor)**.

> MAS is a **standards-aligned composite** (not an official spec). Core Web Vitals remain visible alongside as their own breakdown.

---

## How MAS is calculated (0–100)
**Category weights:** Visibility **40%**, Touchability **30%**, Legibility **20%**, Friction **10%**.

### Visibility (40%)
- **CTA presence:** `visCta = 100 if firstCtaInFold else 60`
- **Density ladder** using `foldCoveragePct` on the **clean** view:  
  `visDen = 100 (≥50), 90 (35–49), 80 (20–34), 60 (<20)`
- **Visibility sub-score:** `round(0.6·visCta + 0.4·visDen)`

### Touchability (30%)
From `smallTapTargets` (first viewport, labeled, visible, de-duped).  
`0→100; 1–3→90; 4–6→85; 7–9→80; ≥10→70`

### Legibility (20%)
- **Min body text in fold:**  
  `≥15px → 100`, `13–14px → 90`, `12px → 80`, `<12px → 60`
- **Hierarchy check:** ensure a visible size contrast. If `maxFontPx < max(20px, 1.25×minFontPx)` ⇒ **–10**.
- Clamp to [0..100].

### Friction (10%)
- Start at 100. If `hasViewportMeta=false` ⇒ **–20**.  
- Consent overlays do **not** affect MAS directly.

**MAS = round(0.40·Visibility + 0.30·Touchability + 0.20·Legibility + 0.10·Friction)**

**Advisory (not part of MAS):** If any `input/textarea/select` computed font is **<16px**, display an **iOS form zoom risk** badge with a targeted fix.

---

## PSI sub-score (0–100)
Map each CWV to 0–100 **linearly** between Good and Poor thresholds:

- **LCPs =** 100→0 across **2,500–4,000 ms**.  
- **INPs =** 100→0 across **200–500 ms** (fallback to TBT: if `tbt ≤ 200` ⇒ 100, else degrade by `tbt-200` capped at 0).  
- **CLSs =** 100→0 across **0.10–0.25**.

**Combine:** `PSI = round(0.5·LCPs + 0.3·INPs + 0.2·CLSs)`

**Missing values:** fill with neutral **80**, and flag in UI (e.g., “INP unavailable, used TBT fallback/neutral”).

---

## Blended Actionability (display score)
**Soft blend (recommended):**  
`MAS_P = round(0.70·MAS + 0.30·PSI)`

Grades:
- **A** ≥ 90 — Ready  
- **B** 80–89 — Needs light tweaks  
- **C** 70–79 — Fix 1–2 issues  
- **D** < 70 — Not mobile-ready

---

## Database implementation

We reuse existing columns:
- Per device: `run_devices.score` holds **MAS**.
- Per run: `runs.psi_score` holds **PSI**.
- Final: `runs.overall_score` = blended **Actionability** using `runs.psi_weight` (default **0.30**).

### 0) Set blend default
```sql
alter table public.runs alter column psi_weight set default 0.30;
```

### 1) Helpers — linear map + PSI sub-score
```sql
create or replace function public._lin_band(val numeric, good numeric, poor numeric)
returns int language sql immutable as $$
  select case
    when val is null then null
    when val <= good then 100
    when val >= poor then 0
    else round(100 * (1 - (val - good) / (poor - good)))::int
  end
$$;

create or replace function public.psi_score_from_fields(
  p_lcp_ms int, p_inp_ms int, p_tbt_ms int, p_cls numeric
) returns int language sql immutable as $$
  with s as (
    select
      public._lin_band(p_lcp_ms, 2500, 4000) as lcp_s,
      case
        when p_inp_ms is not null then public._lin_band(p_inp_ms, 200, 500)
        when p_tbt_ms is null then null
        when p_tbt_ms <= 200 then 100
        else greatest(0, 100 - (p_tbt_ms - 200))
      end as inp_s,
      public._lin_band(p_cls, 0.10, 0.25) as cls_s
  )
  select least(100, greatest(0,
    round(0.5*coalesce(lcp_s,80) + 0.3*coalesce(inp_s,80) + 0.2*coalesce(cls_s,80))
  ))::int
  from s;
$$;

create or replace function public.psi_score_from_json(p_psi jsonb)
returns int language sql immutable as $$
  with vals as (
    select
      nullif((p_psi->>'lcp')::int, 0)     as lcp,
      nullif((p_psi->>'inp')::int, 0)     as inp,
      nullif((p_psi->>'tbt')::int, 0)     as tbt,
      nullif((p_psi->>'cls')::numeric, 0) as cls
  )
  select public.psi_score_from_fields(lcp, inp, tbt, cls) from vals;
$$;
```

### 2) MAS from UX JSON (overlay-neutral)
```sql
create or replace function public.mas_score_from_ux(p_ux jsonb)
returns int language sql immutable as $$
  with u as (
    select
      coalesce((p_ux->>'firstCtaInFold')::boolean, false) as cta,
      coalesce((p_ux->>'foldCoveragePct')::int, 0)        as cov,
      coalesce((p_ux->>'minFontPx')::int, 0)              as minf,
      coalesce((p_ux->>'maxFontPx')::int, 0)              as maxf,
      coalesce((p_ux->>'smallTapTargets')::int, 0)        as taps,
      coalesce((p_ux->>'hasViewportMeta')::boolean, true) as has_vp
  ),
  vis as (
    select
      (case when cta then 100 else 60 end) as vis_cta,
      (case when cov >= 50 then 100 when cov >= 35 then 90
            when cov >= 20 then 80 else 60 end) as vis_den
    from u
  ),
  legibility as (
    select
      (case when minf >= 15 then 100
            when minf >= 13 then 90
            when minf >= 12 then 80
            else 60 end)
      - (case when maxf >= greatest(20, ceil(1.25*minf)) then 0 else 10 end)
      as leg
    from u
  ),
  parts as (
    select
      greatest(0, least(100, round(0.6*vis_cta + 0.4*vis_den))) as visibility,
      (case when taps = 0 then 100 when taps <= 3 then 90
            when taps <= 6 then 85 when taps <= 9 then 80 else 70 end) as touchability,
      greatest(0, least(100, leg)) as legibility,
      greatest(0, least(100, 100 - (case when has_vp then 0 else 20 end))) as friction
  )
  select round(0.40*visibility + 0.30*touchability + 0.20*legibility + 0.10*friction)::int
  from parts;
$$;
```

### 3) Triggers (compute PSI on `runs`, MAS on `run_devices`)
```sql
-- PSI auto-compute on runs
create or replace function public._tg_compute_psi_score() returns trigger
language plpgsql as $$
begin
  if coalesce(new.psi_lcp_ms, new.psi_inp_ms, new.psi_tbt_ms, new.psi_cls) is not null then
    new.psi_score := public.psi_score_from_fields(new.psi_lcp_ms, new.psi_inp_ms, new.psi_tbt_ms, new.psi_cls);
  elsif new.psi_json is not null then
    new.psi_score := public.psi_score_from_json(new.psi_json);
  else
    new.psi_score := null;
  end if;
  return new;
end$$;

drop trigger if exists trg_runs_compute_psi_score on public.runs;
create trigger trg_runs_compute_psi_score
before insert or update of psi_json, psi_lcp_ms, psi_inp_ms, psi_tbt_ms, psi_cls
on public.runs
for each row execute function public._tg_compute_psi_score();

-- MAS auto-compute on run_devices (stored in d.score)
create or replace function public._tg_compute_device_mas() returns trigger
language plpgsql as $$
declare v_ux jsonb;
begin
  v_ux := coalesce(new.raw_json->'ux',
    jsonb_build_object(
      'firstCtaInFold', coalesce(new.cta,false),
      'foldCoveragePct', coalesce(new.fold_pct,0),
      'minFontPx',      coalesce(new.min_font,0),
      'maxFontPx',      coalesce(new.max_font,0),
      'smallTapTargets',coalesce(new.small_taps,0),
      'hasViewportMeta', true
    )
  );
  new.score := public.mas_score_from_ux(v_ux);
  return new;
end$$;

drop trigger if exists trg_run_devices_compute_mas on public.run_devices;
create trigger trg_run_devices_compute_mas
before insert or update of raw_json, cta, fold_pct, min_font, max_font, small_taps
on public.run_devices
for each row execute function public._tg_compute_device_mas();
```

### 4) Finalization (existing functions)
Keep your existing `check_and_finalize_run` / `finalize_run` and ensure:
- `fold_avg = round(avg(run_devices.score))` (**MAS avg**)
- `overall_score = round(psi_score * psi_weight + fold_avg * (1 - psi_weight))`  
  with `psi_weight` defaulting to **0.30**.

---

## UI notes
- Main chip: **Actionability (blended)**. Side chips: **MAS (UX)**, **PSI (Vitals)**.
- “Why this score?” expands to **4 MAS bars** + **LCP/INP(or TBT)/CLS** bars.
- Consent UX shown as a separate badge (Gold/Silver/Bronze/Fail).

---

## Changelog
- **v1.1 (2025‑08‑28):** MAS introduced as per-device score; PSI linear-band sub-score; 70/30 blend; legibility thresholds set to min **15px** with 1.25× heading ratio; overlays neutral in MAS.
