*** a/index.js
--- b/index.js
@@
-'use strict';
-// TODO: existing draft had unstable nav & overlay logic.
-// Replace with hardened implementation per CONTEXT.md.
+'use strict';
+
+/**
+ * Foldy Render Service
+ * Node/Express + Playwright (Chromium)
+ * - Auth: Bearer RENDER_TOKEN (optionally RENDER_TOKEN_NEXT during rotation)
+ * - SSRF guard: http/https only; block localhost/private ranges
+ * - One shared Chromium; 1 context per request; auto-relaunch on disconnect
+ * - Deterministic nav & settle; disable animations; block trackers/video
+ * - Overlay handling: measure pre-hide (penalty), then hide → compute CLEAN fold
+ * - Debug: debugOverlay, debugRects, debugHeatmap
+ */
+
+const express = require('express');
+const { chromium } = require('playwright');
+const dns = require('node:dns').promises;
+const urlLib = require('node:url');
+
+// ---------- Env ----------
+const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
+const TOKENS = new Set(
+  [process.env.RENDER_TOKEN, process.env.RENDER_TOKEN_NEXT].filter(Boolean)
+);
+if (!TOKENS.size) {
+  console.error('FATAL: RENDER_TOKEN missing');
+  process.exit(1);
+}
+
+// ---------- Device Map (MVP) ----------
+// Matches docs (vp size is CSS px, dpr=3 by default).
+// UA is a reasonable Safari/Chrome mobile string for stability.
+const DEVICES = {
+  iphone_15_pro:     { label: 'iPhone 15 Pro',     viewport: { width: 393, height: 852 }, dpr: 3, ua:
+    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' },
+  iphone_15_pro_max: { label: 'iPhone 15 Pro Max', viewport: { width: 430, height: 932 }, dpr: 3, ua:
+    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' },
+  pixel_8:           { label: 'Pixel 8',           viewport: { width: 412, height: 915 }, dpr: 3, ua:
+    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36' },
+  galaxy_s23:        { label: 'Galaxy S23',        viewport: { width: 360, height: 800 }, dpr: 3, ua:
+    'Mozilla/5.0 (Linux; Android 14; SM-S911B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36' },
+  iphone_se_2:       { label: 'iPhone SE (2nd)',   viewport: { width: 375, height: 667 }, dpr: 3, ua:
+    'Mozilla/5.0 (iPhone; CPU iPhone OS 15_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.6 Mobile/15E148 Safari/604.1' },
+};
+
+// ---------- Shared Chromium ----------
+let browser;            // active browser
+let launching = null;   // inflight launch promise
+async function ensureBrowser() {
+  if (browser && browser.isConnected()) return browser;
+  if (launching) return launching;
+  launching = chromium.launch({
+    headless: true,
+    args: [
+      '--disable-dev-shm-usage',
+      '--no-sandbox',
+      '--disable-setuid-sandbox',
+      '--disable-gpu',
+    ],
+  }).then(b => {
+    browser = b;
+    browser.on('disconnected', () => { browser = null; });
+    return b;
+  }).finally(() => { launching = null; });
+  return launching;
+}
+
+// ---------- Express ----------
+const app = express();
+app.use(express.json({ limit: '1mb' }));
+
+// Auth middleware
+function requireAuth(req, res, next) {
+  const auth = req.headers['authorization'] || '';
+  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
+  if (!TOKENS.has(token)) {
+    return res.status(401).json({ error: 'Unauthorized' });
+  }
+  next();
+}
+
+// Basic SSRF guard (scheme + host checks; DNS resolution optional)
+function isBlockedHost(host) {
+  const h = (host || '').toLowerCase();
+  if (!h) return true;
+  if (h === 'localhost' || h === '127.0.0.1' || h === '[::1]') return true;
+  if (/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.test(h)) {
+    const [a,b] = h.split('.').map(Number);
+    // 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 127.0.0.0/8
+    if (a === 10) return true;
+    if (a === 127) return true;
+    if (a === 192 && b === 168) return true;
+    if (a === 172 && b >= 16 && b <= 31) return true;
+  }
+  return false;
+}
+async function ssrfGuard(u) {
+  let parsed;
+  try { parsed = new urlLib.URL(u); } catch { return { ok: false, why: 'invalid_url' }; }
+  if (!/^https?:$/.test(parsed.protocol)) return { ok: false, why: 'scheme' };
+  if (isBlockedHost(parsed.hostname)) return { ok: false, why: 'host' };
+  // Optional DNS hardening: block obvious localhost mappings (best-effort)
+  try {
+    const addrs = await dns.lookup(parsed.hostname, { all: true });
+    for (const a of addrs) {
+      if (isBlockedHost(a.address)) return { ok: false, why: 'dns_private' };
+    }
+  } catch { /* ignore resolution failures */ }
+  return { ok: true };
+}
+
+// Health: also confirm browser launches
+app.get('/health', async (_req, res) => {
+  try { await ensureBrowser(); return res.json({ ok: true, up: true }); }
+  catch (e) { return res.status(500).json({ ok: false, error: String(e) }); }
+});
+
+// ---------- Core: /render ----------
+app.post('/render', requireAuth, async (req, res) => {
+  const q = req.query || {};
+  const { url, device } = req.body || {};
+  const debugOverlay  = q.debugOverlay  === '1' || req.body?.debugOverlay  === true;
+  const debugRects    = q.debugRects    === '1' || req.body?.debugRects    === true;
+  const debugHeatmap  = q.debugHeatmap  === '1' || req.body?.debugHeatmap  === true;
+
+  if (!url || !device || !DEVICES[device]) {
+    return res.status(400).json({ error: 'Bad Request: missing or invalid url/device' });
+  }
+  const guard = await ssrfGuard(url);
+  if (!guard.ok) return res.status(422).json({ error: 'URL blocked by SSRF guard', why: guard.why });
+
+  const dev = DEVICES[device];
+  const t0 = Date.now();
+  let nav_ms=0, settle_ms=0, audit_ms=0, hide_ms=0, clean_ms=0, screenshot_ms=0;
+
+  let context, page;
+  let pngAsSeenB64 = null, pngDebugB64 = null;
+  let debugPayload = null;
+
+  try {
+    const br = await ensureBrowser();
+    context = await br.newContext({
+      viewport: dev.viewport,
+      deviceScaleFactor: dev.dpr,
+      userAgent: dev.ua,
+      isMobile: true,
+      hasTouch: true,
+      locale: 'en-US',
+      colorScheme: 'light',
+      reducedMotion: 'reduce',
+      javaScriptEnabled: true,
+    });
+
+    // Block noisy third parties & heavy media
+    await context.route('**/*', (route) => {
+      const req = route.request();
+      const url = req.url().toLowerCase();
+      const type = req.resourceType();
+      const blockHosts = [
+        'googletagmanager.com','google-analytics.com','doubleclick.net','facebook.com/tr','hotjar.com',
+        'fullstory.com','segment.com','mixpanel.com','amplitude.com','yandex.ru/metrika',
+      ];
+      if (type === 'media' || url.endsWith('.mp4') || url.endsWith('.webm') || url.includes('autoplay=1')) {
+        return route.abort(); // block video
+      }
+      if (blockHosts.some(h => url.includes(h))) {
+        return route.abort();
+      }
+      return route.continue();
+    });
+
+    page = await context.newPage();
+
+    // Kill animations & fixed chat bubbles from affecting taps
+    await page.addStyleTag({ content: `
+      * { animation-duration: 0s !important; animation-delay: 0s !important; transition: none !important; }
+      html, body { scroll-behavior: auto !important; }
+    `});
+
+    // Nav with deterministic strategy: try domcontentloaded → fallback to load
+    const navStart = Date.now();
+    try {
+      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
+    } catch (_) {
+      await page.goto(url, { waitUntil: 'load', timeout: 15000 });
+    }
+    nav_ms = Date.now() - navStart;
+
+    // short settle (network quiet or 600ms whichever first)
+    const settleStart = Date.now();
+    await Promise.race([
+      page.waitForLoadState('networkidle', { timeout: 1200 }).catch(() => {}),
+      new Promise(r => setTimeout(r, 600)),
+    ]);
+    settle_ms = Date.now() - settleStart;
+
+    // Optional as-seen PNG before hiding overlays
+    if (debugOverlay) {
+      const ss = await page.screenshot({ type: 'png' });
+      pngAsSeenB64 = ss.toString('base64');
+    }
+
+    // Audit pre-hide overlays, then hide them, then compute CLEAN fold metrics
+    const auditStart = Date.now();
+    const auditPre = await page.evaluate(({ vw, vh }) => {
+      // Utility helpers
+      const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
+      const fold = { x: 0, y: 0, w: vw, h: vh, area: vw * vh };
+      const visible = (el) => {
+        const s = getComputedStyle(el);
+        if (s.visibility === 'hidden' || s.display === 'none' || Number(s.opacity) === 0) return false;
+        const r = el.getBoundingClientRect();
+        return r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < vh && r.left < vw;
+      };
+      const rectOf = (el) => el.getBoundingClientRect();
+      const interArea = (r) => {
+        const x1 = clamp(r.left, 0, fold.w);
+        const y1 = clamp(r.top, 0, fold.h);
+        const x2 = clamp(r.right, 0, fold.w);
+        const y2 = clamp(r.bottom, 0, fold.h);
+        const w = Math.max(0, x2 - x1);
+        const h = Math.max(0, y2 - y1);
+        return w * h;
+      };
+
+      // Find overlay-like elements (fixed/sticky, large, high z)
+      const overlayRects = [];
+      const overlayElems = [];
+      const all = Array.from(document.querySelectorAll('body *'));
+      for (const el of all) {
+        const s = getComputedStyle(el);
+        if (!['fixed','sticky'].includes(s.position)) continue;
+        if (!visible(el)) continue;
+        const r = rectOf(el);
+        const ia = interArea(r);
+        const z = parseInt(s.zIndex || '0', 10) || 0;
+        // Heuristics: large area or bottom bars/dialogs
+        const large = ia / fold.area >= 0.15;
+        const bottomBar = r.top > vh * 0.55 && ia / fold.area >= 0.05;
+        const dialogRole = el.getAttribute('role') === 'dialog' || el.hasAttribute('aria-modal');
+        if (large || bottomBar || dialogRole || z >= 1000) {
+          overlayRects.push([r.left, r.top, r.width, r.height]);
+          overlayElems.push(el);
+        }
+      }
+
+      const overlayArea = overlayRects.reduce((sum, [x,y,w,h]) => {
+        const ia = interArea({ left: x, top: y, right: x+w, bottom: y+h });
+        return sum + ia;
+      }, 0);
+      const overlayCoveragePct = Math.round((overlayArea / fold.area) * 100);
+      // Blockers: overlays that intersect center or cover CTA-like buttons
+      let overlayBlockers = 0;
+      const cx = vw / 2, cy = vh / 2;
+      overlayElems.forEach((el, i) => {
+        const r = el.getBoundingClientRect();
+        const hitCenter = (cx >= r.left && cx <= r.right && cy >= r.top && cy <= r.bottom);
+        const hasConsentButtons = !!el.querySelector('button, [role="button"], a[href*="accept"], button[id*="accept"], button[name*="accept"]');
+        if (hitCenter || hasConsentButtons) overlayBlockers++;
+      });
+
+      return {
+        overlayCoveragePct,
+        overlayBlockers,
+        overlayRects,
+        overlayElemsMarked: overlayElems.length,
+      };
+    }, { vw: dev.viewport.width, vh: dev.viewport.height });
+    audit_ms = Date.now() - auditStart;
+
+    // Hide overlays (without destroying layout)
+    const hideStart = Date.now();
+    await page.addStyleTag({ content: `
+      [role="dialog"], [aria-modal="true"], .modal, .cookie, .cookies, .cmp, .cc-window, .gdpr, .consent,
+      .evidon-banner, .truste, .osano, .iubenda-cs-container,
+      .fc-consent-root, .fc-dialog-container {
+        display: none !important;
+      }
+      /* Fixed/sticky large layers */
+      body * { will-change: auto !important; }
+      body *:where(:is([style*="position:fixed"],[style*="position: sticky"])) {
+        /* Only hide if very large; guard against headers */
+      }
+    `});
+    // Programmatic hide for the elements we marked
+    await page.evaluate(() => {
+      const foldH = window.innerHeight;
+      const mark = [];
+      const all = Array.from(document.querySelectorAll('body *'));
+      for (const el of all) {
+        const s = getComputedStyle(el);
+        if (!['fixed','sticky'].includes(s.position)) continue;
+        const r = el.getBoundingClientRect();
+        const area = Math.max(0, Math.min(r.bottom, foldH) - Math.max(0, r.top)) * Math.max(0, Math.min(r.right, innerWidth) - Math.max(0, r.left));
+        const big = area / (innerWidth * foldH) >= 0.12;
+        const isHeader = r.height <= 120 && r.top <= 0.5 && (el.tagName === 'HEADER' || /header|nav/i.test(el.className));
+        if (big && !isHeader) {
+          el.setAttribute('data-foldy-hidden', '1');
+          (el).style.setProperty('display', 'none', 'important');
+          mark.push(el);
+        }
+      }
+      return mark.length;
+    });
+    hide_ms = Date.now() - hideStart;
+
+    // CLEAN fold audit (coverage, CTA, fonts, taps, viewport meta)
+    const cleanStart = Date.now();
+    const clean = await page.evaluate(({ vw, vh, debugRects, deviceLabel }) => {
+      const foldArea = vw * vh;
+      const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
+      const isElVisible = (el) => {
+        const s = getComputedStyle(el);
+        if (s.visibility === 'hidden' || s.display === 'none' || Number(s.opacity) === 0) return false;
+        const r = el.getBoundingClientRect();
+        return r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < vh && r.left < vw;
+      };
+      const intersectRect = (r) => {
+        const x1 = clamp(r.left, 0, vw);
+        const y1 = clamp(r.top, 0, vh);
+        const x2 = clamp(r.right, 0, vw);
+        const y2 = clamp(r.bottom, 0, vh);
+        const w = Math.max(0, x2 - x1);
+        const h = Math.max(0, y2 - y1);
+        return { x: x1, y: y1, w, h, area: w*h };
+      };
+
+      // Collect text glyph rects via Range.getClientRects (tight boxes)
+      const glyphRects = [];
+      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
+        acceptNode: (n) => (n.nodeValue && n.nodeValue.trim().length > 0 ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT)
+      });
+      let node;
+      while ((node = walker.nextNode())) {
+        const el = node.parentElement;
+        if (!el || !isElVisible(el)) continue;
+        const r = document.createRange();
+        r.selectNodeContents(node);
+        const rects = Array.from(r.getClientRects());
+        for (const rr of rects) {
+          const inter = intersectRect(rr);
+          if (inter.area > 1) glyphRects.push([inter.x, inter.y, inter.w, inter.h]);
+        }
+      }
+
+      // Media rects (IMG/VIDEO/SVG/CANVAS)
+      const mediaRects = [];
+      document.querySelectorAll('img, video, svg, canvas').forEach(el => {
+        if (!isElVisible(el)) return;
+        const r = el.getBoundingClientRect();
+        const inter = intersectRect(r);
+        if (inter.area > 1) mediaRects.push([inter.x, inter.y, inter.w, inter.h]);
+      });
+
+      // Non-repeating hero backgrounds (large)
+      const heroBgRects = [];
+      const elems = Array.from(document.querySelectorAll('body *'));
+      for (const el of elems) {
+        if (!isElVisible(el)) continue;
+        const s = getComputedStyle(el);
+        if (s.backgroundImage === 'none') continue;
+        if (s.backgroundRepeat && s.backgroundRepeat !== 'no-repeat') continue;
+        const r = el.getBoundingClientRect();
+        const inter = intersectRect(r);
+        if (inter.area / foldArea >= 0.25 && inter.h >= 120) {
+          heroBgRects.push([inter.x, inter.y, inter.w, inter.h]);
+        }
+      }
+
+      // Coverage rasterization 40x24 (cols x rows)
+      const COLS = 24, ROWS = 40; // (swapped to keep tall aspect → more rows)
+      const cellW = vw / COLS, cellH = vh / ROWS;
+      const cover = new Set();
+      const paintRects = glyphRects.concat(mediaRects, heroBgRects);
+      const mark = (x,y,w,h) => {
+        const x0 = Math.floor(x / cellW), y0 = Math.floor(y / cellH);
+        const x1 = Math.floor((x + w) / cellW), y1 = Math.floor((y + h) / cellH);
+        for (let cy = Math.max(0, y0); cy <= Math.min(ROWS-1, y1); cy++) {
+          for (let cx = Math.max(0, x0); cx <= Math.min(COLS-1, x1); cx++) {
+            cover.add(cy * COLS + cx);
+          }
+        }
+      };
+      paintRects.forEach(([x,y,w,h]) => mark(x,y,w,h));
+      const coveredCells = Array.from(cover.values());
+      const foldCoveragePct = Math.round((coveredCells.length / (ROWS * COLS)) * 100);
+
+      // CTA detection (en/fr/de/es/pt/it), accent-insensitive (basic)
+      const CTA_WORDS = [
+        // en
+        'buy now','get started','start now','sign up','subscribe','add to cart','book now','try free',
+        // fr
+        'acheter','commencer','inscription','s’abonner','ajouter au panier','réserver','essayer',
+        // de
+        'jetzt kaufen','loslegen','registrieren','abonnieren','in den warenkorb','buchen','testen',
+        // es
+        'comprar','empezar','regístrate','suscribirse','añadir al carrito','reservar','probar',
+        // pt
+        'comprar','começar','inscreva-se','assinar','adicionar ao carrinho','reservar','experimentar',
+        // it
+        'compra','inizia','registrati','abbonati','aggiungi al carrello','prenota','prova'
+      ];
+      const norm = (s) => (s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');
+      let firstCtaInFold = false;
+      const cands = Array.from(document.querySelectorAll('a,button,[role="button"],input[type=submit]'));
+      for (const el of cands) {
+        if (!isElVisible(el)) continue;
+        const r = el.getBoundingClientRect();
+        if (r.top >= 0 && r.top < vh) {
+          const t = norm(el.innerText || el.value || '');
+          if (CTA_WORDS.some(w => t.includes(w))) { firstCtaInFold = true; break; }
+        }
+      }
+
+      // Fonts (min/max) within fold
+      let minFontPx = Infinity, maxFontPx = 0;
+      const textParents = new Set(glyphRects.length ? glyphRects.map(_=>null) : []);
+      // Fast path: iterate visible elements with text content
+      document.querySelectorAll('body *').forEach(el => {
+        if (!isElVisible(el)) return;
+        if (!el.textContent || !el.textContent.trim()) return;
+        const r = el.getBoundingClientRect();
+        if (r.top >= vh || r.bottom <= 0) return;
+        const fs = parseFloat(getComputedStyle(el).fontSize || '0') || 0;
+        if (fs) {
+          minFontPx = Math.min(minFontPx, fs);
+          maxFontPx = Math.max(maxFontPx, fs);
+        }
+      });
+      if (!isFinite(minFontPx)) minFontPx = 0;
+
+      // Tap target sizing (<44x44) – ignore common chat bubbles bottom-right
+      let smallTapTargets = 0;
+      const ignoreChat = (el) => {
+        const s = getComputedStyle(el);
+        const r = el.getBoundingClientRect();
+        const br = (s.position === 'fixed' && (innerWidth - r.right) <= 24 && (innerHeight - r.bottom) <= 24);
+        const hasChatClass = /chat|intercom|crisp|drift|tidio|messenger|help|support/i.test(el.className + ' ' + (el.id||''));
+        return br && hasChatClass;
+      };
+      const clickables = Array.from(document.querySelectorAll('a,button,[role="button"],input,select'));
+      for (const el of clickables) {
+        if (!isElVisible(el)) continue;
+        if (ignoreChat(el)) continue;
+        const r = el.getBoundingClientRect();
+        if (r.top < vh && r.bottom > 0) {
+          if (r.width < 44 || r.height < 44) smallTapTargets++;
+        }
+      }
+
+      const hasViewportMeta = !!document.querySelector('meta[name="viewport"]');
+      const usesSafeAreaCSS = !!Array.from(document.styleSheets).some(ss => {
+        try {
+          return Array.from(ss.cssRules || []).some(rule =>
+            rule.cssText && rule.cssText.includes('env(safe-area-inset-')
+          );
+        } catch { return false; }
+      });
+
+      const deviceMeta = { viewport: { width: vw, height: vh }, dpr: 3, ua: navigator.userAgent, label: deviceLabel };
+      const out = {
+        deviceMeta,
+        ux: {
+          firstCtaInFold,
+          foldCoveragePct,
+          visibleFoldCoveragePct: undefined, // legacy field not used in scoring
+          paintedCoveragePct: 100, // informative only
+          overlayCoveragePct: undefined, // filled from pre-hide
+          overlayBlockers: undefined,     // filled from pre-hide
+          overlayElemsMarked: undefined,  // filled from pre-hide
+          maxFontPx: Math.round(maxFontPx),
+          minFontPx: Math.round(minFontPx),
+          smallTapTargets,
+          hasViewportMeta,
+          usesSafeAreaCSS
+        }
+      };
+      return debugRects ? { ...out, debug: { rows: 40, cols: 24, glyphRects, mediaRects, heroBgRects, coveredCells: [] } } : out;
+    }, { vw: dev.viewport.width, vh: dev.viewport.height, debugRects, deviceLabel: dev.label });
+    clean_ms = Date.now() - cleanStart;
+
+    // Merge pre-hide overlay metrics
+    clean.ux.overlayCoveragePct = auditPre.overlayCoveragePct;
+    clean.ux.overlayBlockers = auditPre.overlayBlockers;
+    clean.ux.overlayElemsMarked = auditPre.overlayElemsMarked;
+    if (debugRects) {
+      clean.debug = clean.debug || {};
+      clean.debug.overlayRects = auditPre.overlayRects;
+      clean.debug.overlayCells = []; // optional
+    }
+
+    // Final clean screenshot
+    const shotStart = Date.now();
+    const png = await page.screenshot({ type: 'png' });
+    screenshot_ms = Date.now() - shotStart;
+
+    // Optional heatmap overlay (render rectangles then screenshot separate)
+    if (debugHeatmap && clean.debug) {
+      await page.evaluate(({ d }) => {
+        const root = document.createElement('div');
+        root.id = '__foldy_debug_overlay__';
+        root.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647;';
+        const add = (arr, color) => {
+          (arr || []).forEach(([x,y,w,h]) => {
+            const el = document.createElement('div');
+            el.style.cssText = `position:absolute;left:${x}px;top:${y}px;width:${w}px;height:${h}px;outline:2px solid ${color};opacity:0.35;background:${color}`;
+            root.appendChild(el);
+          });
+        };
+        add(d.glyphRects, 'rgba(0,255,0,0.35)'); // green
+        add(d.mediaRects, 'rgba(0,0,255,0.35)'); // blue
+        add(d.heroBgRects,'rgba(255,165,0,0.35)'); // amber
+        document.documentElement.appendChild(root);
+      }, { d: clean.debug });
+      const heatPng = await page.screenshot({ type: 'png' });
+      pngDebugB64 = heatPng.toString('base64');
+      await page.evaluate(() => {
+        const n = document.getElementById('__foldy_debug_overlay__');
+        if (n) n.remove();
+      });
+    }
+
+    const total_ms = Date.now() - t0;
+
+    const body = {
+      device,
+      deviceMeta: clean.deviceMeta,
+      pngBase64: png.toString('base64'),
+      ...(debugOverlay ? { pngWithOverlayBase64: pngAsSeenB64 } : {}),
+      ...(pngDebugB64 ? { pngDebugBase64: pngDebugB64 } : {}),
+      ux: clean.ux,
+      timings: { nav_ms, settle_ms, audit_ms, hide_ms, clean_ms, screenshot_ms, total_ms },
+      ...(debugRects ? { debug: clean.debug } : {})
+    };
+    return res.json(body);
+  } catch (err) {
+    console.error('RenderError', device, url, err);
+    return res.status(500).json({ error: String(err) });
+  } finally {
+    try { if (page) await page.close({ runBeforeUnload: false }); } catch {}
+    try { if (context) await context.close(); } catch {}
+  }
+});
+
+// ---------- Boot ----------
+ensureBrowser().catch(e => {
+  console.error('Browser launch failed:', e);
+  process.exit(1);
+});
+
+app.listen(PORT, () => {
+  console.log(`foldy-render listening on :${PORT}`);
+});
