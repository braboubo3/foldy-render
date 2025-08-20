/**
 * foldy-render — Replit microservice
 * One request per device → headless Chromium → returns:
 *  - first-viewport screenshot (base64 PNG)
 *  - fold-focused DOM audit (CTA-in-fold, font sizes, tap targets, overlays, viewport meta, safe-area)
 *  - simple timings (nav/audit/screenshot/total)
 *
 * Auth: Bearer token in Authorization header (RENDER_TOKEN)
 * Security: basic SSRF allowlist (http/https only, no localhost/private ranges)
 *
 * Tip: ensure package.json has:
 *  {
 *    "type": "module",
 *    "scripts": { "start": "node index.js", "postinstall": "npx playwright install chromium" }
 *  }
 */

import express from "express";
import { chromium, devices } from "playwright";

const PORT = process.env.PORT || 3000;
const AUTH = process.env.RENDER_TOKEN || "devtoken"; // set a strong secret in Replit secrets

const app = express();
app.use(express.json({ limit: "8mb" })); // accept base64 payloads comfortably

/** -------------------------------------------------------
 * Device map (PoC approximations using built-in profiles)
 * - We override viewport to exact px we want for the fold.
 * - DPR/UA/etc. come from the Playwright device profile.
 * ------------------------------------------------------*/
const DEVICE_MAP = {
  iphone_se_2: {
    label: "iPhone SE (2nd gen)",
    vp: { width: 375, height: 667 },
    profile: devices["iPhone SE"],
  },
  iphone_15_pro: {
    label: "iPhone 15 Pro",
    vp: { width: 393, height: 852 },
    // close enough for PoC — Playwright doesn’t ship an “iPhone 15 Pro” preset yet
    profile: devices["iPhone 13 Pro"],
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

/** ---------------------------
 * Simple auth middleware
 * --------------------------*/
function requireAuth(req, res, next) {
  const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!token || token !== AUTH) {
    return res.status(401).json({ error: "unauthorized" });
  }
  next();
}

/** ---------------------------------------------------
 * Basic SSRF guard: allow only http/https; block
 * localhost and RFC1918 private ranges by hostname.
 * NOTE: This does NOT resolve DNS → IP. For MVP.
 * --------------------------------------------------*/
function isAllowedUrl(u) {
  try {
    const { protocol, hostname } = new URL(u);
    if (!/^https?:$/.test(protocol)) return false;
    // block obvious internal targets
    if (
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      /^10\./.test(hostname) ||
      /^192\.168\./.test(hostname) ||
      /^172\.(1[6-9]|2\d|3[0-1])\./.test(hostname)
    ) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

/** ---------------------------------
 * Keep one browser per process
 *  - contexts/pages are per request
 *  - auto-relaunch if disconnected
 * --------------------------------*/
let browser = null;

async function getBrowser() {
  if (browser && browser.isConnected()) return browser;
  if (browser) {
    try {
      await browser.close();
    } catch {
      /* ignore */
    }
  }
  browser = await chromium.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage", // small /dev/shm in tiny containers
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
    ],
  });
  browser.on("disconnected", () => {
    browser = null;
  });
  return browser;
}

/** ---------------
 * Health endpoint
 *  - warms the pod
 *  - ensures browser is ready
 * ---------------*/
