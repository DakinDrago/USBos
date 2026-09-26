# USBos

**[Français](README.md) | [English](README.en.md)**

**Your desktop, your apps, your data — on a USB drive, nothing to install on the computer.**

USBos is a "system" that runs entirely in the browser. You launch it from a USB drive (or any folder), and it gives you a desktop with a calendar, notes, a password manager, a gallery, Markdown documents, and peer-to-peer file chat — all encrypted, and usable on any computer where you plug in your drive.

No server, no installation, no account to create. What's on the drive stays on the drive.

## At a glance

- 🔌 **Portable** — everything lives in a `USBos/` folder on your drive (or disk). Unplug it, plug it in elsewhere, it keeps working.
- 🔒 **Encrypted by default** — an optional passphrase protects your data (AES-GCM). Without it, everything stays readable in plain text; with it, even someone who steals the drive can't read anything.
- 🧩 **7 built-in apps** — Calendar, Vault (passwords), Gallery, Markdown, Mesh (P2P chat/files), Notes, Toolbox.
- 🌐 **Bilingual** — French and English, switchable with one click.
- 🔄 **Automatic updates** — USBos checks for and applies system and app updates by itself, in the background.
- 🚫 **No account, no cloud** — your data never leaves your drive, unless you use Mesh to send it to someone yourself.

## What it looks like

*(add one or two screenshots of the desktop and an app here — e.g. `docs/screenshot-dashboard.png`)*

## What you need

- A **Chrome, Edge, Brave, Opera, or Vivaldi** browser (recent version). USBos uses the *File System Access API*, which doesn't exist in Firefox or Safari — you won't be able to install or open a drive with those browsers.
- A secure context: open the files from `https://`, `http://localhost`, or directly from disk (`file:`), depending on what your browser allows. A plain `http://` site will refuse the permission.
- A USB drive, an external disk, or even just a folder on your computer — everything works the same way.

## Installing USBos on a drive

1. Go to the repo's **Releases** tab (on the right on GitHub, or via the direct link `.../releases/latest`), download the **`installer.html`** file from the latest release, and open it in your browser — no need to clone or download the whole repo.
2. Click **Choose folder**, and select the **parent folder** where you want to install USBos (for example the root of your USB drive) — not an existing `USBos` folder itself, the installer creates that for you.
   > Choosing an existing `USBos/` folder directly limits some sharing features — always target the folder *above* it.
3. Choose the installation mode:

   | Mode | What it does | When to use it |
   |---|---|---|
   | **Fresh install** | Creates USBos from scratch | First installation |
   | **Diff only** | Only updates what changed | Regular update, the safest one |
   | **Update everything** | Rewrites the whole system and apps | After an issue, to start clean (your data is kept) |
   | **Reinstall from scratch** | Erases everything and starts over | Last resort — **destroys your data** |

4. Once installation is done, open **`USBos/index.html`** — that's your entry point from now on.
5. On first launch, you're offered to set a **passphrase** to encrypt your data. You can:
   - set it now (recommended if you plan to keep sensitive info, e.g. in the Vault);
   - or check "continue without a passphrase" and add it later from **Settings → Security**.

   ⚠️ If you forget your passphrase, your encrypted data is **permanently lost** — there is no recovery possible, by design.

## Using USBos day to day

- **Reopening your drive**: plug it into any compatible computer, open `USBos/index.html`, enter your passphrase if you set one.
- **The dashboard**: your home page — a quick view of today's calendar, your latest notes and documents, your Vault status, and available updates.
- **Settings (⚙️)**: appearance (light/dark/sand themes), security (passphrase), managing the `Shared/` folder, system info.
- **Updates**: USBos checks automatically in the background and offers an update when a new version of the system or an app is available — a banner notifies you, nothing happens without your consent to restart.
- **Locking**: the 🔒 lock icon in the header re-locks your session without closing the browser.
- **Guest mode**: from the lock screen, someone can view/drop files into the `Shared/` folder without accessing your notes, Vault, or settings.
- **Handy shortcuts**: `Ctrl+K` opens the command palette, `Ctrl+S` saves, `/` starts a search.

