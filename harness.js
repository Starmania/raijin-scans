#!/usr/bin/env bun
/**
 * Canary for the Raijin Scans reader descrambler — runs the REAL reader.js.
 *
 * Unlike a re-implementation, this loads the shipped reader.js verbatim, gives it
 * a DOMParser (linkedom) and a host.fetch, then drives the full rjGetPages()
 * pagination loop against a real free chapter. If raijin-scans rotates its
 * obfuscation — manifest shape, image layout, or the cursor token — reader.js
 * throws here, *before* users notice. Because it walks the real cursor loop it
 * also catches pagination drift (e.g. a decoy cursor field) that a single-request
 * check would miss.
 *
 * The site is behind Cloudflare, so every request (the chapter GET *and* each
 * admin-ajax POST) goes through one FlareSolverr session: the session's browser
 * holds cf_clearance, which a raw fetch lacks (Cloudflare 403s it on sight).
 *
 * Exit codes (kept identical to the old healthcheck.py so the watchdog is unchanged):
 *   0  healthy       — reader.js paginated a real chapter to completion
 *   1  BROKEN        — reader.js threw / returned no pages: it needs patching
 *   2  inconclusive  — couldn't capture the page / transport error (not our fault)
 *
 * Usage:
 *   bun harness.js
 *   bun harness.js --chapter-url https://raijin-scans.fr/manga/<slug>/<n>/
 *   bun harness.js --flaresolverr http://localhost:8191/v1
 *   bun harness.js --json
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { DOMParser } from "linkedom";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_CHAPTER = "https://raijin-scans.fr/manga/reincarnated-as-a-legendary-grimoire/37/";
const DEFAULT_FLARESOLVERR = "http://localhost:8191/v1";

// BROKEN -> reader.js must be fixed (exit 1). Inconclusive -> transport (exit 2).
class Broken extends Error {}
class Inconclusive extends Error {}

function parseArgs(argv) {
  const a = { chapterUrl: DEFAULT_CHAPTER, flaresolverr: DEFAULT_FLARESOLVERR, json: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--chapter-url") a.chapterUrl = argv[++i];
    else if (argv[i] === "--flaresolverr") a.flaresolverr = argv[++i];
    else if (argv[i] === "--json") a.json = true;
  }
  return a;
}

// Load the shipped reader.js verbatim and hand back its rjGetPages, giving it the
// browser globals it expects (DOMParser, atob, escape) without editing the file.
function loadReader() {
  const src = readFileSync(join(HERE, "reader.js"), "utf8");
  const sandbox = { DOMParser, atob, escape, decodeURIComponent, console, JSON, RegExp, Array, Object, String, Number, Boolean, Math, Error, Promise };
  vm.createContext(sandbox);
  return vm.runInContext(`${src}\n;rjGetPages`, sandbox, { filename: "reader.js" });
}

async function flaresolverr(url, cmd) {
  let data;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(cmd),
      signal: AbortSignal.timeout(90_000),
    });
    data = await res.json();
  } catch (e) {
    throw new Inconclusive(`FlareSolverr unreachable at ${url}: ${e.message}`);
  }
  if (data.status !== "ok") throw new Inconclusive(`FlareSolverr ${cmd.cmd} failed: ${data.message}`);
  return data;
}

// host.fetch as the extension provides it, but tunnelled through FlareSolverr's
// browser session so the POST carries cf_clearance. reader.js sends multipart
// pairs; admin-ajax accepts urlencoded all the same, which is what request.post takes.
function makeHost(fsUrl, session) {
  return {
    async fetch({ url, multipart }) {
      const postData = multipart.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");
      const sol = (await flaresolverr(fsUrl, { cmd: "request.post", url, postData, maxTimeout: 60000, session })).solution || {};
      let body = sol.response || "";
      // FlareSolverr may wrap the JSON body in <html><body><pre>…; unwrap to the object.
      const i = body.indexOf("{");
      if (i > 0) body = body.slice(i, body.lastIndexOf("}") + 1);
      return { ok: sol.status >= 200 && sol.status < 300, status: sol.status, body };
    },
  };
}

async function run(args, checks) {
  const rjGetPages = loadReader();
  checks.push("reader.js loaded");

  const session = `canary_${Date.now()}`;
  await flaresolverr(args.flaresolverr, { cmd: "sessions.create", session });
  try {
    const get = await flaresolverr(args.flaresolverr, { cmd: "request.get", url: args.chapterUrl, maxTimeout: 60000, session });
    const sol = get.solution || {};
    if (sol.status !== 200 || !sol.response) throw new Inconclusive(`GET ${args.chapterUrl} -> status ${sol.status}, len ${(sol.response || "").length}`);
    // If FlareSolverr couldn't solve the CF challenge it may return the challenge page itself
    // (status 200, no reader manifest). Treat this as a transport failure, not a BROKEN reader.
    if (/Just a moment|_cf_chl_opt|challenge-platform|id="challenge-form"/.test(sol.response))
      throw new Inconclusive(`Cloudflare challenge page returned for ${args.chapterUrl} — FlareSolverr clearance may have expired`);
    checks.push(`chapter captured (${sol.response.length} bytes)`);

    const baseUrl = new URL(args.chapterUrl).origin;
    const ctx = { html: sol.response, maxPageRequests: 50, baseUrl, ajaxHeaders: {} };
    const host = makeHost(args.flaresolverr, session);

    let pages;
    try {
      pages = await rjGetPages(ctx, host);
    } catch (e) {
      // Transport/FlareSolverr errors thrown inside host.fetch propagate through the VM
      // context as Inconclusive instances; re-throw them so they stay exit-2, not BROKEN.
      if (e instanceof Inconclusive) throw e;
      const msg = String(e && e.message ? e.message : e);
      // A 5xx mid-loop is the origin/transport hiccuping, not an obfuscation rotation.
      if (/Failed to get page: 5\d\d/.test(msg)) throw new Inconclusive(msg);
      throw new Broken(msg);
    }
    if (!Array.isArray(pages) || pages.length === 0) throw new Broken("rjGetPages returned no pages");
    checks.push(`rjGetPages returned ${pages.length} page url(s)`);
    return pages.length;
  } finally {
    await flaresolverr(args.flaresolverr, { cmd: "sessions.destroy", session }).catch(() => {});
  }
}

const args = parseArgs(process.argv.slice(2));
const checks = [];
const result = { ok: false, stage: null, detail: null, checks: [] };
let code;
try {
  await run(args, checks);
  result.ok = true;
  code = 0;
} catch (e) {
  if (e instanceof Inconclusive) { result.stage = "inconclusive"; code = 2; }
  else { result.stage = "BROKEN"; code = 1; }
  result.detail = String(e && e.message ? e.message : e);
}
result.checks = checks;

if (args.json) {
  console.log(JSON.stringify(result, null, 2));
} else {
  for (const c of checks) console.log(`  ✓ ${c}`);
  if (code === 0) console.log("PASS — reader pipeline healthy");
  else if (code === 1) console.log(`FAIL (BROKEN) — ${result.detail}\n  -> raijin-scans rotated its format; patch reader.js (see MAINTENANCE.md)`);
  else console.log(`INCONCLUSIVE — ${result.detail}`);
}
process.exit(code);
