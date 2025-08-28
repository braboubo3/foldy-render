// Foldy — Render Service (stabilized: watchdogs, CSP-safe heatmap, overlay fix, CTA + text heuristics)
/* eslint-disable no-console */
import express from "express";
import { chromium } from "playwright";
import dns from "node:dns/promises";
import net from "node:net";
import { createClient } from "@supabase/supabase-js";

const PORT = process.env.PORT || 3000;
const RENDER_TOKEN = process.env.RENDER_TOKEN;

const SERVICE_VERSION = process.env.RENDER_VERSION || process.env.COMMIT_SHA || process.env.RENDER_GIT_SHA || "";

// Timeouts (tune via env on Render)
const HARD_TIMEOUT_MS    = parseInt(process.env.RENDER_HARD_TIMEOUT_MS    || "45000", 10);
const DNS_TIMEOUT_MS     = parseInt(process.env.RENDER_DNS_TIMEOUT_MS     || "4000", 10);
const SHOT_TIMEOUT_MS    = parseInt(process.env.RENDER_SHOT_TIMEOUT_MS    || "15000", 10);
const HEATMAP_TIMEOUT_MS = parseInt(process.env.RENDER_HEATMAP_TIMEOUT_MS || "10000", 10);
const SNAP_TIMEOUT_MS    = parseInt(process.env.RENDER_SNAP_TIMEOUT_MS    || "6000", 10);
const NAV_TIMEOUT_MS        = Number(process.env.NAV_TIMEOUT_MS        ?? 22000); // README says ~15s, give heavier pages some headroom.
const HIDE_TIMEOUT_MS       = Number(process.env.HIDE_TIMEOUT_MS       ?? 4000);
const SCREENSHOT_TIMEOUT_MS = Number(process.env.SCREENSHOT_TIMEOUT_MS ?? 15000);

if (!RENDER_TOKEN) {
  console.error("Missing RENDER_TOKEN");
  process.exit(1);
}

const app = express();
app.use(express.json({ limit: "1mb" }));

// NEW: 2025-08-28 in-process concurrency gate to mimic container concurrency=1
//      Keeps one /render active per process to avoid Chromium thrash under load.
const MAX_INPROC_CONCURRENCY = parseInt(process.env.RENDER_CONCURRENCY || "1", 10);
let _foldyActive = 0;
const _foldyWaiters = [];
async function _foldyAcquire() {
  if (_foldyActive < MAX_INPROC_CONCURRENCY) { _foldyActive; return; }
  await new Promise((res) => _foldyWaiters.push(res));
  _foldyActive;
}
function _foldyRelease() {
  _foldyActive = Math.max(0, _foldyActive - 1);
  const next = _foldyWaiters.shift();
  if (next) next();
}


/** ---------- Auth ---------- **/
function authMiddleware(req, res, next) {
  const hdr = req.headers.authorization || "";
  const token = hdr.startsWith("Bearer ") ? hdr.slice(7) : "";
  if (!token || token !== RENDER_TOKEN) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }
  next();
}

// Supabase Storage (server-side upload)
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE; // required
const SUPABASE_BUCKET = process.env.SUPABASE_BUCKET || "screenshot";
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
  console.warn("[foldy] SUPABASE_URL / SUPABASE_SERVICE_ROLE not set – screenshot upload disabled");
}
const supabase = (SUPABASE_URL && SUPABASE_SERVICE_ROLE)
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE, { auth: { persistSession: false } })
  : null;

// normalize object key folder from URL (keep your legacy style e.g. 'https:/domain')
function _foldyKeyFrom(url, ts, device) {
  try {
    const u = new URL(url);
    const hostPath = `${u.protocol.replace("://",":/")}${u.host}${u.pathname}`.replace(/\/+$/,''); // "https:/domain/path"
    return `${hostPath}/${ts}-${device}.png`;
  } catch {
    // fallback for whatever string
    const safe = url.replace(/[^a-z0-9:/._-]+/gi, "").replace(/\/+$/,'');
    return `${safe}/${ts}-${device}.png`;
  }
}

