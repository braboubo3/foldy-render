# Runbook — Foldy Render Service

Operational guide for local dev and production on **Render.com**.

---

## Environments

- **Local dev**: your machine (Node + Playwright Chromium)
- **Production**: Render.com Web Service (Docker runtime)

---

## Environment variables

| Name           | Required | Example  | Description                |
|----------------|----------|----------|----------------------------|
| `RENDER_TOKEN` | ✅       | `s3cr3t` | Bearer token for `/render` |
| `PORT`         | ✅       | `3000`   | HTTP port                  |

---

## Local development

```bash
# 1) Install
npm install
npx playwright install chromium

# 2) Run
export RENDER_TOKEN=devtoken
npm start   # app listens on :3000

# 3) Health
curl -s http://localhost:3000/health
# {"ok":true,"up":true}

# 4) Smoke
curl -s -X POST "http://localhost:3000/render" \
  -H "Authorization: Bearer $RENDER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://example.com","device":"iphone_15_pro"}' | jq '.ux'
```

### Docker (local)

```bash
# Build
docker build -t foldy-render .

# Run
docker run --rm -p 3000:3000 -e RENDER_TOKEN=devtoken foldy-render

# Smoke
curl -s -X POST "http://localhost:3000/render" \
  -H "Authorization: Bearer devtoken" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://example.com","device":"iphone_15_pro"}' | jq '.ux'
```

---

## Deploy to Render.com

- **Service type:** Web Service  
- **Runtime:** Docker  
- **Plan:** Hobby (upgrade if needed)

**Dockerfile must:**
- Install deps: `npm ci --omit=dev`  
- Install Playwright + system libs: `npx playwright install --with-deps chromium`  
- Start app: `npm start`

**Env vars (Render dashboard):**
- `RENDER_TOKEN` (random secret)  
- `PORT=3000`

**Health check:** `GET /health` → `{"ok":true,"up":true}`

**Smoke test (from your machine):**
```bash
curl -s -X GET  "$RENDER_URL/health"
curl -s -X POST "$RENDER_URL/render" \
  -H "Authorization: Bearer $RENDER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://example.com","device":"iphone_15_pro"}' | jq '.timings'
```

---

## Scaling & performance

- One shared Chromium per pod; 1 context/request.  
- Start with 1–2 concurrent device calls per pod if you parallelize upstream.  
- If p95 latency climbs:  
  - Scale out pods (horizontal).  
  - Reduce third-party traffic (we abort many trackers/video by default).  
  - Increase nav timeout modestly for heavy pages.

---

## Observability

- Timings in API response: `nav_ms`, `audit_ms`, `screenshot_ms`, etc. Log them in n8n.  
- Use Render logs for errors; include request `url`, `device`, and error message.  
- Add `debugHeatmap=1` and/or `debugRects=1` on a single request to investigate coverage.

---

## Security

- Bearer auth required for `/render`.  
- SSRF guard blocks non-HTTP(S) and private ranges (127.0.0.1, 10/8, 172.16/12, 192.168/16).  
- Avoid passing secrets in query strings; keep them in headers/env.

---

## Rotate token

1. Add `RENDER_TOKEN_NEXT` in Render.  
2. Roll new token through n8n (use it for requests).  
3. After traffic drains, replace `RENDER_TOKEN` and remove the old one.

---

## Common issues & fixes

**“missing dependencies to run browsers”**  
Ensure Docker build runs:
```bash
npx playwright install --with-deps chromium
```

**401 Unauthorized**  
Missing/incorrect `Authorization` header.

**Navigation timeout / heavy pages**  
Some pages are very slow. Consider slightly higher nav timeout or allow more time in upstream workflow.

**Overlay misclassification**  
Use `debugHeatmap=1` and `debugRects=1` to inspect; adjust heuristics in code if a site is a true edge case.

**Rollback**  
Re-deploy previous image (Render has deploy history).  
Keep `CHANGELOG.md` updated with version tags; tag images per release.

---

## Runbook TL;DR

- **Health:** `GET /health`  
- **Smoke:** `POST /render` with a real URL  
- **Debug:** `debugHeatmap=1` or `debugRects=1`  
- **Scale:** scale out if p95 > 30s (end-to-end), and keep per-device ≤ ~25s.
