#!/usr/bin/env python3
"""
USBos — tools/uapp.py

Construit un paquet .uapp (ZIP standard renommé) à partir d'un dossier
d'app — pour la distribution d'une app tierce, HORS du monorepo officiel
(les 7 apps intégrées, elles, sont livrées par l'updater normal, jamais
par .uapp — voir BUILTIN_APP_IDS dans kernel.js).

Le format n'a RIEN d'exotique : n'importe quel outil de compression ZIP
(y compris "Compresser" dans l'explorateur de fichiers, sur n'importe quel
OS) produit un fichier que le lecteur (system/uapp.js) accepte, tant que
le dossier compressé contient bien manifest.json + lang/fr.json +
lang/en.json à sa racine (ou dans un unique dossier englobant — le lecteur
le retire automatiquement).

Usage :
    python tools/uapp.py pack   apps/mon-app mon-app.uapp
    python tools/uapp.py verify mon-app.uapp
    python tools/uapp.py unpack mon-app.uapp --out /tmp/mon-app

La validation de « verify » est volontairement plus stricte que le strict
nécessaire pour lire le ZIP : elle applique les mêmes règles que le noyau
(system/uapp.js) va appliquer à l'installation, pour repérer les soucis
AVANT de distribuer le paquet plutôt qu'après.
"""
import hashlib
import json
import pathlib
import re
import sys
import zipfile

ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")
RESERVED_IDS = {"system", "shell", "console", "config", "data", "shared", "update", "root", "kernel", "usbos", "apps"}
SEG_RE = re.compile(r"^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$")
SEMVER_RE = re.compile(r"^\d+(?:\.\d+)+(?:-[0-9A-Za-z.-]+)?$")
SKIP_NAMES = {".DS_Store", "Thumbs.db", "desktop.ini"}
MAX_PACKAGE = 40 * 1024 * 1024
MAX_FILE = 25 * 1024 * 1024
MAX_TOTAL = 60 * 1024 * 1024
MAX_ENTRIES = 300


