/**
 * foldy-render — Express + Playwright microservice
 *
 * Endpoints
 *   GET  /health
 *   POST /render  (Authorization: Bearer <RENDER_TOKEN>)
 *     Body: { url, device, debugOverlay?, debugRects?, debugHeatmap? }
 *
 * Behavior
 *   - Loads page on a chosen mobile device preset.
 *   - Runs a pre-hide audit (detect overlays, visible coverage).
 *   - Hides overlays and re-audits on the clean view (this is what we score).
 *   - Returns a single CLEAN first-viewport screenshot.
 *   - Optional debug:
 *       • debugRects=1    → return raw rects and covered cells (JSON)
 *       • debugHeatmap=1  → return a heatmap PNG with counted areas highlighted
 */

import express from "express";
import { chromium, devices } from "playwright";

const PORT = process.env.PORT || 3000;
const AUTH = process.env.RENDER_TOKEN || "devtoken";

const app = express();
app.use(express.json({ limit: "8mb" }));

/* -------------------------------------------------------------------------- */
/* Device presets (override viewport for exact fold)                          */
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

/* --------------------------------- Auth ----------------------------------- */
function requireAuth(req, res, next) {
  const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!token || token !== AUTH) return res.status(401).json({ error: "unauthorized" });
  next();
}

/* ------------------------------- SSRF guard --------------------------------
 * Allow only http/https and block obvious internal hosts (MVP guard).
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

/* --------------------------- Shared Playwright ---------------------------- */
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
  try { await getBrowser(); res.json({ ok: true, up: true }); }
  catch (e) { res.status(500).json({ ok: false, error: String(e) }); }
});

/* -------------------------- Overlay hider (Node) -------------------------- */
async function hideOverlaysAndUnlock(page) {
  await page.evaluate(() => {
    // Hide anything our audit marked
    document.querySelectorAll('[data-foldy-overlay="1"]').forEach((el) => {
      el.setAttribute("data-foldy-overlay-hidden", "1");
      el.style.setProperty("display", "none", "important");
      el.style.setProperty("visibility", "hidden", "important");
    });

    // Extra heuristics for popular CMPs
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

    // Unlock scroll if CMP locked it
    document.documentElement.style.setProperty("overflow", "auto", "important");
    document.body.style.setProperty("overflow", "auto", "important");
    document.body.classList.remove("modal-open", "overflow-hidden", "disable-scroll");
  });
}