async function _foldyUploadScreenshot(key, buf) {
  if (!supabase) throw new Error("supabase_not_configured");
  const { error } = await supabase.storage.from(SUPABASE_BUCKET).upload(key, buf, {
    contentType: "image/png",
    upsert: true
  });
  if (error) throw error;
  const { data } = supabase.storage.from(SUPABASE_BUCKET).getPublicUrl(key);
  return data.publicUrl;
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

  // Disable animations and scroll-behavior
  await page.addInitScript(() => {
    try {
      const s = document.createElement("style");
      s.id = "_foldy_anim_off";
      s.textContent = `*{animation:none!important;transition:none!important} html,body{scroll-behavior:auto!important}`;
      document.documentElement.appendChild(s);
    } catch {}
  });

// NEW: CTA TTV watcher (starts at earliest script run)
await page.addInitScript(() => {
  (function () {
    try {
      const t0 = performance.now();

      // --- utils & i18n lexicon ---
      function norm(s){ return (s || "").normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLowerCase().trim(); }
      function getLang(){
        let l = (document.documentElement.getAttribute("lang") || "").toLowerCase();
        if (!l) {
          const m = document.querySelector('meta[http-equiv="content-language"], meta[name="language"], meta[property="og:locale"]');
          l = (m?.getAttribute("content") || "").toLowerCase();
        }
        l = l.split(/[-_]/)[0];
        return ["en","de","fr","es","it","pt"].includes(l) ? l : "en";
      }
      const LEX = {
        en:{ strong:['buy','add to cart','checkout','order now','subscribe','sign up','get started','start free trial','try free','book demo','schedule demo','contact sales','get quote','request quote','download'],
             weak:['learn more','see more','details','view more','explore','pricing','start now'] },
        de:{ strong:['kaufen','in den warenkorb','zur kasse','jetzt kaufen','bestellen','abonnieren','anmelden','registrieren','loslegen','kostenlos testen','probe starten','demo buchen','demo vereinbaren','vertrieb kontaktieren','angebot anfordern','preis anfragen','herunterladen'],
             weak:['mehr erfahren','details','preise','jetzt starten'] },
        fr:{ strong:['acheter','ajouter au panier','passer au paiement','commander','sabonner','sinscrire','inscription','commencer','essai gratuit','demander une demo','réserver une demo','contacter les ventes','obtenir un devis','télécharger'],
             weak:['en savoir plus','voir plus','tarifs'] },
        es:{ strong:['comprar','añadir al carrito','ir a caja','pagar','suscribirse','regístrate','empezar','prueba gratis','reservar demo','pedir presupuesto','descargar'],
             weak:['saber más','ver más','precios'] },
        it:{ strong:['compra','aggiungi al carrello','cassa','ordina','abbonati','registrati','inizia','prova gratis','prenota demo','contatta vendite','richiedi preventivo','scarica'],
             weak:['scopri di più','vedi di più','prezzi'] },
        pt:{ strong:['comprar','adicionar ao carrinho','finalizar compra','assinar','inscrever-se','começar','teste grátis','agendar demo','falar com vendas','obter cotação','baixar'],
             weak:['saiba mais','ver mais','preços'] },
      };
      const HREF_INTENT = /(checkout|kasse|cart|warenkorb|basket|panier|carrito|carrinho|signup|register|inscription|registrar|pricing|preise|precios|planos|plans|quote|angebot|orcamento|preventivo|contact|kontakt|contato|demo|trial|subscribe|abonnieren|abonnement)/i;
      const CLASS_PRIMARY_HINT = /(btn(-|_)?(primary|cta)|cta(-|_)?btn|button(-|_)?primary|primary(-|_)?button)/i;

      const lang = getLang();

      // --- visibility + shape helpers from your original code ---
      const isVisible = (el) => {
        const cs = getComputedStyle(el);
        if (cs.visibility === "hidden" || cs.display === "none" || parseFloat(cs.opacity||"1") < 0.05) return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      };
      const looksLikeButton = (el) => {
        const role = (el.getAttribute("role") || "").toLowerCase();
        const type = (el.getAttribute("type") || "").toLowerCase();
        const cls  = (el.className || "").toString().toLowerCase();
        const id   = (el.id || "").toLowerCase();
        const classHit = /\b(btn|button|cta|primary|pill|calltoaction|call-to-action)\b/.test(cls)
                      || /\b(btn|button|cta|primary|pill)\b/.test(id)
                      || /\b(btn-|button-|cta-|primary-)/.test(cls);
        const cs = getComputedStyle(el);
        const hasBg = cs.backgroundColor && cs.backgroundColor !== "rgba(0, 0, 0, 0)" && cs.backgroundColor !== "transparent";
        const radius = ["borderTopLeftRadius","borderTopRightRadius","borderBottomLeftRadius","borderBottomRightRadius"]
          .map(k => parseFloat(cs[k] || "0")).reduce((a,b)=>a+b,0);
        const rounded = radius >= 12;
        return classHit || role === "button" || type === "button" || type === "submit" || (hasBg && rounded);
      };

      // --- new: drop hamburgers/nav toggles ---
      function isLikelyNavToggle(el) {
        const name = norm(el.getAttribute("aria-label") || el.textContent || "");
        const withinNav = !!el.closest("nav,[role='navigation']");
        const cls = norm(el.className || "");
        const hasMenuToken = ["menu","menü","hamburger"].some(t => name.includes(t) || cls.includes(t));
        const togglesNav = el.hasAttribute("aria-expanded") || el.hasAttribute("aria-controls");
        return withinNav && (hasMenuToken || togglesNav);
      }

      function hasPhrase(text, list){ const s = norm(text); return list.some(p => s.includes(norm(p))); }

      // --- main CTA classifier used by TTV watcher ---
      function isCTA(el) {
        if (!el.matches || !el.matches("a,button,[role='button'],input[type='submit']")) return false;
        if (!isVisible(el)) return false;
        if (isLikelyNavToggle(el)) return false;

        const label = (el.innerText || el.value || el.getAttribute("aria-label") || el.getAttribute("title") || "").trim();
        const href = (el.getAttribute("href") || "").trim();
        const type = (el.getAttribute("type") || "").toLowerCase();
        const cls  = el.className || "";

        const strong = [...LEX.en.strong, ...(LEX[lang]?.strong||[])];
        const weak   = [...LEX.en.weak,   ...(LEX[lang]?.weak||[])];

        if (hasPhrase(label, strong)) return true;
        if (hasPhrase(label, weak) && (CLASS_PRIMARY_HINT.test(cls) || HREF_INTENT.test(href) || type === "submit")) return true;
        if (!label && HREF_INTENT.test(href) && CLASS_PRIMARY_HINT.test(cls)) return true; // icon-only

        // last resort: visually button + clear intent in href or submit
        if (looksLikeButton(el) && (HREF_INTENT.test(href) || type === "submit")) return true;

        return false;
      }

      let done = false;
      const mark = () => {
        if (done) return;
        done = true;
        window._foldyCtaTtvMs = Math.max(0, Math.round(performance.now() - t0));
      };

      const io = new IntersectionObserver((entries) => {
        for (const e of entries) {
          if (e.isIntersecting) { mark(); break; }
        }
      }, { root: null, threshold: [0, 0.01] });

      const seed = () => {
        document.querySelectorAll("a,button,[role='button'],input[type='submit']").forEach((el) => { if (isCTA(el)) io.observe(el); });
      };
      const mo = new MutationObserver((muts) => {
        for (const m of muts) for (const n of m.addedNodes) {
          if (n.nodeType !== 1) continue;
          const el = n;
          if (isCTA(el)) io.observe(el);
          el.querySelectorAll?.("a,button,[role='button'],input[type='submit']").forEach((c) => { if (isCTA(c)) io.observe(c); });
        }
      });

      document.addEventListener("DOMContentLoaded", seed, { once: true });
      try { seed(); } catch {}
      try { mo.observe(document.documentElement, { childList: true, subtree: true }); } catch {}

      setTimeout(() => {
        try {
          if (!window._foldyCtaTtvMs) {
            const any = Array.from(document.querySelectorAll("a,button,[role='button'],input[type='submit']")).some((el) => {
              if (!isCTA(el)) return false;
              const r = el.getBoundingClientRect();
              return r.top < innerHeight && r.bottom > 0 && r.left < innerWidth && r.right > 0;
            });
            if (any) mark();
          }
        } catch {}
      }, 3000);

      setTimeout(() => {
        if (!window._foldyCtaTtvMs) window._foldyCtaTtvMs = Math.max(0, Math.round(performance.now() - t0));
        io.disconnect?.(); mo.disconnect?.();
      }, 30000);
    } catch {}
  })();
});
  // END NEW: CTA TTV watcher

  page.setDefaultTimeout(15000);
  page.setDefaultNavigationTimeout(15000);
}

