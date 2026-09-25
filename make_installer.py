#!/usr/bin/env python3
"""
USBos — make_installer.py

Génère installer.html en embarquant l'arborescence complète du dossier
USBos/ (base64 par fichier). L'installeur écrit ensuite CHAQUE fichier
individuellement via la File System Access API (pas un unique blob dumpé
d'un coup), et respecte les règles :
  - crée toujours un sous-dossier "USBos" à l'endroit choisi
  - si "USBos" existe déjà : mode mise à jour, ne touche jamais data/ ni config/
"""
import base64
import hashlib
import json
import pathlib
import re
import sys
from datetime import datetime, timezone

ROOT = pathlib.Path(__file__).parent / "USBos"
TEMPLATE = pathlib.Path(__file__).parent / "_installer_template.html"
OUT = pathlib.Path(__file__).parent / "installer.html"
KERNEL_JS = ROOT / "system" / "kernel.js"
KERNEL_VERSION_JSON = ROOT / "system" / "version.json"
INDEX_HTML = ROOT / "index.html"

# Source de vérité unique : KERNEL_VERSION dans system/kernel.js.
# Le build synchronise version.json ("kernel") et les ?v= d'index.html
# avant d'embarquer, pour qu'un bump ne puisse plus diverger.
KERNEL_RE = re.compile(r"const\s+KERNEL_VERSION\s*=\s*['\"]([^'\"]+)['\"]")
SEMVER_RE = re.compile(r"^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$")
CACHEBUST_RE = re.compile(r"""((?:src|href)="system/[^"]+?)(?:\?v=[^"]*)?(")""")

# Dossiers jamais écrasés par l'installeur en mode mise à jour
PRESERVE_ON_UPDATE = {"data", "config"}

# Fonds d'écran JPG par défaut : déposés dans USBos/config/wallpaper-slides/
# des SOURCES, embarqués tels quels (installés à neuf, jamais écrasés).
# Garde-fous : images vraies (magic bytes), 8 Mo/fichier, 5 Mo au total.
WALLPAPER_SRC_DIR = "config/wallpaper-slides"
WALLPAPER_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".gif"}
WALLPAPER_MAX_FILE = 8 * 1024 * 1024
WALLPAPER_MAX_TOTAL = 5 * 1024 * 1024

# Fichiers isolés (égalité stricte) vs dossiers (préfixe) embarqués dans
# installer.html. data/ (données perso du poste de dev), .update/ (tampon)
# et tout fichier local non distribuable sont EXCLUS pour éviter toute
# fuite de données personnelles. Distinguer égalité/préfixe évite
# qu'un fichier nommé p. ex. "system-evil.js" passe le filtre.
ALLOW_FILES = {"index.html", "config/update-sources.json"}
ALLOW_DIRS = ("system/", "apps/", WALLPAPER_SRC_DIR + "/")
# Plafond total brut embarqué (hors base64), wallpapers déjà plafonnés à part.
MAX_TOTAL = 20 * 1024 * 1024
# Nombre max de fonds d'écran par défaut embarqués.
WALLPAPER_MAX_COUNT = 10
EXCLUDE_NAMES = {".DS_Store", "Thumbs.db"}
EXCLUDE_SUFFIXES = (".log", ".tmp", ".bak")


def _is_image(path: pathlib.Path) -> bool:
    try:
        with path.open("rb") as f:
            head = f.read(12)
    except OSError:
        return False
    if path.suffix.lower() not in WALLPAPER_EXTS:
        return False
    is_gif = head[:3] == b"GIF" and head[3:6] in (b"87a", b"89a")
    return (
        head[:3] == b"\xff\xd8\xff"
        or head[:4] == b"\x89PNG"
        or is_gif
        or (head[:4] == b"RIFF" and head[8:12] == b"WEBP")
    )


def is_allowed(rel: str) -> bool:
    if rel in ALLOW_FILES:
        pass
    elif rel.startswith(ALLOW_DIRS):
        pass
    else:
        return False
    name = rel.rsplit("/", 1)[-1]
    if name in EXCLUDE_NAMES:
        return False
    if name.endswith(EXCLUDE_SUFFIXES):
        return False
    return True


def read_kernel_version() -> str:
    """Lit KERNEL_VERSION depuis system/kernel.js (source de vérité)."""
    try:
        src = KERNEL_JS.read_text(encoding="utf-8")
    except OSError:
        raise SystemExit("Version introuvable : USBos/system/kernel.js illisible.")
    m = KERNEL_RE.search(src)
    if not m or not SEMVER_RE.match(m.group(1)):
        raise SystemExit("Version introuvable : const KERNEL_VERSION = 'x.y.z' absente/invalide.")
    return m.group(1)


