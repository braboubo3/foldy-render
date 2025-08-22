// Foldy — Render Service (stabilized)
// One shared Chromium per process; 1 context per request.
// API: POST /render -> { clean PNG + UX metrics + timings }, GET /health.
// Auth: Bearer token (RENDER_TOKEN). SSRF guard: blocks non-http(s) & private ranges.
// Debug flags: debugOverlay, debugRects, debugHeatmap (in body or query).

/* eslint-disable no-console */
import express from "express";
import { chromium } from "playwright";
import dns from "node:dns/promises";
import net from "node:net";
import * as url from "node:url";

const PORT = process.env.PORT || 3000;
const RENDER_TOKEN = process.env.RENDER_TOKEN;

if (!RENDER_TOKEN) {
  console.error("Missing RENDER_TOKEN");
  process.exit(1);
}

const app = express();
app.use(express.json({ limit: "1mb" }));

/** ---------- Auth ---------- **/
function authMiddleware(req, res, next) {
  const hdr = req.headers.authorization || "";
  const token = hdr.startsWith("Bearer ") ? hdr.slice(7) : "";
  if (!token || token !== RENDER_TOKEN) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }
  next();
}

/** ---------- SSRF Guard ---------- **/
const PRIVATE_CIDRS = [
  "127.0.0.0/8", // loopback
  "10.0.0.0/8",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "0.0.0.0/8",
  "169.254.0.0/16", // link-local
];

function ipInCidr(ip, cidr) {
  const [range, bitsStr] = cidr.split("/");
  const bits = parseInt(bitsStr, 10);
  const ipBuf = net.isIP(ip) === 4 ? ipV4ToBuf(ip) : null;
  const rangeBuf = ipV4ToBuf(range);
  if (!ipBuf) return false;
  const mask = ~((1 << (32 - bits)) - 1);
  return (bufToInt(ipBuf) & mask) === (bufToInt(rangeBuf) & mask);
}
function ipV4ToBuf(ip) {
  return Buffer.from(ip.split(".").map((n) => parseInt(n, 10)));
}
function bufToInt(b) {
  return (b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3];
}
async function assertUrlAllowed(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw Object.assign(new Error("Invalid URL"), { status: 400 });
  }
  if (!["http:", "https:"].includes(u.protocol)) {
    throw Object.assign(new Error("Only http/https allowed"), { status: 422 });
  }
  const hostLower = (u.hostname || "").toLowerCase();
  if (
    hostLower === "localhost" ||
    hostLower === "127.0.0.1" ||
    hostLower === "::1"
  ) {
    throw Object.assign(new Error("Localhost blocked"), { status: 422 });
  }

  // Resolve A/AAAA and block private ranges. (We only handle IPv4 here; IPv6 localhost already blocked.)
  let addrs = [];
  try {
    const a = await dns.resolve4(u.hostname, { ttl: false });
    addrs = a;
  } catch (e) {
    // If resolve4 fails, still allow navigation; Playwright will attempt. But we block obvious local names earlier.
    addrs = [];
  }
  for (const ip of addrs) {
    for (const cidr of PRIVATE_CIDRS) {
      if (ipInCidr(ip, cidr)) {
        throw Object.assign(new Error("Private network blocked"), {
          status: 422,
        });
      }
    }
  }
  return u.toString();
}

/** ---------- Devices (MVP) ---------- **/
// Specified in docs with explicit viewports & DPRs
// iphone_15_pro (393×852), iphone_15_pro_max (430×932), pixel_8 (412×915), galaxy_s23 (360×800), iphone_se_2 (375×667)
const DEVICES = {
  iphone_15_pro: {
    label: "iPhone 15 Pro",
    viewport: { width: 393, height: 852 },
    dpr: 3,
    ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
    mobile: true,
  },
  iphone_15_pro_max: {
    label: "iPhone 15 Pro Max",
    viewport: { width: 430, height: 932 },
    dpr: 3,
    ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
    mobile: true,
  },
  pixel_8: {
    label: "Pixel 8",
    viewport: { width: 412, height: 915 },
    dpr: 2.625,
    ua: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36",
    mobile: true,
  },
  galaxy_s23: {
    label: "Galaxy S23",
    viewport: { width: 360, height: 800 },
    dpr: 3,
    ua: "Mozilla/5.0 (Linux; Android 14; SM-S911B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36",
    mobile: true,
  },
  iphone_se_2: {
    label: "iPhone SE (2nd gen)",
    viewport: { width: 375, height: 667 },
    dpr: 2,
    ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
    mobile: true,
  },
};

