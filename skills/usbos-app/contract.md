# USBos App Contract (reference)

This is the exact contract enforced by `USBos/system/kernel.js`.
If this file and the kernel disagree, **the kernel wins** — update this file.

## Files

```
USBos/apps/<id>/
  manifest.json   { "id", "name", "version", "entry" (default "index.js"),
                    "description", "icon" (single emoji) }
  index.js        classic script ending with `return USBosApp;`
  version.json    { "version" } — MUST match manifest.json version
  vendor/         (optional) static third-party code, loaded via readAppAsset
```

Rules: `id` matches the folder name (`^[a-z0-9-]{1,64}$`, case-insensitive).
The kernel ignores apps with an unreadable manifest or a mismatched id.

## Module shape

```js
const USBosApp = {
  id: '<id>',                       // must equal manifest id
  async mount(ctx, stage) { /* build UI into stage */ },
  async unmount() { /* clear timers, listeners, connections */ },
};
return USBosApp;                     // top-level return: legal, code runs via new Function()
```

- Exactly **one app mounted at a time**. On switch/close the kernel
  posts `__usbosUnmount` and waits up to 500 ms for `unmount()` before
  destroying the iframe — keep cleanup fast and total.
- `stage` is a plain DOM element (`<div id="stage">`). Do not touch
  anything outside it (you cannot anyway: opaque origin).
- `document` / `window` inside the iframe are the **iframe's own**.
  `parent`, `top`, `indexedDB`, `localStorage` are unreachable/unusable —
  go through `ctx` for everything persistent.

## `ctx.fs` — files (all paths relative, `".."` rejected, FAT32-safe names)

| Method | Scope | Notes |
|---|---|---|
| `readText(p)` / `writeText(p, s)` | `data:<id>/` | text ≤ 2 MB per call |
| `readJSON(p)` / `writeJSON(p, o)` | `data:<id>/` | same cap (serialized) |
| `readBinary(p)` / `writeBinary(p, buf)` | `data:<id>/` | binary ≤ 25 MB per call |
| `exists(p)` / `remove(p)` / `list(p='')` | `data:<id>/` | `remove` is recursive |
| `readAppAsset(p)` | `apps:<id>/` read-only | static assets (e.g. `vendor/lib.js`), never encrypted |
| `readShared(p)` / `writeShared(p, buf)` | `shared:/` (="Partage/") | **common to all apps**, plaintext by design |
| `readSharedText(p)` / `writeSharedText(p, s)` | `shared:/` | text ≤ 2 MB |
| `listShared(p='')` / `existsShared(p)` / `removeShared(p)` | `shared:/` | common, plaintext |

- `data:<id>/` is transparently AES-GCM encrypted (or plaintext in
  plain mode) — the app always sees cleartext. Never store secrets in
  `shared:/`: it is readable outside USBos by design.
- Calls that cannot complete reject (timeout 30 s). Always `try/catch`
  persistence and surface failures in the UI — never leave the app stuck.
- Recommended pattern — **import from `shared:/`** (read-only): list
  with `listShared('')` filtered by extension (cap display at ~20),
  read with `readSharedText`, validate the shape before merging, never
  overwrite — merge (new ids on collision), then `persist()` + toast.
  If `shared:/` is unavailable the call rejects: toast it, do not crash.
  Document shortcuts/limits inline (a discreet `.hint` line, e.g.
  `Ctrl+S` save · `/` search · caps) — every visible string via `t()`.

## `ctx.ui`

| Method | Notes |
|---|---|
| `log(message, level?)` | `debug`/`info`/`warn`/`error` (default `info`), 2000 chars max, goes to the kernel journal |
| `toast(message)` | shell notification, 200 chars max, throttled to 1 per 2 s per app |

## `ctx` misc

- `ctx.appId` — your id (informational; the kernel enforces the real one).
- `ctx.manifest` — your parsed manifest.
- `ctx.i18n` — `{ lang, locale, t(key, params?), tp(key, count, params?) }`,
  frozen at mount. **Every user-visible string** goes through
  `t('<id>.<key>')` (params `{name}`), plurals through `tp()` with
  `{one, other}` dict entries, dates through `Intl` +
  `ctx.i18n.locale`. Add FR + EN entries under your `<id>` namespace in
  `USBos/system/lang/fr.json` / `en.json` (symmetric, validated).
  `shell.*` keys are also available (shared errors). Logs stay French.

## Sandbox & CSP (what you live with)

- `sandbox="allow-scripts allow-forms allow-modals allow-downloads"`
  (+ `allow-popups` where whitelisted). `allow-same-origin` and
  `allow-top-navigation*` are **refused** — requesting them logs a
  kernel warning and keeps you opaque.
- The iframe inherits the shell CSP: `unsafe-inline` allowed,
  `unsafe-eval` allowed (the loader itself needs it), network only to
  `https:`/`wss:` (needed e.g. for WebRTC signalling).
- Clipboard: `navigator.clipboard` may be unavailable (non-secure
  context) — provide a manual-copy fallback.
- `crypto.randomUUID()` may be unavailable — ship the
  `getRandomValues` fallback from `template/`.
- No `prompt()`/`confirm()`/`alert()`: they are blocking and depend on
  `allow-modals`. Build inline confirmations (two-step delete pattern).
- Fullscreen/pointer-lock/geolocation/notification APIs are unavailable
  or unreliable sandboxed — do not depend on them.

## Styling (themes apply only if you use variables)

- Use **CSS custom properties**, never hardcoded hex:
  `--bg --panel --panel2 --border --text --muted --placeholder --accent
  --accent2 --ok --warn --err --deep --logtext --hover`.
- Roots are flex columns filling the space (`width:100%; flex:1`);
  avoid fixed `max-width` cages and inner scroll traps — the shell
  provides the single styled scrollbar.
- `prefers-reduced-motion` is neutralized kernel-side; keep your own
  animations ≤ 200 ms.
