🔥 One-liner

Foldy answers: “Is my page mobile-ready?” with a hard focus on the first viewport. We render popular devices, audit the fold, hide cookie overlays for scoring, pull PSI Mobile, then return a clean screenshot, metrics, and a single score with fixes.

🎯 MVP Scope (what ships now)
/render microservice (Node + Playwright, Chromium on Render.com): clean fold PNG + audit JSON.
PSI Mobile (Google PageSpeed Insights) pulled per run and merged into the score.
n8n Cloud orchestration: webhook → fan-out to 5 devices → aggregate → store.
Supabase (Postgres + Storage): persist runs + per-device results; screenshots saved to Storage.
Lovable/Next.js UI: submit URL → results page with per-device cards and overall score.
Non-Goals (MVP): desktop suite, deep SEO/Lighthouse clone, login or multi-step flows, cross-browser beyond Chromium, full-page diffs.

✅ Acceptance Criteria
5 devices supported; p95 run ≤ 30s on Render Hobby.
Clean screenshot = overlays removed; overlay penalty still applied.
CTA detection works EN/FR/DE/ES/PT/IT; scores stable (±3) across 3 runs.
Supabase records runs and device rows; UI renders from DB.

🏗 Architecture (high level)
Frontend (Lovable) → n8n Webhook → /render per device → n8n aggregates + scores → Supabase write → UI reads.
Render service traits: shared Chromium, 1 context/request, Bearer auth, SSRF guard, blocks heavy 3P (analytics/video), debug flags.

📱 Devices (MVP)
iphone_15_pro (393×852)
iphone_15_pro_max (430×932)
pixel_8 (412×915)
galaxy_s23 (360×800)
iphone_se_2 (375×667)

🔌 API (abridged)
POST /render Auth: Authorization: Bearer <RENDER_TOKEN>

Body
{
  "url": "https://example.com",
  "device": "iphone_15_pro",
  "debugOverlay": false,
  "debugRects": false,
  "debugHeatmap": false
}

Response (abridged)
{
  "deviceMeta": { "viewport": {"width":393,"height":852}, "dpr": 3, "ua": "...", "label": "iPhone 15 Pro" },
  "pngBase64": "<CLEAN fold PNG>",
  "ux": {
    "firstCtaInFold": true,
    "foldCoveragePct": 60,                 // CLEAN (used for score)
    "visibleFoldCoveragePct": 68,          // pre-hide reference
    "paintedCoveragePct": 100,             // debug only
    "overlayCoveragePct": 83,              // pre-hide overlay size
    "overlayBlockers": 1,
    "overlayElemsMarked": 1,
    "maxFontPx": 32, "minFontPx": 12,
    "smallTapTargets": 3,
    "hasViewportMeta": true,
    "usesSafeAreaCSS": false               // advisory; currently disabled
  },
  "timings": { "nav_ms": 10500, "settle_ms": 801, "audit_ms": 604, "hide_ms": 216, "clean_ms": 88, "screenshot_ms": 10088, "total_ms": 22766 },

  // Optional when debug flags set:
  "pngWithOverlayBase64": "<AS-SEEN PNG>",
  "pngDebugBase64": "<heatmap PNG>",
  "debug": { "rows":40,"cols":24,"glyphRects":[...], "mediaRects":[...], "heroBgRects":[...], "overlayRects":[...], "coveredCells":[...], "overlayCells":[...] }
}

📐 Coverage method (key decisions)
Foreground content = union of:
glyph-tight text node rects (not line boxes)
IMG/VIDEO/SVG/CANVAS rects
Large, non-repeating hero backgrounds (≥ 25% of fold)
Rasterize to 40×24 grid; coverage = % of first-viewport cells touched.
Compute pre-hide (for overlay size) and clean (after hiding overlays). Score uses clean.
CTA detection: i18n, accent-insensitive.
Tap-target check: flags <44×44 labeled actions; ignores chat bubbles bottom-right.

🕶 Overlays (cookie/CMP/modals)
Detect pre-hide via position (fixed/sticky), size/z-index, bottom bar with consent buttons, cookie/consent hints. Headers/navs excluded.
Hide overlays before screenshot & clean metrics.
Still report overlayCoveragePct & overlayBlockers → penalty applied.

🧮 Scoring (MVP)
Two pillars → Mobile-Ready Score.
Fold Score (0–100) — start 100, subtract:
−30 CTA not visible in fold
−15 Max fold font < 20px
−10 Min fold font < 16px
−10 Any small tap targets (<44×44, labeled)
−15 Missing <meta name="viewport">

Fold coverage (clean): <20% → −15, 20–34% → −10, ≥35% → 0

Overlay penalty (pre-hide):
blockers > 0 → −10
else overlay ≥50% → −8, ≥30% → −5, ≥15% → −3

Vitals Score (0–100) — from PSI Mobile:
−10 if LCP > 3000ms
−5 if INP > 200ms (or if no INP, TBT > 200ms)
−5 if CLS > 0.10

Final: Mobile-Ready = 0.6 × Fold + 0.4 × Vitals (rounded).
Badges: ≥90 Great • 70–89 Needs tweaks • <70 Not ready.

🔁 Orchestration (n8n)
Webhook → validate URL → create runs(pending) → PSI call → loop 5 devices calling /render (sequential v0) → compute device scores + overall → upload PNGs to Supabase Storage → insert run_devices → update runs(complete) → respond with run_id + summary.

🗄 Data model (Supabase, MVP)
runs: id, url, status(pending|complete|failed), overall_score, psi_json, created_at
run_devices: id, run_id, device, device_score, fold_pct, cta, max_font, min_font, small_taps, overlay_pct, overlay_blockers, screenshot_url, timings(jsonb), raw(jsonb), created_at
Indexes: runs(url), run_devices(run_id)

🧰 Debug knobs
debugRects=1 → return rect arrays + covered cells (JSON)
debugHeatmap=1 → return heatmap PNG overlaying counted regions (clean view)
debugOverlay=1 → return as-seen PNG before hiding overlays

🔐 Env & deploy
Render service: RENDER_TOKEN, PORT=3000
Build: npm ci --omit=dev && npx playwright install --with-deps chromium
Start: npm start
Health: GET /health → {"ok":true,"up":true}

n8n: SUPABASE_SERVICE_KEY, SUPABASE_URL, RENDER_URL, RENDER_TOKEN

Frontend: SUPABASE_ANON_KEY, SUPABASE_URL, PUBLIC_N8N_WEBHOOK

📋 Operational guardrails
Timeouts: 15s nav; 25s per device call; retry /render once on 5xx.
Block analytics/video to stabilize loads.
Basic SSRF guard (http/https only; blocks private ranges).
Rate-limit UI submits; token on /render.

🗓 Open TODOs (next)
Finalize PSI parsing + merge into score in n8n.
Add safe-area detector back (advisory) + notch overlap check.
Optional occlusion pass (subtract overlapping elements).
UI polish: shareable link, “show banner” debug toggle, per-device badges.