/** ---------- In-page auditing ---------- **/
const PAGE_EVAL = {
  async asSeen(page) { return page.screenshot({ type: "png", fullPage: false, timeout: SNAP_TIMEOUT_MS - 500 }); },

  // Pre-hide overlays
  async preHideOverlays(
    page,
    { timeoutMs = (typeof HIDE_TIMEOUT_MS !== 'undefined' ? HIDE_TIMEOUT_MS : 4000) } = {}
  ) {
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

        const btnCount = el.querySelectorAll("button,a,[role='button']").length;
        const wideBar = (inFoldWidth / vw) >= 0.6;
        const likelyBar = (r.height >= 48 && r.top >= vh - 220 && wideBar && btnCount >= 2);

        if (looksLikeCookie) return true;
        if (likelyBar) return true;
        return inFoldArea / foldArea >= 0.20;
      });

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
      if ((e.message || '').includes('PREHIDE_TIMEOUT')) {
        return { overlayRects: [], overlayElemsMarked: 0, overlayCoveragePct: 0, overlayBlockers: 0, _preHideTimedOut: true };
      }
      throw e;
    }
  },

  // Hide ONLY tagged overlays
  async hideOverlays(page) {
    await page.addStyleTag({ content: `[data-foldy-overlay-candidate="1"]{display:none!important}` });
  },

  // Compute coverage + metrics (+ NEW heuristics)
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
        if (cs.visibility === "hidden" || cs.display === "none") return false;
        if (parseFloat(cs.opacity || "1") < 0.05) return false;
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) return false;
        if (r.bottom <= 0 || r.right <= 0 || r.top >= vh || r.left >= vw) return false;
        return true;
      }

