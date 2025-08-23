// Foldy — Render Service (stabilized: overlay-fix, faster heatmap, tighter text, CTA boxes, safer hero BG)
/* eslint-disable no-console */
import express from "express";
import { chromium } from "playwright";
import dns from "node:dns/promises";
import net from "node:net";

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
  "127.0.0.0/8",
  "10.0.0.0/8",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "0.0.0.0/8",
  "169.254.0.0/16",
];

function ipV4ToBuf(ip) { return Buffer.from(ip.split(".").map((n) => parseInt(n, 10))); }
function bufToInt(b) { return (b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]; }
function ipInCidr(ip, cidr) {
  const [range, bitsStr] = cidr.split("/");
  const bits = parseInt(bitsStr, 10);
  const ipBuf = net.isIP(ip) === 4 ? ipV4ToBuf(ip) : null;
  const rangeBuf = ipV4ToBuf(range);
  if (!ipBuf) return false;
  const mask = ~((1 << (32 - bits)) - 1);
  return (bufToInt(ipBuf) & mask) === (bufToInt(rangeBuf) & mask);
}
async function assertUrlAllowed(raw) {
  let u;
  try { u = new URL(raw); } catch { throw Object.assign(new Error("Invalid URL"), { status: 400 }); }
  if (!["http:", "https:"].includes(u.protocol)) {
    throw Object.assign(new Error("Only http/https allowed"), { status: 422 });
  }
  const hostLower = (u.hostname || "").toLowerCase();
  if (hostLower === "localhost" || hostLower === "127.0.0.1" || hostLower === "::1") {
    throw Object.assign(new Error("Localhost blocked"), { status: 422 });
  }
  let addrs = [];
  try { addrs = await dns.resolve4(u.hostname, { ttl: false }); } catch { addrs = []; }
  for (const ip of addrs) {
    for (const cidr of PRIVATE_CIDRS) {
      if (ipInCidr(ip, cidr)) throw Object.assign(new Error("Private network blocked"), { status: 422 });
    }
  }
  return u.toString();
}

/** ---------- Devices ---------- **/
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
  return {
    key,
    label: d.label,
    contextOpts: {
      viewport: d.viewport,
      deviceScaleFactor: d.dpr,
      isMobile: !!d.mobile,
      hasTouch: true,
      userAgent: d.ua,
      locale: "en-US",
    },
  };
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

/** ---------- Helpers ---------- **/
const now = () => Date.now();
function ms(start, end) { return Math.max(0, Math.round(end - start)); }

/** ---------- Page setup: block heavy 3P; stop animations ---------- **/
const ABORT_PATTERNS = [
  "googletagmanager.com","google-analytics.com","doubleclick.net","facebook.net",
  "hotjar.com","fullstory.com","segment.io","mixpanel.com","amplitude.com",
  "newrelic.com","clarity.ms",".mp4",".m3u8",".webm",".mov","youtube.com",
  "vimeo.com","player.vimeo.com",
];
async function prepPage(page) {
  await page.route("**/*", (route) => {
    const url = route.request().url().toLowerCase();
    const shouldAbort = ABORT_PATTERNS.some((p) => url.includes(p));
    if (shouldAbort) return route.abort();
    return route.continue();
  });
  await page.addInitScript(() => {
    try {
      const s = document.createElement("style");
      s.id = "_foldy_anim_off";
      s.textContent = `*{animation:none!important;transition:none!important} html,body{scroll-behavior:auto!important}`;
      document.documentElement.appendChild(s);
    } catch {}
  });
  page.setDefaultTimeout(15000);
  page.setDefaultNavigationTimeout(15000);
}

