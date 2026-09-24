#!/usr/bin/env python3
"""
USBos — tools/validate-versions.py

Garde-fou anti-divergence des numéros de version (source unique :
KERNEL_VERSION dans USBos/system/kernel.js).
Usage :  python tools/validate-versions.py
Exit 0 only if no FAIL.

Règles :
  kernel-sync      KERNEL_VERSION == USBos/system/version.json["kernel"]
  index-cachebust  tous les ?v= de USBos/index.html == KERNEL_VERSION
  app-sync         apps/<id>/manifest.json["version"] == apps/<id>/version.json["version"]
  semver           chaque version lue est au format x.y.z
"""
import json
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).parent.parent
KERNEL_JS = ROOT / "USBos" / "system" / "kernel.js"
KERNEL_VERSION_JSON = ROOT / "USBos" / "system" / "version.json"
INDEX_HTML = ROOT / "USBos" / "index.html"
APPS_DIR = ROOT / "USBos" / "apps"

SEMVER_RE = re.compile(r"^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$")
KERNEL_RE = re.compile(r"const\s+KERNEL_VERSION\s*=\s*['\"]([^'\"]+)['\"]")
CACHEBUST_RE = re.compile(r"""(?:src|href)="system/[^"]+?\?v=([^"&\s]+)""")

results = []  # (level, rule, detail)


def check(rule, ok, detail=""):
    results.append(("PASS" if ok else "FAIL", rule, detail))


def main() -> int:
    try:
        kernel_src = KERNEL_JS.read_text(encoding="utf-8")
    except OSError as err:
        print(f"FAIL kernel-sync : kernel.js illisible ({err})")
        return 1
    m = KERNEL_RE.search(kernel_src)
    kernel_v = m.group(1) if m else None
    check("kernel-found", kernel_v is not None,
          f"KERNEL_VERSION={kernel_v}" if kernel_v else "const KERNEL_VERSION introuvable")
    check("kernel-semver", bool(kernel_v and SEMVER_RE.match(kernel_v)),
          kernel_v or "absente")

    try:
        vjson = json.loads(KERNEL_VERSION_JSON.read_text(encoding="utf-8"))
        json_v = vjson.get("kernel")
    except (OSError, ValueError) as err:
        json_v = None
        check("kernel-sync", False, f"version.json illisible ({err})")
    if json_v is not None or kernel_v is not None:
        # Ne signaler qu'une fois si version.json était illisible.
        if not any(r[1] == "kernel-sync" for r in results):
            check("kernel-sync", json_v == kernel_v,
                  f"version.json={json_v} vs kernel.js={kernel_v}")

    try:
        index_src = INDEX_HTML.read_text(encoding="utf-8")
    except OSError as err:
        index_src = None
        check("index-cachebust", False, f"index.html illisible ({err})")
    if index_src is not None:
        found = CACHEBUST_RE.findall(index_src)
        check("index-found", bool(found),
              f"{len(found)} asset(s) versionné(s)" if found else "aucun ?v= system/ trouvé")
        bad = sorted({v for v in found if v != kernel_v})
        check("index-cachebust", not bad,
              f"?v= divergents : {bad}" if bad else f"tous à ?v={kernel_v}")

    app_dirs = sorted(p for p in APPS_DIR.iterdir() if p.is_dir()) if APPS_DIR.is_dir() else []
    check("apps-found", bool(app_dirs),
          f"{len(app_dirs)} app(s)" if app_dirs else "aucune app trouvée")
    for app in app_dirs:
        try:
            manifest_v = json.loads((app / "manifest.json").read_text(encoding="utf-8")).get("version")
        except (OSError, ValueError) as err:
            check("app-sync", False, f"{app.name} : manifest.json illisible ({err})")
            continue
        try:
            file_v = json.loads((app / "version.json").read_text(encoding="utf-8")).get("version")
        except (OSError, ValueError) as err:
            check("app-sync", False, f"{app.name} : version.json illisible ({err})")
            continue
        ok = manifest_v == file_v and bool(manifest_v and SEMVER_RE.match(manifest_v))
        check("app-sync", ok,
              f"{app.name} : manifest={manifest_v} vs version.json={file_v}"
              if not ok else f"{app.name}={manifest_v}")

    fails = [r for r in results if r[0] == "FAIL"]
    for level, rule, detail in results:
        print(f"{level} {rule}" + (f" : {detail}" if detail else ""))
    print(f"{len(results) - len(fails)}/{len(results)} PASS" + (f", {len(fails)} FAIL" if fails else ""))
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
