#!/usr/bin/env python3
"""
USBos — format conteneur .upack v1 + référence Python.

Un .upack est UN fichier unique auto-décrit pour transporter un gros
fichier par morceaux (Mesh chunké, import Galerie) sans jamais tenir
l'ensemble en RAM plus que nécessaire :

  offset  contenu
  0       magic b'USBOS1' (6 octets)
  6       longueur de l'en-tête JSON, uint32 big-endian
  10      en-tête JSON (utf-8) :
          {"v":1,"name":"film.mp4","mime":"video/mp4","size":123456,
           "chunk":1048576,"hashes":["<sha256 hex>", ...],"sha":"<sha256 hex>"}
  10+N    morceaux concaténés (chunk octets chacun, sauf le dernier)

Règles :
  - len(hashes) == ceil(size / chunk), chaque morceau est vérifié par son
    sha256 avant usage ; "sha" couvre le fichier d'origine reconstitué.
  - Extensions : seul ".upack" (insensible à la casse) est reconnu.
  - Implémentation JS miroir : USBos/system/upack.js (copié en vendor/ dans
    les apps qui en ont besoin : mesh, gallery). Les deux doivent rester
    compatibles — voir tools/test-upack.cjs (roundtrip JS) et le contrôle
    croisé Python <-> JS ci-dessous.

Usage :
    python tools/upack.py pack  film.mp4 film.upack [--chunk 1048576]
    python tools/upack.py unpack film.upack [--out DIR]
    python tools/upack.py verify film.upack
"""
import hashlib
import json
import pathlib
import sys

MAGIC = b"USBOS1"
VERSION = 1
DEFAULT_CHUNK = 1024 * 1024
MAX_CHUNKS = 100000