/** ---------- In-page auditing code ---------- **/
const PAGE_EVAL = {
  async asSeen(page) { return page.screenshot({ type: "png", fullPage: false }); },

  // Pre-hide: find overlay candidates & tag them; compute coverage stats
  async preHideOverlays(page) {
    return page.evaluate(() => {
      const vw = window.innerWidth, vh = window.innerHeight;
      const foldArea = vw * vh;

      function isVisible(el) {
        const r = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        if (style.visibility === "hidden" || style.display === "none" || style.opacity === "0") return false;
        if (r.width <= 0 || r.height <= 0) return false;
        return r.top < vh && r.left < vw && r.bottom > 0 && r.right > 0;
      }

      const candidates = Array.from(document.querySelectorAll("*")).filter((el) => {
        const cs = getComputedStyle(el);
        if (!(cs.position === "fixed" || cs.position === "sticky")) return false;
        if (!isVisible(el)) return false;
        const r = el.getBoundingClientRect();
        const inFoldWidth = Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0));
        const inFoldHeight = Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0));
        const inFoldArea = inFoldWidth * inFoldHeight;
        if (inFoldArea / foldArea < 0.12 && !(r.height > 48 && r.top > vh - 200)) return false;

        const txt = (el.innerText || "").toLowerCase();
        const looksLikeCookie = txt.includes("cookie") || txt.includes("consent") || txt.includes("accept all") || txt.includes("agree");
        const likelyBar = r.height >= 48 && r.top >= vh - 220;
        return looksLikeCookie || likelyBar || inFoldArea / foldArea >= 0.25;
      });

      // Tag actual overlay nodes so we can hide only them
      candidates.forEach((el) => { try { el.setAttribute("data-foldy-overlay-candidate", "1"); } catch {} });

      const overlayRects = candidates.map((el) => {
        const r = el.getBoundingClientRect();
        const x = Math.max(0, r.left);
        const y = Math.max(0, r.top);
        const w = Math.min(vw, r.right) - x;
        const h = Math.min(vh, r.bottom) - y;
        return [Math.max(0, Math.round(x)), Math.max(0, Math.round(y)), Math.max(0, Math.round(w)), Math.max(0, Math.round(h))];
      }).filter((r) => r[2] > 0 && r[3] > 0);

      const overlayArea = overlayRects.reduce((a, [, , w, h]) => a + (w * h), 0);

      return {
        overlayRects,
        overlayElemsMarked: candidates.length,
        overlayCoveragePct: Math.min(100, Math.round((overlayArea / foldArea) * 100)),
        overlayBlockers: candidates.length > 0 ? 1 : 0
      };
    });
  },

  // Hide ONLY the tagged overlays
  async hideOverlays(page) {
    await page.addStyleTag({ content: `[data-foldy-overlay-candidate="1"]{display:none!important}` });
  },

  // Clean audit (after hide)
  async cleanAudit(page) {
    return page.evaluate(() => {
      const vw = window.innerWidth, vh = window.innerHeight;
      const foldArea = vw * vh;

      const GRID_ROWS = 24;
      const GRID_COLS = 40;
      const cellW = vw / GRID_COLS;
      const cellH = vh / GRID_ROWS;

      function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }
      function isVisible(el) {
        const cs = getComputedStyle(el);
        if (cs.visibility === "hidden" || cs.display === "none" || cs.opacity === "0") return false;
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) return false;
        if (r.bottom <= 0 || r.right <= 0 || r.top >= vh || r.left >= vw) return false;
        return true;
      }

      // Text: per-line fragments (tighter than one giant box) + 1px erosion
      function rectsForTextNodes() {
        const rects = [];
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
          acceptNode: (n) => {
            if (!n.nodeValue || !n.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
            const el = n.parentElement;
            if (!el) return NodeFilter.FILTER_REJECT;
            if (!isVisible(el)) return NodeFilter.FILTER_REJECT;
            const fs = parseFloat(getComputedStyle(el).fontSize || "0");
            if (fs < 8) return NodeFilter.FILTER_REJECT;
            return NodeFilter.FILTER_ACCEPT;
          }
        });
        let node;
        while ((node = walker.nextNode())) {
          const range = document.createRange();
          try {
            range.selectNodeContents(node);
            const list = range.getClientRects();
            for (const r of list) {
              let x = Math.max(0, Math.min(r.left, vw));
              let y = Math.max(0, Math.min(r.top, vh));
              let w = Math.max(0, Math.min(r.right, vw) - x);
              let h = Math.max(0, Math.min(r.bottom, vh) - y);
              if (w <= 1 || h <= 6) continue; // drop tiny fragments
              // erode to avoid painting gutters
              x = Math.min(x + 1, vw); y = Math.min(y + 1, vh);
              w = Math.max(0, w - 2);  h = Math.max(0, h - 2);
              if (w > 0 && h > 0) rects.push([x, y, w, h]);
            }
          } catch {}
          range.detach?.();
        }
        return rects;
      }

      // Foreground media (counts as-is)
      function rectsForMedia() {
        const rects = [];
        document.querySelectorAll("img,video,svg,canvas").forEach((el) => {
          if (!isVisible(el)) return;
          const r = el.getBoundingClientRect();
          const x = clamp(r.left, 0, vw), y = clamp(r.top, 0, vh);
          const w = clamp(r.right, 0, vw) - x, h = clamp(r.bottom, 0, vh) - y;
          if (w > 0 && h > 0) rects.push([x, y, w, h]);
        });
        return rects;
      }

      // Count full CTA hit-area, with per-CTA cap (≤6% of fold)
      function rectsForCTAs() {
        const rects = [];
        const capArea = 0.06 * foldArea;
        const btns = Array.from(document.querySelectorAll("a,button,[role='button']")).filter(isVisible);
        for (const el of btns) {
          const r = el.getBoundingClientRect();
          const isChatBubble = (r.width <= 64 && r.height <= 64 && r.right >= vw - 80 && r.bottom >= vh - 140);
          if (isChatBubble) continue;
          if (r.bottom <= 0 || r.top >= vh) continue;
          if (Math.min(r.width, r.height) < 44) continue;

          let x = clamp(r.left, 0, vw), y = clamp(r.top, 0, vh);
          let w = clamp(r.right, 0, vw) - x, h = clamp(r.bottom, 0, vh) - y;
          if (w <= 0 || h <= 0) continue;

          // Cap contribution
          const area = w * h;
          if (area > capArea) {
            const scale = Math.sqrt(capArea / area);
            const nw = Math.max(1, w * scale), nh = Math.max(1, h * scale);
            const cx = x + w / 2, cy = y + h / 2;
            x = clamp(cx - nw / 2, 0, vw);
            y = clamp(cy - nh / 2, 0, vh);
            w = clamp(x + nw, 0, vw) - x;
            h = clamp(y + nh, 0, vh) - y;
          }
          rects.push([x, y, w, h]);
        }
        return rects;
      }

      // Large, non-repeating hero backgrounds (raster preferred; SVG allowed in a narrow case)
      function rectsForHeroBackgrounds() {
        const rects = [];
        const els = Array.from(document.querySelectorAll("body *"));
        els.forEach((el) => {
          if (!isVisible(el)) return;
          const cs = getComputedStyle(el);
          const bg = cs.backgroundImage;
          if (!bg || bg === "none") return;
          if (/gradient\(/i.test(bg)) return; // ignore gradients

          // Only consider single-layer backgrounds for hero logic
          const urls = bg.match(/url\((?:[^)(]|\((?:[^)(]+|\([^)(]*\))*\))*\)/g) || [];
          if (urls.length !== 1) return;
          const url0 = urls[0].replace(/^url\(["']?/, "").replace(/["']?\)$/, "");

          const isRaster = /\.(jpe?g|png|webp|avif)(\?|$)/i.test(url0) ||
                           /^data:image\/(jpeg|jpg|png|webp|avif)/i.test(url0);
          const isSvg = /\.svg(\?|$)/i.test(url0) || /^data:image\/svg\+xml/i.test(url0);

          const nonRepeating = /no-repeat/i.test(cs.backgroundRepeat || "");
          const large = /cover|contain/i.test(cs.backgroundSize || "");
          if (!nonRepeating && !large) return;

          const r = el.getBoundingClientRect();
          const x = clamp(r.left, 0, vw), y = clamp(r.top, 0, vh);
          const w = clamp(r.right, 0, vw) - x, h = clamp(r.bottom, 0, vh) - y;
          if (w <= 0 || h <= 0) return;

          const area = w * h;
          const bigEnough = (area / foldArea >= 0.35) && (w >= 0.60 * vw) && (h >= 0.30 * vh);
          if (!bigEnough) return;

          // Avoid double counting when a big foreground media exists inside the section
          const hasBigMediaChild = Array.from(el.querySelectorAll("img,video,svg,canvas")).some((child) => {
            if (!isVisible(child)) return false;
            const cr = child.getBoundingClientRect();
            const cx = clamp(cr.left, 0, vw), cy = clamp(cr.top, 0, vh);
            const cw = clamp(cr.right, 0, vw) - cx, ch = clamp(cr.bottom, 0, vh) - cy;
            return (cw * ch) / foldArea >= 0.20;
          });
          if (hasBigMediaChild) return;

          if (isRaster) {
            rects.push([x, y, w, h]);
            return;
          }
          if (isSvg) {
            const textLen = (el.innerText || "").trim().length;
            if (textLen >= 30) rects.push([x, y, w, h]); // narrow allowance for true SVG heroes
          }
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
          "get started","start now","buy","add to cart","book","sign up","log in","subscribe","try","contact","learn more",
          "commencer","acheter","ajouter au panier","réserver","s'inscrire","se connecter","essayer","nous contacter","en savoir plus",
          "jetzt starten","kaufen","in den warenkorb","buchen","registrieren","anmelden","testen","kontakt","mehr erfahren",
          "empezar","comprar","añadir al carrito","reservar","regístrate","iniciar sesión","probar","contacto","más información",
          "começar","comprar","adicionar ao carrinho","reservar","inscrever-se","entrar","experimentar","contato","saiba mais",
          "inizia","compra","aggiungi al carrello","prenota","iscriviti","accedi","prova","contattaci","scopri di più"
        ];
        function hasCta(el) { return PHRASES.some((p) => ((el.innerText || "").toLowerCase()).includes(p)); }
        const candidates = Array.from(document.querySelectorAll("a,button,[role='button']")).filter(isVisible);
        let firstInFold = false;
        for (const el of candidates) {
          const r = el.getBoundingClientRect();
          if (r.top >= 0 && r.bottom <= window.innerHeight) { if (hasCta(el)) { firstInFold = true; break; } }
        }
        return { firstCtaInFold: firstInFold };
      }

      function foldFontStats() {
        const els = Array.from(document.querySelectorAll("body *")).filter(isVisible);
        let minFont = Infinity, maxFont = 0;
        els.forEach((el) => {
          const r = el.getBoundingClientRect();
          if (r.bottom <= 0 || r.top >= vh) return;
          const px = parseFloat(getComputedStyle(el).fontSize || "0");
          if (px > 0) { minFont = Math.min(minFont, px); maxFont = Math.max(maxFont, px); }
        });
        return { minFontPx: Number.isFinite(minFont) ? Math.round(minFont) : 0, maxFontPx: Math.round(maxFont) };
      }

      function smallTapTargetsCount() {
        const targets = Array.from(document.querySelectorAll("a,button,[role='button'],input[type='button'],input[type='submit']")).filter(isVisible);
        let count = 0;
        targets.forEach((el) => {
          const r = el.getBoundingClientRect();
          const isChatBubble = (r.width <= 64 && r.height <= 64 && r.right >= vw - 80 && r.bottom >= vh - 140);
          if (isChatBubble) return;
          if (r.top < vh && r.bottom > 0) if (Math.min(r.width, r.height) < 44) count++;
        });
        return count;
      }

      function hasViewportMeta() { return !!document.querySelector('meta[name="viewport"]'); }

      const textRects = rectsForTextNodes();
      const mediaRects = rectsForMedia();
      const ctaRects = rectsForCTAs();
      const heroRects = rectsForHeroBackgrounds();

      const allRects = textRects.concat(mediaRects, ctaRects, heroRects);
      const coveredCells = rasterizeToGrid(allRects);

      const foldCoveragePct = Math.round((coveredCells.length / (GRID_ROWS * GRID_COLS)) * 100);
      const paintedCoveragePct = 100; // reserved/debug
      const { firstCtaInFold } = ctaDetection();
      const { minFontPx, maxFontPx } = foldFontStats();
      const smallTaps = smallTapTargetsCount();
      const visibleFoldCoveragePct = foldCoveragePct;

      const usesSafeAreaCSS = (() => {
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
          ctaRects: ctaRects.map((r) => r.map((n) => Math.round(n))),
          heroBgRects: heroRects.map((r) => r.map((n) => Math.round(n))),
          coveredCells
        }
      };
    });
  },

  // Draw heatmap overlay (single shot) and return PNG
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
    });
    await page.evaluate(({ debugRects }) => {
      const canvas = document.getElementById("_foldy_heatmap");
      if (!canvas) return;
      const ctx = canvas.getContext("2d");
      const w = canvas.width, h = canvas.height;
      const cols = debugRects.cols, rows = debugRects.rows;
      const cellW = w / cols, cellH = h / rows;

      // grid fill
      debugRects.coveredCells.forEach((idx) => {
        const gy = Math.floor(idx / cols);
        const gx = idx % cols;
        ctx.fillStyle = "rgba(0, 255, 0, 0.20)";
        ctx.fillRect(gx * cellW, gy * cellH, cellW, cellH);
      });

      function drawRects(rects, color) {
        ctx.strokeStyle = color;
        rects.forEach(([x,y,w,h]) => { ctx.strokeRect(x, y, w, h); });
      }
      drawRects(debugRects.glyphRects, "rgba(0,128,0,0.7)");        // text
      drawRects(debugRects.mediaRects, "rgba(0,0,255,0.7)");        // media
      drawRects(debugRects.ctaRects || [], "rgba(128,0,128,0.85)"); // CTAs
      drawRects(debugRects.heroBgRects, "rgba(255,165,0,0.8)");     // hero bg
    }, { debugRects });
    const png = await page.screenshot({ type: "png", fullPage: false });
    await page.evaluate(() => { document.getElementById("_foldy_heatmap")?.remove(); });
    return png;
  }
};

