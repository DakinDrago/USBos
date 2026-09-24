#!/usr/bin/env python3
"""
USBos app validator — `python validate.py USBos/apps/<id>/`.

Static checks against skills/usbos-app/contract.md. Exit 0 only if no FAIL
(warnings are advisory). Also used in CI.
"""
import json
import pathlib
import re
import sys

SEMVER = re.compile(r"^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$")
ID_RE = re.compile(r"^[a-z0-9-]{1,64}$", re.IGNORECASE)
HEX_RE = re.compile(r"#[0-9a-fA-F]{6}\b")
FORBIDDEN_CALLS = ["prompt(", "confirm(", "alert("]

results = []  # (level, rule, detail)


def check(rule, ok, detail=""):
    results.append(("PASS" if ok else "FAIL", rule, detail))


def main(argv):
    if len(argv) != 1:
        print("usage: validate.py USBos/apps/<id>/")
        return 2
    root = pathlib.Path(argv[0])
    if not root.is_dir():
        print(f"not a directory: {root}")
        return 2

    # ---- manifest ----
    manifest_path = root / "manifest.json"
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        manifest_ok = True
    except (OSError, ValueError) as err:
        check(False, "manifest", False, f"unreadable: {err}")
        manifest, manifest_ok = {}, False
    if manifest_ok:
        check("manifest", manifest.get("id") == root.name,
              f"id={manifest.get('id')!r} vs folder={root.name!r}")
        check("manifest-id",
              bool(ID_RE.match(str(manifest.get("id") or ""))),
              "id must match ^[a-z0-9-]{1,64}$")
        for field in ("name", "description", "icon"):
            if manifest.get(field):
                check(f"manifest-{field}", True, "")
            else:
                results.append(("WARN", f"manifest-{field}", "missing (recommended)"))
        check("manifest-version", bool(SEMVER.match(str(manifest.get("version") or ""))),
              f"version={manifest.get('version')!r}")
        entry = manifest.get("entry", "index.js")
        check("manifest-entry", (root / entry).is_file(), f"entry={entry!r}")

    # ---- version.json sync ----
    version_path = root / "version.json"
    try:
        version = json.loads(version_path.read_text(encoding="utf-8")).get("version")
        check("version-sync", version == manifest.get("version"),
              f"version.json={version!r} vs manifest={manifest.get('version')!r}")
    except (OSError, ValueError) as err:
        check("version-sync", False, f"unreadable: {err}")

    # ---- index.js static checks ----
    entry = manifest.get("entry", "index.js") if manifest_ok else "index.js"
    code_path = root / entry
    try:
        code = code_path.read_text(encoding="utf-8")
    except OSError as err:
        check("index-readable", False, str(err))
        code = ""
    if code:
        code_nocomments = re.sub(r"/\*.*?\*/", "", code, flags=re.S)
        code_nocomments = re.sub(r"(?m)^[ \t]*//.*$", "", code_nocomments)
        code_nocomments = re.sub(r"[ \t]//[^:\n]*$", "", code_nocomments)
        check("no-esm", not re.search(r"^\s*(import\s|export\s)", code, re.M),
              "ES modules forbidden (classic script + top-level return)")
        check("has-return", bool(re.search(r"^return\s+USBosApp\s*;", code, re.M)),
              "must end with top-level `return USBosApp;`")
        check("has-mount", "mount(" in code, "mount(ctx, stage) required")
        check("has-unmount", "unmount(" in code, "unmount() required")
        for call in FORBIDDEN_CALLS:
            check(f"no-{call[:-1]}", call not in code_nocomments,
                  f"{call} is blocking / sandbox-hostile — use inline UI")
        check("no-same-origin", "allow-same-origin" not in code,
              "would break iframe isolation")
        check("no-parent-escape",
              not re.search(r"""['"]\.\.(/|\\|$)""", code),
              "hardcoded '..' paths are rejected by the kernel bridge")
        check("no-top-navigation", "allow-top-navigation" not in code,
              "would break iframe isolation")
        hexes = set(HEX_RE.findall(code))
        if hexes:
            results.append(("WARN", "theme-vars",
                            f"hardcoded hex {sorted(hexes)[:5]} — use var(--panel)… so themes apply"))
        else:
            results.append(("PASS", "theme-vars", ""))
        if "randomUUID" in code and "getRandomValues" not in code:
            results.append(("WARN", "uuid-fallback",
                            "crypto.randomUUID without getRandomValues fallback (non-secure contexts)"))
        else:
            results.append(("PASS", "uuid-fallback", ""))
        if len(code.encode("utf-8")) > 512 * 1024:
            results.append(("WARN", "size", "index.js > 512 KB — consider vendor/ splitting"))
        else:
            results.append(("PASS", "size", ""))

    fails = [r for r in results if r[0] == "FAIL"]
    warns = [r for r in results if r[0] == "WARN"]
    passes = [r for r in results if r[0] == "PASS"]
    for level, rule, detail in results:
        if level == "PASS" and not detail:
            continue
        print(f"{level:5} {rule}" + (f" — {detail}" if detail else ""))
    print(f"\n{len(passes)} passed, {len(warns)} warnings, {len(fails)} failures "
          f"for {root}")
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
