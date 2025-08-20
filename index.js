/**
 * foldy-render — Express + Playwright microservice
 *
 * Endpoints
 *   GET  /health     -> warm/liveness
 *   POST /render     -> { url, device, debugOverlay? }  (Authorization: Bearer <RENDER_TOKEN>)
 *
 * Returns (abridged)
 *   {
 *     deviceMeta: { viewport, dpr, ua, label },
 *     pngBase64: "<clean first-viewport PNG>",          // overlay removed (default)
 *     // pngWithOverlayBase64: "<as-seen PNG>",         // only when debugOverlay=1
 *     ux: {
 *       firstCtaInFold, foldCoveragePct, visibleFoldCoveragePct,
 *       paintedCoveragePct, overlayCoveragePct, overlayBlockers,
 *       maxFontPx, minFontPx, smallTapTargets, hasViewportMeta, usesSafeAreaCSS
 *     },
 *     timings: { nav_ms, settle_ms, audit_ms, hide_ms, screenshot_ms, total_ms }
 *   }
 *
 * Notes
 * - Uses the official Playwright Docker image in production (all OS deps baked in).
 * - One Chromium browser per process, one isolated context per request.
 * - Basic SSRF guard (http/https only; blocks localhost/private ranges).
 */

import express from "express";
import { chromium, devices } from "playwright";

const PORT = process.env.PORT || 3000;
const AUTH = process.env.RENDER_TOKEN || "devtoken";

const app = express();
app.use(express.json({ limit: "8mb" }));

/* -------------------------------------------------------------------------- */
/* Device presets (PoC). We override viewport for exact fold height/width.    */
/* -------------------------------------------------------------------------- */
const DEVICE_MAP = {
  iphone_se_2: {
    label: "iPhone SE (2nd gen)",
    vp: { width: 375, height: 667 },
    profile: devices["iPhone SE"],
  },
  iphone_15_pro: {
    label: "iPhone 15 Pro",
    vp: { width: 393, height: 852 },
    profile: devices["iPhone 13 Pro"], // close enough preset
  },
  iphone_15_pro_max: {
    label: "iPhone 15 Pro Max",
    vp: { width: 430, height: 932 },
    profile: devices["iPhone 13 Pro Max"],
  },
  pixel_8: {
    label: "Pixel 8",
    vp: { width: 412, height: 915 },
    profile: devices["Pixel 5"],
  },
  galaxy_s23: {
    label: "Galaxy S23",
    vp: { width: 360, height: 800 },
    profile: devices["Galaxy S9+"],
  },
};

/* ------------------------------ Auth middleware --------------------------- */
function requireAuth(req, res, next) {
  const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!token || token !== AUTH) return res.status(401).json({ error: "unauthorized" });
  next();
}

/* ------------------------------- SSRF guard --------------------------------
 * Allow only http/https and block obvious internal hosts. (MVP guard; does
 * not resolve DNS to IP — that’s OK for our use case here.)
 * -------------------------------------------------------------------------- */
function isAllowedUrl(u) {
  try {
    const { protocol, hostname } = new URL(u);
    if (!/^https?:$/.test(protocol)) return false;
    if (
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      /^10\./.test(hostname) ||
      /^192\.168\./.test(hostname) ||
      /^172\.(1[6-9]|2\d|3[0-1])\./.test(hostname)
    ) return false;
    return true;
  } catch {
    return false;
  }
}

/* --------------------------- Playwright browser --------------------------- */
let browser = null;

async function getBrowser() {
  if (browser && browser.isConnected()) return browser;
  if (browser) try { await browser.close(); } catch {}
  browser = await chromium.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
    ],
  });
  browser.on("disconnected", () => { browser = null; });
  return browser;
}