/** ---------- Routes ---------- **/
app.get("/health", (_req, res) => res.json({ ok: true, up: true }));

app.post("/render", authMiddleware, async (req, res) => {
  const t0 = now();
  const q = req.query || {};
  const body = req.body || {};

  const urlRaw = (body.url || q.url || "").trim();
  const deviceKey = (body.device || q.device || "").trim();
  const debugOverlay = parseInt(body.debugOverlay ?? q.debugOverlay ?? 0, 10) === 1;
  const debugRects = parseInt(body.debugRects ?? q.debugRects ?? 0, 10) === 1;
  const debugHeatmap = parseInt(body.debugHeatmap ?? q.debugHeatmap ?? 0, 10) === 1;

  if (!urlRaw || !deviceKey) return res.status(400).json({ error: "Missing url or device" });

  try {
    const safeUrl = await assertUrlAllowed(urlRaw);
    const device = deviceFromKey(deviceKey);
    if (!device) return res.status(400).json({ error: "Invalid device" });

    const browser = await getBrowser();
    const context = await browser.newContext(device.contextOpts);
    const page = await context.newPage();
    await prepPage(page);

    const navStart = now();
    let asSeenPngBuf = null;
    await page.goto(safeUrl, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
    const navEnd = now();

    if (debugOverlay) asSeenPngBuf = await PAGE_EVAL.asSeen(page);

    const preStart = now();
    const pre = await PAGE_EVAL.preHideOverlays(page);
    const preEnd = now();

    const hideStart = now();
    await PAGE_EVAL.hideOverlays(page);
    const hideEnd = now();

    const cleanStart = now();
    const { ux, debugRects: rectsForDebug } = await PAGE_EVAL.cleanAudit(page);
    const cleanEnd = now();

    const shotStart = now();
    const cleanPngBuf = await page.screenshot({ type: "png", fullPage: false });
    const shotEnd = now();

    let heatmapBuf = null;
    if (debugHeatmap) heatmapBuf = await PAGE_EVAL.heatmapPng(page, rectsForDebug);

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
        settle_ms: 0,
        audit_ms: ms(preStart, preEnd),
        hide_ms: ms(hideStart, hideEnd),
        clean_ms: ms(cleanStart, cleanEnd),
        screenshot_ms: ms(shotStart, shotEnd),
        total_ms: ms(t0, now()),
      },
    };

    if (debugOverlay && asSeenPngBuf) payload.pngWithOverlayBase64 = asSeenPngBuf.toString("base64");
    if (debugRects) payload.debug = rectsForDebug;
    if (debugHeatmap && heatmapBuf) payload.pngDebugBase64 = heatmapBuf.toString("base64");

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
    server = app.listen(PORT, () => console.log(`Foldy render up on :${PORT}`));
  })
  .catch((e) => {
    console.error("Failed to launch Chromium:", e);
    process.exit(1);
  });

process.on("SIGTERM", async () => {
  try { await (await getBrowser()).close(); } catch {}
  server?.close?.(() => process.exit(0));
});
