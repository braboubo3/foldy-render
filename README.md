# foldy-render

Playwright microservice for **Foldy** (mobile fold auditor).  
**One request per device** → headless Chromium → returns:
- First-viewport **screenshot** (base64 PNG)
- **DOM audit** JSON (CTA-in-fold, fonts, tap targets, overlays, viewport meta, safe-area)
- **Timings** (nav/audit/screenshot/total)

> Built to run in a Playwright-ready container (Docker). Perfect for Render.com Hobby/Basic.

---

## Endpoints

### `GET /health`
Warm-up & liveness.

**Response**
```json
{ "ok": true, "up": true }
POST /render (auth required)
Body:

json
Kopieren
Bearbeiten
{ "url": "https://example.com", "device": "iphone_15_pro" }
Header:

pgsql
Kopieren
Bearbeiten
Authorization: Bearer <RENDER_TOKEN>
Content-Type: application/json
Response (abridged)

json
Kopieren
Bearbeiten
{
  "device": "iphone_15_pro",
  "deviceMeta": { "viewport": { "width": 393, "height": 852 }, "dpr": 3, "ua": "..." },
  "pngBase64": "<base64 PNG>",
  "ux": {
    "firstCtaInFold": true,
    "foldCoveragePct": 62,
    "maxFontPx": 28,
    "minFontPx": 14,
    "smallTapTargets": 3,
    "hasViewportMeta": true,
    "overlayBlockers": 1,
    "usesSafeAreaCSS": false
  },
  "timings": { "nav_ms": 1234, "settle_ms": 800, "audit_ms": 40, "screenshot_ms": 20, "total_ms": 2230 }
}
Supported devices (PoC):

iphone_se_2 (375×667)

iphone_15_pro (393×852)

iphone_15_pro_max (430×932)

pixel_8 (412×915)

galaxy_s23 (360×800)

Quick start (Render.com)
Repo contents (at root):

index.js (Express + Playwright app)

package.json (with "type":"module" and postinstall)

Dockerfile (uses Playwright base image)

.gitignore

Create Web Service on Render → choose this repo → runtime Docker → Hobby plan is fine.

Env vars:

RENDER_TOKEN=<long-random-string>

PORT=3000 (optional; Render also provides one)

Settings → Health Check Path = /health.

Test:

bash
Kopieren
Bearbeiten
curl -s https://<service>.onrender.com/health
curl -s -X POST https://<service>.onrender.com/render \
  -H "Authorization: Bearer <RENDER_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://example.com","device":"iphone_15_pro"}' | jq .
Run locally with Docker
Requires Docker. Using the Playwright image avoids OS deps headaches.

bash
Kopieren
Bearbeiten
# build
docker build -t foldy-render:local .

# run
docker run --rm -p 3000:3000 -e RENDER_TOKEN=mydevtoken foldy-render:local

# health
curl -s http://localhost:3000/health

# render
curl -s -X POST http://localhost:3000/render \
  -H "Authorization: Bearer mydevtoken" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://example.com","device":"iphone_15_pro"}' | jq .
Environment variables
Name	Required	Description
RENDER_TOKEN	Yes	Bearer token for /render requests
PORT	No	Port to bind (Render injects automatically)

Never commit secrets to the repo. Use platform env vars.

Notes & safety
Basic SSRF guard: only http/https URLs; blocks localhost and private ranges (MVP-level).

Each request uses a fresh browser context; the Chromium browser is kept warm.

We clip the screenshot to the first viewport (not full-page).

We block heavy 3rd-party scripts (analytics/video) to stabilize renders.

Project structure
pgsql
Kopieren
Bearbeiten
.
├── Dockerfile
├── index.js
├── package.json
└── .gitignore
License
MIT (or your choice)

perl
Kopieren
Bearbeiten

---

### `.github/pull_request_template.md`
```markdown
## Summary
<!-- What does this PR change? One or two sentences. -->

## Changes
- [ ] Endpoint(s):
  - [ ] `/health`
  - [ ] `/render`
- [ ] Logic:
  - [ ] Device map
  - [ ] DOM audit heuristics
  - [ ] Screenshot behavior
  - [ ] Timings / metrics
- [ ] Infra:
  - [ ] Dockerfile
  - [ ] Env var handling
  - [ ] Auth (Bearer token)

## Testing
- [ ] Local Docker run (`/health` OK)
- [ ] Local `/render` with `iphone_15_pro` returns base64 + `ux` + `timings`
- [ ] Tested 2–3 real URLs (Shopify PDP, SaaS lander, blog)
- [ ] Error path: invalid URL returns `400`; missing auth returns `401`

**Commands**
```bash
# build & run
docker build -t foldy-render:local .
docker run --rm -p 3000:3000 -e RENDER_TOKEN=mydevtoken foldy-render:local

# smoke
curl -s localhost:3000/health
curl -s -X POST localhost:3000/render -H "Authorization: Bearer mydevtoken" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://example.com","device":"iphone_15_pro"}' | jq .
Deployment checklist (Render)
 Repo has Dockerfile at root

 Service created on Render → Web Service

 Health Check Path set to /health

 Env var RENDER_TOKEN set (long random string)

 Smoke test against the Render URL passes

Security & Ops
 No secrets committed (checked .env, index.js, Dockerfile)

 SSRF guard still in place

 Auth required for /render

 Logs show context/browser closing (no leaks)

Follow-ups (optional)
 Add more device profiles (exact UA/DPR)

 Tune timeouts/retries

 Add semaphore for concurrency (later)

 Metrics to Supabase/n8n

Screenshots (optional)
<!-- Paste any relevant terminal output or screenshots -->
perl
Kopieren
Bearbeiten
