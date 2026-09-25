#!/usr/bin/env python3
"""
USBos — tools/gen_files_json.py

Génère les descripteurs exigés par system/updater.js pour UN composant
(le noyau ou une app) en vue de leur publication sur un dépôt GitHub public.

Usage :
    python tools/gen_files_json.py USBos/system --version 2.2.1
    python tools/gen_files_json.py USBos/apps/notes

Le script écrit (ou met à jour) dans le dossier du composant :
    version.json   { "version": "x.y.z" }  (ou {"kernel": "x.y.z"} pour system)
    files.json     { "files": { "<chemin relatif>": "<sha256 hex>", ... } }

Les chemins sont relatifs à la racine du composant, avec des "/" POSIX.
version.json et files.json eux-mêmes sont exclus des hash (ils décriraient
leur propre contenu, ce qui serait instable).

Contrat avec l'updater :
  - composant "system"  -> baseUrl/version.json { "version" }, fichiers
    appliqués sous system: (localPrefix "") ;
  - composant "apps/<id>" -> baseUrl/version.json { "version" }, fichiers
    appliqués sous apps:<id>/ (localPrefix "<id>/").

Note version.json noyau : le local system/version.json utilise
{"kernel", "schema"} ; le publié exige {"version"}. On écrit les trois
clés {"kernel", "schema", "version"} (miroir) pour satisfaire les deux
lecteurs ; l'updater préserve le schéma par merge à l'application.
"""
import hashlib
import json
import os
import pathlib
import re
import sys

SKIP_NAMES = {"version.json", "files.json", ".DS_Store", "Thumbs.db"}
SKIP_SUFFIXES = (".log", ".tmp", ".bak")
SKIP_DIRS = {".git", "node_modules", "__pycache__", "dist"}
SKIP_EXT_SPECIAL = {".pem"}
REL_RE = re.compile(r"^[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)*$")
SEMVER_RE = re.compile(r"^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$")
MAX_FILE_BYTES = 50 * 1024 * 1024


def atomic_write(path: pathlib.Path, text: str) -> None:
    # newline="\n" : LF forcé même sous Windows, sinon les hash files.json
    # (calculés sur l'arbre) divergent des blobs servis (LF normalisé).
    tmp = path.with_name(path.name + ".tmp")
    with tmp.open("w", encoding="utf-8", newline="\n") as f:
        f.write(text)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


def dump_canonical(obj) -> str:
    return json.dumps(obj, indent=2, sort_keys=True, ensure_ascii=False) + "\n"


def sha256_file(path: pathlib.Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def main(argv: list) -> int:
    if len(argv) < 1:
        print(__doc__)
        return 2
    comp = pathlib.Path(argv[0])
    if not comp.is_dir():
        print(f"Erreur : dossier introuvable : {comp}")
        return 1

    version = None
    rest = argv[1:]
    i = 0
    while i < len(rest):
        a = rest[i]
        if a.startswith("--version="):
            version = a.split("=", 1)[1]
        elif a == "--version" and i + 1 < len(rest):
            version = rest[i + 1]
            i += 1
        i += 1

    is_kernel = comp.resolve().name == "system" and comp.parent.name != "apps"
    version_path = comp / "version.json"

    if version is None:
        try:
            current = json.loads(version_path.read_text(encoding="utf-8"))
            version = current.get("kernel" if is_kernel else "version") or current.get("version" if is_kernel else "kernel")
        except (OSError, ValueError):
            version = None
        if not version:
            print("Erreur : précisez --version x.y.z (aucune version existante trouvée).")
            return 1

    if not SEMVER_RE.match(version):
        print(f"Erreur : version invalide (semver x.y.z attendu) : {version}")
        return 1

    # Écritures AVANT hachage : version.json + manifest.json sont mutés ici,
    # donc leurs hash doivent être calculés après (sinon files.json fige
    # l'ancien contenu et l'updater refuse la bascule pour "Bad hash").
    if is_kernel:
        schema = 1
        try:
            exist = json.loads(version_path.read_text(encoding="utf-8"))
            if isinstance(exist.get("schema"), int):
                schema = exist["schema"]
        except (OSError, ValueError):
            pass
        atomic_write(version_path, dump_canonical({"kernel": version, "schema": schema, "version": version}))
    else:
        atomic_write(version_path, dump_canonical({"version": version}))
        # Synchronise manifest.json (affiché dans la sidebar).
        manifest = comp / "manifest.json"
        try:
            m = json.loads(manifest.read_text(encoding="utf-8"))
            if m.get("version") != version:
                m["version"] = version
                atomic_write(manifest, dump_canonical(m))
                print(f"manifest.json synchronisé à {version}.")
        except (OSError, ValueError) as err:
            print(f"Avertissement : manifest.json non synchronisé ({err}).")

    files = {}
    for p in sorted(comp.rglob("*")):
        if p.is_symlink():
            continue
        if not p.is_file():
            continue
        rel = p.relative_to(comp).as_posix()
        parts = rel.split("/")
        if any(d in SKIP_DIRS for d in parts[:-1]):
            continue
        if rel.split("/")[-1] in SKIP_NAMES:
            continue
        name = rel.rsplit("/", 1)[-1]
        if name.startswith("."):
            continue
        if name == ".env" or p.suffix == ".pem":
            continue
        if rel.endswith(SKIP_SUFFIXES):
            continue
        if not REL_RE.match(rel):
            print(f"Erreur : chemin non publiable (caractères interdits) : {rel}")
            return 1
        size = p.stat().st_size
        if size > MAX_FILE_BYTES:
            print(f"Erreur : fichier trop volumineux (>50 Mo) : {rel}")
            return 1
        files[rel] = sha256_file(p)

    atomic_write(comp / "files.json", dump_canonical({"version": version, "files": files}))
    print(f"{comp} : version {version}, {len(files)} fichier(s) hachés -> files.json.")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