app.get("/health", async (_req, res) => {
  try {
    await getBrowser();
    res.json({ ok: true, up: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

/** -----------------------------------------------
 * Main endpoint: /render
 * Body: { url: string, device: keyof DEVICE_MAP }
 * Returns:
 *  {
 *    device, deviceMeta: { viewport, dpr, ua },
 *    pngBase64, ux: { ...fold heuristics... },
 *    timings: { nav_ms, settle_ms, audit_ms, screenshot_ms, total_ms }
 *  }
 * ----------------------------------------------*/
app.post("/render", requireAuth, async (req, res) => {
  const { url, device } = req.body || {};
  if (!url || !device || !DEVICE_MAP[device] || !isAllowedUrl(url)) {
    return res.status(400).json({ error: "bad input" });
  }

  const start = Date.now();
  let context; // ensure close in finally

  try {
    const b = await getBrowser();
    const conf = DEVICE_MAP[device];

    // One isolated context per job, with our profile + exact viewport
    context = await b.newContext({
      ...conf.profile,
      viewport: conf.vp,
    });

    const page = await context.newPage();
    page.setDefaultNavigationTimeout(15000);
    page.setDefaultTimeout(15000);

    // Optional: block heavy third-parties to stabilize rendering & reduce CPU
    await page.route("**/*", (route) => {
      const u = route.request().url();
      if (
        /\.(mp4|mov|avi|m4v|webm)$/i.test(u) ||
        /(hotjar|fullstory|segment|google-analytics|gtm|optimizely|clarity|doubleclick)/i.test(
          u
        )
      ) {
        return route.abort();
      }
      return route.continue();
    });

    // --- Navigate & settle
    const tNav0 = Date.now();
    await page.goto(url, { waitUntil: "networkidle" });
    const nav_ms = Date.now() - tNav0;

    const tSettle0 = Date.now();
    await page.waitForTimeout(800); // allow late JS to settle
    const settle_ms = Date.now() - tSettle0;

    // --- DOM audit (runs in-page)
    const tAudit0 = Date.now();
const ux = await page.evaluate(() => {
  const vpH = window.innerHeight;
  const vpW = window.innerWidth;

  const inViewport = (r) => r.top < vpH && r.bottom > 0 && r.left < vpW && r.right > 0;

  const isVisible = (el) => {
    const st = getComputedStyle(el);
    if (st.visibility === "hidden" || st.display === "none" || st.opacity === "0") return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };

  const getText = (el) => (el.innerText || el.textContent || "").trim().toLowerCase();
  const getAria = (el) => (el.getAttribute("aria-label") || el.getAttribute("title") || "").trim().toLowerCase();

  // CTA detection (text, aria-label, or input value)
  const CTA_RE = /(buy|add to cart|add-to-cart|shop now|sign up|sign-up|get started|get-started|try|subscribe|join|book|order|download|contact|checkout|continue)/i;
  const actionCandidates = Array.from(
    document.querySelectorAll('a,button,[role="button"],input[type="submit"],input[type="button"]')
  ).filter(isVisible);

  const firstCtaInFold = actionCandidates.some((el) => {
    const label = getText(el) || getAria(el) || (el.value || "").toLowerCase();
    if (!CTA_RE.test(label)) return false;
    const r = el.getBoundingClientRect();
    return inViewport(r);
  });

  // All visible elements intersecting the first viewport
  const inFoldVisible = Array.from(document.querySelectorAll("body *")).filter(
    (el) => isVisible(el) && inViewport(el.getBoundingClientRect())
  );

  // Typography stats
  let maxFont = 0;
  let minFont = Infinity;
  for (const el of inFoldVisible) {
    const fs = parseFloat(getComputedStyle(el).fontSize || "0");
    if (fs > 0) {
      if (fs > maxFont) maxFont = fs;
      if (fs < minFont) minFont = fs;
    }
  }

  // Tap targets under 44x44 within the fold
  const smallTapTargets = actionCandidates.filter((el) => {
    const r = el.getBoundingClientRect();
    return inViewport(r) && (r.width < 44 || r.height < 44);
  }).length;

  // Viewport meta
  const hasViewportMeta = !!document.querySelector('meta[name="viewport"]');

  // Overlays: large fixed/sticky with high z-index covering ≥30% of the fold
  const overlayBlockers = Array.from(document.querySelectorAll("body *")).filter((el) => {
    const st = getComputedStyle(el);
    if (!["fixed", "sticky"].includes(st.position)) return false;
    const z = parseInt(st.zIndex || "0", 10);
    if (isNaN(z) || z < 1000) return false;
    const r = el.getBoundingClientRect();
    if (!inViewport(r)) return false;
    const w = Math.max(0, Math.min(r.right, vpW) - Math.max(r.left, 0));
    const h = Math.max(0, Math.min(r.bottom, vpH) - Math.max(r.top, 0));
    const area = w * h;
    return r.top <= 0 && area >= vpW * vpH * 0.3;
  }).length;

  // Safe-area CSS usage (approx)
  let usesSafeAreaCSS = false;
  for (const ss of Array.from(document.styleSheets)) {
    try {
      for (const rule of Array.from(ss.cssRules)) {
        if (rule.cssText && rule.cssText.includes("safe-area-inset")) {
          usesSafeAreaCSS = true; break;
        }
      }
      if (usesSafeAreaCSS) break;
    } catch { /* cross-origin stylesheet, ignore */ }
  }

  // Fold coverage via coarse grid (union of areas; avoids overlap double-count)
  const ROWS = 40, COLS = 24;
  const cellW = vpW / COLS, cellH = vpH / ROWS;
  const covered = new Set();
  for (const el of inFoldVisible) {
    const r = el.getBoundingClientRect();
    const x0 = Math.max(0, Math.floor(r.left / cellW));
    const x1 = Math.min(COLS - 1, Math.floor((r.right - 0.01) / cellW));
    const y0 = Math.max(0, Math.floor(r.top / cellH));
    const y1 = Math.min(ROWS - 1, Math.floor((r.bottom - 0.01) / cellH));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) covered.add(y * COLS + x);
    }
  }
  const foldCoveragePct = Math.min(100, Math.round((covered.size / (ROWS * COLS)) * 100));

  return {
    firstCtaInFold,
    foldCoveragePct,
    maxFontPx: maxFont || 0,
    minFontPx: Number.isFinite(minFont) ? minFont : 0,
    smallTapTargets,
    hasViewportMeta,
    overlayBlockers,
    usesSafeAreaCSS,
  };
});


    });
    const audit_ms = Date.now() - tAudit0;

    // --- Viewport screenshot (first fold only)
    const tShot0 = Date.now();
    const { width, height } = DEVICE_MAP[device].vp;
    const buf = await page.screenshot({
      type: "png",
      fullPage: false,
      clip: { x: 0, y: 0, width, height },
    });
    const pngBase64 = buf.toString("base64");
    const screenshot_ms = Date.now() - tShot0;

    // --- Response
    const meta = {
      viewport: { width, height },
      dpr: DEVICE_MAP[device].profile.deviceScaleFactor || 1,
      ua: DEVICE_MAP[device].profile.userAgent || null,
      label: DEVICE_MAP[device].label,
    };

    res.json({
      device,
      deviceMeta: meta,
      pngBase64,
      ux,
      timings: {
        nav_ms,
        settle_ms,
        audit_ms,
        screenshot_ms,
        total_ms: Date.now() - start,
      },
    });
  } catch (e) {
    // Return partial timings if we have them; n8n can decide to retry
    res.status(500).json({ error: String(e) });
  } finally {
    // Always clean up the isolated context
    try {
      if (context) await context.close();
    } catch {
      /* ignore */
    }
  }
});

/** Graceful shutdown (helps in hosted envs) */
process.on("SIGTERM", async () => {
  try {
    if (browser) await browser.close();
  } finally {
    process.exit(0);
  }
});

app.listen(PORT, () => {
  console.log(`foldy-render up on :${PORT}`);
});