function deviceFromKey(key) {
  const d = DEVICES[key];
  if (!d) return null;
  const contextOpts = {
    viewport: d.viewport,
    deviceScaleFactor: d.dpr,
    isMobile: !!d.mobile,
    hasTouch: true,
    userAgent: d.ua,
    locale: "en-US",
  };
  return { key, label: d.label, contextOpts };
}

/** ---------- Shared browser ---------- **/
let browserPromise = null;
async function getBrowser() {
  if (!browserPromise) {
    browserPromise = chromium.launch({
      headless: true,
      args: [
        "--disable-dev-shm-usage",
        "--no-sandbox",
        "--disable-gpu",
        "--no-default-browser-check",
      ],
    });
  }
  return browserPromise;
}

/** ---------- Helpers: timing ---------- **/
const now = () => Date.now();
function ms(start, end) {
  return Math.max(0, Math.round(end - start));
}

/** ---------- Page setup: network hygiene & animation kill ---------- **/
const ABORT_PATTERNS = [
  // analytics/ads
  "googletagmanager.com",
  "google-analytics.com",
  "doubleclick.net",
  "facebook.net",
  "hotjar.com",
  "fullstory.com",
  "segment.io",
  "mixpanel.com",
  "amplitude.com",
  "newrelic.com",
  "clarity.ms",
  // heavy media
  ".mp4",
  ".m3u8",
  ".webm",
  ".mov",
  "youtube.com",
  "vimeo.com",
  "player.vimeo.com",
];

async function prepPage(page) {
  // Abort trackers & big media
  await page.route("**/*", (route) => {
    const url = route.request().url().toLowerCase();
    const shouldAbort = ABORT_PATTERNS.some((p) => url.includes(p));
    if (shouldAbort) return route.abort();
    return route.continue();
  });

  await page.addInitScript(() => {
    try {
      // Reduce animations/transitions for stability
      const s = document.createElement("style");
      s.id = "_foldy_anim_off";
      s.textContent = `
        * { animation: none !important; transition: none !important; }
        html, body { scroll-behavior: auto !important; }
      `;
      document.documentElement.appendChild(s);
    } catch { /* noop */ }
  });

  page.setDefaultTimeout(15000);
  page.setDefaultNavigationTimeout(15000);
}