def sync_versions(kernel_version: str) -> None:
    """Aligne version.json et les ?v= d'index.html sur KERNEL_VERSION.

    Les fichiers sources sont réécrits sur place (puis embarqués) :
    toute divergence est signalée sur stdout.
    """
    try:
        vobj = json.loads(KERNEL_VERSION_JSON.read_text(encoding="utf-8"))
    except (OSError, ValueError) as err:
        raise SystemExit(f"version.json illisible ({err}).")
    if vobj.get("kernel") != kernel_version:
        print(f"version.json : kernel {vobj.get('kernel')} -> {kernel_version}.")
        vobj["kernel"] = kernel_version
        KERNEL_VERSION_JSON.write_text(
            json.dumps(vobj, indent=2, ensure_ascii=False) + "\n", encoding="utf-8", newline="\n")

    try:
        html = INDEX_HTML.read_text(encoding="utf-8")
    except OSError as err:
        raise SystemExit(f"index.html illisible ({err}).")
    new_html, n = CACHEBUST_RE.subn(
        lambda m: f"{m.group(1)}?v={kernel_version}{m.group(2)}", html)
    if n == 0:
        raise SystemExit("index.html : aucun asset system/ à versionner (?v=).")
    if new_html != html:
        print(f"index.html : {n} asset(s) aligné(s) sur ?v={kernel_version}.")
        INDEX_HTML.write_text(new_html, encoding="utf-8", newline="\n")


def tree_hash(hashes: dict) -> str:
    """Empreinte globale des sources (triées relpath:sha256) — fraîcheur."""
    h = hashlib.sha256()
    for rel in sorted(hashes):
        h.update(f"{rel}:{hashes[rel]}\n".encode("utf-8"))
    return h.hexdigest()


def collect_files():
    files = {}
    hashes = {}
    wall_total = 0
    wall_count = 0
    raw_total = 0
    for p in sorted(ROOT.rglob("*")):
        if p.is_file():
            rel = p.relative_to(ROOT).as_posix()
            if not is_allowed(rel):
                continue
            if rel.startswith(WALLPAPER_SRC_DIR + "/"):
                wall_count += 1
                if wall_count > WALLPAPER_MAX_COUNT:
                    raise SystemExit(f"Fonds par défaut : {WALLPAPER_MAX_COUNT} max (refusé : {rel}).")
                if not _is_image(p):
                    raise SystemExit(f"Fond refusé (pas une vraie image) : {rel}")
                size = p.stat().st_size
                if size > WALLPAPER_MAX_FILE:
                    raise SystemExit(f"Fond trop lourd (max 8 Mo) : {rel}")
                wall_total += size
                if wall_total > WALLPAPER_MAX_TOTAL:
                    raise SystemExit("Fonds par défaut : 5 Mo au total max.")
            raw = p.read_bytes()
            raw_total += len(raw)
            files[rel] = base64.b64encode(raw).decode("ascii")
            hashes[rel] = hashlib.sha256(raw).hexdigest()
    if raw_total > MAX_TOTAL:
        raise SystemExit(f"Payload trop lourd : {raw_total // 1024} Ko bruts (max {MAX_TOTAL // 1024 // 1024} Mo).")
    return files, hashes, raw_total


def main():
    kernel_version = read_kernel_version()
    sync_versions(kernel_version)
    files, hashes, raw_total = collect_files()
    # Marqueur de fraîcheur : l'installeur affiche noyau + date + hash
    # court, fini les payloads impossibles à dater (vieux noyau réinstallé).
    meta = {
        "kernelVersion": kernel_version,
        "builtAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "treeHash": tree_hash(hashes),
    }
    # preserveOnUpdate gardé dans le payload (compat) ET lu par le gabarit
    # (planInstall s'en sert, défaut ['data', 'config'] si absent).
    payload = {
        "files": files,
        "hashes": hashes,
        "preserveOnUpdate": sorted(PRESERVE_ON_UPDATE),
        "meta": meta,
    }
    template = TEMPLATE.read_text(encoding="utf-8")
    if "__USBOS_PAYLOAD__" not in template:
        raise SystemExit("Gabarit invalide : __USBOS_PAYLOAD__ introuvable.")
    # Échapper "<" en \u003c : neutralise tout "</script>" résiduel et
    # verrouille l'injection JSON dans le <script> du gabarit.
    payload_json = json.dumps(payload, separators=(",", ":")).replace("<", "\\u003c")
    out = template.replace("__USBOS_PAYLOAD__", payload_json)
    OUT.write_text(out, encoding="utf-8", newline="\n")
    total_kb = sum(len(v) for v in files.values()) * 3 // 4 // 1024
    skipped_note = " (data/ et fichiers locaux exclus)"
    print(f"installer.html généré : {len(files)} fichiers, ~{total_kb} Ko encodés"
          f" ({raw_total // 1024} Ko bruts / {MAX_TOTAL // 1024 // 1024} Mo max){skipped_note}.")
    print(f"Contenu : noyau {meta['kernelVersion']} — construit le {meta['builtAt']}"
          f" ({meta['treeHash'][:12]}).")
    if raw_total > MAX_TOTAL * 3 // 4:
        print(f"ALERTE : payload à {raw_total * 100 // MAX_TOTAL} % du plafond de"
              f" {MAX_TOTAL // 1024 // 1024} Mo — pensez à alléger.")


if __name__ == "__main__":
    main()
