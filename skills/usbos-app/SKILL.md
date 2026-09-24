---
name: usbos-app
description: Create, modify, or review applications for USBos (the 100% browser, USB-key operating system). Use when the user asks for a new USBos app, changes to an existing app under USBos/apps/, or a review of app code against the USBos contract.
license: MIT
metadata:
  version: "1.0.0"
  audience: [human, agent]
---

# USBos App Creator

USBos is a zero-dependency, browser-only "OS on a USB key" (File System
Access API, no server). Apps live under `USBos/apps/<id>/` and run
**sandboxed** — the kernel only ever sees their `manifest.json`.

## Workflow (follow in order)

1. **Scaffold** — copy `template/` to `USBos/apps/<id>/` and fill the
   `TODO`s. Keep `id` == folder name, lowercase letters/digits/`-`.
2. **Contract** — read `contract.md` and implement
   `mount(ctx, stage)` / `unmount()`. Data belongs in `data:<id>/`
   (auto-scoped, encrypted at rest unless plain mode); static assets
   via `readAppAsset`; shared exchange via `shared:` (plaintext by design).
3. **UI & styles** — use **CSS variables only** (`var(--panel)`,
   `var(--text)`…) so light/dark/custom themes apply. Follow the UX
   patterns in `template/` (two-step delete, toasts, `/` search,
   `Ctrl+S`, action-first empty states, `aria-label`s).
   **No hardcoded French** (or any language): every visible string via
   `ctx.i18n.t('<id>.<key>')` / `tp()` plurals / `ctx.i18n.locale` for
   dates (`Intl`), and add the FR + EN entries under your `<id>`
   namespace in `USBos/system/lang/fr.json` + `en.json` (symmetric —
   checked by `python tools/validate-lang.py`). Logs (`ctx.ui.log`)
   stay in French.
4. **Validate** — run `python skills/usbos-app/validate.py USBos/apps/<id>/`
   and fix every FAIL. Also mount it once (open the app in USBos).
5. **Publish** — see `publishing.md` (own public GitHub repo,
   `version.json` + `files.json`, bump manifest **and** version.json).

## Golden rules (non-negotiable)

- Classic script + top-level `return USBosApp` — **no ES modules**,
  no `import`/`export` (the kernel loads code with `new Function`).
- Never `prompt()` / `confirm()` / `alert()` — use inline UI.
- Never request `allow-same-origin` — the sandbox stays opaque.
- Never read another app's data; never store secrets in `shared/`.
- Clean up in `unmount()`: timers, listeners, connections.
- `crypto.randomUUID()` needs a fallback (non-secure contexts).
- Keep binary writes ≤ 25 MB, text/JSON ≤ 2 MB per call.