### The `Shared/` folder

Next to `USBos/`, the installer creates a **`Shared/`** folder (shown in French as `Partage/`). It's a common space, **intentionally unencrypted**, that any app can use to import or export files (photos, `.md` documents, `.ics` calendars, etc.) — handy for getting files in or out of your drive without going through a specific app. Never put anything confidential in it: everything in `Shared/` is readable without a passphrase.

## The 7 apps

| App | What it does |
|---|---|
| 📅 **Calendar** | Month/Week/Day calendar, `.ics` import/export (compatible with Google, Outlook, Apple) |
| 🔐 **Vault** | Credential manager (username/password), protected by its own passphrase on top of the general encryption |
| 🖼️ **Gallery** | Storage and viewing of images and videos |
| 📝 **Markdown** | Document writing with preview, `.md` export/import |
| 📡 **Mesh** | Direct chat and file transfer between two USBos drives, peer-to-peer (WebRTC) — no file ever passes through a central server |
| 🗒️ **Notes** | Quick notes with title and content, built-in search |
| 🧰 **Toolbox** | Small utilities (copy, conversions…) |

## Security and privacy — what to know

- Your apps' content (`data/`) is encrypted with **AES-GCM** (key derived from your passphrase via PBKDF2, 210,000 iterations) — a robust, well-established standard.
- The system itself (`system/`, `apps/`) and the `Shared/` folder remain **unencrypted**: they are software components and files meant for exchange, not personal data.
- The Vault applies a **second layer of encryption** with its own passphrase, on top of the system's.
- Updates are verified by hash (SHA-256) to guarantee they weren't corrupted in transit, but are not cryptographically signed — trust rests on the update source repository you configure.
- USBos never sends you any data: everything stays local, except what you share yourself via Mesh.

## Not working? (quick troubleshooting)

- **"This browser is not supported"** → use Chrome, Edge, Brave, Opera, or Vivaldi. Firefox and Safari are not compatible.
- **"Permission denied" on opening** → make sure you're opening the file from `https://`, `http://localhost`, or locally (`file:`), depending on what your browser allows.
- **Some options or buttons seem missing after an update** → do `Ctrl+F5` to force a reload (the browser sometimes keeps an old cached version).
- **The `Shared/` folder is unavailable** → you probably selected the `USBos/` folder itself instead of its parent during installation. Go to **Settings → Sharing → Reconnect**, or choose `Change drive` and select the correct parent folder.
- **I forgot my passphrase** → unfortunately there is no recovery: encrypted data is lost by design (no backdoor exists).

---

## For developers

This section is a technical summary. Full details (app contract, update format, validation tools) remain available in the code and in `skills/usbos-app/SKILL.md`.

### Repository structure