/** ---------- In-page auditing code ---------- **/
const PAGE_EVAL = {
  // Return as-seen screenshot PNG (called before hiding overlays when debugOverlay=1)
  async asSeen(page) {
    return page.screenshot({ type: "png", fullPage: false });
  },

  // Scan overlays before hide; identify candidates and compute stats in fold.
  async preHideOverlays(page) {
    return page.evaluate(() => {
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const foldArea = vw * vh;

      function isVisible(el) {
        const r = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        if (style.visibility === "hidden" || style.display === "none" || style.opacity === "0") return false;
        if (r.width <= 0 || r.height <= 0) return false;
        return r.top < vh && r.left < vw && r.bottom > 0 && r.right > 0;
      }

      // Heuristics: fixed/sticky, large coverage, cookie keywords/buttons
      const candidates = Array.from(document.querySelectorAll("*"))
        .filter((el) => {
          const style = getComputedStyle(el);
          const pos = style.position;
          if (!(pos === "fixed" || pos === "sticky")) return false;
          if (!isVisible(el)) return false;
          const r = el.getBoundingClientRect();
          const inFoldWidth = Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0));
          const inFoldHeight = Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0));
          const inFoldArea = inFoldWidth * inFoldHeight;
          // Big panels or bars
          if (inFoldArea / foldArea < 0.12 && !(r.height > 48 && r.top > vh - 200)) return false;

          const txt = (el.innerText || "").toLowerCase();
          const looksLikeCookie =
            txt.includes("cookie") || txt.includes("consent") ||
            txt.includes("accept all") || txt.includes("agree");
          const likelyBar = r.height >= 48 && r.top >= vh - 220;
          return looksLikeCookie || likelyBar || inFoldArea / foldArea >= 0.25;
        });

      const overlayRects = candidates.map((el) => {
        const r = el.getBoundingClientRect();
        const x = Math.max(0, r.left);
        const y = Math.max(0, r.top);
        const w = Math.min(vw, r.right) - x;
        const h = Math.min(vh, r.bottom) - y;
        return [Math.max(0, Math.round(x)), Math.max(0, Math.round(y)), Math.max(0, Math.round(w)), Math.max(0, Math.round(h))];
      }).filter((r) => r[2] > 0 && r[3] > 0);

      // Merge overlap area for coverage
      function rectArea([, , w, h]) { return w * h; }
      const overlayArea = overlayRects.reduce((a, r) => a + rectArea(r), 0); // double-count overlaps; good enough for penalty roughness

      return {
        overlayRects,
        overlayElemsMarked: candidates.length,
        overlayCoveragePct: Math.min(100, Math.round((overlayArea / foldArea) * 100)),
        overlayBlockers: candidates.length > 0 ? 1 : 0 // "blockers" is a count of blocking entities; keep 1+ to trigger penalty
      };
    });
  },

  // Hide overlays in-place
  async hideOverlays(page, overlayRects) {
    await page.addStyleTag({
      content: `
        /* Hide selected overlays (best-effort) */
        [data-foldy-overlay-hide="1"] { display: none !important; }
      `,
    });
    await page.evaluate((rects) => {
      const vh = window.innerHeight;
      function tag(el) {
        el.setAttribute("data-foldy-overlay-hide", "1");
      }
      const elems = Array.from(document.querySelectorAll("*"));
      for (const el of elems) {
        const r = el.getBoundingClientRect();
        for (const [x, y, w, h] of rects) {
          // If element intersects with any overlay rect within the fold, hide it.
          const inter =
            Math.max(0, Math.min(r.right, x + w) - Math.max(r.left, x)) *
            Math.max(0, Math.min(r.bottom, y + h) - Math.max(r.top, y));
          if (inter > 0 && r.top < vh && r.bottom > 0) {
            tag(el);
            break;
          }
        }
      }
    }, overlayRects || []);
  },

  // Compute fold coverage + CTA/font/tap-target metrics on CLEAN view
  async cleanAudit(page) {
    return page.evaluate(() => {
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const foldArea = vw * vh;

      const GRID_ROWS = 24;
      const GRID_COLS = 40;
      const cellW = vw / GRID_COLS;
      const cellH = vh / GRID_ROWS;

      function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }
      function isVisible(el) {
        const style = getComputedStyle(el);
        if (style.visibility === "hidden" || style.display === "none" || style.opacity === "0") return false;
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) return false;
        if (r.bottom <= 0 || r.right <= 0 || r.top >= vh || r.left >= vw) return false;
        return true;
      }

      function rectsForTextNodes() {
        const rects = [];
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
          acceptNode: (n) => {
            if (!n.nodeValue || !n.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
            const el = n.parentElement;
            if (!el) return NodeFilter.FILTER_REJECT;
            if (!isVisible(el)) return NodeFilter.FILTER_REJECT;
            const style = getComputedStyle(el);
            // Ignore extremely small or script-like text
            const fontPx = parseFloat(style.fontSize || "0");
            if (fontPx < 8) return NodeFilter.FILTER_REJECT;
            return NodeFilter.FILTER_ACCEPT;
          }
        });
        let node;
        while ((node = walker.nextNode())) {
          const range = document.createRange();
          try {
            range.selectNodeContents(node);
            const r = range.getBoundingClientRect();
            if (r && r.width > 0 && r.height > 0 && r.top < vh && r.left < vw && r.bottom > 0 && r.right > 0) {
              const x = clamp(r.left, 0, vw), y = clamp(r.top, 0, vh);
              const w = clamp(r.right, 0, vw) - x, h = clamp(r.bottom, 0, vh) - y;
              if (w > 0 && h > 0) rects.push([x, y, w, h]);
            }
          } catch { /* skip */ }
          range.detach?.();
        }
        return rects;
      }

      function rectsForMedia() {
        const sels = "img,video,svg,canvas";
        const rects = [];
        document.querySelectorAll(sels).forEach((el) => {
          if (!isVisible(el)) return;
          const r = el.getBoundingClientRect();
          const x = clamp(r.left, 0, vw), y = clamp(r.top, 0, vh);
          const w = clamp(r.right, 0, vw) - x, h = clamp(r.bottom, 0, vh) - y;
          if (w > 0 && h > 0) rects.push([x, y, w, h]);
        });
        return rects;
      }

      function rectsForHeroBackgrounds() {
        const rects = [];
        const els = Array.from(document.querySelectorAll("body *"));
        els.forEach((el) => {
          if (!isVisible(el)) return;
          const cs = getComputedStyle(el);
          const bg = cs.backgroundImage;
          if (!bg || bg === "none") return;
          const repeat = cs.backgroundRepeat || "";
          const size = cs.backgroundSize || "";
          // Non-repeating, large-ish background (often hero)
          const nonRepeating = repeat.includes("no-repeat");
          const large = size.includes("cover") || size.includes("contain");
          if (!nonRepeating && !large) return;
          const r = el.getBoundingClientRect();
          const x = clamp(r.left, 0, vw), y = clamp(r.top, 0, vh);
          const w = clamp(r.right, 0, vw) - x, h = clamp(r.bottom, 0, vh) - y;
          const area = w * h;
          if (area / (vw * vh) >= 0.25) rects.push([x, y, w, h]);
        });
        return rects;
      }

      function rasterizeToGrid(rects) {
        const covered = new Set();
        rects.forEach(([x, y, w, h]) => {
          const x0 = Math.floor(x / cellW);
          const y0 = Math.floor(y / cellH);
          const x1 = Math.ceil((x + w) / cellW);
          const y1 = Math.ceil((y + h) / cellH);
          for (let gy = Math.max(0, y0); gy < Math.min(GRID_ROWS, y1); gy++) {
            for (let gx = Math.max(0, x0); gx < Math.min(GRID_COLS, x1); gx++) {
              covered.add(gy * GRID_COLS + gx);
            }
          }
        });
        return Array.from(covered.values()).sort((a, b) => a - b);
      }

      function ctaDetection() {
        const PHRASES = [
          // EN
          "get started","start now","buy","add to cart","book","sign up","log in","subscribe","try","contact","learn more",
          // FR
          "commencer","acheter","ajouter au panier","réserver","s'inscrire","se connecter","essayer","nous contacter","en savoir plus",
          // DE
          "jetzt starten","kaufen","in den warenkorb","buchen","registrieren","anmelden","testen","kontakt","mehr erfahren",
          // ES
          "empezar","comprar","añadir al carrito","reservar","regístrate","iniciar sesión","probar","contacto","más información",
          // PT
          "começar","comprar","adicionar ao carrinho","reservar","inscrever-se","entrar","experimentar","contato","saiba mais",
          // IT
          "inizia","compra","aggiungi al carrello","prenota","iscriviti","accedi","prova","contattaci","scopri di più"
        ];
        function hasCta(el) {
          const t = (el.innerText || "").toLowerCase();
          return PHRASES.some((p) => t.includes(p));
        }
        const candidates = Array.from(document.querySelectorAll("a,button,[role='button']"))
          .filter((el) => isVisible(el));
        // First CTA appearing within fold
        let firstInFold = false;
        for (const el of candidates) {
          const r = el.getBoundingClientRect();
          if (r.top >= 0 && r.bottom <= window.innerHeight) {
            if (hasCta(el)) { firstInFold = true; break; }
          }
        }
        return { firstCtaInFold: firstInFold };
      }

      // Fonts (min/max px) within fold
      function foldFontStats() {
        const els = Array.from(document.querySelectorAll("body *")).filter(isVisible);
        let minFont = Infinity, maxFont = 0;
        els.forEach((el) => {
          const r = el.getBoundingClientRect();
          if (r.bottom <= 0 || r.top >= vh) return;
          const px = parseFloat(getComputedStyle(el).fontSize || "0");
          if (px > 0) {
            minFont = Math.min(minFont, px);
            maxFont = Math.max(maxFont, px);
          }
        });
        return {
          minFontPx: Number.isFinite(minFont) ? Math.round(minFont) : 0,
          maxFontPx: Math.round(maxFont),
        };
      }

      function smallTapTargetsCount() {
        const targets = Array.from(document.querySelectorAll("a,button,[role='button'],input[type='button'],input[type='submit']"))
          .filter(isVisible);
        let count = 0;
        targets.forEach((el) => {
          const r = el.getBoundingClientRect();
          // Ignore common chat widgets anchored bottom-right
          const isChatBubble = (r.width <= 64 && r.height <= 64 && r.right >= vw - 80 && r.bottom >= vh - 140);
          if (isChatBubble) return;
          if (r.top < vh && r.bottom > 0) {
            if (Math.min(r.width, r.height) < 44) count++;
          }
        });
        return count;
      }

      function hasViewportMeta() {
        return !!document.querySelector('meta[name="viewport"]');
      }

      const textRects = rectsForTextNodes();
      const mediaRects = rectsForMedia();
      const heroRects = rectsForHeroBackgrounds();

      const allRects = textRects.concat(mediaRects, heroRects);
      const coveredCells = rasterizeToGrid(allRects);

      const paintedCoveragePct = 100; // reserved (legacy/debug)
      const foldCoveragePct = Math.round((coveredCells.length / (GRID_ROWS * GRID_COLS)) * 100);

      const { firstCtaInFold } = ctaDetection();
      const { minFontPx, maxFontPx } = foldFontStats();
      const smallTaps = smallTapTargetsCount();

      // Visible fold coverage prior to overlay hide (we don't compute here; handled pre-hide); keep visibleFoldCoveragePct as alias of clean for now.
      const visibleFoldCoveragePct = foldCoveragePct;

      // Detect presence of CSS safe-area usage (advisory only)
      const usesSafeAreaCSS = (() => {
        // quick heuristic: look for "env(safe-area-inset" in inline stylesheets
        const sheets = Array.from(document.querySelectorAll("style"));
        return sheets.some((s) => (s.textContent || "").includes("safe-area-inset"));
      })();

      return {
        ux: {
          firstCtaInFold,
          foldCoveragePct,
          visibleFoldCoveragePct,
          paintedCoveragePct,
          maxFontPx,
          minFontPx,
          smallTapTargets: smallTaps,
          hasViewportMeta: hasViewportMeta(),
          usesSafeAreaCSS,
        },
        debugRects: {
          rows: GRID_ROWS,
          cols: GRID_COLS,
          glyphRects: textRects.map((r) => r.map((n) => Math.round(n))),
          mediaRects: mediaRects.map((r) => r.map((n) => Math.round(n))),
          heroBgRects: heroRects.map((r) => r.map((n) => Math.round(n))),
          coveredCells
        }
      };
    });
  },

  // Draw heatmap overlay (clean) and screenshot result
  async heatmapPng(page, debugRects) {
    await page.addScriptTag({
      content: `(() => {
        const prev = document.getElementById("_foldy_heatmap");
        if (prev) prev.remove();
        const c = document.createElement("canvas");
        c.id = "_foldy_heatmap";
        c.width = window.innerWidth;
        c.height = window.innerHeight;
        c.style.position = "fixed";
        c.style.left = "0"; c.style.top = "0";
        c.style.zIndex = "9999999";
        c.style.pointerEvents = "none";
        document.body.appendChild(c);
      })();`,
      type: "text/javascript",
    });
    const buf = await page.screenshot({ type: "png", fullPage: false });
    await page.evaluate(({ debugRects }) => {
      const canvas = document.getElementById("_foldy_heatmap");
      if (!canvas) return;
      const ctx = canvas.getContext("2d");
      const w = canvas.width, h = canvas.height;

      // overlay grid coverage
      const cols = debugRects.cols, rows = debugRects.rows;
      const cellW = w / cols, cellH = h / rows;

      ctx.lineWidth = 1;
      ctx.strokeStyle = "rgba(0,0,0,0.2)";

      // cells
      debugRects.coveredCells.forEach((idx) => {
        const gy = Math.floor(idx / cols);
        const gx = idx % cols;
        ctx.fillStyle = "rgba(0, 255, 0, 0.20)"; // do not color-control externally; fixed here
        ctx.fillRect(gx * cellW, gy * cellH, cellW, cellH);
      });

      function drawRects(rects, color) {
        ctx.strokeStyle = color;
        rects.forEach(([x,y,w,h]) => {
          ctx.strokeRect(x, y, w, h);
        });
      }
      drawRects(debugRects.glyphRects, "rgba(0,128,0,0.7)");
      drawRects(debugRects.mediaRects, "rgba(0,0,255,0.7)");
      drawRects(debugRects.heroBgRects, "rgba(255,165,0,0.8)");
    }, { debugRects });
    const png = await page.screenshot({ type: "png", fullPage: false });
    await page.evaluate(() => {
      document.getElementById("_foldy_heatmap")?.remove();
    });
    return png;
  }
};

