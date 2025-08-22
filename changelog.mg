### `CHANGELOG.md`

```markdown
# Changelog — Foldy Render Service

All notable changes to this project will be documented here.

## [Unreleased]
- PSI Mobile parsing + merge into overall score (n8n side)
- UI: shareable report links, per-device badges
- Safe-area detector (advisory) and notch overlap check
- Optional occlusion pass (subtract overlapping elements)
- Parallel device fan-out (cap concurrency per pod)

## [0.6.0] — 2025-08-22
### Added
- Overlay-aware **clean screenshot** (cookie/CMP elements hidden).
- Fold audit with:
  - `firstCtaInFold`
  - `foldCoveragePct` (clean)
  - `visibleFoldCoveragePct` (pre-hide reference)
  - `paintedCoveragePct` (debug)
  - `overlayCoveragePct`, `overlayBlockers`, `overlayElemsMarked`
  - `maxFontPx`, `minFontPx`, `smallTapTargets`, `hasViewportMeta`
- **i18n CTA** detection (EN/FR/DE/ES/PT/IT).
- **Hero background** counting (large non-repeating backgrounds).
- **Debug modes**:
  - `debugRects=1` → rect arrays + covered cells
  - `debugHeatmap=1` → heatmap PNG overlay (clean)
  - `debugOverlay=1` → “as-seen” PNG before hiding overlays
- Basic SSRF guard; Bearer auth.

### Changed
- Standardized hosting on **Render.com** (Docker).
- Disabled `usesSafeAreaCSS` scoring (advisory flag only, returns `false` for now).
- Trimmed heavy third-party requests (analytics/video) to stabilize timings.

### Docs
- Added `CONTEXT.md`, `API.md`, `SCORING.md`, `ARCHITECTURE.md`, `DB.sql`, `WORKFLOW.md`, `RUNBOOK.md`.