// --- helpers for CTA detection (i18n + nav-toggle exclusion) ---
// --- helpers for CTA detection (UPDATED: 2025-08-26 i18n + nav-toggle exclusion) ---
function norm(s){
  return (s || "").normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLowerCase().trim();
}
function getLang(){
  let l = (document.documentElement.getAttribute("lang") || "").toLowerCase();
  if (!l) {
    const m = document.querySelector('meta[http-equiv="content-language"], meta[name="language"], meta[property="og:locale"]');
    l = (m?.getAttribute("content") || "").toLowerCase();
  }
  l = l.split(/[-_]/)[0];
  return ["en","de","fr","es","it","pt"].includes(l) ? l : "en";
}

// NEW: i18n phrase lexicon
const LEX = {
  en:{ strong:['buy','add to cart','checkout','order now','subscribe','sign up','get started','start free trial','try free','book demo','schedule demo','contact sales','get quote','request quote','download'],
       weak:['learn more','see more','details','view more','explore','pricing','start now'] },
  de:{ strong:['kaufen','in den warenkorb','zur kasse','jetzt kaufen','bestellen','abonnieren','anmelden','registrieren','loslegen','kostenlos testen','demo buchen','demo vereinbaren','vertrieb kontaktieren','angebot anfordern','preis anfragen','herunterladen'],
       weak:['mehr erfahren','details','preise','jetzt starten'] },
  fr:{ strong:['acheter','ajouter au panier','passer au paiement','commander','sabonner','sinscrire','inscription','commencer','essai gratuit','demander une demo','réserver une demo','contacter les ventes','obtenir un devis','télécharger'],
       weak:['en savoir plus','voir plus','tarifs'] },
  es:{ strong:['comprar','añadir al carrito','ir a caja','pagar','suscribirse','regístrate','empezar','prueba gratis','reservar demo','pedir presupuesto','descargar'],
       weak:['saber más','ver más','precios'] },
  it:{ strong:['compra','aggiungi al carrello','cassa','ordina','abbonati','registrati','inizia','prova gratis','prenota demo','contatta vendite','richiedi preventivo','scarica'],
       weak:['scopri di più','vedi di più','prezzi'] },
  pt:{ strong:['comprar','adicionar ao carrinho','finalizar compra','assinar','inscrever-se','começar','teste grátis','agendar demo','falar com vendas','obter cotação','baixar'],
       weak:['saiba mais','ver mais','preços'] },
};

// Intent hints
const HREF_INTENT = /(checkout|kasse|cart|warenkorb|basket|panier|carrito|carrinho|signup|register|inscription|registrar|pricing|preise|precios|planos|plans|quote|angebot|orcamento|preventivo|contact|kontakt|contato|demo|trial|subscribe|abonnieren|abonnement)/i;
const CLASS_PRIMARY_HINT = /(btn(-|_)?(primary|cta)|cta(-|_)?btn|button(-|_)?primary|primary(-|_)?button)/i;

// (UNCHANGED) button-ish look heuristic (kept from your file)
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

// NEW: ignore hamburger/menu toggles inside <nav>
function _foldyIsNavToggle(el) {
  const name = norm(el.getAttribute("aria-label") || el.textContent || "");
  const withinNav = !!el.closest("nav,[role='navigation']");
  const cls = norm(el.className || "");
  const hasMenuToken = ["menu","menü","hamburger"].some(t => name.includes(t) || cls.includes(t));
  const togglesNav = el.hasAttribute("aria-expanded") || el.hasAttribute("aria-controls");
  return withinNav && (hasMenuToken || togglesNav);
}

function _foldyHasPhrase(text, list){ const s = norm(text); return list.some(p => s.includes(norm(p))); }

// NEW: canonical CTA predicate
function _foldyIsCTA(el) {
  if (!el.matches("a,button,[role='button'],input[type='submit']")) return false;
  if (!isVisible(el)) return false;
  if (_foldyIsNavToggle(el)) return false;

  const lang = getLang();
  const strong = [...LEX.en.strong, ...(LEX[lang]?.strong||[])];
  const weak   = [...LEX.en.weak,   ...(LEX[lang]?.weak||[])];

  const label = (el.innerText || el.value || el.getAttribute("aria-label") || el.getAttribute("title") || "").trim();
  const href  = (el.getAttribute("href") || "").trim();
  const type  = (el.getAttribute("type") || "").toLowerCase();
  const cls   = el.className || "";

  if (_foldyHasPhrase(label, strong)) return true;
  if (_foldyHasPhrase(label, weak) && (CLASS_PRIMARY_HINT.test(cls) || HREF_INTENT.test(href) || type === "submit")) return true;
  if (!label && HREF_INTENT.test(href) && CLASS_PRIMARY_HINT.test(cls)) return true;
  if (looksLikeButton(el) && (HREF_INTENT.test(href) || type === "submit")) return true;

  return false;
}

