# Foldy — Render Service

**Mobile-ready, fold-first audits.**  
This service renders popular mobile devices, **hides cookie overlays**, measures **above-the-fold** content, and returns a **clean screenshot** + **metrics**. n8n aggregates results across devices and merges **PSI Mobile** (PageSpeed Insights) into the final score.

---

## Quick links
- 👉 [CONTEXT.md](./CONTEXT.md) — source of truth  
- 🔌 [API.md](./API.md) — `/render` contract + examples  
- 🧮 [SCORING.md](./SCORING.md) — rubric (Fold + PSI)  
- 🗺️ [ARCHITECTURE.md](./ARCHITECTURE.md) — data flow  
- 🗄️ [DB.sql](./DB.sql) — Supabase schema  
- 🔁 [WORKFLOW.md](./WORKFLOW.md) — n8n orchestration  
- 🛠️ [RUNBOOK.md](./RUNBOOK.md) — deploy & smoke tests  
- 📝 [CHANGELOG.md](./CHANGELOG.md)

> If any link 404s, create that file using the templates in this project.

---

## What this repo is

This is the **rendering microservice** for Foldy:

- **Input:** `{ url, device }`  
- **Output:** first-viewport **clean PNG** (overlay removed) + **fold audit JSON**  
- **Devices (MVP):** iPhone 15 Pro/Max, Pixel 8, Galaxy S23, iPhone SE (2nd)

The **MVP report** is built by n8n on top: it fans out to 5 devices, merges results, pulls **PSI Mobile**, scores, stores to **Supabase**, and the **Lovable/Next.js** UI reads from there.

---

## API (summary)

**POST** `/render`  
**Auth:** `Authorization: Bearer <RENDER_TOKEN>`

**Body**
```json
{
  "url": "https://example.com",
  "device": "iphone_15_pro",
  "debugOverlay": false,
  "debugRects": false,
  "debugHeatmap": false
}
```

**200 Response (abridged)**
```jsonc
{
  "device": "iphone_15_pro",
  "deviceMeta": {
    "viewport": { "width": 393, "height": 852 },
    "dpr": 3,
    "ua": "...",
    "label": "iPhone 15 Pro"
  },
  "pngBase64": "<CLEAN fold PNG>",
  "ux": {
    "firstCtaInFold": true,
    "foldCoveragePct": 60,
    "visibleFoldCoveragePct": 68,
    "paintedCoveragePct": 100,
    "overlayCoveragePct": 83,
    "overlayBlockers": 1,
    "overlayElemsMarked": 1,
    "maxFontPx": 32,
    "minFontPx": 12,
    "smallTapTargets": 3,
    "hasViewportMeta": true,
    "usesSafeAreaCSS": false
  },
  "timings": {
    "nav_ms": 10500,
    "settle_ms": 801,
    "audit_ms": 604,
    "hide_ms": 216,
    "clean_ms": 88,
    "screenshot_ms": 10088,
    "total_ms": 22766
  },
  "pngWithOverlayBase64": "<optional>",        // if debugOverlay=1
  "pngDebugBase64": "<optional heatmap PNG>",  // if debugHeatmap=1
  "debug": {
    "rows": 40,
    "cols": 24,
    "glyphRects": [...],
    "mediaRects": [...],
    "heroBgRects": [...],
    "overlayRects": [...],
    "coveredCells": [...],
    "overlayCells": [...]
  } // if debugRects=1
}
```

See **API.md** for full payloads and cURL examples.

---

## Local development

Prod runs on Render.com (Playwright image + deps). Local is for quick tests.

```bash
# 1) Install deps
npm install
npx playwright install chromium

# 2) Run
export RENDER_TOKEN=devtoken
npm start     # listens on :3000

# 3) Health
curl -s http://localhost:3000/health
# → {"ok":true,"up":true}

# 4) Smoke test
curl -s -X POST "http://localhost:3000/render" \
  -H "Authorization: Bearer $RENDER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://example.com","device":"iphone_15_pro"}' | jq '.ux'
```

---

## Docker