/* --------------------------------- Health --------------------------------- */
app.get("/health", async (_req, res) => {
  try {
    await getBrowser();
    res.json({ ok: true, up: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

/* -------------------------- Overlay hider (Node) -------------------------- */
/** Hides elements marked by the in-page audit + common CMPs; unlocks scroll. */
async function hideOverlaysAndUnlock(page) {
  await page.evaluate(() => {
    // Hide anything our audit marked
    document.querySelectorAll('[data-foldy-overlay="1"]').forEach((el) => {
      el.setAttribute("data-foldy-overlay-hidden", "1");
      el.style.setProperty("display", "none", "important");
      el.style.setProperty("visibility", "hidden", "important");
    });

    // Extra heuristics for cookie/consent UIs
    const selectors = [
      '[id*="cookie" i]','[class*="cookie" i]',
      '[id*="consent" i]','[class*="consent" i]',
      '[id*="gdpr" i]','[class*="gdpr" i]',
      '[role="dialog"]',
    ];
    document.querySelectorAll(selectors.join(",")).forEach((el) => {
      const st = getComputedStyle(el);
      if (st.position === "fixed" || st.position === "sticky") {
        el.setAttribute("data-foldy-overlay-hidden", "1");
        el.style.setProperty("display", "none", "important");
        el.style.setProperty("visibility", "hidden", "important");
      }
    });

    // Many CMPs lock scroll; unlock it
    document.documentElement.style.setProperty("overflow", "auto", "important");
    document.body.style.setProperty("overflow", "auto", "important");
    document.body.classList.remove("modal-open", "overflow-hidden", "disable-scroll");
  });
}

async function evalCleanFold(page) {
  return page.evaluate(() => {
    const vpW = window.innerWidth, vpH = window.innerHeight;
    const inViewport = (r) => r.top < vpH && r.bottom > 0 && r.left < vpW && r.right > 0;
    const isVisible = (el) => {
      const st = getComputedStyle(el);
      if (st.visibility === "hidden" || st.display === "none" || st.opacity === "0") return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    const intersect = (r) => {
      const left = Math.max(0, r.left), top = Math.max(0, r.top);
      const right = Math.min(vpW, r.right), bottom = Math.min(vpH, r.bottom);
      const w = Math.max(0, right - left), h = Math.max(0, bottom - top);
      return w > 0 && h > 0 ? { left, top, right, bottom, width: w, height: h } : null;
    };
    const rgbaAlpha = (rgba) => {
      if (!rgba || !rgba.startsWith("rgba")) return 1;
      const p = rgba.replace(/^rgba\(|\)$/g, "").split(",");
      return parseFloat(p[3] || "1");
    };
    const getText = (el) => (el.innerText || el.textContent || "").trim().toLowerCase();
    const getAria = (el) => (el.getAttribute("aria-label") || el.getAttribute("title") || "").trim().toLowerCase();
    const isMediaTag = (el) => ["IMG","VIDEO","CANVAS","SVG"].includes(el.tagName);

    // Visible-in-fold elements
    const allInFoldVisible = Array.from(document.querySelectorAll("body *"))
      .filter((el) => isVisible(el) && inViewport(el.getBoundingClientRect()));

    // Content rects (glyph-tight text + foreground media)
    const TEXT_LEN_MIN = 3, FONT_MIN = 12;
    const contentRects = [];

    // Media
    for (const el of allInFoldVisible) {
      if (!isMediaTag(el)) continue;
      const i = intersect(el.getBoundingClientRect()); if (i) contentRects.push(i);
    }

    // Text nodes
    const acceptText = { acceptNode: (n) =>
      (n.nodeType === Node.TEXT_NODE && (n.textContent || "").trim().length >= TEXT_LEN_MIN)
        ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP };
    for (const root of allInFoldVisible) {
      const stRoot = getComputedStyle(root);
      const fsRoot = parseFloat(stRoot.fontSize || "0");
      const alphaRoot = rgbaAlpha(stRoot.color || "rgba(0,0,0,1)");
      if (fsRoot < FONT_MIN || alphaRoot <= 0.05) continue;

      const tw = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, acceptText);
      let node; 
      while ((node = tw.nextNode())) {
        try {
          const rng = document.createRange(); rng.selectNodeContents(node);
          const rects = Array.from(rng.getClientRects());
          for (const rr of rects) {
            const i = intersect(rr); if (!i) continue;
            if (i.width < 2 || i.height < fsRoot * 0.4) continue;
            contentRects.push(i);
          }
        } catch {}
      }
    }

    // Grid union
    const ROWS = 40, COLS = 24, cellW = vpW / COLS, cellH = vpH / ROWS;
    const cells = new Set();
    for (const r of contentRects) {
      const x0 = Math.max(0, Math.floor(r.left / cellW));
      const x1 = Math.min(COLS - 1, Math.floor((r.right - 0.01) / cellW));
      const y0 = Math.max(0, Math.floor(r.top / cellH));
      const y1 = Math.min(ROWS - 1, Math.floor((r.bottom - 0.01) / cellH));
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) cells.add(y * COLS + x);
    }
    const foldCoveragePct = Math.min(100, Math.round((cells.size / (ROWS * COLS)) * 100));

    // CTA visibility after overlay removal (authoritative for UI)
    const CTA_RE = /(buy|add to cart|add-to-cart|shop now|sign up|sign-up|get started|get-started|try|subscribe|join|book|order|checkout|continue|download|contact)/i;
    const actionable = Array.from(document.querySelectorAll('a,button,[role="button"],input[type="submit"],input[type="button"]'))
      .filter((el) => isVisible(el) && !el.disabled && getComputedStyle(el).cursor !== "default");
    const firstCtaInFold = actionable.some((el) => {
      const label = getText(el) || getAria(el) || (el.value || "").toLowerCase();
      return CTA_RE.test(label) && inViewport(el.getBoundingClientRect());
    });

    return { foldCoveragePct, firstCtaInFold };
  });
}


/* --------------------------------- /render --------------------------------
 * Body: { url: string, device: keyof DEVICE_MAP, debugOverlay?: boolean }
 * Returns: clean screenshot (overlay removed) + fold audit (overlay-excluded).
 * -------------------------------------------------------------------------- */
app.post("/render", requireAuth, async (req, res) => {
  const { url, device } = req.body || {};
  const debugOverlay =
    (req.body && (req.body.debugOverlay === true || req.body.debugOverlay === "1")) ||
    (req.query && (req.query.debugOverlay === "1" || req.query.debugOverlay === "true"));

  if (!url || !device || !DEVICE_MAP[device] || !isAllowedUrl(url)) {
    return res.status(400).json({ error: "bad input" });
  }

  const start = Date.now();
  let context = null;

  try {
    const b = await getBrowser();
    const conf = DEVICE_MAP[device];

    context = await b.newContext({
      ...conf.profile,
      viewport: conf.vp, // enforce exact fold dimensions
    });

    const page = await context.newPage();
    page.setDefaultNavigationTimeout(15000);
    page.setDefaultTimeout(15000);

    // Light request interception to speed up/stabilize loads
    await page.route("**/*", (route) => {
      const u = route.request().url();
      if (
        /\.(mp4|mov|avi|m4v|webm)$/i.test(u) ||
        /(hotjar|fullstory|segment|google-analytics|gtm|optimizely|clarity|doubleclick)/i.test(u)
      ) return route.abort();
      return route.continue();
    });

    // Navigate & settle
    const tNav0 = Date.now();
    await page.goto(url, { waitUntil: "networkidle" });
    const nav_ms = Date.now() - tNav0;

    const tSettle0 = Date.now();
    await page.waitForTimeout(800);
    const settle_ms = Date.now() - tSettle0;

    /* ----------------------------- In-page audit ---------------------------- */
    const tAudit0 = Date.now();
    const ux = await page.evaluate(() => {
      const vpW = window.innerWidth, vpH = window.innerHeight;
      const VP = { left: 0, top: 0, right: vpW, bottom: vpH, width: vpW, height: vpH };

      const inViewport = (r) => r.top < vpH && r.bottom > 0 && r.left < vpW && r.right > 0;
      const isVisible = (el) => {
        const st = getComputedStyle(el);
        if (st.visibility === "hidden" || st.display === "none" || st.opacity === "0") return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      };
      const intersect = (r) => {
        const left = Math.max(0, r.left), top = Math.max(0, r.top);
        const right = Math.min(vpW, r.right), bottom = Math.min(vpH, r.bottom);
        const w = Math.max(0, right - left), h = Math.max(0, bottom - top);
        return w > 0 && h > 0 ? { left, top, right, bottom, width: w, height: h } : null;
      };
      const rgbaAlpha = (rgba) => {
        if (!rgba || !rgba.startsWith("rgba")) return 1;
        const p = rgba.replace(/^rgba\(|\)$/g, "").split(",");
        return parseFloat(p[3] || "1");
      };
      const getText = (el) => (el.innerText || el.textContent || "").trim().toLowerCase();
      const getAria = (el) => (el.getAttribute("aria-label") || el.getAttribute("title") || "").trim().toLowerCase();
      const isMediaTag = (el) => ["IMG","VIDEO","CANVAS","SVG"].includes(el.tagName);

      // CTA visible in-fold?
      const CTA_RE = /(buy|add to cart|add-to-cart|shop now|sign up|sign-up|get started|get-started|try|subscribe|join|book|order|checkout|continue|download|contact)/i;
      const actionable = Array.from(document.querySelectorAll('a,button,[role="button"],input[type="submit"],input[type="button"]'))
        .filter((el) => isVisible(el) && !el.disabled && getComputedStyle(el).cursor !== "default");
      const firstCtaInFold = actionable.some((el) =>
        CTA_RE.test(getText(el) || getAria(el) || (el.value || "")) && inViewport(el.getBoundingClientRect())
      );

      // All visible elements intersecting the fold
      const allInFoldVisible = Array.from(document.querySelectorAll("body *"))
        .filter((el) => isVisible(el) && inViewport(el.getBoundingClientRect()));

      // Typography bounds in fold
      let maxFont = 0, minFont = Infinity;
      for (const el of allInFoldVisible) {
        const fs = parseFloat(getComputedStyle(el).fontSize || "0");
        if (fs > 0) { if (fs > maxFont) maxFont = fs; if (fs < minFont) minFont = fs; }
      }

      // Small tap targets in fold
      const smallTapTargets = actionable.filter((el) => {
        const r = el.getBoundingClientRect();
        return inViewport(r) && (r.width < 44 || r.height < 44);
      }).length;

      // Viewport meta
      const hasViewportMeta = !!document.querySelector('meta[name="viewport"]');

      // Safe-area CSS (approx)
      let usesSafeAreaCSS = false;
      for (const ss of Array.from(document.styleSheets)) {
        try {
          for (const rule of Array.from(ss.cssRules)) {
            if (rule.cssText && rule.cssText.includes("safe-area-inset")) { usesSafeAreaCSS = true; break; }
          }
          if (usesSafeAreaCSS) break;
        } catch {}
      }

      /* ------------------------- Overlay detection ------------------------- */
      const overlayCandidates = Array.from(document.querySelectorAll("body *")).filter((el) => {
        if (!isVisible(el)) return false;
        const st = getComputedStyle(el);
        if (!["fixed","sticky"].includes(st.position)) return false;
        const r = el.getBoundingClientRect(); if (!inViewport(r)) return false;
        const inter = intersect(r); if (!inter) return false;
        const areaPct = (inter.width * inter.height) / (vpW * vpH);
        const z = parseInt(st.zIndex || "0", 10) || 0;
        if (areaPct >= 0.15 && z >= 100) return true; // sizable overlay
        const hint = (el.id + " " + el.className + " " + (el.getAttribute("role") || "") + " " + (el.getAttribute("aria-label") || "")).toLowerCase();
        return /(cookie|consent|gdpr|privacy|cmp)/.test(hint);
      });

      // Mark overlays so Node can hide them before screenshot
      overlayCandidates.forEach((el) => el.setAttribute("data-foldy-overlay", "1"));

      const overlayRects = overlayCandidates
        .map((el) => intersect(el.getBoundingClientRect()))
        .filter(Boolean);

      // "Blockers" = very large/top-covering overlays
      const overlayBlockers = overlayCandidates.filter((el) => {
        const r = el.getBoundingClientRect();
        const inter = intersect(r);
        const areaPct = inter ? (inter.width * inter.height) / (vpW * vpH) : 0;
        const topCover = r.top <= 0 && r.height >= vpH * 0.25;
        return areaPct >= 0.30 || topCover;
      }).length;

      /* ------------------ Content rects (glyph-tight) ------------------ */
      const TEXT_LEN_MIN = 3, FONT_MIN = 12;
      const contentRects = [];

      // Foreground media
      for (const el of allInFoldVisible) {
        if (!isMediaTag(el)) continue;
        const i = intersect(el.getBoundingClientRect()); if (i) contentRects.push(i);
      }

      // Text nodes
      const acceptText = { acceptNode: (n) =>
        (n.nodeType === Node.TEXT_NODE && (n.textContent || "").trim().length >= TEXT_LEN_MIN)
          ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP };
      for (const root of allInFoldVisible) {
        const stRoot = getComputedStyle(root);
        const fsRoot = parseFloat(stRoot.fontSize || "0");
        const alphaRoot = rgbaAlpha(stRoot.color || "rgba(0,0,0,1)");
        if (fsRoot < FONT_MIN || alphaRoot <= 0.05) continue;

        const tw = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, acceptText);
        let node;
        while ((node = tw.nextNode())) {
          try {
            const rng = document.createRange(); rng.selectNodeContents(node);
            const rects = Array.from(rng.getClientRects());
            for (const rr of rects) {
              const i = intersect(rr); if (!i) continue;
              if (i.width < 2 || i.height < fsRoot * 0.4) continue; // filter slivers
              contentRects.push(i);
            }
          } catch {}
        }
      }

      // Painted rects (debug/insight)
      const paintedRects = [...contentRects];
      for (const el of allInFoldVisible) {
        if (isMediaTag(el)) continue;
        const st = getComputedStyle(el);
        let paints = false;
        if (st.backgroundImage && st.backgroundImage !== "none") paints = true;
        const bg = st.backgroundColor || "";
        if (!paints && bg && bg !== "transparent") paints = !bg.startsWith("rgba") || rgbaAlpha(bg) > 0.05;
        if (!paints) {
          const hasBorder =
            ["borderTopWidth","borderRightWidth","borderBottomWidth","borderLeftWidth"].some(k => parseFloat(st[k]) > 0) &&
            ["borderTopColor","borderRightColor","borderBottomColor","borderLeftColor"].some(k => (st[k]||"") !== "transparent");
          paints = hasBorder;
        }
        if (paints) { const i = intersect(el.getBoundingClientRect()); if (i) paintedRects.push(i); }
      }

      // Grid union helpers
      const ROWS = 40, COLS = 24, cellW = vpW / COLS, cellH = vpH / ROWS;
      const toCells = (rects) => {
        const set = new Set();
        for (const r of rects) {
          const x0 = Math.max(0, Math.floor(r.left / cellW));
          const x1 = Math.min(COLS - 1, Math.floor((r.right - 0.01) / cellW));
          const y0 = Math.max(0, Math.floor(r.top / cellH));
          const y1 = Math.min(ROWS - 1, Math.floor((r.bottom - 0.01) / cellH));
          for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) set.add(y * COLS + x);
        }
        return set;
      };
      const pct = (set) => Math.min(100, Math.round((set.size / (ROWS * COLS)) * 100));

      const contentCells = toCells(contentRects);
      const paintedCells = toCells(paintedRects);
      const overlayCells = toCells(overlayRects);

      const visibleFoldCoveragePct = pct(contentCells);           // includes overlay
      const overlayCoveragePct = pct(overlayCells);
      const underlayCells = new Set([...contentCells].filter((id) => !overlayCells.has(id)));
      const foldCoveragePct = pct(underlayCells);                  // EXCLUDES overlay (use for score)

      return {
        firstCtaInFold,
        foldCoveragePct,                // clean / baseline
        visibleFoldCoveragePct,         // as-seen
        paintedCoveragePct: pct(paintedCells),
        overlayCoveragePct,
        overlayBlockers,
        overlayElemsMarked: overlayCandidates.length,
        maxFontPx: maxFont || 0,
        minFontPx: Number.isFinite(minFont) ? minFont : 0,
        smallTapTargets,
        hasViewportMeta,
        usesSafeAreaCSS
      };
    });
    const audit_ms = Date.now() - tAudit0;

    /* ------------------- Screenshots (clean-only by default) ------------------- */
    const { width, height } = conf.vp;

    // Optional: with-overlay screenshot for debugging
    let pngWithOverlayBase64 = null;
    if (debugOverlay) {
      const bufOverlay = await page.screenshot({
        type: "png",
        fullPage: false,
        clip: { x: 0, y: 0, width, height },
      });
      pngWithOverlayBase64 = bufOverlay.toString("base64");
    }

    // Hide overlays + settle a moment
    const tHide0 = Date.now();
    await hideOverlaysAndUnlock(page);
    await page.waitForTimeout(120);
    const hide_ms = Date.now() - tHide0;

    // Recompute fold on the CLEAN view so metrics match the screenshot
    const tClean0 = Date.now();
    const clean = await evalCleanFold(page);
    const clean_ms = Date.now() - tClean0;
    
    // Overwrite the fields we display/score
    ux.foldCoveragePct = clean.foldCoveragePct;
    ux.firstCtaInFold  = clean.firstCtaInFold;


    const tShot0 = Date.now();
    const buf = await page.screenshot({
      type: "png",
      fullPage: false,
      clip: { x: 0, y: 0, width, height },
    });
    const pngBase64 = buf.toString("base64");
    const screenshot_ms = Date.now() - tShot0;

    // Device meta
    const meta = {
      viewport: { width, height },
      dpr: conf.profile.deviceScaleFactor || 1,
      ua: conf.profile.userAgent || null,
      label: conf.label,
    };

    // Build response
    const payload = {
      device,
      deviceMeta: meta,
      pngBase64, // CLEAN (overlay removed)
      ux,
      timings: {
        nav_ms,
        settle_ms,
        audit_ms,
        hide_ms,
        clean_ms, 
        screenshot_ms,
        total_ms: Date.now() - start,
      },
    };
    if (debugOverlay && pngWithOverlayBase64) {
      payload.pngWithOverlayBase64 = pngWithOverlayBase64; // optional
    }

    res.json(payload);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  } finally {
    try { if (context) await context.close(); } catch {}
  }
});

/* --------------------------- Graceful shutdown ---------------------------- */
process.on("SIGTERM", async () => {
  try { if (browser) await browser.close(); } finally { process.exit(0); }
});

app.listen(PORT, () => {
  console.log(`foldy-render up on :${PORT}`);
});
