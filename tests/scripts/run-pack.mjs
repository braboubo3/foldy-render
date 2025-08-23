#!/usr/bin/env node
// Foldy test runner: executes a YAML pack, saves artifacts, asserts expectations.
// Usage:
//   RENDER_URL=https://<host> RENDER_TOKEN=xxx node scripts/run-pack.mjs tests/pack.smoke.yaml --out=artifacts [--devices=all|iphone_15_pro,pixel_8] [--debug=0|1]
// Exit code != 0 on failures.
//
// Requires: "type":"module" in package.json and dev dep js-yaml.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const RENDER_URL = process.env.RENDER_URL?.replace(/\/+$/, "");
const RENDER_TOKEN = process.env.RENDER_TOKEN;

if (!RENDER_URL || !RENDER_TOKEN) {
  console.error("Missing env: RENDER_URL and/or RENDER_TOKEN");
  process.exit(2);
}

function parseArgs() {
  const args = process.argv.slice(2);
  if (!args[0]) {
    console.error("Usage: run-pack.mjs <pack.yaml> [--out=artifacts] [--devices=all|csv] [--debug=0|1]");
    process.exit(2);
  }
  const opts = { pack: args[0], out: "artifacts", devices: "all", debug: "0" };
  for (const a of args.slice(1)) {
    const [k, v] = a.split("=");
    if (k === "--out") opts.out = v;
    if (k === "--devices") opts.devices = v;
    if (k === "--debug") opts.debug = v;
  }
  return opts;
}

function slug(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); }

async function postRender({ url, device, debug }) {
  const res = await fetch(`${RENDER_URL}/render`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${RENDER_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      url,
      device,
      debugOverlay: debug ? 1 : 0,
      debugRects: debug ? 1 : 0,
      debugHeatmap: debug ? 1 : 0,
    }),
  });
  if (!res.ok) {
    const txt = await res.text().catch(()=>"");
    throw new Error(`HTTP ${res.status} ${res.statusText} ${txt}`);
  }
  return res.json();
}

function writeBase64Png(b64, filename) {
  if (!b64) return;
  fs.writeFileSync(filename, Buffer.from(b64, "base64"));
}

function bandedAssert(actual, band, name, results) {
  if (!band) return;
  if (typeof band.min === "number" && actual < band.min) {
    results.push({ type: "fail", what: `${name} < min`, expected: band.min, actual });
  }
  if (typeof band.max === "number" && actual > band.max) {
    results.push({ type: "fail", what: `${name} > max`, expected: band.max, actual });
  }
}

async function run() {
  const { pack, out, devices, debug } = parseArgs();
  const debugOn = debug === "1";
  const spec = yaml.load(fs.readFileSync(pack, "utf8"));

  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const root = path.join(out, `${slug(spec.name || "pack")}-${runId}`);
  ensureDir(root);

  const selectedDevices = devices === "all"
    ? (spec.devices || ["iphone_15_pro","pixel_8","iphone_se_2"])
    : devices.split(",").map(s => s.trim()).filter(Boolean);

  const summaryRows = [];
  const summaryJsonl = [];

  console.log(`== Foldy Pack: ${spec.name || path.basename(pack)} ==`);
  console.log(`Devices: ${selectedDevices.join(", ")}  Debug: ${debugOn ? "on" : "off"}  Output: ${root}`);
  let failed = 0;

  for (const t of spec.tests) {
    for (const dev of selectedDevices) {
      const testDir = path.join(root, `${slug(t.id)}__${dev}`);
      ensureDir(testDir);
      process.stdout.write(`• ${t.id} @ ${dev} … `);

      try {
        const resp = await postRender({ url: t.url, device: dev, debug: debugOn });

        // Save artifacts
        fs.writeFileSync(path.join(testDir, "response.json"), JSON.stringify(resp, null, 2));
        writeBase64Png(resp.pngBase64, path.join(testDir, "clean.png"));
        writeBase64Png(resp.pngWithOverlayBase64, path.join(testDir, "as-seen.png"));
        writeBase64Png(resp.pngDebugBase64, path.join(testDir, "heatmap.png"));

        // Assertions
        const res = [];
        const exp = t.expect || {};
        const ux = resp.ux || {};
        bandedAssert(ux.foldCoveragePct, exp.foldCoveragePct, "foldCoveragePct", res);
        bandedAssert(ux.overlayCoveragePct, exp.overlayCoveragePct, "overlayCoveragePct", res);
        bandedAssert(ux.smallTapTargets, exp.smallTapTargets, "smallTapTargets", res);
        bandedAssert(ux.minFontPx, exp.minFontPx, "minFontPx", res);
        bandedAssert(ux.maxFontPx, exp.maxFontPx, "maxFontPx", res);
        if (typeof exp.hasViewportMeta === "boolean" && ux.hasViewportMeta !== exp.hasViewportMeta) {
          res.push({ type: "fail", what: "hasViewportMeta", expected: exp.hasViewportMeta, actual: ux.hasViewportMeta });
        }
        if (typeof exp.firstCtaInFold === "boolean" && ux.firstCtaInFold !== exp.firstCtaInFold) {
          res.push({ type: "fail", what: "firstCtaInFold", expected: exp.firstCtaInFold, actual: ux.firstCtaInFold });
        }

        const ok = res.length === 0;
        summaryRows.push({
          id: t.id, device: dev, url: t.url,
          fold: ux.foldCoveragePct, overlay: ux.overlayCoveragePct,
          taps: ux.smallTapTargets, minFont: ux.minFontPx, maxFont: ux.maxFontPx,
          hasViewportMeta: ux.hasViewportMeta, firstCtaInFold: ux.firstCtaInFold,
          ok
        });
        summaryJsonl.push({ id: t.id, device: dev, url: t.url, ok, ux, timings: resp.timings });

        if (!ok) {
          failed++;
          fs.writeFileSync(path.join(testDir, "failures.json"), JSON.stringify(res, null, 2));
          console.log("FAIL");
        } else {
          console.log("OK");
        }
      } catch (e) {
        failed++;
        fs.writeFileSync(path.join(testDir, "error.txt"), String(e.stack || e));
        console.log("ERROR");
      }
    }
  }

  // Write summaries
  const csvHeader = "id,device,foldCoveragePct,overlayCoveragePct,smallTapTargets,minFontPx,maxFontPx,hasViewportMeta,firstCtaInFold,ok,url\n";
  const csv = csvHeader + summaryRows.map(r =>
    [r.id, r.device, r.fold, r.overlay, r.taps, r.minFont, r.maxFont, r.hasViewportMeta, r.firstCtaInFold, r.ok, r.url]
      .map(v => (v === undefined ? "" : String(v).replace(/,/g,";")))
      .join(",")
  ).join("\n");
  fs.writeFileSync(path.join(root, "summary.csv"), csv);
  fs.writeFileSync(path.join(root, "summary.jsonl"), summaryJsonl.map(j => JSON.stringify(j)).join("\n"));
  fs.writeFileSync(path.join(root, "run.json"), JSON.stringify({ pack, devices: selectedDevices, debug: debugOn, startedAt: runId, renderUrl: RENDER_URL }, null, 2));

  console.log(`\nSummary: ${summaryRows.length} cases, ${failed} failed. Artifacts: ${root}`);
  process.exit(failed ? 1 : 0);
}

globalThis.fetch ??= (await import("node-fetch")).default;
run().catch((e) => { console.error(e); process.exit(3); });
