# Publishing a USBos app

Each app ships in its **own public GitHub repository** (the updater treats
every component separately). The kernel never bundles apps.

## 1. Repository layout (repo root)

```
version.json   { "version": "1.2.3" }   # MUST match manifest.json version
files.json     { "files": { "index.js": "<sha256 hex>", "manifest.json": "<sha256 hex>", … } }
index.js
manifest.json
vendor/…       (if any — same relative paths as under USBos/apps/<id>/)
```

Generate both descriptors — never by hand:

```sh
python tools/gen_files_json.py USBos/apps/<id> --version 1.2.3
```

This also syncs `manifest.json` ↔ `version.json`.

## 2. Register the source

On a dev key (console only — there is intentionally **no UI** for this):

```js
// read current file first, then add your entry and write it back
```

`config/update-sources.json` shape:

```json
{
  "kernel": "https://raw.githubusercontent.com/<account>/usbos-kernel/main",
  "apps": {
    "my-app": "https://raw.githubusercontent.com/<account>/usbos-app-my-app/main"
  }
}
```

Only `https://` URLs are accepted. For production keys, bake the file
into `make_installer.py` sources instead — it ships inside
`installer.html` and merges on install.

## 3. Release checklist

1. `python skills/usbos-app/validate.py USBos/apps/<id>/` → 0 failures.
2. Bump **both** `manifest.json` and `version.json` (same value).
3. Regenerate `files.json` + `version.json` via `gen_files_json.py`.
4. Mount the app once in USBos (CRUD, reload, unmount without errors).
5. `raw.githubusercontent.com` is free for public repos, no token needed.