/* -------------------------- Clean-fold re-audit --------------------------- */
async function evalCleanFold(page) {
  return page.evaluate(() => {
    const vpW = window.innerWidth, vpH = window.innerHeight;
    const inViewport = (r) => r.top < vpH && r.bottom > 0 && r.left < vpW && r.right > 0;
    const isVisible = (el) => {
      const st = getComputedStyle(el);
      if (st.visibility === "hidden" || st.display === "none" || st.opacity === "0") return false;
      const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0;
    };
    const intersect = (r) => {
      const left = Math.max(0, r.left), top = Math.max(0, r.top);
      const right = Math.min(vpW, r.right), bottom = Math.min(vpH, r.bottom);
      const w = Math.max(0, right - left), h = Math.max(0, bottom - top);
      return w > 0 && h > 0 ? { left, top, right, bottom, width: w, height: h } : null;
    };
    const rgbaAlpha = (rgba) => rgba?.startsWith("rgba") ? parseFloat(rgba.replace(/^rgba\(|\)$/g,"").split(",")[3]||"1") : 1;
    const norm = (s) => (s||"").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    const getText = (el) => (el.innerText || el.textContent || "");
    const getAria = (el) => (el.getAttribute("aria-label") || el.getAttribute("title") || "");
    const isMedia = (el) => ["IMG","VIDEO","CANVAS","SVG"].includes(el.tagName);

    const all = Array.from(document.querySelectorAll("body *"))
      .filter((el) => isVisible(el) && inViewport(el.getBoundingClientRect()));

    // Content rects: glyph text + media + large, non-repeating hero BGs
    const TEXT_LEN_MIN = 3, FONT_MIN = 12;
    const rects = [];

    // media
    for (const el of all) { if (isMedia(el)) { const i = intersect(el.getBoundingClientRect()); if (i) rects.push(i); } }

    // glyph text
    const acceptText = { acceptNode:n => (n.nodeType===Node.TEXT_NODE && (n.textContent||"").trim().length>=TEXT_LEN_MIN) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP };
    for (const root of all) {
      const st = getComputedStyle(root); const fs = parseFloat(st.fontSize||"0"); const alpha = rgbaAlpha(st.color||"rgba(0,0,0,1)");
      if (fs<FONT_MIN || alpha<=0.05) continue;
      const tw = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, acceptText);
      let node; while ((node = tw.nextNode())) {
        try {
          const rng = document.createRange(); rng.selectNodeContents(node);
          for (const rr of Array.from(rng.getClientRects())) {
            const i = intersect(rr); if (!i) continue;
            if (i.width<2 || i.height<fs*0.4) continue;
            rects.push(i);
          }
        } catch {}
      }
    }

    // Hero background images (large, no-repeat) treated as content
    for (const el of all) {
      if (el.tagName==="HTML"||el.tagName==="BODY") continue;
      const st = getComputedStyle(el);
      if (st.backgroundImage && st.backgroundImage!=="none" && (st.backgroundRepeat||"").includes("no-repeat")) {
        const i = intersect(el.getBoundingClientRect());
        if (i && (i.width*i.height) >= vpW*vpH*0.25) rects.push(i);
      }
    }

    // Grid union
    const ROWS=40, COLS=24, cellW=vpW/COLS, cellH=vpH/ROWS;
    const cells=new Set();
    for (const r of rects) {
      const x0=Math.max(0,Math.floor(r.left/cellW)), x1=Math.min(COLS-1,Math.floor((r.right-0.01)/cellW));
      const y0=Math.max(0,Math.floor(r.top/cellH)),  y1=Math.min(ROWS-1,Math.floor((r.bottom-0.01)/cellH));
      for (let y=y0;y<=y1;y++) for (let x=x0;x<=x1;x++) cells.add(y*COLS+x);
    }
    const foldCoveragePct = Math.min(100, Math.round((cells.size/(ROWS*COLS))*100));

    // CTA detection (i18n, accent-insensitive) on clean view
    const CTA_RE = new RegExp([
      "buy","add to cart","add-to-cart","shop now","sign up","signup","get started","start now","try","free trial",
      "subscribe","join","book","order","checkout","continue","download","contact","learn more","demo","request demo",
      "essayer","essai gratuit","demarrer","demarrer maintenant","sinscrire","inscrivez","demander une demo","acheter",
      "ajouter au panier","commander","souscrire",
      "jetzt kaufen","in den warenkorb","jetzt starten","kostenlos testen","mehr erfahren","anmelden","registrieren",
      "comprar","agregar al carrito","empieza","prueba gratis","solicitar demo","suscribete","contacto",
      "comprar","adicionar ao carrinho","iniciar","teste gratis","solicitar demo","assine","contato",
      "compra","aggiungi al carrello","inizia ora","prova gratis","richiedi demo","iscriviti","contattaci"
    ].join("|"), "i");
    const actionable = Array.from(document.querySelectorAll('a,button,[role="button"],input[type="submit"],input[type="button"]'))
      .filter((el)=> isVisible(el) && !el.disabled && getComputedStyle(el).cursor!=="default");
    const firstCtaInFold = actionable.some((el)=>{
      const label = norm(getText(el) || getAria(el) || el.value || "");
      return CTA_RE.test(label) && inViewport(el.getBoundingClientRect());
    });

    return { foldCoveragePct, firstCtaInFold };
  });
}

