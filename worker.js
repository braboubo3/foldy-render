// worker.js — Foldy screenshot worker (sequential)
// Run with: node worker.js  (set envs below)

import { createClient } from "@supabase/supabase-js";
import playwright from "playwright"; // assume chromium is used in index.js too

const RECYCLE_EVERY_N_JOBS = parseInt(process.env.WORKER_BROWSER_RECYCLE_N || "50", 10);
const BROWSER_ARGS = ["--no-sandbox"]; // keep minimal on small instances

let browser = null;
let jobsSinceLaunch = 0;

async function getBrowser() {
  if (!browser || jobsSinceLaunch >= RECYCLE_EVERY_N_JOBS) {
    if (browser) { try { await browser.close(); } catch {} }
    browser = await playwright.chromium.launch({ headless: true, args: BROWSER_ARGS });
    jobsSinceLaunch = 0;
  }
  return browser;
}

async function processJob(job) {
  const b = await getBrowser();
  const ctx = await b.newContext({ deviceScaleFactor: 3 }); // set per device if you have a map
  const page = await ctx.newPage();
  try {
    // ... navigate, hide overlays, cap fonts.ready, screenshot, upload ...
  } finally {
    jobsSinceLaunch += 1;
    await ctx.close().catch(()=>{});
  }
}


// ---- Env ----
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
const SUPABASE_BUCKET = process.env.SUPABASE_BUCKET || "screenshot";
const WORKER_SLEEP_MS = parseInt(process.env.WORKER_SLEEP_MS || "1500", 10);
const BROWSER_HEADLESS = process.env.HEADFUL ? false : true;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
  console.error("[worker] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE");
  process.exit(1);
}
const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE, { auth: { persistSession: false } });

// small sleep util
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function claimJob() {
  const { data, error } = await sb.rpc("claim_screenshot_job", { p_worker_id: crypto.randomUUID() });
  if (error) {
    console.error("[worker] claim error:", error);
    return null;
  }
  return data;
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

// NOTE: replicate your "clean screenshot" routine (hide overlays, etc.)
// For MVP, we simply navigate, run the same audit/hide steps you have.
// To keep this file smaller, we do a focused path: wait DOMContentLoaded,
// run your "hide overlays" evaluate, then screenshot viewport.
async function processJob(job) {
  const t0 = Date.now();
  const browser = await playwright.chromium.launch({ headless: BROWSER_HEADLESS, args: ["--no-sandbox"] });
  const ctx = await browser.newContext({
    // consider mirroring device DPR/UA if you have a device map in index.js
    deviceScaleFactor: 3
  });
  const page = await ctx.newPage();
  try {
    // 1) Navigate (you can copy your NAV timeout constants)
    await page.goto(job.url, { waitUntil: "domcontentloaded", timeout: 25000 });

    // 2) Hide overlays — paste the same evaluate you use before "clean screenshot"
    await page.evaluate(() => {
      // Minimal hide overlays; replace with your actual logic
      const blockers = Array.from(document.querySelectorAll('[role="dialog"], .modal, .popup, [data-cookiebanner], [id*="cookie"]'));
      for (const el of blockers) {
        el.setAttribute("data-foldy-hidden", "1");
        el.style.setProperty("display", "none", "important");
        el.style.setProperty("opacity", "0", "important");
        el.style.setProperty("visibility", "hidden", "important");
      }
    });

    // 3) Cap webfont wait to 1.5s (prevents font stalls)
    await page.evaluate(async (capMs) => {
      try {
        if (document.fonts?.ready) {
          await Promise.race([
            document.fonts.ready,
            new Promise((r) => setTimeout(r, capMs)),
          ]);
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

    // 7) Best-effort update run_devices row (if exists)
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
    await browser.close().catch(()=>{});
  }
}

async function main() {
  console.log("[worker] started");
  while (true) {
    const job = await claimJob();
    if (!job) {
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
