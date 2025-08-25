// Foldy — Render Service (stabilized: watchdogs, CSP-safe heatmap, overlay fix, CTA + text heuristics)
/* eslint-disable no-console */
import express from "express";
import { chromium } from "playwright";
import dns from "node:dns/promises";
import net from "node:net";

const PORT = process.env.PORT || 3000;
const RENDER_TOKEN = process.env.RENDER_TOKEN;

const SERVICE_VERSION = process.env.RENDER_VERSION || process.env.COMMIT_SHA || process.env.RENDER_GIT_SHA || "";

// Timeouts (tune via env on Render)
const HARD_TIMEOUT_MS    = parseInt(process.env.RENDER_HARD_TIMEOUT_MS    || "45000", 10);
const DNS_TIMEOUT_MS     = parseInt(process.env.RENDER_DNS_TIMEOUT_MS     || "4000", 10);
const SHOT_TIMEOUT_MS    = parseInt(process.env.RENDER_SHOT_TIMEOUT_MS    || "15000", 10);
const HEATMAP_TIMEOUT_MS = parseInt(process.env.RENDER_HEATMAP_TIMEOUT_MS || "10000", 10);
const SNAP_TIMEOUT_MS    = parseInt(process.env.RENDER_SNAP_TIMEOUT_MS    || "6000", 10);
const NAV_TIMEOUT_MS        = Number(process.env.NAV_TIMEOUT_MS        ?? 22000); // README says ~15s, give heavier pages some headroom. :contentReference[oaicite:1]{index=1}
const HIDE_TIMEOUT_MS       = Number(process.env.HIDE_TIMEOUT_MS       ?? 4000);
const SCREENSHOT_TIMEOUT_MS = Number(process.env.SCREENSHOT_TIMEOUT_MS ?? 15000);


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

// ---- SSRF guard: allow only http(s) and block private IPs (v4 & v6) ----
const PRIVATE_V6 = [
  "::1/128",   // loopback
  "fc00::/7",  // unique local
  "fe80::/10", // link-local
];

function ipInCidr6(ip, cidr) {
  if (net.isIP(ip) !== 6) return false;
  const [base, bitsStr] = cidr.split("/");
  const bits = parseInt(bitsStr, 10);
  const ipBlocks = ip.split(":").map(x => x.padStart(4, "0"));
  const baseBlocks = base.split(":").map(x => x.padStart(4, "0"));
  let bitsLeft = bits;
  for (let i = 0; i < 8 && bitsLeft > 0; i++) {
    const take = Math.min(16, bitsLeft);
    const ipPart   = parseInt(ipBlocks[i], 16) >>> (16 - take);
    const basePart = parseInt(baseBlocks[i], 16) >>> (16 - take);
    if (ipPart !== basePart) return false;
    bitsLeft -= take;
  }
  return true;
}

async function assertUrlAllowed(raw) {
  let u;
  try { u = new URL(raw); } catch { throw Object.assign(new Error("Invalid URL"), { status: 400 }); }

  if (!["http:", "https:"].includes(u.protocol)) {
    throw Object.assign(new Error("Only http/https allowed"), { status: 422 });
  }

  const host = (u.hostname || "").toLowerCase();
  if (host === "localhost" || host === "127.0.0.1" || host === "::1") {
    throw Object.assign(new Error("Localhost blocked"), { status: 422 });
  }

  let v4 = [], v6 = [];
  try { v4 = await withTimeout(dns.resolve4(host), DNS_TIMEOUT_MS, `DNS A(${host})`); } catch {}
  try { v6 = await withTimeout(dns.resolve6(host), DNS_TIMEOUT_MS, `DNS AAAA(${host})`); } catch {}

  for (const ip of v4) for (const cidr of PRIVATE_CIDRS)
    if (ipInCidr(ip, cidr)) throw Object.assign(new Error("Private network blocked (v4)"), { status: 422 });

  for (const ip of v6) {
    if (ip === "::1") throw Object.assign(new Error("Loopback blocked (v6)"), { status: 422 });
    for (const cidr of PRIVATE_V6)
      if (ipInCidr6(ip, cidr)) throw Object.assign(new Error("Private network blocked (v6)"), { status: 422 });
  }

  return u.toString();
}


