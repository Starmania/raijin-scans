# Maintenance — fixing the reader when raijin-scans rotates its obfuscation

This repo hosts `reader.js`, the page-list descrambler for the **Raijin Scans (fr)**
Tachiyomi/Mihon extension. The site **rotates the obfuscation** of its reader manifest
periodically; when it does, page loading breaks and `reader.js` must be patched. This file
is everything needed to do that fast.

## TL;DR recovery loop

1. Capture a fresh chapter page (site is behind Cloudflare → use FlareSolverr, below).
2. Find the `rjfr_` manifest `<script>` and diff its shape against what `reader.js` expects.
3. Patch `reader.js` here (the bundled fallback only needs syncing on contract changes — see below).
4. Validate with `bun -c reader.js` + the canary harness below (`bun harness.js`).
5. Commit + push `main` → the release workflow publishes a new `latest` release.
6. Devices pick it up within the 12h cache TTL; the bundled fallback covers fresh installs.

## Two copies — when to sync

The exact same descrambler lives in **two** places, but they update on **different cadences**:

- **`reader.js`** (this repo) — the live, updatable copy. Served from the latest GitHub
  release and fetched at runtime; updating it fixes users **without a new APK**. Patch this
  for **every** rotation.
- **`DEFAULT_SCRIPT`** in the extension:
  `extensions-source/src/fr/raijinscans/src/eu/kanade/tachiyomi/extension/fr/raijinscans/ReaderScriptManager.kt`
  — the bundled fallback used when the remote fetch fails or the version gate rejects it.
  It is a Kotlin multi-dollar raw string (`$$"""..."""`): write `$` literally (no escaping), and
  only an actual Kotlin interpolation needs the `$$` prefix. Keep `\\` literal. The body is
  otherwise identical to `reader.js`.

