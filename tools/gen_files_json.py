#!/usr/bin/env python3
"""
USBos — tools/gen_files_json.py

Génère les descripteurs exigés par system/updater.js pour UN composant
(le noyau ou une app) en vue de leur publication sur un dépôt GitHub public.

Usage :
    python tools/gen_files_json.py USBos/system --version 2.2.1
    python tools/gen_files_json.py USBos/apps/notes

En pratique, tu n'as presque jamais besoin d'appeler ce script toi-même :
utilise `python tools/release.py`, qui l'appelle pour tous les composants
automatiquement. Ce script reste utile pour régénérer UN seul composant
en isolation (debug, script externe).

Le script écrit (ou met à jour) dans le dossier du composant :
    version.json   { "version": "x.y.z" }  (ou {"kernel": "x.y.z"} pour system)
    files.json     { "files": { "<chemin relatif>": "<sha256 hex>", ... } }

Les chemins sont relatifs à la racine du composant, avec des "/" POSIX.
version.json et files.json eux-mêmes sont exclus des hash (ils décriraient
leur propre contenu, ce qui serait instable).

Source de vérité pour la version :
  - noyau (system/)   -> const KERNEL_VERSION dans kernel.js (system/version.json
    est un MIROIR, tenu à jour par make_installer.py / tools/release.py).
  - une app (apps/<id>/) -> le champ "version" de manifest.json. version.json
    est un miroir généré ici, jamais édité à la main.
  --version force une valeur explicite (prioritaire sur la source ci-dessus)
  et resynchronise le fichier source correspondant.

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


def generate(comp: pathlib.Path, version: str = None) -> int:
    """Régénère version.json + files.json pour UN composant. Retourne 0/1.

    version=None : lit la source de vérité (KERNEL_VERSION déjà répercuté
    dans system/version.json pour le noyau via sync_versions ; manifest.json
    pour une app). Passe une valeur explicite pour forcer/bumper.
    """
    if not comp.is_dir():
        print(f"Erreur : dossier introuvable : {comp}")
        return 1

    is_kernel = comp.resolve().name == "system" and comp.parent.name != "apps"
    version_path = comp / "version.json"
    manifest_path = comp / "manifest.json"

    if version is None:
        if is_kernel:
            # Le noyau n'a pas de manifest.json : sa source de vérité est
            # KERNEL_VERSION (kernel.js), déjà répercuté dans version.json
            # par make_installer.sync_versions() avant l'appel à generate().
            try:
                version = json.loads(version_path.read_text(encoding="utf-8")).get("kernel")
            except (OSError, ValueError):
                version = None
        else:
            # Source de vérité d'une app : manifest.json (un seul endroit
            # à éditer). version.json n'est qu'un miroir généré ici.
            try:
                version = json.loads(manifest_path.read_text(encoding="utf-8")).get("version")
            except (OSError, ValueError):
                version = None
            if not version:
                try:
                    version = json.loads(version_path.read_text(encoding="utf-8")).get("version")
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
        # Synchronise manifest.json (source de vérité normalement déjà à
        # jour ; ce chemin ne sert qu'avec un --version explicite qui
        # diverge de ce que contenait manifest.json).
        try:
            m = json.loads(manifest_path.read_text(encoding="utf-8"))
            if m.get("version") != version:
                m["version"] = version
                atomic_write(manifest_path, dump_canonical(m))
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


def main(argv: list) -> int:
    if len(argv) < 1:
        print(__doc__)
        return 2
    comp = pathlib.Path(argv[0])

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

    return generate(comp, version)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))