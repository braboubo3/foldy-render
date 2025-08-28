// worker.js — Foldy screenshot worker (sequential, persistent browser)
import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";
import { randomUUID } from "node:crypto";

// ---- Env ----
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
const SUPABASE_BUCKET = process.env.SUPABASE_BUCKET || "screenshot";
const WORKER_SLEEP_MS = parseInt(process.env.WORKER_SLEEP_MS || "1500", 10);
const BROWSER_ARGS = ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"];
const RECYCLE_EVERY_N_JOBS = parseInt(process.env.WORKER_BROWSER_RECYCLE_N || "50", 10);
const MAX_ATTEMPTS = parseInt(process.env.WORKER_MAX_ATTEMPTS || "3", 10);

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
  console.error("[worker] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE");
  process.exit(1);
}
const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE, { auth: { persistSession: false } });

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// --- Devices (trim as needed)
const DEVICES = {
  iphone_15_pro: { viewport: { width: 393, height: 852 }, dpr: 3, mobile: true,
    ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1" },
  pixel_8:       { viewport: { width: 412, height: 915 }, dpr: 2.625, mobile: true,
    ua: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36" },
  galaxy_s23:    { viewport: { width: 360, height: 800 }, dpr: 3, mobile: true,
    ua: "Mozilla/5.0 (Linux; Android 14; SM-S911B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36" },
  iphone_se_2:   { viewport: { width: 375, height: 667 }, dpr: 2, mobile: true,
    ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1" },
};
function deviceOpts(key) {
  const d = DEVICES[key] || DEVICES.iphone_15_pro;
  return {
    viewport: d.viewport,
    deviceScaleFactor: d.dpr,
    isMobile: !!d.mobile,
    hasTouch: true,
    userAgent: d.ua,
    locale: "en-US",
    bypassCSP: true,
  };
}

// --- URL coercer (accept string | {url}|{href} | search first http(s) in JSON)
function _coerceUrl(u) {
  if (!u) return null;
  if (typeof u === "string") return u;
  if (typeof u.url === "string") return u.url;
  if (typeof u.href === "string") return u.href;
  try {
    const s = JSON.stringify(u);
    const m = s.match(/https?:\/\/[^\s"']+/i);
    if (m) return m[0];
  } catch {}
  return null;
}

// NEW: 2025-08-28 — robust URL extraction across common job shapes.
// Tries explicit fields first, then nested payloads, finally a JSON scan fallback.
function _foldyExtractUrl(job) {
  // Guard against null/primitive
  if (!job || typeof job !== "object") return null;
  // Preferred explicit fields
  const direct =
    _coerceUrl(job.url) ||
    _coerceUrl(job.href);
  if (direct) return direct;
  // Common nested locations (e.g., n8n or RPC wrappers)
  const nested =
    _coerceUrl(job.payload) ||          // payload.url / payload.href / scan
    _coerceUrl(job.data) ||             // data.url
    _coerceUrl(job.job) ||              // job.url (wrapped)
    _coerceUrl(job.target) ||           // target.url
    null;
  if (nested) return nested;
  // Last resort: scan the whole object
  return _coerceUrl(job);
}

// --- Persistent browser with periodic recycle
let browser = null;
let jobsSinceLaunch = 0;
async function getBrowser() {
  if (!browser || jobsSinceLaunch >= RECYCLE_EVERY_N_JOBS) {
    if (browser) { try { await browser.close(); } catch {} }
    browser = await chromium.launch({ headless: true, args: BROWSER_ARGS });
    jobsSinceLaunch = 0;
    console.log("[worker] (re)launched Chromium");
  }
  return browser;
}

// --- RPC: claim next queued job (single canonical function with p_max_attempts)
async function claimJob() {
  const { data, error } = await sb.rpc("claim_screenshot_job", {
    p_worker_id: randomUUID(),
    p_max_attempts: MAX_ATTEMPTS
  });
  if (error) {
    console.error("[worker] claim error:", error);
    return null;
  }
    // MODIFIED: 2025-08-28 — normalize claim shapes
  // Possible shapes:
  //  - null                        -> no job
  //  - {}                          -> no job (treat as idle)
  //  - [{...}]                     -> take first row
  //  - { job: {...} }              -> unwrap job
  //  - { id, url, ... }            -> job object
  if (!data) return null;
  if (Array.isArray(data)) {
    if (data.length === 0) return null;
    if (data.length > 1) console.warn("[worker] claim returned multiple rows; taking first");
    return data[0];
  }
  if (typeof data === "object") {
    if (Object.keys(data).length === 0) return null; // empty object => idle
    if (data.job && typeof data.job === "object") return data.job; // unwrap wrapper
    return data; // assume direct job shape
  }
  // Unexpected primitive -> treat as no job
  console.warn("[worker] claim returned unexpected primitive:", typeof data);
  return null;
}

async function uploadToStorage(key, buf) {
  const { error } = await sb.storage.from(SUPABASE_BUCKET).upload(key, buf, {
    contentType: "image/png",
    upsert: true
  });
  if (error) throw error;
  const { data } = sb.storage.from(SUPABASE_BUCKET).getPublicUrl(key);
  return data.publicUrl;
}

async function processJob(job) {
  const t0 = Date.now();
  const b = await getBrowser();
  const ctx = await b.newContext(deviceOpts(job.device));
  const page = await ctx.newPage();
  try {
    // MODIFIED: 2025-08-28 — extract URL from multiple shapes (direct, nested, fallback)
    const targetUrl = _foldyExtractUrl(job);
    if (!targetUrl) {
      // Keep throw so existing catch updates status=error, but log with context first.
      console.warn("[worker] discard job with invalid/missing URL", {
        jobId: job?.id ?? null,
        urlType: typeof job?.url,
        hasPayload: !!job?.payload
      });
      throw new Error(`invalid_job_url: got ${typeof job?.url} value=${JSON.stringify(job?.url).slice(0,200)}`);
    }
    console.log(`[worker] processing ${job.id} attempt=${job.attempt} device=${job.device} url=${targetUrl}`);

    // 1) Navigate
    await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 25000 });
    await page.waitForLoadState("networkidle", { timeout: 4000 }).catch(() => {});
    await page.waitForTimeout(500).catch(() => {});

    // 2) Hide overlays (minimal; extend to match API’s clean)
    await page.evaluate(() => {
      const sel = '[role="dialog"], .modal, .popup, [data-cookiebanner], [id*="cookie"]';
      for (const el of Array.from(document.querySelectorAll(sel))) {
        try {
          el.setAttribute("data-foldy-hidden", "1");
          el.style.setProperty("display", "none", "important");
          el.style.setProperty("opacity", "0", "important");
          el.style.setProperty("visibility", "hidden", "important");
        } catch {}
      }
    });

    // 3) Cap webfont wait to 1.5s
    await page.evaluate(async (capMs) => {
      try {
        if (document.fonts?.ready) {
          await Promise.race([document.fonts.ready, new Promise(r => setTimeout(r, capMs))]);
        }
      } catch {}
    }, 1500);

    // 4) Screenshot viewport (PNG)
    const buf = await page.screenshot({ type: "png", fullPage: false, timeout: 15000 });

    // 5) Upload
    const publicUrl = await uploadToStorage(job.screenshot_key, buf);

    // 6) Update job
    await sb.from("screenshot_jobs").update({
      status: "done",
      finished_at: new Date().toISOString(),
      screenshot_url: publicUrl
    }).eq("id", job.id);

    // 7) Best-effort link to run_devices (if present)
    if (job.run_id) {
      const { data: rd } = await sb
        .from("run_devices")
        .select("id")
        .eq("run_id", job.run_id)
        .eq("device", job.device)
        .eq("render_ts_ms", job.render_ts_ms)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (rd?.id) {
        await sb.from("run_devices").update({
          screenshot_key: job.screenshot_key,
          screenshot_url: publicUrl
        }).eq("id", rd.id);
      }
    }

    jobsSinceLaunch += 1;
    console.log(`[worker] job ${job.id} done in ${Date.now() - t0}ms → ${publicUrl}`);
  } catch (err) {
    console.error("[worker] job error:", err);
    await sb.from("screenshot_jobs").update({
      status: "error",
      finished_at: new Date().toISOString(),
      error: String(err)
    }).eq("id", job.id);
  } finally {
    await ctx.close().catch(()=>{});
  }
}

async function main() {
  console.log("[worker] started");
  while (true) {
    let job = null;
    try { job = await claimJob(); } catch (e) {
      console.error("[worker] claim threw:", e);
      job = null;
    }
      // MODIFIED: 2025-08-28 — treat empty objects as idle to avoid poison loop
      if (
        !job ||
        (typeof job === "object" && job !== null && Object.keys(job).length === 0)
      ) {
        // No work right now — small sleep to avoid hot loop
        await sleep(WORKER_SLEEP_MS);
        continue;
      }
    await processJob(job);
  }
}

main().catch(e => {
  console.error("[worker] fatal:", e);
  process.exit(1);
});