// Generic watchdog
function withTimeout(promise, ms, label = "operation") {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`${label} timeout after ${ms}ms`);
      err.status = 504;
      reject(err);
    }, ms);
  });
  return Promise.race([promise.finally(() => clearTimeout(timer)), timeout]);
}

async function resolve4WithTimeout(hostname, ms) {
  return withTimeout(dns.resolve4(hostname, { ttl: false }), ms, `DNS resolve(${hostname})`);
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

/** ---------- Page setup ---------- **/
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

/** ---------- In-page auditing ---------- **/
const PAGE_EVAL = {
  async asSeen(page) { return page.screenshot({ type: "png", fullPage: false, timeout: relaxed ? 0 : (SNAP_TIMEOUT_MS - 500) }); },

  // Pre-hide overlays
  // Run overlay pre-scan with a hard deadline; soft-fail on timeout.
  // Usage: const pre = await this.preHideOverlays(page, { timeoutMs: HIDE_TIMEOUT_MS });
  async preHideOverlays(
    page,
    { timeoutMs = (typeof HIDE_TIMEOUT_MS !== 'undefined' ? HIDE_TIMEOUT_MS : 4000) } = {}
  ) {
    // Small helper: give any promise a deadline
    const withTimeout = (promise, ms, tag) => Promise.race([
      promise,
      new Promise((_, rej) => setTimeout(() => rej(new Error(`${tag}_TIMEOUT`)), ms))
    ]);

    try {
      const res = await withTimeout(page.evaluate(() => {
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

        const txt = (el.innerText || "").toLowerCase();
        const looksLikeCookie =
          txt.includes("cookie") || txt.includes("consent") ||
          txt.includes("accept all") || txt.includes("agree");

        // bottom bar must be wide and contain at least two actionable items
        const btnCount = el.querySelectorAll("button,a,[role='button']").length;
        const wideBar = (inFoldWidth / vw) >= 0.6;
        const likelyBar = (r.height >= 48 && r.top >= vh - 220 && wideBar && btnCount >= 2);

        if (looksLikeCookie) return true;
        if (likelyBar) return true;
        // otherwise require larger area to avoid tagging tiny pills
        return inFoldArea / foldArea >= 0.20;
      });

      // Tag actual overlay nodes so we hide only them
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
      }), timeoutMs, 'PREHIDE');
      return { ...res, _preHideTimedOut: false };
    } catch (e) {
      // Soft-fail on timeout; keep the run alive and signal the flag.
      if ((e.message || '').includes('PREHIDE_TIMEOUT')) {
        return { overlayRects: [], overlayElemsMarked: 0, overlayCoveragePct: 0, overlayBlockers: 0, _preHideTimedOut: true };
      }
      throw e; // real error → bubble up
    }
  },

  // Hide ONLY tagged overlays
  async hideOverlays(page) {
    await page.addStyleTag({ content: `[data-foldy-overlay-candidate="1"]{display:none!important}` });
  },

  // Compute coverage + metrics
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
        // hidden or collapsed
        if (cs.visibility === "hidden" || cs.display === "none") return false;
        // effectively invisible (helps remove ghost text in translucent layers)
        if (parseFloat(cs.opacity || "1") < 0.05) return false;
      
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) return false;
        if (r.bottom <= 0 || r.right <= 0 || r.top >= vh || r.left >= vw) return false;
        return true;
      }


      // --- helpers for CTA detection ---
      function norm(t) {
        return (t || "")
          .toLowerCase()
          .normalize("NFD").replace(/[\u0300-\u036f]/g, "");
      }
      const CTA_PHRASES = [
        "get started","start now","request a demo","book a demo","request demo",
        "buy","add to cart","sign up","log in","subscribe","try","contact","learn more",
        "demander une demo","demander une démo","essayer","nous contacter","en savoir plus",
        "commencer","acheter","ajouter au panier","reserver","réserver","s'inscrire","se connecter",
        "demo anfordern","jetzt starten","kaufen","in den warenkorb","buchen","registrieren","anmelden","testen","kontakt","mehr erfahren",
        "solicitar una demo","empezar","comprar","añadir al carrito","reservar","regístrate","iniciar sesion","iniciar sesión","probar","contacto","mas informacion","más información",
        "solicitar uma demo","comecar","começar","comprar","adicionar ao carrinho","reservar","inscrever-se","entrar","experimentar","contato","saiba mais",
        "richiedi una demo","inizia","compra","aggiungi al carrello","prenota","iscriviti","accedi","prova","contattaci","scopri di piu","scopri di più"
      ];
      function hasCtaText(el) {
        const t = norm(el.innerText || "");
        return t.length > 2 && CTA_PHRASES.some(p => t.includes(p));
      }
      function looksLikeButton(el) {
        const role = (el.getAttribute("role") || "").toLowerCase();
        const type = (el.getAttribute("type") || "").toLowerCase();
        const cls = (el.className || "").toString().toLowerCase();
        const id = (el.id || "").toLowerCase();
        const classHit = /\b(btn|button|cta|primary|pill|calltoaction|call-to-action)\b/.test(cls)
                      || /\b(btn|button|cta|primary|pill)\b/.test(id)
                      || /\b(btn-|button-|cta-|primary-)/.test(cls);
        const roleHit  = role === "button";
        const typeHit  = type === "button" || type === "submit";
        const cs = getComputedStyle(el);
        const hasBg = cs.backgroundColor && cs.backgroundColor !== "rgba(0, 0, 0, 0)" && cs.backgroundColor !== "transparent";
        const radius = ["borderTopLeftRadius","borderTopRightRadius","borderBottomLeftRadius","borderBottomRightRadius"]
          .map(k => parseFloat(cs[k] || "0")).reduce((a,b)=>a+b,0);
        const rounded = radius >= 12;
        return classHit || roleHit || typeHit || (hasBg && rounded);
      }

      // --- Rect collectors ---
      function rectsForTextNodes() {
        const rects = [];
        const vw = window.innerWidth, vh = window.innerHeight;
      
        // Unicode whitespace (incl. NBSP, hair, narrow, ZW, BOM…)
        const WS = /[\s\u00A0\u1680\u180E\u2000-\u200B\u202F\u205F\u3000\uFEFF]/;
      
        // rgba() alpha extractor
        const alphaOf = (cssColor) => {
          const m = /\brgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)/i.exec(cssColor || "");
          return m ? (m[4] === undefined ? 1 : parseFloat(m[4])) : 1;
        };
      
        // probe if a rect contains at least one non-whitespace glyph
        function rectHasGlyph(rect) {
          const { left, top, width, height } = rect;
          if (width <= 0 || height <= 0) return false;
      
          const samples = Math.min(10, Math.max(3, Math.ceil(width / 8))); // 3..10 points
          const y = Math.min(vh - 1, Math.max(0, top + height / 2));
      
          for (let i = 0; i < samples; i++) {
            const x = Math.min(vw - 1, Math.max(0, left + ((i + 0.5) / samples) * width));
      
            // Try both APIs for wider browser support
            const cp = (document.caretPositionFromPoint && document.caretPositionFromPoint(x, y)) || null;
            if (cp && cp.offsetNode && cp.offsetNode.nodeType === Node.TEXT_NODE) {
              const s = cp.offsetNode.nodeValue || "";
              const k = Math.min(Math.max(cp.offset, 0), Math.max(0, s.length - 1));
              if (s[k] && !WS.test(s[k])) return true;
            }
      
            const cr = (document.caretRangeFromPoint && document.caretRangeFromPoint(x, y)) || null;
            if (cr && cr.startContainer && cr.startContainer.nodeType === Node.TEXT_NODE) {
              const s = cr.startContainer.nodeValue || "";
              const k = Math.min(Math.max(cr.startOffset, 0), Math.max(0, s.length - 1));
              if (s[k] && !WS.test(s[k])) return true;
            }
          }
          return false; // only spaces seen
        }
      
        const walker = document.createTreeWalker(
          document.body,
          NodeFilter.SHOW_TEXT,
          {
            acceptNode: (n) => {
              const s = n.nodeValue || "";
              // Trim ends; if entire node becomes whitespace → reject early
              let i = 0, j = s.length - 1;
              while (i <= j && WS.test(s[i])) i++;
              while (j >= i && WS.test(s[j])) j--;
              if (j < i) return NodeFilter.FILTER_REJECT;
      
              const el = n.parentElement;
              if (!el) return NodeFilter.FILTER_REJECT;
      
              const cs = getComputedStyle(el);
              if (cs.visibility === "hidden" || cs.display === "none") return NodeFilter.FILTER_REJECT;
              if (parseFloat(cs.opacity || "1") < 0.05) return NodeFilter.FILTER_REJECT;
      
              const fs = parseFloat(cs.fontSize || "0");
              if (fs < 8) return NodeFilter.FILTER_REJECT;
      
              // transparent text (color alpha 0 or -webkit-text-fill-color transparent)
              const aColor = alphaOf(cs.color);
              const fill = cs.webkitTextFillColor || "";
              const fillTransparent = fill === "transparent" || /rgba\(\s*0\s*,\s*0\s*,\s*0\s*,\s*0\s*\)/i.test(fill);
              if (aColor < 0.05 || fillTransparent) return NodeFilter.FILTER_REJECT;
      
              return NodeFilter.FILTER_ACCEPT;
            }
          }
        );
      
        let node;
        while ((node = walker.nextNode())) {
          const el = node.parentElement;
          const cs = getComputedStyle(el);
          const fs = parseFloat(cs.fontSize || "0");
      
          // Select the WHOLE node first; we’ll validate each rect contains a glyph
          const range = document.createRange();
          try {
            range.selectNodeContents(node);
            const list = range.getClientRects(); // per-line fragments
      
            for (const r of list) {
              if (!rectHasGlyph(r)) continue; // <- drop whitespace-only fragments
      
              let x = Math.max(0, Math.min(r.left, vw));
              let y = Math.max(0, Math.min(r.top, vh));
              let w = Math.max(0, Math.min(r.right, vw) - x);
              let h = Math.max(0, Math.min(r.bottom, vh) - y);
              if (w <= 1 || h <= 6) continue;
      
              // tighten vertically to ~font-size
              const targetH = Math.min(h, Math.max(8, fs * 1.3));
              const dy = (h - targetH) / 2;
              y = Math.max(0, Math.min(y + dy, vh));
              h = Math.max(0, Math.min(targetH, vh - y));
      
              // small erosion to avoid gutters
              x = Math.min(x + 1, vw); y = Math.min(y + 1, vh);
              w = Math.max(0, w - 2);  h = Math.max(0, h - 2);
      
              if (w > 0 && h > 0) rects.push([x, y, w, h]);
            }
          } catch {}
          range.detach?.();
        }
        return rects;
      }



      function rectsForMedia() {
        const rects = [];
        document.querySelectorAll("img,video,svg,canvas").forEach((el) => {
          if (!isVisible(el)) return;
          const r = el.getBoundingClientRect();
          const x = Math.max(0, Math.min(r.left, vw));
          const y = Math.max(0, Math.min(r.top, vh));
          const w = Math.max(0, Math.min(r.right, vw) - x);
          const h = Math.max(0, Math.min(r.bottom, vh) - y);
          if (w > 0 && h > 0) rects.push([x, y, w, h]);
        });
        return rects;
      }

      function rectsForCTAs() {
        const rects = [];
        const capArea = 0.06 * foldArea; // ≤6% per CTA
        const minDim  = 32;
        const minArea = 0.015 * foldArea;

        const btns = Array.from(document.querySelectorAll("a,button,[role='button']"))
          .filter(isVisible)
          .filter((el) => hasCtaText(el) || looksLikeButton(el));

        for (const el of btns) {
          const r = el.getBoundingClientRect();
          const isChatBubble = (r.width <= 64 && r.height <= 64 && r.right >= vw - 80 && r.bottom >= vh - 140);
          if (isChatBubble) continue;
          if (r.bottom <= 0 || r.top >= vh) continue;

          let x = Math.max(0, Math.min(r.left, vw));
          let y = Math.max(0, Math.min(r.top, vh));
          let w = Math.max(0, Math.min(r.right, vw) - x);
          let h = Math.max(0, Math.min(r.bottom, vh) - y);
          if (w <= 0 || h <= 0) continue;

          const area = w * h;
          if (Math.min(w, h) < minDim && area < minArea) continue;

          if (area > capArea) {
            const scale = Math.sqrt(capArea / area);
            const nw = Math.max(1, w * scale), nh = Math.max(1, h * scale);
            const cx = x + w / 2, cy = y + h / 2;
            x = Math.max(0, Math.min(cx - nw / 2, vw));
            y = Math.max(0, Math.min(cy - nh / 2, vh));
            w = Math.max(0, Math.min(x + nw, vw) - x);
            h = Math.max(0, Math.min(y + nh, vh) - y);
          }
          rects.push([x, y, w, h]);
        }
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
          if (/gradient\(/i.test(bg)) return;

          const urls = bg.match(/url\((?:[^)(]|\((?:[^)(]+|\([^)(]*\))*\))*\)/g) || [];
          if (urls.length !== 1) return;
          const url0 = urls[0].replace(/^url\(["']?/, "").replace(/["']?\)$/, "");

          const isRaster = /\.(jpe?g|png|webp|avif)(\?|$)/i.test(url0) ||
                           /^data:image\/(jpeg|jpg|png|webp|avif)/i.test(url0);
          const isSvg = /\.svg(\?|$)/i.test(url0) || /^data:image\/svg\+xml/i.test(url0);
          if (!isRaster || isSvg) return; // raster only (ignore SVG backgrounds)

          const nonRepeating = /no-repeat/i.test(cs.backgroundRepeat || "");
          const large = /cover|contain/i.test(cs.backgroundSize || "");
          if (!nonRepeating && !large) return;

          const r = el.getBoundingClientRect();
          const x = Math.max(0, Math.min(r.left, vw));
          const y = Math.max(0, Math.min(r.top, vh));
          const w = Math.max(0, Math.min(r.right, vw) - x);
          const h = Math.max(0, Math.min(r.bottom, vh) - y);
          if (w <= 0 || h <= 0) return;

          const area = w * h;
          const bigEnough = (area / foldArea >= 0.45) && (w >= 0.70 * vw) && (h >= 0.35 * vh);
          if (!bigEnough) return;

          const hasBigMediaChild = Array.from(el.querySelectorAll("img,video,svg,canvas")).some((child) => {
            if (!isVisible(child)) return false;
            const cr = child.getBoundingClientRect();
            const cx = Math.max(0, Math.min(cr.left, vw));
            const cy = Math.max(0, Math.min(cr.top, vh));
            const cw = Math.max(0, Math.min(cr.right, vw) - cx);
            const ch = Math.max(0, Math.min(cr.bottom, vh) - cy);
            return (cw * ch) / foldArea >= 0.20;
          });
          if (hasBigMediaChild) return;

          rects.push([x, y, w, h]);
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
        const candidates = Array.from(document.querySelectorAll("a,button,[role='button']"))
          .filter(isVisible)
          .filter(el => hasCtaText(el) || looksLikeButton(el));
        let firstInFold = false;
        for (const el of candidates) {
          const r = el.getBoundingClientRect();
          if (r.top >= 0 && r.bottom <= window.innerHeight) { firstInFold = true; break; }
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

      function smallTapTargets() {
        const targets = Array.from(document.querySelectorAll(
          "a,button,[role='button'],input[type='button'],input[type='submit']"
        )).filter(isVisible);
      
        const rects = [];
        let count = 0;
      
        targets.forEach((el) => {
          const r = el.getBoundingClientRect();
          // ignore typical chat-bubble area
          const isChatBubble = (r.width <= 64 && r.height <= 64 && r.right >= vw - 80 && r.bottom >= vh - 140);
          if (isChatBubble) return;
      
          if (r.top < vh && r.bottom > 0) {
            const minSide = Math.min(r.width, r.height);
            if (minSide < 44) {
              count++;
              const x = Math.max(0, Math.min(r.left, vw));
              const y = Math.max(0, Math.min(r.top, vh));
              const w = Math.max(0, Math.min(r.right, vw) - x);
              const h = Math.max(0, Math.min(r.bottom, vh) - y);
              if (w > 0 && h > 0) rects.push([x, y, w, h]);
            }
          }
        });
      
        return { count, rects };
      }


      function hasViewportMeta() { return !!document.querySelector('meta[name="viewport"]'); }
      const small = smallTapTargets();
      
      const textRects = rectsForTextNodes();
      const mediaRects = rectsForMedia();
      const ctaRects = rectsForCTAs();
      const heroRects = rectsForHeroBackgrounds();

      const allRects = textRects.concat(mediaRects, ctaRects, heroRects);
      const coveredCells = rasterizeToGrid(allRects);

      const foldCoveragePct = Math.round((coveredCells.length / (GRID_ROWS * GRID_COLS)) * 100);
      const paintedCoveragePct = 100; // reserved
      const { firstCtaInFold } = ctaDetection();
      const { minFontPx, maxFontPx } = foldFontStats();

      const usesSafeAreaCSS = (() => {
        const sheets = Array.from(document.querySelectorAll("style"));
        return sheets.some((s) => (s.textContent || "").includes("safe-area-inset"));
      })();

      return {
        ux: {
          firstCtaInFold,
          foldCoveragePct,
          visibleFoldCoveragePct: foldCoveragePct,
          paintedCoveragePct,
          maxFontPx,
          minFontPx,
          smallTapTargets: small.count,
          hasViewportMeta: hasViewportMeta(),
          usesSafeAreaCSS,
        },
        debugRects: {
          rows: GRID_ROWS,
          cols: GRID_COLS,
          glyphRects: textRects.map((r) => r.map((n) => Math.round(n))),
          mediaRects: mediaRects.map((r) => r.map((n) => Math.round(n))),
          ctaRects:   ctaRects.map((r) => r.map((n) => Math.round(n))),
          heroBgRects:heroRects.map((r) => r.map((n) => Math.round(n))),
          smallTapRects: small.rects.map((r) => r.map((n) => Math.round(n))),
          coveredCells
        }
      };
    });
  },

  // CSP-safe, lightweight heatmap overlay
  async heatmapPng(page, debugRects) {
    await page.evaluate((debugRects) => {
      const prev = document.getElementById("_foldy_heatmap");
      if (prev) prev.remove();
      const c = document.createElement("canvas");
      c.id = "_foldy_heatmap";
      c.width = window.innerWidth;
      c.height = window.innerHeight;
      Object.assign(c.style, { position: "fixed", left: "0px", top: "0px", zIndex: "9999999", pointerEvents: "none" });
      document.body.appendChild(c);

      const ctx = c.getContext("2d");
      const w = c.width, h = c.height;
      const cols = debugRects.cols, rows = debugRects.rows;
      const cellW = w / cols, cellH = h / rows;

      // grid fill (what we count)
      ctx.fillStyle = "rgba(0,255,0,0.12)";
      for (let i = 0; i < debugRects.coveredCells.length; i++) {
        const idx = debugRects.coveredCells[i];
        const gy = (idx / cols) | 0;
        const gx = idx % cols;
        ctx.fillRect(gx * cellW, gy * cellH, cellW, cellH);
      }

      // strokes (limited to prevent slow draws)
      const MAX_STROKES = 2000;
      let drawn = 0;
      function drawRects(rects, stroke) {
        if (!rects) return;
        ctx.strokeStyle = stroke;
        const n = Math.min(rects.length, Math.max(0, MAX_STROKES - drawn));
        for (let i = 0; i < n; i++) {
          const [x, y, w, h] = rects[i];
          ctx.strokeRect(x, y, w, h);
        }
        drawn += n;
      }
      drawRects(debugRects.glyphRects,  "rgba(0,128,0,0.7)");
      drawRects(debugRects.mediaRects,  "rgba(0,0,255,0.7)");
      drawRects(debugRects.ctaRects,    "rgba(128,0,128,0.85)");
      drawRects(debugRects.heroBgRects, "rgba(255,165,0,0.8)");
      drawRects(debugRects.smallTapRects, "rgba(255, 215, 0, 0.95)"); // small tap targets
    }, debugRects);

    await page.evaluate(async () => { if (document.fonts?.ready) await document.fonts.ready; });
    const png = await page.screenshot({ type: "png", fullPage: false, timeout: relaxed ? 0 : SCREENSHOT_TIMEOUT_MS });
    await page.evaluate(() => document.getElementById("_foldy_heatmap")?.remove());
    return png;
  },
}; // <-- do not remove; closes PAGE_EVAL

/** ---------- Routes ---------- **/
app.get("/health", (_req, res) => res.json({ ok: true, up: true }));

app.post("/render", authMiddleware, async (req, res) => {
  // default socket timeouts (we may relax later)
  res.setTimeout(HARD_TIMEOUT_MS + 5000);
  req.setTimeout?.(HARD_TIMEOUT_MS + 5000);

  const t0 = now();
  const q = req.query || {};
  const body = req.body || {};

  // Per-request relaxed mode (for n8n batches): bypass step watchdogs
  const relaxed =
    (process.env.RENDER_DISABLE_TIMEOUTS === "1") ||
    (String(body.relaxed ?? q.relaxed ?? "0") === "1");

  const WT = (p, ms, label) => (relaxed ? p : withTimeout(p, ms, label));

  if (relaxed) {
    const long = Math.max(120000, (HARD_TIMEOUT_MS || 45000) * 3);
    res.setTimeout(long);
    req.setTimeout?.(long);
  }

  // Params
  const urlRaw = (body.url || q.url || "").trim();
  const deviceKey = (body.device || q.device || "").trim();
  const debugOverlay = parseInt(body.debugOverlay ?? q.debugOverlay ?? 0, 10) === 1;
  const debugRects   = parseInt(body.debugRects   ?? q.debugRects   ?? 0, 10) === 1;
  const debugHeatmap = parseInt(body.debugHeatmap ?? q.debugHeatmap ?? 0, 10) === 1;

  if (!urlRaw || !deviceKey) {
    return res.status(400).json({ error: "Missing url or device" });
  }

  let context = null, page = null;
  try {
    const safeUrl = await assertUrlAllowed(urlRaw);
    const device = deviceFromKey(deviceKey);
    if (!device) return res.status(400).json({ error: "Invalid device" });

    const browser = await WT(getBrowser(), 10000, "launch chromium");
    context = await WT(
      browser.newContext({ ...device.contextOpts, bypassCSP: true }),
      8000,
      "newContext"
    );
    page = await WT(context.newPage(), 5000, "newPage");
     await prepPage(page);
     if (relaxed) {
       // Disable Playwright’s built-in timeouts for this request
       page.setDefaultTimeout(0);
       page.setDefaultNavigationTimeout(0);
     }

    // Navigate
    const navStart = now();
     await WT(page.goto(safeUrl, { waitUntil: "domcontentloaded", timeout: relaxed ? 0 : NAV_TIMEOUT_MS }), NAV_TIMEOUT_MS, "page.goto");
    await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
    // Small wait: late cookie bars often render after idle
    await page.waitForTimeout(700).catch(() => {});
    const navEnd = now();

    // As-seen (optional)
    let asSeenPngBuf = null;
    if (debugOverlay) {
      try {
        await page.evaluate(async () => { if (document.fonts?.ready) await document.fonts.ready; });
        asSeenPngBuf = await page.screenshot({ type: "png", fullPage: false, timeout: relaxed ? 0 : SCREENSHOT_TIMEOUT_MS });
      } catch (e) {
        console.warn('[debugOverlay] as-seen failed:', e?.message || e);
        // continue; not fatal
      }
    }


    // Pre-hide overlay audit
    const preStart = now();
     // Pre-scan overlays using WT; soft-fail on timeout/error
     let pre = { overlayRects: [], overlayElemsMarked: 0, overlayCoveragePct: 0, overlayBlockers: 0, _preHideTimedOut: false };
     try {
       pre = await WT(PAGE_EVAL.preHideOverlays(page), HIDE_TIMEOUT_MS, "preHideOverlays");
     } catch (e) {
       pre._preHideTimedOut = true;
       console.warn("[preHideOverlays] soft-fail:", e?.message || e);
     }
    const preEnd = now();

    // Hide overlays (tagged only)
    const hideStart = now();
    await WT(PAGE_EVAL.hideOverlays(page), HIDE_TIMEOUT_MS, "hideOverlays");
    const hideEnd = now();

    // Clean audit (after hiding)
    const cleanStart = now();
    const { ux, debugRects: rectsForDebug } = await WT(PAGE_EVAL.cleanAudit(page), 9000, "cleanAudit");
    const cleanEnd = now();

    // Clean screenshot
    const shotStart = now();
    // settle webfonts to avoid empty text lines in screenshots
    await page.evaluate(async () => { if (document.fonts?.ready) await document.fonts.ready; });
    const cleanPngBuf = await WT(
      page.screenshot({ type: "png", fullPage: false, timeout: relaxed ? 0 : (SHOT_TIMEOUT_MS - 1000) }),
      SHOT_TIMEOUT_MS,
      "clean screenshot"
    );
    const shotEnd = now();

    // Heatmap (optional)
    let heatmapBuf = null;
    if (debugHeatmap) {
      heatmapBuf = await WT(PAGE_EVAL.heatmapPng(page, rectsForDebug), HEATMAP_TIMEOUT_MS, "heatmapPng");
    }

    // Response
    const deviceMeta = {
      viewport: device.contextOpts.viewport,
      dpr: device.contextOpts.deviceScaleFactor,
      ua: device.contextOpts.userAgent,
      label: device.label,
    };

    const nowDate = new Date();
    const payload = {
      ts_ms: nowDate.getTime(),
      ts_iso: nowDate.toISOString(),
      serviceVersion: SERVICE_VERSION,

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
       debugFlags: {
        preHideTimedOut: pre?._preHideTimedOut === true,
        asSeenFailed: Boolean(debugOverlay && !asSeenPngBuf),
      },
    };

    if (debugOverlay && asSeenPngBuf) {
      payload.pngWithOverlayBase64 = asSeenPngBuf.toString("base64");
    }
    if (debugHeatmap && heatmapBuf) {
      payload.pngDebugBase64 = heatmapBuf.toString("base64");
    }
    if (debugRects) {
      payload.debug = {
        ...rectsForDebug,
        overlayRects: pre.overlayRects, // <- from pre-hide pass
      };
    }

    return res.json(payload);
  } catch (err) {
    const status = err?.status || 500;
    console.error("Render error:", deviceKey, urlRaw, err?.message || err);
    return res.status(status).json({ error: String(err?.message || err) });
  } finally {
    try { await page?.close?.(); } catch {}
    try { await context?.close?.(); } catch {}
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
