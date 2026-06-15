# raijin-scans

Updatable page-list reader script for the **RaijinScans** (fr) extension in
[keiyoushi/extensions-source](https://github.com/keiyoushi/extensions-source).

The reader descrambles a per-page randomized manifest and walks an obfuscated
`admin-ajax.php` response. The site rotates that obfuscation, so the descrambler
is shipped here as an external JS bundle that the extension fetches and runs in a
sandboxed WebView — it can be updated server-side without releasing a new APK.

## Files

- **`reader.js`** — entry point `async function rjGetPages(ctx, host)`, returns
  an array of image-url strings.
- **`reader.json`** — manifest the extension reads first:
  ```json
  { "validVersion": [1], "script": "reader.js" }
  ```
  `validVersion` lists the parser versions this bundle is compatible with;
  `script` is the bare filename (no path) of the JS to fetch from the same
  release.

## Distribution

The extension fetches from the **latest GitHub release**:

```
https://github.com/Starmania/raijin-scans/releases/latest/download/reader.json
https://github.com/Starmania/raijin-scans/releases/latest/download/<script>
```

`reader.json` is fetched first (version-gated against the extension's
`PARSER_VERSION`), then the named JS. The extension caches the JS 12h and falls
back to a bundled copy if the fetch fails or the version doesn't match.

To publish an update: bump/edit `reader.js`, attach both `reader.js` and
`reader.json` to a new GitHub release, and publish it as `latest`.

## JS contract

`rjGetPages(ctx, host)`:

- `ctx` = `{ baseUrl, chapterUrl, html, ajaxHeaders, maxPageRequests }`.
- `host.fetch(spec)` → Promise of `{ ok, status, body }`. `spec` =
  `{ url, method?, headers?, multipart?: [[name, value], ...], body?, contentType? }`.
  okhttp performs the request on the app's network stack; the WebView never hits
  the network directly.
- `host.log(msg)` logs to logcat.