/** ---------- /health ---------- **/
app.get("/health", (_req, res) => {
  res.json({ ok: true, up: true });
});

/** ---------- /render ---------- **/
app.post("/render", authMiddleware, async (req, res) => {
  const t0 = now();
  const q = req.query || {};
  const body = req.body || {};

  const urlRaw = (body.url || q.url || "").trim();
  const deviceKey = (body.device || q.device || "").trim();
  const debugOverlay = parseInt(body.debugOverlay ?? q.debugOverlay ?? 0, 10) === 1;
  const debugRects = parseInt(body.debugRects ?? q.debugRects ?? 0, 10) === 1;
  const debugHeatmap = parseInt(body.debugHeatmap ?? q.debugHeatmap ?? 0, 10) === 1;

  if (!urlRaw || !deviceKey) {
    return res.status(400).json({ error: "Missing url or device" });
  }

  try {
    const safeUrl = await assertUrlAllowed(urlRaw);
    const device = deviceFromKey(deviceKey);
    if (!device) {
      return res.status(400).json({ error: "Invalid device" });
    }

    const browser = await getBrowser();
    const context = await browser.newContext(device.contextOpts);
    const page = await context.newPage();
    await prepPage(page);

    const navStart = now();
    let asSeenPngBuf = null;

    // Navigate & settle
    await page.goto(safeUrl, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
    const navEnd = now();

    // Optional pre-hide PNG
    if (debugOverlay) {
      asSeenPngBuf = await PAGE_EVAL.asSeen(page);
    }

    // Pre-hide audit (overlay scan)
    const preStart = now();
    const pre = await PAGE_EVAL.preHideOverlays(page);
    const preEnd = now();

    // Hide overlays
    const hideStart = now();
    await PAGE_EVAL.hideOverlays(page, pre.overlayRects || []);
    const hideEnd = now();

    // Clean audit
    const cleanStart = now();
    const { ux, debugRects: rectsForDebug } = await PAGE_EVAL.cleanAudit(page);
    const cleanEnd = now();

    // Clean screenshot
    const shotStart = now();
    const cleanPngBuf = await page.screenshot({ type: "png", fullPage: false });
    const shotEnd = now();

    // Optional heatmap PNG (clean)
    let heatmapBuf = null;
    if (debugHeatmap) {
      heatmapBuf = await PAGE_EVAL.heatmapPng(page, rectsForDebug);
    }

    await context.close();

    const deviceMeta = {
      viewport: device.contextOpts.viewport,
      dpr: device.contextOpts.deviceScaleFactor,
      ua: device.contextOpts.userAgent,
      label: device.label,
    };

    const payload = {
      device: deviceKey,
      deviceMeta,
      pngBase64: cleanPngBuf.toString("base64"),
      ux: {
        ...ux,
        overlayCoveragePct: pre.overlayCoveragePct,
        overlayBlockers: pre.overlayBlockers,
        overlayElemsMarked: pre.overlayElemsMarked,
      },
      timings: {
        nav_ms: ms(navStart, navEnd),
        settle_ms: 0,              // kept for compatibility; we fold into nav
        audit_ms: ms(preStart, preEnd),
        hide_ms: ms(hideStart, hideEnd),
        clean_ms: ms(cleanStart, cleanEnd),
        screenshot_ms: ms(shotStart, shotEnd),
        total_ms: ms(t0, now()),
      },
    };

    if (debugOverlay && asSeenPngBuf) {
      payload.pngWithOverlayBase64 = asSeenPngBuf.toString("base64");
    }
    if (debugRects) {
      payload.debug = rectsForDebug;
    }
    if (debugHeatmap && heatmapBuf) {
      payload.pngDebugBase64 = heatmapBuf.toString("base64");
    }

    return res.json(payload);
  } catch (err) {
    const status = err?.status || 500;
    console.error("Render error:", err?.message || err);
    return res.status(status).json({ error: String(err?.message || err) });
  }
});

/** ---------- Boot ---------- **/
let server;
getBrowser()
  .then(() => {
    server = app.listen(PORT, () => {
      console.log(`Foldy render up on :${PORT}`);
    });
  })
  .catch((e) => {
    console.error("Failed to launch Chromium:", e);
    process.exit(1);
  });

// Graceful shutdown
process.on("SIGTERM", async () => {
  try {
    await (await getBrowser()).close();
  } catch {}
  server?.close?.(() => process.exit(0));
});
