# Foldy Render API

The **render service** loads a URL on a chosen mobile device, hides cookie/consent overlays, audits the **first viewport**, and returns a **clean screenshot** plus **UX metrics**.

> **Auth:** All endpoints require `Authorization: Bearer <RENDER_TOKEN>`.

---

## Endpoints

### `GET /health`
Health probe and boot check.

**Response**
```json
{ "ok": true, "up": true }
```

**Failure**
```json
{ "ok": false, "error": "..." }
```

---

### `POST /render`
Render and audit a single device.

**Headers**
```
Authorization: Bearer <RENDER_TOKEN>
Content-Type: application/json
```

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

**Devices (MVP)**
- `iphone_15_pro` (393×852)
- `iphone_15_pro_max` (430×932)
- `pixel_8` (412×915)
- `galaxy_s23` (360×800)
- `iphone_se_2` (375×667)

> The service **rejects** non-HTTP(S) and private-network hosts (basic SSRF guard).

**200 Response (abridged)**
```json
{
  "device": "iphone_15_pro",
  "deviceMeta": {
    "viewport": { "width": 393, "height": 852 },
    "dpr": 3,
    "ua": "Mozilla/5.0 ... Mobile/15E148 Safari/604.1",
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

  "pngWithOverlayBase64": "<AS-SEEN PNG>",   // present if debugOverlay=1
  "pngDebugBase64": "<heatmap PNG>",         // present if debugHeatmap=1
  "debug": {                                 // present if debugRects=1
    "rows": 40,
    "cols": 24,
    "glyphRects": [[x,y,w,h], ...],
    "mediaRects": [[x,y,w,h], ...],
    "heroBgRects": [[x,y,w,h], ...],
    "overlayRects": [[x,y,w,h], ...],
    "coveredCells": [int, ...],
    "overlayCells": [int, ...]
  }
}
```

**Error responses**
- `400 Bad Request` – missing/invalid `url` or `device`
- `401 Unauthorized` – missing/invalid Bearer token
- `422 Unprocessable Entity` – URL blocked by SSRF guard
- `500 Internal Server Error` – navigation or rendering failure

Example:
```json
{ "error": "Error: Navigation timeout of 15000 ms exceeded" }
```

---

## cURL Examples

**Smoke test**
```bash
curl -s -X POST "$RENDER_URL/render" \
  -H "Authorization: Bearer $RENDER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://example.com","device":"iphone_15_pro"}' | jq '.ux'
```

**With heatmap (debug)**
```bash
curl -s -X POST "$RENDER_URL/render?debugHeatmap=1" \
  -H "Authorization: Bearer $RENDER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://poslik.com","device":"iphone_15_pro"}' \
  | jq -r '.pngDebugBase64' | base64 --decode > fold-heatmap.png
```

**With rects JSON (debug)**
```bash
curl -s -X POST "$RENDER_URL/render?debugRects=1" \
  -H "Authorization: Bearer $RENDER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://sellerboard.com","device":"iphone_15_pro"}' | jq '.debug'
```

---

## Notes & Limits
- Typical device call: **5–12s** on average pages; heavy sites can take longer.
- Timeouts: ~15s navigation + short waits for stability; total per device kept under ~25s.
- Animations disabled; common analytics/video requests aborted to stabilize metrics.
- **Clean screenshot** only (overlays removed); overlay size still reported and penalized in scoring.