```bash
# Build
docker build -t foldy-render .

# Run
docker run -p 3000:3000 -e RENDER_TOKEN=devtoken foldy-render

# Test
curl -s -X POST "http://localhost:3000/render" \
  -H "Authorization: Bearer devtoken" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://example.com","device":"iphone_15_pro"}' | jq '.ux'
```

---

## Deploy on Render.com

- **Service type:** Web Service  
- **Runtime:** Docker  
- **Plan:** Hobby (upgrade as needed)

**Environment variables**
- `RENDER_TOKEN` — random secret string  
- `PORT=3000`

**Dockerfile should:**
- `npm ci --omit=dev`  
- `npx playwright install --with-deps chromium`  
- `npm start`

**Health check:** `GET /health` → `{"ok":true,"up":true}`

See **RUNBOOK.md** for detailed steps and smoke tests.

---

## Environment variables

| Variable      | Required | Default | Purpose                     |
|---------------|----------|---------|-----------------------------|
| `RENDER_TOKEN`| ✅        | —       | Bearer auth for `/render`   |
| `PORT`        | ✅        | `3000`  | Express port                |

---

## Security

- Bearer auth required for `/render`.  
- SSRF guard: http/https only; blocks localhost and private ranges.  
- Network hygiene: aborts analytics/video to stabilize loads.  
- Keep secrets in env vars (Render dashboard), not in code.

---

## Debug modes

- `debugOverlay=1` → also returns as-seen PNG (pre-hide)  
- `debugRects=1` → returns rect arrays + covered cells (JSON)  
- `debugHeatmap=1` → returns heatmap PNG (clean view)

Legend:
- **Green** = text glyphs  
- **Blue** = media (IMG/VIDEO/SVG/CANVAS)  
- **Amber** = large non-repeating hero backgrounds

**Example:**
```bash
curl -s -X POST "$RENDER_URL/render?debugHeatmap=1" \
  -H "Authorization: Bearer $RENDER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://poslik.com","device":"iphone_15_pro"}' \
  | jq -r '.pngDebugBase64' | base64 --decode > fold-heatmap.png
```

---

## Performance notes

- One shared Chromium per process; 1 context/request.  
- Timeouts: navigation ~15s; typical device call 5–12s on average pages.  
- Animations disabled for faster rasterization.  
- Heavy third parties blocked by default.

---

## Integration (n8n + Supabase + UI)

### n8n (MVP flow)
Webhook → validate URL → create `runs(pending)` → PSI Mobile → loop 5 devices calling `/render` → compute per-device scores + overall → upload PNGs to Supabase Storage → insert `run_devices` → update `runs(complete)` → respond with `run_id`.

### Supabase schema
See **DB.sql**. We store:

- `runs`: id, url, status, overall_score, psi_json, created_at  
- `run_devices`: per-device metrics + screenshot_url, timings, raw

### UI (Lovable/Next.js)

- `/` submit URL → returns `run_id`  
- `/report/[id]` polls Supabase until complete; displays device cards, PSI, and the **Mobile-Ready Score** (Fold 60% + Vitals 40%).  
- Scoring details: **SCORING.md**.

---

## Troubleshooting

**“missing dependencies to run browsers”**  
Ensure build step runs: `npx playwright install --with-deps chromium`

**401 Unauthorized**  
Missing/incorrect `RENDER_TOKEN` header.

**Slow screenshots / timeouts**  
We disable animations and block heavy 3P; if still slow, increase nav timeout slightly.

**Overlay/header confusion**  
Use `debugHeatmap=1` + `debugRects=1` to visualize. Heuristics exclude typical headers and detect cookie bars/dialogs.

**Tap targets inflated by chat widgets**  
We ignore common chat bubbles anchored bottom-right.

---

## Roadmap & status

MVP = Fold + PSI (in progress).

Next: safe-area detector (advisory), notch overlap check, optional occlusion pass, shareable links & per-device badges.

Track changes in **CHANGELOG.md**.

---

## License

Proprietary (MVP-phase). Decide OSS/commercial license before public release.

---

> Starting a new ChatGPT thread? Paste **CONTEXT.md** as your first message.
