# Scoring (MVP)

We compute two sub-scores per URL and combine them.

## Fold Score (0–100)
Start at **100**. Subtract:

- CTA not visible in fold: **−30**
- Max fold font < **20px**: **−15**
- Min fold font < **16px**: **−10**
- Any small tap targets (<44×44, labeled): **−10**
- Missing `<meta name="viewport">`: **−15**

**Fold content coverage (CLEAN):**
- `< 20%`: **−15**
- `20–34%`: **−10**
- `≥ 35%`: **0**

**Overlay penalty (measured pre-hide):**
- `overlayBlockers > 0`: **−10**
- else if `overlayCoveragePct ≥ 50`: **−8**
- else if `≥ 30`: **−5**
- else if `≥ 15`: **−3**
- else: **0**

Clamp Fold Score to [0, 100].

## Vitals Score (0–100) — PSI Mobile
- LCP > 3000 ms: **−10**
- INP > 200 ms **or** (if no field INP) TBT > 200 ms: **−5**
- CLS > 0.10: **−5**

Clamp to [0, 100].

## Final
**Mobile-Ready Score** = `0.6 × Fold + 0.4 × Vitals` (rounded).

> Notes
> - Fold metrics are computed on the **clean** view (overlays hidden).  
> - Overlays still incur a penalty for UX friction.  
> - We ignore chat widgets for tap-target penalties.