// MODIFIED: shim so any legacy call-sites still work
function hasCtaText(el) {
  const lang = getLang();
  const strong = [...LEX.en.strong, ...(LEX[lang]?.strong||[])];
  const weak   = [...LEX.en.weak,   ...(LEX[lang]?.weak||[])];
  const t = (el.innerText || el.value || el.getAttribute("aria-label") || el.getAttribute("title") || "");
  if (_foldyHasPhrase(t, strong)) return true;
  const href  = (el.getAttribute("href") || "").trim();
  const type  = (el.getAttribute("type") || "").toLowerCase();
  const cls   = el.className || "";
  return _foldyHasPhrase(t, weak) && (CLASS_PRIMARY_HINT.test(cls) || HREF_INTENT.test(href) || type === "submit");
}


      // --- Rect collectors (text/media/cta/hero) ---
      function rectsForTextNodes() {
        const rects = [];
        const vw = window.innerWidth, vh = window.innerHeight;
        const WS = /[\s\u00A0\u1680\u180E\u2000-\u200B\u202F\u205F\u3000\uFEFF]/;
        const alphaOf = (cssColor) => {
          const m = /\brgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)/i.exec(cssColor || "");
          return m ? (m[4] === undefined ? 1 : parseFloat(m[4])) : 1;
        };
        function rectHasGlyph(rect) {
          const { left, top, width, height } = rect;
          if (width <= 0 || height <= 0) return false;
          const samples = Math.min(10, Math.max(3, Math.ceil(width / 8)));
          const y = Math.min(vh - 1, Math.max(0, top + height / 2));
          for (let i = 0; i < samples; i++) {
            const x = Math.min(vw - 1, Math.max(0, left + ((i + 0.5) / samples) * width));
            const cp = (document.caretPositionFromPoint && document.caretPositionFromPoint(x, y)) || null;
            if (cp && cp.offsetNode && cp.offsetNode.nodeType === Node.TEXT_NODE) {
              const s = cp.offsetNode.nodeValue || ""; const k = Math.min(Math.max(cp.offset, 0), Math.max(0, s.length - 1));
              if (s[k] && !WS.test(s[k])) return true;
            }
            const cr = (document.caretRangeFromPoint && document.caretRangeFromPoint(x, y)) || null;
            if (cr && cr.startContainer && cr.startContainer.nodeType === Node.TEXT_NODE) {
              const s = cr.startContainer.nodeValue || ""; const k = Math.min(Math.max(cr.startOffset, 0), Math.max(0, s.length - 1));
              if (s[k] && !WS.test(s[k])) return true;
            }
          }
          return false;
        }
        const walker = document.createTreeWalker(
          document.body,
          NodeFilter.SHOW_TEXT,
          {
            acceptNode: (n) => {
              const s = n.nodeValue || "";
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
          const range = document.createRange();
          try {
            range.selectNodeContents(node);
            const list = range.getClientRects();
            for (const r of list) {
              if (!rectHasGlyph(r)) continue;
              let x = Math.max(0, Math.min(r.left, vw));
              let y = Math.max(0, Math.min(r.top, vh));
              let w = Math.max(0, Math.min(r.right, vw) - x);
              let h = Math.max(0, Math.min(r.bottom, vh) - y);
              if (w <= 1 || h <= 6) continue;
              const targetH = Math.min(h, Math.max(8, fs * 1.3));
              const dy = (h - targetH) / 2;
              y = Math.max(0, Math.min(y + dy, vh));
              h = Math.max(0, Math.min(targetH, vh - y));
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
      
        const btns = Array.from(document.querySelectorAll("a,button,[role='button'],input[type='submit']"))
          .filter(isVisible)
          .filter(_foldyIsCTA);

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
          if (!isRaster || isSvg) return;

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
      const nodes = Array.from(document.querySelectorAll("a,button,[role='button'],input[type='submit']"))
        .filter(isVisible)
        .filter(_foldyIsCTA)
        .map(el => {
          const r = el.getBoundingClientRect();
          const text = (el.innerText || el.value || el.getAttribute("aria-label") || el.getAttribute("title") || "").trim();
          const lang = getLang();
          const strong = [...LEX.en.strong, ...(LEX[lang]?.strong||[])];
          const kind = _foldyHasPhrase(text, strong) ? "primary" : "secondary";
          return { el, r, text, kind };
        });
    
      const inFold = nodes.filter(n => n.r.top >= 0 && n.r.bottom <= window.innerHeight)
                          .sort((a,b) => a.r.top - b.r.top);
      const first = inFold[0] || null;
    
      return {
        firstCtaInFold: !!first,
        ctaText: first?.text || null,
        ctaKind: first?.kind || null,
        ctaCandidatesCount: nodes.length
      };
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

      // NEW — Safe-Area checks
      const viewportMetaEl = document.querySelector('meta[name="viewport"]');
      const viewportContent = (viewportMetaEl?.getAttribute("content") || "").toLowerCase();
      const viewportFitCover = /\bviewport-fit\s*=\s*cover\b/.test(viewportContent);
      const usesSafeAreaCSS = (() => {
        const sheets = Array.from(document.querySelectorAll("style"));
        const sheetHit = sheets.some((s) => (s.textContent || "").includes("safe-area-inset"));
        const inlineHit = Array.from(document.querySelectorAll("[style]")).some((el) =>
          (el.getAttribute("style") || "").includes("safe-area-inset")
        );
        return sheetHit || inlineHit;
      })();

      function bandIntersects(rects, y0, y1) {
        return rects.some(([x, y, w, h]) => {
          const yy0 = Math.max(y, y0), yy1 = Math.min(y + h, y1);
          const xx0 = Math.max(x, 0),    xx1 = Math.min(x + w, vw);
          return (yy1 - yy0) > 2 && (xx1 - xx0) > 2;
        });
      }

      // Fixed header detector (top-pinned, wide, fixed|sticky)
      function fixedHeaderPct() {
        let maxH = 0;
        const els = Array.from(document.querySelectorAll("body *")).filter(isVisible);
        for (const el of els) {
          const cs = getComputedStyle(el);
          const pos = cs.position;
          if (!(pos === "fixed" || pos === "sticky")) continue;
          const r = el.getBoundingClientRect();
          const nearTop = r.top <= 2;
          const wide = r.width >= 0.8 * vw;
          if (nearTop && wide && r.height > 8) {
            maxH = Math.max(maxH, r.height);
          }
        }
        return Math.min(100, Math.round((maxH / vh) * 100));
      }

      // CTA contrast (WCAG AA) — compute min ratio among in-fold CTAs
      function parseColorToRGBA(s) {
        if (!s) return [255,255,255,1];
        s = s.trim().toLowerCase();
        // rgb/rgba()
        let m = s.match(/^rgba?\(([^)]+)\)$/);
        if (m) {
          const parts = m[1].split(",").map(x => x.trim());
          const r = parseFloat(parts[0]), g = parseFloat(parts[1]), b = parseFloat(parts[2]);
          const a = parts[3] !== undefined ? parseFloat(parts[3]) : 1;
          return [r,g,b, isNaN(a) ? 1 : a];
        }
        // #rgb/#rrggbb
        m = s.match(/^#([0-9a-f]{3,8})$/i);
        if (m) {
          const hex = m[1];
          if (hex.length === 3) {
            const r = parseInt(hex[0]+hex[0],16), g = parseInt(hex[1]+hex[1],16), b = parseInt(hex[2]+hex[2],16);
            return [r,g,b,1];
          }
          if (hex.length === 6) {
            const r = parseInt(hex.slice(0,2),16), g = parseInt(hex.slice(2,4),16), b = parseInt(hex.slice(4,6),16);
            return [r,g,b,1];
          }
          if (hex.length === 8) {
            const r = parseInt(hex.slice(0,2),16), g = parseInt(hex.slice(2,4),16), b = parseInt(hex.slice(4,6),16), a = parseInt(hex.slice(6,8),16)/255;
            return [r,g,b,a];
          }
        }
        // default
        return [255,255,255,1];
      }
      function relLum([r,g,b]) {
        const f = (c) => {
          c = c/255;
          return (c <= 0.03928) ? (c/12.92) : Math.pow((c+0.055)/1.055, 2.4);
        };
        return 0.2126*f(r) + 0.7152*f(g) + 0.0722*f(b);
      }
      function effectiveBgRGBA(el) {
        let node = el;
        while (node && node !== document.documentElement) {
          const cs = getComputedStyle(node);
          const bg = cs.backgroundColor;
          const [r,g,b,a] = parseColorToRGBA(bg);
          if (a > 0.01 && !(r===0 && g===0 && b===0 && a===0)) return [r,g,b,a];
          node = node.parentElement;
        }
        return [255,255,255,1]; // fallback white
      }
      function minCtaContrastInFold(els) {
        let minRatio = Infinity;
        let any = false;
        for (const el of els) {
          if (!isVisible(el)) continue;
          const r = el.getBoundingClientRect();
          if (!(r.top >= 0 && r.bottom <= vh)) continue; // must be fully in fold
          const cs = getComputedStyle(el);
          const fg = parseColorToRGBA(cs.color);
          const bg = effectiveBgRGBA(el);
          const L1 = relLum([fg[0],fg[1],fg[2]]);
          const L2 = relLum([bg[0],bg[1],bg[2]]);
          const ratio = (Math.max(L1,L2) + 0.05) / (Math.min(L1,L2) + 0.05);
          if (Number.isFinite(ratio)) {
            minRatio = Math.min(minRatio, ratio);
            any = true;
          }
        }
        return any ? minRatio : null;
      }

      const small = smallTapTargets();
      const textRects = rectsForTextNodes();
      const mediaRects = rectsForMedia();
      const ctaRects = rectsForCTAs();
      const heroRects = rectsForHeroBackgrounds();

      const allRects = textRects.concat(mediaRects, ctaRects, heroRects);
      const coveredCells = rasterizeToGrid(allRects);

      const foldCoveragePct = Math.round((coveredCells.length / (GRID_ROWS * GRID_COLS)) * 100);
      const paintedCoveragePct = 100; // reserved

      const { firstCtaInFold, ctaText, ctaKind, ctaCandidatesCount } = ctaDetection();
      const { minFontPx, maxFontPx } = foldFontStats();

      // NEW — Safe-area risk bands (heuristic heights)
      const TOP_BAND = 44;   // approx iOS sensor+bar zone in CSS px
      const BOT_BAND = 34;   // approx iOS home indicator zone
      const safeAreaRiskTop    = viewportFitCover && !usesSafeAreaCSS && bandIntersects(allRects, 0, TOP_BAND);
      const safeAreaRiskBottom = viewportFitCover && !usesSafeAreaCSS && bandIntersects(allRects, vh - BOT_BAND, vh);

      // NEW — Fixed header pct
      const fixedHeaderPctVal = fixedHeaderPct();

      // NEW — CTA contrast
      const ctaNodes = Array.from(document.querySelectorAll("a,button,[role='button'],input[type='submit']")).filter(_foldyIsCTA);
      const ctaContrastMin = minCtaContrastInFold(ctaNodes);
      const ctaContrastFail = (ctaContrastMin !== null) ? (ctaContrastMin < 4.5) : false;

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
        
          // NEW fields
          viewportFitCover,
          usesSafeAreaCSS,
          safeAreaRiskTop,
          safeAreaRiskBottom,
          fixedHeaderPct: fixedHeaderPctVal,
          ctaContrastMin: (ctaContrastMin !== null ? Number(ctaContrastMin.toFixed(2)) : null),
          ctaContrastFail,
          ctaCandidatesCount,
        
          // NEW: expose CTA text + kind (for debugging & UX)
          ctaText,
          ctaKind
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

      ctx.fillStyle = "rgba(0,255,0,0.12)";
      for (let i = 0; i < debugRects.coveredCells.length; i++) {
        const idx = debugRects.coveredCells[i];
        const gy = (idx / cols) | 0;
        const gx = idx % cols;
        ctx.fillRect(gx * cellW, gy * cellH, cellW, cellH);
      }

      const MAX_STROKES = 2000;
      let drawn = 0;
      function drawRects(rects, stroke) {
        if (!rects) return;
        const ctx2 = ctx;
        ctx2.strokeStyle = stroke;
        const n = Math.min(rects.length, Math.max(0, MAX_STROKES - drawn));
        for (let i = 0; i < n; i++) {
          const [x, y, w, h] = rects[i];
          ctx2.strokeRect(x, y, w, h);
        }
        drawn += n;
      }
      drawRects(debugRects.glyphRects,  "rgba(0,128,0,0.7)");
      drawRects(debugRects.mediaRects,  "rgba(0,0,255,0.7)");
      drawRects(debugRects.ctaRects,    "rgba(128,0,128,0.85)");
      drawRects(debugRects.heroBgRects, "rgba(255,165,0,0.8)");
      drawRects(debugRects.smallTapRects, "rgba(255, 215, 0, 0.95)");
    }, debugRects);

    await page.evaluate(async () => { if (document.fonts?.ready) await document.fonts.ready; });
    const png = await page.screenshot({ type: "png", fullPage: false, timeout: SCREENSHOT_TIMEOUT_MS });
    await page.evaluate(() => document.getElementById("_foldy_heatmap")?.remove());
    return png;
  },
}; // <-- do not remove; closes PAGE_EVAL

/** ---------- Routes ---------- **/
app.get("/health", (_req, res) => res.json({ ok: true, up: true }));

app.post("/render", authMiddleware, async (req, res) => {
  await _foldyAcquire(); // NEW: serialize per-process renders
  res.setTimeout(HARD_TIMEOUT_MS + 5000);
  req.setTimeout?.(HARD_TIMEOUT_MS + 5000);

  const t0 = now();
  const q = req.query || {};
  const body = req.body || {};

  const relaxed =
    (process.env.RENDER_DISABLE_TIMEOUTS === "1") ||
    (String(body.relaxed ?? q.relaxed ?? "0") === "1");

  const WT = (p, ms, label) => (relaxed ? p : withTimeout(p, ms, label));

  if (relaxed) {
    const long = Math.max(120000, (HARD_TIMEOUT_MS || 45000) * 3);
    res.setTimeout(long);
    req.setTimeout?.(long);
  }

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
      page.setDefaultTimeout(0);
      page.setDefaultNavigationTimeout(0);
    }

    // Navigate
    const navStart = now();
    await WT(page.goto(safeUrl, { waitUntil: "domcontentloaded", timeout: relaxed ? 0 : NAV_TIMEOUT_MS }), NAV_TIMEOUT_MS, "page.goto");
    await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(700).catch(() => {});
    const navEnd = now();

    // NEW: 2025-08-27 fast-fail on bot/challenge pages to avoid 90s proxy aborts
    async function _foldyBotDetect(page) { // NEW
      try {
        return await page.evaluate(() => {
          const t = ((document.title || "") + " " + (document.body?.innerText || "")).toLowerCase();
          // Cloudflare / common bot challenge phrases
          const rx = /(just a moment|checking your browser|verify you are human|are you a human|cloudflare|attention required|enable javascript)/i;
          // Turnstile / hcaptcha markers
          const hasTurnstile = !!document.querySelector('[data-sitekey][data-callback], iframe[src*="challenges.cloudflare.com"]');
          const hasHcaptcha  = !!document.querySelector('iframe[src*="hcaptcha.com"], div.h-captcha');
          return rx.test(t) || hasTurnstile || hasHcaptcha;
        });
      } catch {
        return false;
      }
    }
    
    try {
      const botBlocked = await _foldyBotDetect(page); // NEW
      if (botBlocked) {
        let asSeenPngBuf = null;
        try {
          asSeenPngBuf = await page.screenshot({ type: "png", fullPage: false, timeout: SCREENSHOT_TIMEOUT_MS });
        } catch (_) {}
        // Minimal payload; keep shape close to normal error for n8n
        const blockedPayload = {
          error: "bot_protection_detected",
          url: safeUrl,
          debugFlags: { botProtection: true },
          timings: { nav_ms: ms(navStart, navEnd) },
          pngBase64: asSeenPngBuf ? asSeenPngBuf.toString("base64") : undefined
        };
        try { await browser.close(); } catch {}
        return res.status(422).json(blockedPayload);
      }
    } catch (_) { /* ignore and proceed */ }


    // As-seen (optional)
    let asSeenPngBuf = null;
    if (debugOverlay) {
      try {
        await page.evaluate(async () => { if (document.fonts?.ready) await document.fonts.ready; });
        asSeenPngBuf = await page.screenshot({ type: "png", fullPage: false, timeout: relaxed ? 0 : SCREENSHOT_TIMEOUT_MS });
      } catch (e) {
        console.warn('[debugOverlay] as-seen failed:', e?.message || e);
      }
    }

    // Pre-hide overlay audit
    const preStart = now();
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

    // === Screenshot job enqueue (before screenshot work) ===
    let screenshot_key = null;
    let screenshot_url = null;
    let screenshot_job_id = null;
    
    try {
      // Use current time for this request; payload is not built yet here
      const ts = Date.now();
    
      // Build the storage key using the requested URL + timestamp + device
      screenshot_key = _foldyKeyFrom(safeUrl, ts, deviceKey);
    
      // Precompute a public URL (optional, convenient for clients)
      if (supabase) {
        const { data } = supabase.storage.from(SUPABASE_BUCKET).getPublicUrl(screenshot_key);
        screenshot_url = data.publicUrl;
      }
    
      // Optional: forward a run_id from the request if present
      const run_id = (req.body?.run_id || req.query?.run_id || null) || null;
    
      if (!supabase) {
        console.warn("[foldy] Supabase not configured; skipping screenshot job enqueue");
      } else {
        // Insert job as queued; the worker will process and upload later
        const { data: job, error: jobErr } = await supabase
          .from("screenshot_jobs")
          .insert({
            run_id,
            device: deviceKey,
            url: safeUrl,
            render_ts_ms: ts,
            status: "queued",
            screenshot_key,
            screenshot_url
          })
          .select("*")
          .single();
    
        if (jobErr) {
          console.error("[foldy] failed to enqueue screenshot job:", jobErr);
        } else {
          screenshot_job_id = job.id;
        }
      }
    } catch (e) {
      console.warn("[foldy] enqueue screenshot job skipped:", e?.message || e);
    }
    // === /enqueue ===


    // NEW: Pull CTA TTV (ms) from page (recorded by init script)
    let ctaTtvMs = await page.evaluate(() => (typeof window._foldyCtaTtvMs === "number" ? Math.max(0, Math.round(window._foldyCtaTtvMs)) : null));
    // Fallback: if not recorded but CTA is visible now, approximate as time since navStart
    if ((ctaTtvMs === null || ctaTtvMs === undefined) && ux?.firstCtaInFold) {
      ctaTtvMs = ms(navStart, now());
    }

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
      // NEW: echo the requested URL as the first line in the JSON
      url: safeUrl,
      ts_ms: nowDate.getTime(),
      ts_iso: nowDate.toISOString(),
      serviceVersion: SERVICE_VERSION,

      device: deviceKey,
      deviceMeta,
      // no inline base64; we return storage info + job id
      screenshot_url: screenshot_url || null,
      screenshot_key: screenshot_key || null,
      screenshot_job_id: screenshot_job_id || null,

      ux: {
        ...ux,
        overlayCoveragePct: pre.overlayCoveragePct,
        overlayBlockers: pre.overlayBlockers,
        overlayElemsMarked: pre.overlayElemsMarked,

        // NEW: CTA time-to-visibility
        ctaTtvMs: (typeof ctaTtvMs === "number" ? ctaTtvMs : null),
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
        overlayRects: pre.overlayRects,
      };
    }

    return res.json(payload);
  } catch (err) {
    const status = err?.status || 500;
    console.error("Render error:", deviceKey, urlRaw, err?.message || err);
    return res.status(status).json({ error: String(err?.message || err) });
  } finally {
    _foldyRelease(); // NEW
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