```
USBos/
├── README.md
├── README.en.md
├── installer.html                    # generated — never edit by hand
├── _installer_template.html          # installer template
├── make_installer.py                 # builds installer.html
│
├── USBos/                            # what actually gets deployed on the drive
│   ├── index.html                    # launcher — boot screen
│   │
│   ├── system/                       # kernel — never touched by an app
│   │   ├── kernel.js                 # boot, shell UI, encryption, RPC bridge
│   │   ├── kernel.css
│   │   ├── vfs.js                    # virtual file system
│   │   ├── crypto.js                 # PBKDF2 + AES-GCM
│   │   ├── logbus.js                 # in-memory log (dmesg-like)
│   │   ├── console.js                # window.usbos / u API + command palette
│   │   ├── updater.js                # delta update over HTTPS
│   │   ├── upack.js                  # .upack container (JS)
│   │   ├── version.json
│   │   ├── files.json                # updater descriptor (generated)
│   │   └── lang/
│   │       ├── fr.json
│   │       └── en.json
│   │
│   ├── apps/                         # 7 sandboxed apps (iframe srcdoc)
│   │   ├── agenda/
│   │   │   ├── index.js
│   │   │   ├── manifest.json
│   │   │   ├── version.json
│   │   │   └── files.json
│   │   ├── coffre/
│   │   │   └── … (same 4 files)
│   │   ├── gallery/
│   │   │   ├── vendor/upack.js
│   │   │   └── … (same 4 files)
│   │   ├── markdown/
│   │   │   └── … (same 4 files)
│   │   ├── mesh/
│   │   │   ├── vendor/peerjs.min.js
│   │   │   └── … (same 4 files)
│   │   ├── notes/
│   │   │   └── … (same 4 files)
│   │   └── toolbox/
│   │       └── … (same 4 files)
│   │
│   └── config/
│       └── update-sources.json       # HTTPS sources (kernel + apps)
│
├── skills/
│   └── usbos-app/                    # guide for building a new app
│       ├── SKILL.md
│       ├── contract.md
│       ├── publishing.md
│       ├── validate.py
│       └── template/
│           ├── index.js
│           ├── manifest.json
│           └── version.json
│
└── tools/                            # build and validation scripts
    ├── validate-versions.py
    ├── validate-lang.py
    ├── gen_files_json.py
    ├── upack.py
    ├── test-lang.cjs
    └── test-upack.cjs
```

**Not version-controlled but generated/created at runtime** (absent from the tree above):
- `USBos/data/` — encrypted user data
- `USBos/.update/` — updater staging and backups
- `Shared/` — sibling of `USBos/`, created by the installer

### App contract

Each app is a plain script loaded into an isolated `srcdoc` iframe (strict sandbox, no `allow-same-origin`):

```js
const USBosApp = {
  id: 'my-app',
  async mount(ctx, stage) {
    // ctx.fs.readJSON/writeJSON/readText/writeText/readBinary/writeBinary
    //   -> app-specific data, in data/<my-app>/
    // ctx.fs.readShared/writeShared/...  -> Shared/, common, plain text
    // ctx.ui.log(message, level?) / ctx.ui.toast(message)
    // stage: DOM element to mount the UI into
  },
  async unmount() { /* cleanup: timers, listeners, connections */ },
};
return USBosApp;
```

The kernel communicates with each app only via `postMessage`; the app never has direct access to the file system or the kernel's DOM. See `skills/usbos-app/SKILL.md` for the full template and validation script (`validate.py`).

### Publishing a new release

One command, one place to edit before running it:

- for the kernel: `const KERNEL_VERSION` in `system/kernel.js`;
- for an app: the `"version"` field in `apps/<id>/manifest.json`.

```bash
python tools/release.py
```

This automatically regenerates, for the kernel **and** every app (no need to say which ones changed): the mirrored `version.json` files, `index.html`'s `?v=` cache-busters, every `files.json`/hash, and `installer.html` — then runs `validate-versions.py` and shows the result. If nothing changed somewhere, the output is byte-identical (no noise in git). All that's left is to commit and push to `main`.

### Useful tools

```bash
python tools/validate-versions.py      # version consistency across the whole repo
python tools/validate-lang.py          # FR/EN dictionary symmetry
node tools/test-lang.cjs               # runtime tests on translations
python tools/release.py                # the one command: syncs everything and rebuilds installer.html
python tools/upack.py pack|verify|unpack ...   # .upack container (export/import)
python skills/usbos-app/validate.py USBos/apps/<id>/   # validate a new app
```

### Known limitations

- Update descriptors (`files.json`/`version.json`) are hash-verified but **not cryptographically signed** — update security relies on the trust placed in the configured update source repository.
- File names publishable in an update are restricted to `A-Za-z0-9._-/` (no spaces or accents).
- Log export (`usbos.logs.export()`) produces a plain-text file — anonymize it before sharing it in a bug report.

## Contributing

Feedback, bug reports, and app ideas are welcome via the repo's **Issues**. To propose a new app, start with `skills/usbos-app/SKILL.md`.