/* ---------------------------- Heatmap (debug) ----------------------------- */
async function drawAndSnapHeatmap(page, opts = { rows: 40, cols: 24 }) {
  const meta = await page.evaluate((grid) => {
    const vpW = innerWidth, vpH = innerHeight;
    const isVisible = (el) => {
      const st = getComputedStyle(el);
      if (st.visibility==="hidden"||st.display==="none"||st.opacity==="0") return false;
      const r=el.getBoundingClientRect(); return r.width>0&&r.height>0;
    };
    const intersect = (r) => {
      const L=Math.max(0,r.left), T=Math.max(0,r.top), R=Math.min(vpW,r.right), B=Math.min(vpH,r.bottom);
      const W=Math.max(0,R-L), H=Math.max(0,B-T); return W>0&&H>0?{left:L,top:T,width:W,height:H}:null;
    };
    const rgbaAlpha = (rgba) => rgba?.startsWith("rgba") ? parseFloat(rgba.replace(/^rgba\(|\)$/g,"").split(",")[3]||"1") : 1;
    const isMedia = (el) => ["IMG","VIDEO","CANVAS","SVG"].includes(el.tagName);
    const all = Array.from(document.querySelectorAll("body *")).filter(isVisible);

    const glyphRects=[], mediaRects=[], heroBgRects=[];
    for (const el of all) { if (isMedia(el)) { const i=intersect(el.getBoundingClientRect()); if (i) mediaRects.push(i); } }
    const TEXT_LEN_MIN=3, FONT_MIN=12;
    const acceptText={acceptNode:n=>(n.nodeType===Node.TEXT_NODE&&(n.textContent||"").trim().length>=TEXT_LEN_MIN)?NodeFilter.FILTER_ACCEPT:NodeFilter.FILTER_SKIP};
    for (const root of all) {
      const st=getComputedStyle(root); const fs=parseFloat(st.fontSize||"0"); const alpha=rgbaAlpha(st.color||"rgba(0,0,0,1)");
      if (fs<FONT_MIN||alpha<=0.05) continue;
      const tw=document.createTreeWalker(root, NodeFilter.SHOW_TEXT, acceptText);
      let node; while((node=tw.nextNode())){
        try {
          const rng=document.createRange(); rng.selectNodeContents(node);
          for (const rr of Array.from(rng.getClientRects())) {
            const i=intersect(rr); if(!i) continue;
            if (i.width<2||i.height<fs*0.4) continue;
            glyphRects.push(i);
          }
        } catch{}
      }
    }
    for (const el of all) {
      if (el.tagName==="HTML"||el.tagName==="BODY") continue;
      const st=getComputedStyle(el);
      if (st.backgroundImage && st.backgroundImage!=="none" && (st.backgroundRepeat||"").includes("no-repeat")) {
        const i=intersect(el.getBoundingClientRect());
        if (i && (i.width*i.height) >= vpW*vpH*0.25) heroBgRects.push(i);
      }
    }

    // Draw overlay
    const root=document.createElement("div"); root.id="__foldy_debug";
    root.style.cssText=`position:fixed;inset:0;pointer-events:none;z-index:2147483647;
      background: repeating-linear-gradient(0deg,transparent,transparent ${vpH/grid.rows}px,rgba(255,255,255,.04) ${vpH/grid.rows}px,rgba(255,255,255,.04) ${2*vpH/grid.rows}px),
                  repeating-linear-gradient(90deg,transparent,transparent ${vpW/grid.cols}px,rgba(255,255,255,.04) ${vpW/grid.cols}px,rgba(255,255,255,.04) ${2*vpW/grid.cols}px);`;
    document.documentElement.appendChild(root);
    const paint=(rects,color)=>{ for (const r of rects){ const d=document.createElement("div");
      d.style.cssText=`position:absolute;left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px;background:${color};`; root.appendChild(d);} };
    paint(glyphRects,"rgba(50,200,90,.35)");
    paint(mediaRects,"rgba(50,120,220,.35)");
    paint(heroBgRects,"rgba(200,160,60,.28)");

    return {
      glyphRects: glyphRects.map(r=>[r.left,r.top,r.width,r.height]),
      mediaRects: mediaRects.map(r=>[r.left,r.top,r.width,r.height]),
      heroBgRects: heroBgRects.map(r=>[r.left,r.top,r.width,r.height]),
      rows: grid.rows, cols: grid.cols
    };
  }, opts);

  const png = await page.screenshot({ type: "png", fullPage: false, clip: { x: 0, y: 0, width: page.viewportSize().width, height: page.viewportSize().height } });
  await page.evaluate(() => { document.getElementById("__foldy_debug")?.remove(); });
  return { pngDebugBase64: png.toString("base64"), debugMeta: meta };
}