**Don't reflexively sync `DEFAULT_SCRIPT`.** A pure descramble fix ships via the release alone;
the stale fallback only matters before the first remote fetch, and that fetch overrides it. Only
re-sync the fallback when you're **already** touching the extension repo for a contract change
(see [When to touch the extension repo](#when-to-touch-the-extension-repo-extensions-source)),
so fresh installs aren't broken on first launch.

If you change the **JS↔Kotlin contract** (the `ctx` fields, `host.fetch`/`host.log`, or
`rjGetPages`'s signature/return), bump `PARSER_VERSION` in `ReaderScriptManager.kt` and add
the new version to `reader.json`'s `validVersion`. A pure descramble fix (most rotations)
does **not** need a version bump.

## When to touch the extension repo (`extensions-source`)

**Default: don't.** Ship descramble fixes here (`reader.js` → release) so users update without
a new APK. Only push commits (no PR, byt you may trigger PushNotification to say you have commited some work) against `extensions-source` when the extension needs a **new API/contract**
it can't get from `reader.js` alone — i.e. the Kotlin↔JS boundary itself changed:

- New/changed `ctx` field, `host.*` bridge method, or `rjGetPages` signature/return shape.
- `PARSER_VERSION` / `reader.json` `validVersion` bump (the version gate is enforced Kotlin-side).
- New host capability (extra okhttp call, preference, header) the script must call into.
- Bundled-fallback drift: after such a change, sync `DEFAULT_SCRIPT` so fresh installs work
  before the first remote fetch.

If a rotation is fixable by editing `reader.js` alone (the usual case), **do not** update
`extensions-source` — a release here covers all existing users, while an APK bump only delays
the fix behind store/repo propagation.

## How the reader works (so you know what to look for)

Entry point: `async function rjGetPages(ctx, host)` → returns array of image-url strings.
Runs in a sandboxed headless WebView; all network goes through the okhttp host bridge
(`host.fetch`), never the WebView itself. See `README.md` for the host contract.

Per-chapter flow:

1. **Find the manifest.** Pick the first `<script>` whose text contains `rjfr_`. Inside it,
   a JSON object is injected, either:
   - `window["rjfr_<hex>"][...length] = { ... }`, or
   - `window["rjfr_<hex>"].push({ ... })`.
2. **Locate + parse that object.** It contains keys `m` (string) and `c` (object).
   ⚠️ The object's **first key is randomized** (e.g. `{"rj<hex>":1,"m":...,"c":{...}}`), so do
   **not** assume it starts with `"m"`. Current code anchors on the `"m"` key and walks back to
   the enclosing `{`, then brace-matches forward respecting string literals (`extractObject`).
3. **Rebuild config.** `b64 = m.split("|").map(k => c[k]).join("")` → base64 → JSON `config`
   with arrays `d`, `m`, `l`.
4. **Un-permute.** `ordered[config.m[i]] = config.d[i]`; then `vals[i] = ordered[config.l[i]]`.
   `vals` has ~15 entries.
5. **Pull fields out of `vals`:**
   - `action` = the only string starting with `rjfr_`.
   - `keyArr` = `vals[13]` (array of ~12 `rj<hex>` POST field names).
   - `contentValues` = `vals[1]..vals[6]`.
6. **Paginate admin-ajax.** POST `multipart/form-data` to `${ctx.baseUrl}/wp-admin/admin-ajax.php`:
   - `action` = action
   - `keyArr[0..5]` = contentValues
   - `keyArr[6]` = **running count of pages already loaded** (not 0)
   - `keyArr[7]` = `"0"` (offset, always 0)
   - `keyArr[8]` = value of `[data-rj-free-reader-root]` attribute from the page
   - `keyArr[9]` = cursor (see below)
   Response is an obfuscated JSON tree. Walk it (`findImages`) to find the array of image
   objects; the real url in each object is the `http...` string with an image extension
   (a decoy admin-ajax url also lives there). The parent object also holds: the **only string
   primitive** = next `cursor`; the **only boolean primitive** = whether to keep looping.

## Things that have rotated before (history)

- Manifest injected via `.push(...)` → switched to indexed `[...length] = ...` assignment.
- `keyArr[6]` was treated as constant `0` → it's the running page count.
- Manifest object first key randomized (`{"rj<hex>":1,"m":...}`) → it no longer starts with
  `"m"`; locator changed from `/\{\s*"m"\s*:/` to: find `"m":`, then `lastIndexOf("{", mKey)`.

When it breaks again, suspect (in order): the manifest object shape/key order, the `vals`
index of `keyArr` (was 13) and `contentValues` (was 1..6), the `keyArr[6..9]` slot meanings,
and the image-vs-decoy heuristic in `imageUrlOrNull`.

## Tooling

### FlareSolverr (bypass Cloudflare to capture pages)

The site returns `403` to plain `curl`. A FlareSolverr instance runs locally on **:8191**.
Probe it: `curl -s http://localhost:8191/v1 -X POST -H 'Content-Type: application/json' -d '{"cmd":"sessions.list"}'`

Capture a chapter page:

```bash
curl -s http://localhost:8191/v1 -X POST -H 'Content-Type: application/json' \
  -d '{"cmd":"request.get","url":"https://raijin-scans.fr/manga/colorist/1/","maxTimeout":60000}' \
  -o /tmp/ch.json
python3 -c "import json;s=json.load(open('/tmp/ch.json'))['solution'];open('/tmp/ch.html','w').write(s['response']);print(s['status'],len(s['response']))"
```

Find chapter slugs from a series page (same `request.get` on `https://raijin-scans.fr/manga/<slug>/`).
Known-good test title: `tensei-shitara-slime-datta-ken-01` (free chapters).

### Canary harness (`harness.js`) — runs the real reader.js

`harness.js` is the health check the watchdog runs. Instead of re-implementing the
descramble (the old `healthcheck.py` did, and so missed bugs the real code would hit —
e.g. the cursor-decoy 403), it loads the shipped `reader.js` verbatim under a `linkedom`
DOMParser and drives the full `rjGetPages()` pagination loop against a live free chapter.
Every request (chapter GET + each admin-ajax POST) is tunnelled through one FlareSolverr
session so it carries `cf_clearance`.

```bash
bun install                 # first time (pulls linkedom)
bun harness.js              # human-readable PASS / FAIL / INCONCLUSIVE
bun harness.js --json       # {ok,stage,detail,checks} — what the watchdog parses
bun harness.js --chapter-url https://raijin-scans.fr/manga/<slug>/<n>/
```

Exit codes: `0` healthy · `1` BROKEN (reader.js threw / no pages → patch it) ·
`2` inconclusive (FlareSolverr/transport, not the scraper's fault). When it reports
BROKEN, capture the chapter HTML (above) and diff the manifest shape to find what moved:
if `action` is empty, `vals[13]` (keyArr) isn't a ~12-element list of `rj<hex>` strings,
or `contentValues` look wrong, the `vals` indices have shifted — dump the whole `vals`
array and re-match by shape.

### har-mcp

A full chapter HAR capture lived at `extensions-source/src/fr/raijinscans/build/raijin.har`
(gitignored build dir, may be stale/absent). The `har-mcp` server (search/list/get over HAR
entries) is handy for finding the original admin-ajax request/response pairs and confirming
the multipart field names against a real browser session.

## Release flow

`.github/workflows/release.yml`: on push to `main` touching `reader.js`/`reader.json` (or manual
`workflow_dispatch`), it creates a GitHub release marked `--latest`, titled with the UTC ISO
timestamp, attaching `reader.js` + `reader.json`. The extension fetches from
`releases/latest/download/{reader.json,reader.js}`.