def sha256_file(path: pathlib.Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for b in iter(lambda: f.read(65536), b""):
            h.update(b)
    return h.hexdigest()


def guess_mime(name: str) -> str:
    ext = name.rsplit(".", 1)[-1].lower() if "." in name else ""
    return {
        "jpg": "image/jpeg", "jpeg": "image/jpeg", "png": "image/png",
        "webp": "image/webp", "gif": "image/gif",
        "mp4": "video/mp4", "webm": "video/webm", "mkv": "video/x-matroska",
        "mov": "video/quicktime", "avi": "video/x-msvideo",
        "mp3": "audio/mpeg", "wav": "audio/wav", "ogg": "audio/ogg",
        "flac": "audio/flac", "m4a": "audio/mp4",
    }.get(ext, "application/octet-stream")


def check_ext(path: pathlib.Path) -> None:
    if path.suffix.lower() != ".upack":
        raise SystemExit(f"Extension refusée ('.upack' attendu) : {path.name}")


def cmd_pack(src: str, dst: str, chunk: int, mime: str | None) -> int:
    src_p, dst_p = pathlib.Path(src), pathlib.Path(dst)
    check_ext(dst_p)
    if chunk <= 0 or chunk > 64 * 1024 * 1024:
        raise SystemExit("chunk doit valoir 1..67108864 octets.")
    size = src_p.stat().st_size
    n = (size + chunk - 1) // chunk if size else 1
    if n > MAX_CHUNKS:
        raise SystemExit(f"Trop de morceaux ({n}, max {MAX_CHUNKS}) : augmentez --chunk.")
    hashes = []
    with src_p.open("rb") as f:
        while True:
            b = f.read(chunk)
            if not b:
                break
            hashes.append(hashlib.sha256(b).hexdigest())
    if size == 0:
        hashes = [hashlib.sha256(b"").hexdigest()]
    header = {
        "v": VERSION,
        "name": src_p.name,
        "mime": mime or guess_mime(src_p.name),
        "size": size,
        "chunk": chunk,
        "hashes": hashes,
        "sha": sha256_file(src_p),
    }
    hbytes = json.dumps(header, separators=(",", ":")).encode("utf-8")
    with src_p.open("rb") as fin, dst_p.open("wb") as fout:
        fout.write(MAGIC)
        fout.write(len(hbytes).to_bytes(4, "big"))
        fout.write(hbytes)
        while True:
            b = fin.read(65536)
            if not b:
                break
            fout.write(b)
    print(f"{dst_p.name} : {src_p.name} ({size} o, {len(hashes)} morceau(x)) -> OK")
    return 0


def read_upack(path: pathlib.Path):
    """Retourne (header: dict, offset_donnees: int). Lève SystemExit si invalide."""
    check_ext(path)
    with path.open("rb") as f:
        if f.read(len(MAGIC)) != MAGIC:
            raise SystemExit(f"Magic invalide (pas un .upack) : {path.name}")
        raw_len = f.read(4)
        if len(raw_len) != 4:
            raise SystemExit(f"Fichier tronqué (longueur) : {path.name}")
        hlen = int.from_bytes(raw_len, "big")
        if hlen <= 0 or hlen > 1024 * 1024:
            raise SystemExit(f"En-tête suspect ({hlen} o) : {path.name}")
        try:
            header = json.loads(f.read(hlen).decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            raise SystemExit(f"En-tête illisible : {path.name}")
    if not isinstance(header, dict) or header.get("v") != VERSION:
        raise SystemExit(f"Version non supportée : {path.name}")
    for k in ("name", "mime", "size", "chunk", "hashes", "sha"):
        if k not in header:
            raise SystemExit(f"En-tête incomplet ({k}) : {path.name}")
    if (not isinstance(header.get("chunk"), int) or header["chunk"] <= 0
            or header["chunk"] > 64 * 1024 * 1024):
        raise SystemExit(f"En-tête incohérent (chunk) : {path.name}")
    if not isinstance(header.get("size"), int) or header["size"] < 0:
        raise SystemExit(f"En-tête incohérent (size) : {path.name}")
    expect = (header["size"] + header["chunk"] - 1) // header["chunk"] if header["size"] else 1
    if (not isinstance(header.get("hashes"), list) or len(header["hashes"]) != expect
            or len(header["hashes"]) > MAX_CHUNKS):
        raise SystemExit(f"En-tête incohérent (hashes) : {path.name}")
    return header, 6 + 4 + hlen


def cmd_verify(upack: str) -> int:
    path = pathlib.Path(upack)
    header, off = read_upack(path)
    if header["size"] == 0:
        empty = hashlib.sha256(b"").hexdigest()
        ok = header["hashes"] == [empty] and header["sha"] == empty
        print(f"{path.name} : {header['name']} (0 o) -> {'OK' if ok else 'CORROMPU'}")
        return 0 if ok else 1
    total = hashlib.sha256()
    idx = 0
    with path.open("rb") as f:
        f.seek(off)
        while True:
            b = f.read(header["chunk"])
            if not b:
                break
            if hashlib.sha256(b).hexdigest() != header["hashes"][idx]:
                print(f"Morceau {idx} CORROMPU.")
                return 1
            total.update(b)
            idx += 1
    if idx != len(header["hashes"]) or total.hexdigest() != header["sha"]:
        print("Contenu INCOMPLET ou sha global invalide.")
        return 1
    print(f"{path.name} : {header['name']} ({header['size']} o, {idx} morceau(x)) -> OK")
    return 0


def cmd_unpack(upack: str, out: str | None) -> int:
    path = pathlib.Path(upack)
    header, off = read_upack(path)
    dest = (pathlib.Path(out) if out else path.parent) / header["name"]
    if dest.exists():
        raise SystemExit(f"Refus d'écraser : {dest}")
    if header["size"] == 0:
        empty = hashlib.sha256(b"").hexdigest()
        if header["hashes"] != [empty] or header["sha"] != empty:
            print("Contenu CORROMPU, extraction annulée.")
            return 1
        dest.write_bytes(b"")
        print(f"{dest.name} (0 o) -> OK")
        return 0
    total = hashlib.sha256()
    idx = 0
    with path.open("rb") as fin, dest.open("wb") as fout:
        fin.seek(off)
        while True:
            b = fin.read(header["chunk"])
            if not b:
                break
            if idx >= len(header["hashes"]) or hashlib.sha256(b).hexdigest() != header["hashes"][idx]:
                dest.unlink(missing_ok=True)
                print(f"Morceau {idx} CORROMPU, extraction annulée.")
                return 1
            total.update(b)
            fout.write(b)
            idx += 1
    if idx != len(header["hashes"]) or total.hexdigest() != header["sha"]:
        dest.unlink(missing_ok=True)
        print("Contenu INCOMPLET ou sha global invalide, extraction annulée.")
        return 1
    print(f"{dest.name} ({header['size']} o) -> OK")
    return 0


def main(argv: list) -> int:
    if len(argv) < 1 or argv[0] not in ("pack", "unpack", "verify"):
        print(__doc__)
        return 2
    cmd = argv[0]
    if cmd == "pack":
        if len(argv) < 3:
            print("Usage : python tools/upack.py pack IN OUT [--chunk N] [--mime TYPE]")
            return 2
        chunk, mime = DEFAULT_CHUNK, None
        i = 3
        while i < len(argv):
            if argv[i] == "--chunk" and i + 1 < len(argv):
                chunk = int(argv[i + 1])
                i += 2
            elif argv[i] == "--mime" and i + 1 < len(argv):
                mime = argv[i + 1]
                i += 2
            else:
                i += 1
        return cmd_pack(argv[1], argv[2], chunk, mime)
    if cmd == "unpack":
        if len(argv) < 2:
            print("Usage : python tools/upack.py unpack IN.upack [--out DIR]")
            return 2
        out = argv[3] if len(argv) > 3 and argv[2] == "--out" else None
        return cmd_unpack(argv[1], out)
    if len(argv) < 2:
        print("Usage : python tools/upack.py verify IN.upack")
        return 2
    return cmd_verify(argv[1])


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