def sha256_file(path: pathlib.Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for b in iter(lambda: f.read(65536), b""):
            h.update(b)
    return h.hexdigest()


def iter_source_files(src: pathlib.Path):
    for p in sorted(src.rglob("*")):
        if p.is_symlink() or not p.is_file():
            continue
        if p.name in SKIP_NAMES or p.name.startswith("._"):
            continue
        rel = p.relative_to(src).as_posix()
        for seg in rel.split("/"):
            if not SEG_RE.match(seg):
                raise SystemExit(f"Erreur : nom de fichier non publiable dans un .uapp : {rel!r} (segment {seg!r})")
        yield rel, p


def cmd_pack(src_dir: str, out_path: str) -> int:
    src = pathlib.Path(src_dir)
    if not src.is_dir():
        print(f"Erreur : dossier introuvable : {src}")
        return 1
    manifest_path = src / "manifest.json"
    if not manifest_path.is_file():
        print("Erreur : manifest.json absent du dossier source.")
        return 1
    for code in ("fr", "en"):
        if not (src / "lang" / f"{code}.json").is_file():
            print(f"Erreur : lang/{code}.json absent — chaque app porte ses traductions (règle USBos).")
            return 1

    files = list(iter_source_files(src))
    if not files:
        print("Erreur : dossier source vide.")
        return 1
    if len(files) > MAX_ENTRIES:
        print(f"Erreur : trop de fichiers ({len(files)} > {MAX_ENTRIES}).")
        return 1
    total = 0
    for rel, p in files:
        size = p.stat().st_size
        if size > MAX_FILE:
            print(f"Erreur : fichier trop volumineux (>25 Mo) : {rel}")
            return 1
        total += size
    if total > MAX_TOTAL:
        print(f"Erreur : contenu total trop volumineux (>60 Mo) : {total} octets.")
        return 1

    out = pathlib.Path(out_path)
    tmp = out.with_suffix(out.suffix + ".tmp")
    with zipfile.ZipFile(tmp, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for rel, p in files:
            zi = zipfile.ZipInfo(rel, date_time=(1980, 1, 1, 0, 0, 0))  # horodatage stable -> paquet reproductible
            zi.external_attr = (0o100644 << 16)  # fichier régulier, permissions ordinaires
            with p.open("rb") as f:
                z.writestr(zi, f.read())
    tmp.replace(out)

    size_out = out.stat().st_size
    if size_out > MAX_PACKAGE:
        out.unlink(missing_ok=True)
        print(f"Erreur : paquet final trop volumineux (>{MAX_PACKAGE // 1024 // 1024} Mo) : {size_out} octets.")
        return 1
    print(f"{out} : {len(files)} fichier(s), {size_out} octets, sha256={sha256_file(out)}")
    return 0


def _validate_manifest(m: dict, present: set) -> list:
    errs = []
    if not isinstance(m, dict):
        return ["manifest.json n'est pas un objet"]
    mid = m.get("id")
    if not isinstance(mid, str) or not ID_RE.match(mid):
        errs.append(f"id invalide : {mid!r}")
    elif mid in RESERVED_IDS:
        errs.append(f"id réservé : {mid!r}")
    name = m.get("name")
    if not isinstance(name, str) or not name.strip() or len(name) > 60:
        errs.append(f"name invalide : {name!r}")
    version = m.get("version")
    if not isinstance(version, str) or not SEMVER_RE.match(version):
        errs.append(f"version invalide (semver attendu) : {version!r}")
    entry = m.get("entry")
    if not isinstance(entry, str) or not entry.endswith(".js"):
        errs.append(f"entry invalide (doit finir par .js) : {entry!r}")
    elif entry not in present:
        errs.append(f"entry absent du paquet : {entry!r}")
    csp = m.get("csp")
    if csp is not None:
        if not isinstance(csp, dict):
            errs.append("csp invalide (objet attendu)")
        else:
            cs = csp.get("connectSrc")
            if cs is not None:
                if not isinstance(cs, list) or len(cs) > 10:
                    errs.append("csp.connectSrc invalide (liste de 10 entrées max)")
                else:
                    host_re = re.compile(r"^(?:https|wss)://(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9](?::[0-9]{1,5})?$")
                    for v in cs:
                        if not isinstance(v, str) or not host_re.match(v):
                            errs.append(f"csp.connectSrc : hôte refusé (doit être https:// ou wss://, pas de joker) : {v!r}")
    return errs


def cmd_verify(uapp_path: str) -> int:
    p = pathlib.Path(uapp_path)
    if not p.is_file():
        print(f"Erreur : fichier introuvable : {p}")
        return 1
    if p.stat().st_size > MAX_PACKAGE:
        print(f"Erreur : paquet trop volumineux (>{MAX_PACKAGE // 1024 // 1024} Mo).")
        return 1
    try:
        z = zipfile.ZipFile(p)
    except zipfile.BadZipFile as err:
        print(f"Erreur : pas un ZIP valide ({err}).")
        return 1

    bad = z.testzip()
    if bad:
        print(f"Erreur : CRC invalide sur {bad!r}.")
        return 1

    names = [n for n in z.namelist() if not n.endswith("/")]
    names = [n for n in names if pathlib.PurePosixPath(n).name not in SKIP_NAMES and not pathlib.PurePosixPath(n).name.startswith("._") and not n.startswith("__MACOSX/")]
    if not names:
        print("Erreur : paquet sans fichier.")
        return 1

    # Dossier englobant unique -> on le retire pour la suite des vérifs (miroir du lecteur JS).
    strip = ""
    if "manifest.json" not in names:
        tops = {n.split("/", 1)[0] for n in names}
        if len(tops) == 1 and all("/" in n for n in names):
            strip = next(iter(tops)) + "/"
    rel_names = {(n[len(strip):] if strip else n) for n in names}

    errs = []
    for rel in rel_names:
        if ".." in rel.split("/") or rel.startswith("/") or "\\" in rel:
            errs.append(f"chemin illégal : {rel!r}")
        for seg in rel.split("/"):
            if not SEG_RE.match(seg):
                errs.append(f"segment de chemin illégal : {seg!r} (dans {rel!r})")
                break
    if len(rel_names) != len({n.lower() for n in rel_names}):
        errs.append("collision de chemins insensible à la casse (problème sur clé FAT/exFAT)")
    if "manifest.json" not in rel_names:
        errs.append("manifest.json absent")
    if "lang/fr.json" not in rel_names:
        errs.append("lang/fr.json absent — chaque app porte ses traductions")
    if "lang/en.json" not in rel_names:
        errs.append("lang/en.json absent — chaque app porte ses traductions")

    manifest = None
    if "manifest.json" not in errs and "manifest.json" in rel_names:
        try:
            raw = z.read(strip + "manifest.json" if strip else "manifest.json")
            manifest = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as err:
            errs.append(f"manifest.json illisible ({err})")
    if manifest is not None:
        errs.extend(_validate_manifest(manifest, rel_names))
    for code in ("fr", "en"):
        key = f"lang/{code}.json"
        if key in rel_names:
            try:
                obj = json.loads(z.read(strip + key if strip else key).decode("utf-8"))
                if not isinstance(obj, dict):
                    errs.append(f"{key} n'est pas un objet")
            except (UnicodeDecodeError, json.JSONDecodeError) as err:
                errs.append(f"{key} illisible ({err})")

    if errs:
        print(f"{p} : INVALIDE")
        for e in errs:
            print(f"  - {e}")
        return 1
    print(f"{p} : valide — app {manifest['id']!r} v{manifest['version']} ({len(rel_names)} fichier(s), sha256={sha256_file(p)})")
    return 0


def cmd_unpack(uapp_path: str, out_dir: str) -> int:
    p = pathlib.Path(uapp_path)
    out = pathlib.Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(p) as z:
        for info in z.infolist():
            if info.is_dir():
                continue
            rel = info.filename
            if ".." in pathlib.PurePosixPath(rel).parts or rel.startswith("/") or "\\" in rel:
                print(f"Erreur : chemin illégal ignoré : {rel!r}")
                continue
            dest = out / rel
            dest.parent.mkdir(parents=True, exist_ok=True)
            with z.open(info) as src, dest.open("wb") as dst:
                dst.write(src.read())
    print(f"Extrait dans {out}")
    return 0


def main(argv: list) -> int:
    if len(argv) < 1 or argv[0] not in ("pack", "unpack", "verify"):
        print(__doc__)
        return 2
    cmd = argv[0]
    if cmd == "pack":
        if len(argv) < 3:
            print("Usage : python tools/uapp.py pack <dossier_app> <sortie.uapp>")
            return 2
        return cmd_pack(argv[1], argv[2])
    if cmd == "verify":
        if len(argv) < 2:
            print("Usage : python tools/uapp.py verify <fichier.uapp>")
            return 2
        return cmd_verify(argv[1])
    if cmd == "unpack":
        if len(argv) < 2:
            print("Usage : python tools/uapp.py unpack <fichier.uapp> [--out DIR]")
            return 2
        out_dir = argv[3] if len(argv) >= 4 and argv[2] == "--out" else str(pathlib.Path(argv[1]).with_suffix(""))
        return cmd_unpack(argv[1], out_dir)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))