/* --------------------------------- /render -------------------------------- */
app.post("/render", requireAuth, async (req, res) => {
  const { url, device } = req.body || {};
  const debugOverlay  = req.query.debugOverlay === "1" || req.body?.debugOverlay === true;
  const debugRects    = req.query.debugRects === "1"   || req.body?.debugRects === true;
  const debugHeatmap  = req.query.debugHeatmap === "1" || req.body?.debugHeatmap === true;

  if (!url || !device || !DEVICE_MAP[device] || !isAllowedUrl(url)) {
    return res.status(400).json({ error: "bad input" });
  }

  const start = Date.now();
  let context = null;

  try {
    const b = await getBrowser();
    const conf = DEVICE_MAP[device];

    context = await b.newContext({ ...conf.profile, viewport: conf.vp });
    const page = await context.newPage();
    page.setDefaultNavigationTimeout(15000);
    page.setDefaultTimeout(15000);

    // Trim trackers/heavy media to stabilize load
    await page.route("**/*", (route) => {
      const u = route.request().url();
      if (/\.(mp4|mov|avi|m4v|webm)$/i.test(u) ||
          /(hotjar|fullstory|segment|google-analytics|gtm|optimizely|clarity|doubleclick)/i.test(u)) {
        return route.abort();
      }
      return route.continue();
    });

    // Navigate
    const tNav0 = Date.now();
    await page.goto(url, { waitUntil: "networkidle" });
    const nav_ms = Date.now() - tNav0;

    // Disable animations (faster/more deterministic screenshots)
    await page.addStyleTag({ content: `
      *,*::before,*::after{animation:none!important;transition:none!important}
      html{scroll-behavior:auto!important}
    `});

    const tSettle0 = Date.now();
    await page.waitForTimeout(800);
    const settle_ms = Date.now() - tSettle0;

    /* --------------------------- Pre-hide audit ---------------------------- */
    const tAudit0 = Date.now();
    const ux = await page.evaluate((opts) => {
      const vpW = window.innerWidth, vpH = window.innerHeight;

      const inViewport = (r) => r.top < vpH && r.bottom > 0 && r.left < vpW && r.right > 0;
      const isVisible = (el) => {
        const st = getComputedStyle(el);
        if (st.visibility==="hidden"||st.display==="none"||st.opacity==="0") return false;
        const r = el.getBoundingClientRect(); return r.width>0 && r.height>0;
      };
      const intersect = (r) => {
        const L=Math.max(0,r.left), T=Math.max(0,r.top), R=Math.min(vpW,r.right), B=Math.min(vpH,r.bottom);
        const W=Math.max(0,R-L), H=Math.max(0,B-T); return W>0&&H>0?{left:L,top:T,right:R,bottom:B,width:W,height:H}:null;
      };
      const rgbaAlpha = (rgba) => rgba?.startsWith("rgba") ? parseFloat(rgba.replace(/^rgba\(|\)$/g,"").split(",")[3]||"1") : 1;
      const norm = (s) => (s||"").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"");
      const getText=(el)=>(el.innerText||el.textContent||"");
      const getAria=(el)=>(el.getAttribute("aria-label")||el.getAttribute("title")||"");
      const isMedia=(el)=>["IMG","VIDEO","CANVAS","SVG"].includes(el.tagName);

      // CTA (i18n)
      const CTA_RE = new RegExp([
        "buy","add to cart","add-to-cart","shop now","sign up","signup","get started","start now","try","free trial",
        "subscribe","join","book","order","checkout","continue","download","contact","learn more","demo","request demo",
        "essayer","essai gratuit","demarrer","demarrer maintenant","sinscrire","inscrivez","demander une demo","acheter",
        "ajouter au panier","commander","souscrire",
        "jetzt kaufen","in den warenkorb","jetzt starten","kostenlos testen","mehr erfahren","anmelden","registrieren",
        "comprar","agregar al carrito","empieza","prueba gratis","solicitar demo","suscribete","contacto",
        "comprar","adicionar ao carrinho","iniciar","teste gratis","solicitar demo","assine","contato",
        "compra","aggiungi al carrello","inizia ora","prova gratis","richiedi demo","iscriviti","contattaci"
      ].join("|"), "i");

      const actionable = Array.from(document.querySelectorAll('a,button,[role="button"],input[type="submit"],input[type="button"]'))
        .filter((el)=> isVisible(el) && !el.disabled && getComputedStyle(el).cursor!=="default");

      const firstCtaInFold = actionable.some((el)=>{
        const label = norm(getText(el) || getAria(el) || el.value || "");
        return CTA_RE.test(label) && inViewport(el.getBoundingClientRect());
      });

      // Visible elements in fold
      const all = Array.from(document.querySelectorAll("body *"))
        .filter((el)=> isVisible(el) && inViewport(el.getBoundingClientRect()));

      // Typography bounds
      let maxFontPx=0, minFontPx=Infinity;
      for (const el of all) {
        const fs = parseFloat(getComputedStyle(el).fontSize||"0");
        if (fs>0) { if (fs>maxFontPx) maxFontPx=fs; if (fs<minFontPx) minFontPx=fs; }
      }
      if (!Number.isFinite(minFontPx)) minFontPx = 0;

      // Small tap targets (basic)
      const hasLabel = (el) => {
        const t=(el.innerText||el.textContent||"").trim();
        const a=(el.getAttribute("aria-label")||el.title||"").trim();
        return (t.length + a.length) > 0;
      };
      const isLikelyChatWidget = (el) => {
        const idc=(el.id+" "+el.className).toLowerCase();
        if (/(intercom|crisp|drift|tawk|livechat|hubspot-messages|zendesk|olark)/.test(idc)) return true;
        const st=getComputedStyle(el); const r=el.getBoundingClientRect();
        const anchoredBR = st.position==="fixed" && (vpW - r.right < 120) && (vpH - r.bottom < 120);
        return anchoredBR && r.width<=64 && r.height<=64;
      };
      const smallTapTargets = actionable.filter((el) => {
        if (isLikelyChatWidget(el)) return false;
        const r = el.getBoundingClientRect(); const area = r.width*r.height;
        return inViewport(r) && hasLabel(el) && (r.width<44 || r.height<44) && area>300;
      }).length;

      const hasViewportMeta = !!document.querySelector('meta[name="viewport"]');

      // Overlay detection (stricter; avoid headers/navs)
      const isLikelyHeader = (el, r) => {
        if (el.closest("header,[role='banner'],nav,[role='navigation']")) return true;
        const nearTop = r.top <= 0 && r.height <= vpH * 0.35;
        const fullWidth = r.width >= vpW * 0.9;
        const hint = /(cookie|consent|gdpr|privacy|cmp)/i.test((el.id+" "+el.className+" "+(el.getAttribute("role")||"")+" "+(el.getAttribute("aria-label")||"")));
        return nearTop && fullWidth && !hint;
      };

      const overlayCandidates = Array.from(document.querySelectorAll("body *")).filter((el)=>{
        if (!isVisible(el)) return false;
        const st=getComputedStyle(el);
        if (!["fixed","sticky"].includes(st.position)) return false;
        const r=el.getBoundingClientRect(); if (!inViewport(r)) return false;
        if (isLikelyHeader(el, r)) return false;

        const inter=intersect(r); if (!inter) return false;
        const areaPct = (inter.width*inter.height)/(vpW*vpH);
        const z = parseInt(st.zIndex||"0",10) || 0;

        const cookieHint = /(cookie|consent|gdpr|privacy|cmp)/i.test((el.id+" "+el.className+" "+(el.getAttribute("role")||"")+" "+(el.getAttribute("aria-label")||"")));
        const isDialog = el.getAttribute("role")==="dialog" || el.getAttribute("aria-modal")==="true";
        const wideBar = inter.width >= vpW*0.9 && r.height >= 64;
        const nearBottom = r.bottom >= vpH - Math.min(200, vpH*0.3);
        const hasConsentButtons = /(accept|allow|agree|deny|reject|save|preferences|settings)/i.test((el.innerText||""))
                                  && el.querySelectorAll("button,a,[role='button']").length >= 2;

        if (cookieHint || isDialog) return true;
        if (nearBottom && wideBar && hasConsentButtons) return true;
        if (areaPct >= 0.30 && z >= 300) return true;  // huge cover
        if (areaPct >= 0.15 && z >= 500) return true;  // sizable, very high z

        return false;
      });
      overlayCandidates.forEach((el)=> el.setAttribute("data-foldy-overlay","1"));
      const overlayRects = overlayCandidates.map((el)=> intersect(el.getBoundingClientRect())).filter(Boolean);
      const overlayBlockers = overlayCandidates.filter((el)=>{
        const r=el.getBoundingClientRect(); const i=intersect(r);
        const areaPct = i ? (i.width*i.height)/(vpW*vpH) : 0;
        const topCover = r.top<=0 && r.height>=vpH*0.25;
        return areaPct>=0.30 || topCover;
      }).length;

      // Content rects: glyph text + media + large hero BGs
      const TEXT_LEN_MIN=3, FONT_MIN=12;
      const contentRects=[]; const glyphRects=[]; const mediaRects=[]; const heroBgRects=[];

      // media
      for (const el of all) {
        if (!isMedia(el)) continue;
        const i=intersect(el.getBoundingClientRect()); if (i) { contentRects.push(i); mediaRects.push(i); }
      }

      // glyph text
      const acceptText={acceptNode:n=>(n.nodeType===Node.TEXT_NODE&&(n.textContent||"").trim().length>=TEXT_LEN_MIN)?NodeFilter.FILTER_ACCEPT:NodeFilter.FILTER_SKIP};
      for (const root of all) {
        const st=getComputedStyle(root); const fs=parseFloat(st.fontSize||"0"); const alpha=rgbaAlpha(st.color||"rgba(0,0,0,1)");
        if (fs<FONT_MIN || alpha<=0.05) continue;
        const tw=document.createTreeWalker(root, NodeFilter.SHOW_TEXT, acceptText);
        let node; while((node=tw.nextNode())){
          try {
            const rng=document.createRange(); rng.selectNodeContents(node);
            for (const rr of Array.from(rng.getClientRects())) {
              const i=intersect(rr); if (!i) continue;
              if (i.width<2 || i.height<fs*0.4) continue;
              contentRects.push(i); glyphRects.push(i);
            }
          } catch {}
        }
      }

      // large non-repeating hero BGs as content (conversion-relevant)
      for (const el of all) {
        if (el.tagName==="HTML"||el.tagName==="BODY") continue;
        const st=getComputedStyle(el);
        if (st.backgroundImage && st.backgroundImage!=="none" && (st.backgroundRepeat||"").includes("no-repeat")) {
          const i=intersect(el.getBoundingClientRect());
          if (i) {
            const areaPct=(i.width*i.height)/(vpW*vpH);
            if (areaPct>=0.25 && !el.closest('[data-foldy-overlay="1"]')) { contentRects.push(i); heroBgRects.push(i); }
          }
        }
      }

      // painted (debug/insight)
      const paintedRects=[...contentRects];
      for (const el of all) {
        if (["IMG","VIDEO","CANVAS","SVG"].includes(el.tagName)) continue;
        const st=getComputedStyle(el); let paints=false;
        if (st.backgroundImage && st.backgroundImage!=="none") paints=true;
        const bg=st.backgroundColor||"";
        if (!paints && bg && bg!=="transparent") paints=!bg.startsWith("rgba")||rgbaAlpha(bg)>0.05;
        if (!paints) {
          const hasBorder=
            ["borderTopWidth","borderRightWidth","borderBottomWidth","borderLeftWidth"].some(k=>parseFloat(st[k])>0) &&
            ["borderTopColor","borderRightColor","borderBottomColor","borderLeftColor"].some(k=>(st[k]||"")!=="transparent");
          paints=hasBorder;
        }
        if (paints) { const i=intersect(el.getBoundingClientRect()); if (i) paintedRects.push(i); }
      }

      // grid union
      const ROWS=40, COLS=24, cellW=vpW/COLS, cellH=vpH/ROWS;
      const toCells=(rects)=>{ const set=new Set();
        for (const r of rects) {
          const x0=Math.max(0,Math.floor(r.left/cellW)), x1=Math.min(COLS-1,Math.floor((r.right-0.01)/cellW));
          const y0=Math.max(0,Math.floor(r.top/cellH)), y1=Math.min(ROWS-1,Math.floor((r.bottom-0.01)/cellH));
          for (let y=y0;y<=y1;y++) for (let x=x0;x<=x1;x++) set.add(y*COLS+x);
        } return set; };
      const pct=(set)=> Math.min(100, Math.round((set.size/(ROWS*COLS))*100));

      const contentCells=toCells(contentRects);
      const paintedCells=toCells(paintedRects);
      const overlayCells=toCells(overlayRects);

      const visibleFoldCoveragePct = pct(contentCells);
      const overlayCoveragePct     = pct(overlayCells);

      // Build debug (optional)
      let debug = undefined;
      if (opts && opts.wantRects) {
        debug = {
          rows: ROWS, cols: COLS,
          glyphRects: glyphRects.map(r=>[r.left,r.top,r.width,r.height]),
          mediaRects: mediaRects.map(r=>[r.left,r.top,r.width,r.height]),
          heroBgRects: heroBgRects.map(r=>[r.left,r.top,r.width,r.height]),
          overlayRects: overlayRects.map(r=>[r.left,r.top,r.width,r.height]),
          coveredCells: Array.from(contentCells),
          overlayCells: Array.from(overlayCells),
        };
      }

      return {
        firstCtaInFold,
        visibleFoldCoveragePct,
        paintedCoveragePct: pct(paintedCells),
        overlayCoveragePct,
        overlayBlockers,
        overlayElemsMarked: overlayCandidates.length,
        maxFontPx, minFontPx, smallTapTargets, hasViewportMeta,
        usesSafeAreaCSS: false,        // intentionally kept advisory + disabled
        debug
      };
    }, { wantRects: debugRects });
    const audit_ms = Date.now() - tAudit0;

    /* ------------------------- Optional overlay shot ------------------------ */
    let pngWithOverlayBase64 = null;
    if (debugOverlay) {
      const bufOverlay = await page.screenshot({ type: "png", fullPage: false, clip: { x: 0, y: 0, width: conf.vp.width, height: conf.vp.height } });
      pngWithOverlayBase64 = bufOverlay.toString("base64");
    }

    /* ------------------ Hide overlays → clean audit & shot ------------------ */
    const tHide0 = Date.now();
    await hideOverlaysAndUnlock(page);
    await page.waitForTimeout(120);
    const hide_ms = Date.now() - tHide0;

    const tClean0 = Date.now();
    const clean = await evalCleanFold(page);
    const clean_ms = Date.now() - tClean0;

    // Overwrite fields we score/show
    ux.foldCoveragePct = clean.foldCoveragePct;
    ux.firstCtaInFold  = clean.firstCtaInFold;

    // Optional heatmap (clean view)
    let pngDebugBase64 = null, debugMeta = null;
    if (debugHeatmap) {
      const dbg = await drawAndSnapHeatmap(page, { rows: 40, cols: 24 });
      pngDebugBase64 = dbg.pngDebugBase64;
      debugMeta = dbg.debugMeta;
    }

    // Clean screenshot (shown to users)
    const tShot0 = Date.now();
    const buf = await page.screenshot({
      type: "png",
      fullPage: false,
      clip: { x: 0, y: 0, width: conf.vp.width, height: conf.vp.height },
    });
    const pngBase64 = buf.toString("base64");
    const screenshot_ms = Date.now() - tShot0;

    // Device meta
    const meta = {
      viewport: { width: conf.vp.width, height: conf.vp.height },
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
    if (debugOverlay && pngWithOverlayBase64) payload.pngWithOverlayBase64 = pngWithOverlayBase64;
    if (debugRects && ux.debug) payload.debug = ux.debug;
    if (debugHeatmap && pngDebugBase64) payload.pngDebugBase64 = pngDebugBase64;
    if (debugHeatmap && debugMeta) payload.debugMeta = debugMeta;

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
