// worker.js — Foldy screenshot worker (fresh, strict job normalization)
// NEW: 2025-08-29 — stop hot-loop on empty claims; fetch URL from DB by id if RPC omits it.

import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";
import { randomUUID } from "node:crypto";

// --------- Env ---------
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
const SUPABASE_BUCKET = process.env.SUPABASE_BUCKET || "screenshot";

const POLL_SLEEP_MS = parseInt(process.env.WORKER_SLEEP_MS || "1200", 10);
const ERROR_BACKOFF_MS = 1000;

const BROWSER_ARGS = ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"];
const RECYCLE_EVERY_N_JOBS = parseInt(process.env.WORKER_BROWSER_RECYCLE_N || "50", 10);
const MAX_ATTEMPTS = parseInt(process.env.WORKER_MAX_ATTEMPTS || "3", 10);

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
  console.error("[worker] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE");
  process.exit(1);
}

const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE, { auth: { persistSession: false } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --------- Devices (minimal, stable) ---------
const DEVICES = {
  iphone_15_pro: {
    viewport: { width: 393, height: 852 },
    dpr: 3,
    mobile: true,
    ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
  },
  pixel_8: {
    viewport: { width: 412, height: 915 },
    dpr: 2.625,
    mobile: true,
    ua: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36",
  },
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

// --------- Browser mgmt ---------
let browser = null;
let jobsSinceLaunch = 0;

async function getBrowser() {
  if (!browser || jobsSinceLaunch >= RECYCLE_EVERY_N_JOBS) {
    if (browser) {
      try { await browser.close(); } catch {}
    }
    browser = await chromium.launch({ headless: true, args: BROWSER_ARGS });
    jobsSinceLaunch = 0;
    console.log("[worker] (re)launched Chromium");
  }
  return browser;
}

// --------- URL helpers ---------
function coerceUrl(u) {
  if (!u) return null;
  if (typeof u === "string") return u;
  if (typeof u === "object") {
    if (typeof u.url === "string") return u.url;
    if (typeof u.href === "string") return u.href;
    try {
      const s = JSON.stringify(u);
      const m = s.match(/https?:\/\/[^\s"']+/i);
      if (m) return m[0];
    } catch {}
  }
  return null;
}

function looksHttp(u) {
  return typeof u === "string" && /^https?:\/\//i.test(u);
}

// --------- Job normalization (definitive) ---------
// Accepts messy RPC shapes and returns either a strict Job or null.
// If RPC omits url, we fetch it from screenshot_jobs by id.
async function claimNormalizedJob() {
  const { data, error } = await sb.rpc("claim_screenshot_job", {
    p_worker_id: randomUUID(),
    p_max_attempts: MAX_ATTEMPTS,
  });

  if (error) {
    console.error("[worker] claim error:", error);
    return null; // idle on claim failure (we backoff in main)
  }

  // Unwrap common shapes
  let row = null;
  if (!data) {
    row = null;
  } else if (Array.isArray(data)) {
    row = data.length ? data[0] : null;
  } else if (typeof data === "object") {
    // Treat empty objects or counter-like rows as idle
    const keys = Object.keys(data);
    if (keys.length === 0) row = null;
    else if (data.job && typeof data.job === "object") row = data.job;
    else if (!("id" in data) && keys.every((k) => ["count", "status", "message"].includes(k))) {
      row = null;
    } else {
      row = data;
    }
  } else {
    // unexpected primitive
    row = null;
  }

  if (!row) return null;

  // Build normalized job with minimal required fields
  const job = {
    id: row.id ?? row.job_id ?? null,
    device: row.device ?? "iphone_15_pro",
    screenshot_key: row.screenshot_key ?? null,
    run_id: row.run_id ?? null,
    render_ts_ms: row.render_ts_ms ?? null,
    url: coerceUrl(row.url) || coerceUrl(row.target_url) || coerceUrl(row.href) || coerceUrl(row.payload) || null,
  };

  // If we have an id but no url, fetch from DB
  if (job.id && !looksHttp(job.url)) {
    const { data: dbJob, error: dbErr } = await sb
      .from("screenshot_jobs")
      .select("id,url,device,screenshot_key,run_id,render_ts_ms")
      .eq("id", job.id)
      .maybeSingle();
    if (dbErr) {
      console.warn("[worker] lookup by id failed:", dbErr?.message || dbErr);
    }
    if (dbJob) {
      job.url = looksHttp(job.url) ? job.url : dbJob.url;
      job.device = job.device || dbJob.device || "iphone_15_pro";
      job.screenshot_key = job.screenshot_key || dbJob.screenshot_key || null;
      job.run_id = job.run_id || dbJob.run_id || null;
      job.render_ts_ms = job.render_ts_ms || dbJob.render_ts_ms || null;
    }
  }

  // Validate final job
  if (!job.id) return null; // nothing actionable
  if (!looksHttp(job.url)) return null; // still not usable
  if (!job.screenshot_key) job.screenshot_key = `${job.id}.png`; // safe default path

  return job;
}

// --------- Screenshot + upload ---------
async function uploadPng(key, buf) {
  const { error } = await sb.storage.from(SUPABASE_BUCKET).upload(key, buf, {
    contentType: "image/png",
    upsert: true,
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
    // 1) Navigate (fast + robust)
    await page.goto(job.url, { waitUntil: "domcontentloaded", timeout: 25000 });
    await page.waitForLoadState("networkidle", { timeout: 4000 }).catch(() => {});
    await page.waitForTimeout(400).catch(() => {});

    // 2) Quick overlay hide (minimal)
    await page.evaluate(() => {
      const sel = '[role="dialog"], .modal, .popup, [data-cookiebanner], [id*="cookie"]';
      for (const el of Array.from(document.querySelectorAll(sel))) {
        try {
          el.style.setProperty("display", "none", "important");
          el.style.setProperty("opacity", "0", "important");
          el.style.setProperty("visibility", "hidden", "important");
        } catch {}
      }
    });

    // 3) Screenshot viewport
    const buf = await page.screenshot({ type: "png", fullPage: false, timeout: 15000 });

    // 4) Upload
    const publicUrl = await uploadPng(job.screenshot_key, buf);

    // 5) Mark done
    await sb.from("screenshot_jobs").update({
      status: "done",
      finished_at: new Date().toISOString(),
      screenshot_url: publicUrl,
    }).eq("id", job.id);

    // 6) Best-effort link into run_devices (optional)
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
          screenshot_url: publicUrl,
        }).eq("id", rd.id);
      }
    }

    jobsSinceLaunch += 1;
    console.log(`[worker] job ${job.id} done in ${Date.now() - t0}ms → ${publicUrl}`);
  } catch (err) {
    console.error("[worker] job error:", err);
    // Only try to update if we have an id
    if (job?.id) {
      await sb.from("screenshot_jobs").update({
        status: "error",
        finished_at: new Date().toISOString(),
        error: String(err),
      }).eq("id", job.id);
    }
    throw err; // bubble to main for backoff
  } finally {
    await ctx.close().catch(() => {});
  }
}

// --------- Main loop (idle-aware, non-spam) ---------
async function main() {
  console.log("[worker] started");
  while (true) {
    try {
      const job = await claimNormalizedJob();
      if (!job) {
        // No work — idle quietly
        await sleep(POLL_SLEEP_MS);
        continue;
      }
      console.log(`[worker] processing id=${job.id} device=${job.device} url=${job.url}`);
      await processJob(job);
    } catch (e) {
      console.error("[worker] tick error:", e?.message || e);
      await sleep(ERROR_BACKOFF_MS); // backoff prevents log spam
    }
  }
}

main().catch((e) => {
  console.error("[worker] fatal:", e);
  process.exit(1);
});
