#!/usr/bin/env python3
"""
USBos — tools/validate-lang.py

Validateur statique du bilinguisme FR/EN + packs custom.
Usage :  python tools/validate-lang.py
Exit 0 only if no FAIL (warnings are advisory).

Règles :
  dicts-valid      fr.json / en.json lisibles, clés symétriques
  dict-plurals     les objets {one, other} sont complets des deux côtés
  params-shape     les {placeholders} des dicts sont des identifiants simples
  keys-used        chaque t()/tp()/bt()/tx('chemin') du runtime existe dans en.json
  bootstrap-parity BOOTSTRAP_I18N (pré-vfs) == mêmes chemins/valeurs FR des JSON
  installer-sym    le dict STR inline de l'installeur est symétrique FR/EN
  no-hardcoded     aucun français en dur dans les littéraux UI (hors logs,
                   commentaires et bloc BOOTSTRAP documenté)
"""
import json
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).parent.parent
LANG_DIR = ROOT / "USBos" / "system" / "lang"
JS_FILES = [
    ROOT / "USBos" / "system" / "kernel.js",
    ROOT / "USBos" / "system" / "console.js",
    ROOT / "USBos" / "system" / "updater.js",
    ROOT / "USBos" / "system" / "vfs.js",
    *(sorted((ROOT / "USBos" / "apps").glob("*/index.js"))),
]
TEMPLATE = ROOT / "_installer_template.html"

results = []  # (level, rule, detail)


def check(rule, ok, detail=""):
    results.append(("PASS" if ok else "FAIL", rule, detail))


def warn(rule, detail=""):
    results.append(("WARN", rule, detail))


def leaf_keys(obj, prefix, out):
    if isinstance(obj, dict) and not ("one" in obj and "other" in obj):
        for k, v in obj.items():
            leaf_keys(v, f"{prefix}.{k}" if prefix else k, out)
    else:
        out.append(prefix)
    return out


def get_path(obj, path):
    cur = obj
    for part in path.split("."):
        if not isinstance(cur, dict) or part not in cur:
            return None
        cur = cur[part]
    return cur


def decode_js_string(raw):
    """Décode un littéral JS '...' ou "..." (échappements simples)."""
    if len(raw) < 2 or raw[0] not in "'\"" or raw[-1] != raw[0]:
        return None
    q = raw[0]
    body = raw[1:-1]
    out = []
    i = 0
    while i < len(body):
        c = body[i]
        if c == "\\" and i + 1 < len(body):
            n = body[i + 1]
            out.append({"n": "\n", "t": "\t", "r": "\r", "'": "'", '"': '"', "\\": "\\"}.get(n, n))
            i += 2
            continue
        out.append(c)
        i += 1
    return "".join(out)


def main():
    try:
        fr = json.loads((LANG_DIR / "fr.json").read_text(encoding="utf-8"))
        en = json.loads((LANG_DIR / "en.json").read_text(encoding="utf-8"))
    except (OSError, ValueError) as err:
        check("dicts-valid", False, f"unreadable: {err}")
        return report()

    fr_keys = set(leaf_keys(fr, "", []))
    en_keys = set(leaf_keys(en, "", []))
    check("dicts-valid", fr_keys == en_keys,
          "" if fr_keys == en_keys else
          f"missing in en: {sorted(fr_keys - en_keys)[:8]} / missing in fr: {sorted(en_keys - fr_keys)[:8]}")

    # ---- pluriels : mêmes formes des deux côtés ----
    bad = []
    def walk(a, b, prefix):
        if isinstance(a, dict) and ("one" in a or "other" in a):
            if not (isinstance(b, dict) and isinstance(a.get("one"), str) and isinstance(a.get("other"), str)
                    and isinstance(b.get("one"), str) and isinstance(b.get("other"), str)):
                bad.append(prefix)
            return
        if isinstance(a, dict) and isinstance(b, dict):
            for k in a:
                if k in b:
                    walk(a[k], b[k], f"{prefix}.{k}")
    walk(fr, en, "")
    check("dict-plurals", not bad, "" if not bad else f"incomplete plurals: {bad[:8]}")

    # ---- placeholders ----
    # {ident} = interpolation réelle ; le reste ({ confirm: true }, {a, b},
    # guillemets…) est de la doc littérale — seuls les quasi-identifiants
    # cassés ({nom }, {no m}) sont refusés.
    bad_ph = []

    def walk_ph(o, prefix):
        if isinstance(o, dict):
            for k, v in o.items():
                walk_ph(v, f"{prefix}.{k}")
        elif isinstance(o, str):
            for ph in re.findall(r"\{([^}]*)\}", o):
                if re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", ph):
                    continue
                if re.fullmatch(r"[\w\s,:'\".\-…/()«»!?…–—]+", ph):
                    continue
                bad_ph.append(f"{prefix} {{{ph}}}")
    walk_ph(en, "en")
    walk_ph(fr, "fr")
    check("params-shape", not bad_ph, "" if not bad_ph else f"bad placeholders: {bad_ph[:8]}")

    # ---- parité des placeholders fr vs en (même clé = mêmes {params}) ----
    def ph_sets(o, prefix, acc):
        if isinstance(o, dict):
            for k, v in o.items():
                ph_sets(v, f"{prefix}.{k}", acc)
        elif isinstance(o, str):
            acc[prefix] = {ph for ph in re.findall(r"\{([^}]*)\}", o)
                             if re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", ph)}
        return acc
    fr_ph, en_ph = ph_sets(fr, "", {}), ph_sets(en, "", {})
    ph_mismatch = sorted(p for p in fr_ph if p in en_ph and fr_ph[p] != en_ph[p])
    check("params-shape", not ph_mismatch,
          "" if not ph_mismatch else f"fr/en placeholder mismatch: {ph_mismatch[:8]}")

    # ---- clés utilisées dans le code ----
    # Préfixes dynamiques (concaténés : t('a.b.' + key)) vérifiés par existence
    # du namespace parent au lieu de la clé exacte.
    DYNAMIC_PREFIXES = ("shell.wallpaper.labels.", "shell.ui.accents.")
    used = set()
    for path in JS_FILES:
        try:
            code = path.read_text(encoding="utf-8")
        except OSError:
            continue
        code_nc = re.sub(r"/\*.*?\*/", "", code, flags=re.S)
        code_nc = re.sub(r"(?m)^[ \t]*//.*$", "", code_nc)
        for m in re.finditer(r"(?<![\w.])(?:t|tp|bt|tx)\(\s*['\"]([^'\"]+)['\"]", code_nc):
            used.add(m.group(1))

    def key_exists(k):
        # EN est la référence (les packs customs sont validés ⊆ EN) : une clé
        # absente de en.json est manquante même si fr.json la contient.
        if get_path(en, k) is not None:
            return True
        return any(k == p or k.startswith(p) and get_path(en, p.rstrip(".")) is not None
                   for p in DYNAMIC_PREFIXES)
    missing = sorted(k for k in used if not key_exists(k))
    check("keys-used", not missing,
          f"{len(used)} keys used" if not missing else f"missing: {missing[:10]}")

    # ---- pas d'occultage de t() dans kernel.js ----
    # t() est la fonction i18n globale partagée par les scripts classiques.
    # Un `const/let t` (ou param/catch nommé t) dans un scope qui appelle
    # t('...') lève "Cannot access 't' before initialization" (TDZ) et peut
    # tronquer une page entière (ex. Réglages réduit au seul tableau
    # Apparence). Les usages locaux existants (resolveThemeName, toast,
    # accentPair : aucun appel t() dans leur scope) ont été renommés par
    # simplicité — nommer toute variable autrement (track, title...).
    t_shadow = []
    try:
        kcode = (ROOT / "USBos" / "system" / "kernel.js").read_text(encoding="utf-8")
        for i, line in enumerate(kcode.split("\n"), 1):
            s = line.strip()
            if not s or s.startswith("//") or s.startswith("*"):
                continue
            if re.search(r"(?:^|[^\w.])(?:const|let|var)\s+t\s*=", line):
                t_shadow.append(f"kernel.js:{i}: {s[:90]}")
            elif re.search(r"catch\s*\(\s*t\s*\)", line):
                t_shadow.append(f"kernel.js:{i}: {s[:90]}")
    except OSError as err:
        t_shadow.append(f"unreadable kernel.js ({err})")
    check("no-t-shadow", not t_shadow,
          "" if not t_shadow else f"{len(t_shadow)} hit(s), e.g. {t_shadow[:6]}")

    # ---- parité BOOTSTRAP_I18N (pré-vfs) ----
    # Regex déjà tolérante multiligne (re.S) ; le runtime couvre le reste
    # (tools/test-lang.cjs exerce bt() sur les deux hints fr/en).
    kernel = (ROOT / "USBos" / "system" / "kernel.js").read_text(encoding="utf-8")
    m = re.search(r"const BOOTSTRAP_I18N = \{(.*?)\n\};", kernel, flags=re.S)
    boot_bad = []
    if not m:
        check("bootstrap-parity", False, "BOOTSTRAP_I18N block not found")
    else:
        block = m.group(1)
        for lang in ("fr", "en"):
            sec = re.search(rf"{lang}: \{{(.*?)\n  \}},?", block, flags=re.S)
            if not sec:
                boot_bad.append(f"section {lang} missing")
                continue
            pairs = re.findall(r"'([^']+)':\s*('(?:[^'\\]|\\.)*'|\"(?:[^\"\\]|\\.)*\")", sec.group(1))
            ref = fr if lang == "fr" else en
            for path, raw in pairs:
                val = decode_js_string(raw)
                if val is None:
                    boot_bad.append(f"{lang}:{path} (unparsable)")
                    continue
                if get_path(ref, path) != val:
                    boot_bad.append(f"{lang}:{path} differs from {lang}.json")
        check("bootstrap-parity", not boot_bad, "" if not boot_bad else f"{boot_bad[:8]}")

    # ---- symétrie STR de l'installeur ----
    try:
        tpl = TEMPLATE.read_text(encoding="utf-8")
        str_block = tpl.split("const STR = {", 1)[1]
        # Neutralise les interpolations ${...} des template literals avant le
        # comptage d'accolades : leur contenu n'est pas de la structure.
        str_block = re.sub(r"\$\{[^{}]*\}", "", str_block)
        # découpe fr: {...} / en: {...} au premier niveau (profondeur d'accolades)
        sections = {}
        for lang in ("fr", "en"):
            start = str_block.index(f"{lang}: {{") + len(lang) + 3
            depth, i = 1, start
            while depth and i < len(str_block):
                if str_block[i] == "{":
                    depth += 1
                elif str_block[i] == "}":
                    depth -= 1
                i += 1
            body = str_block[start:i - 1]
            # clés de premier niveau uniquement (lignes '    key:' ou '    key(')
            keys = set(re.findall(r"(?m)^    ([A-Za-z_][A-Za-z0-9_]*)[(:]", body))
            sections[lang] = keys
        check("installer-sym", sections["fr"] == sections["en"],
              "" if sections["fr"] == sections["en"] else
              f"fr-only: {sorted(sections['fr'] - sections['en'])[:6]} / en-only: {sorted(sections['en'] - sections['fr'])[:6]}")
    except (OSError, ValueError, IndexError) as err:
        check("installer-sym", False, f"unparsable: {err}")

    # ---- aucun français en dur dans l'UI ----
    accent_re = re.compile(r"[àâäéèêëîïôöùûüçœæÀÂÄÉÈÊËÎÏÔÖÙÛÜÇŒÆ]")
    plain_words = ("Importer", "Exporter", "Supprimer", "Annuler", "Enregistrer", "Rechercher",
                   "Choisir", "Continuer", "Dossier", "Fichier", "Quitter", "Créer", "Ouvrir",
                   "Fermer", "Accepter", "Refuser", "Envoyer", "Ajouter", "Modifier", "Aperçu",
                   "Générer", "Calculer", "Utiliser", "Langue", "Sécurité", "Partage", "Shared", "Système",
                   "Aujourd", "Toujours", "Jamais", "Chaque", "Toutes", "Entre", "Sortie")
    hits = []
    for path in JS_FILES:
        lines = path.read_text(encoding="utf-8").split("\n")
        in_boot = False
        for i, line in enumerate(lines, 1):
            code = re.sub(r"[ \t]//.*$", "", line)  # commentaire fin de ligne
            code = re.sub(r"/\*.*?\*/", "", code)    # commentaire inline
            s = code.strip()
            if not s:
                continue
            if "const BOOTSTRAP_I18N" in line:
                in_boot = True
                continue
            if in_boot:
                if re.match(r"^};", line):
                    in_boot = False
                continue
            if s.startswith("//") or s.startswith("*") or s.startswith("/*"):
                continue
            if "USBosLog" in code or "ui.log(" in code or re.search(r"(?<![\w.])log\s*\(", code):
                continue
            # littéraux contenant un accent ('...' "..." et `...` backticks)
            for m in re.finditer(r"'[^'\n]*[àâäéèêëîïôöùûüçœæ][^'\n]*'|\"[^\"\n]*[àâäéèêëîïôöùûüçœæ][^\"\n]*\"|`[^`\n]*[àâäéèêëîïôöùûüçœæ][^`\n]*`", code, flags=re.I):
                frag = m.group(0)
                if re.search(r"t\(['\"][\w.]+['\"]\)", frag):
                    continue  # clé i18n, pas du texte
                hits.append(f"{path.name}:{i}: {s[:100]}")
                break
            else:
                for w in plain_words:
                    # 'Shared' reste sensible à la casse : 'shared' minuscule =
                    # schéma VFS (shared:), classes CSS (shared-*) ou variable
                    # — anglais par construction, pas du français UI. Seul
                    # 'Shared' capitalisé (label disque EN en dur) est chassé.
                    flags = 0 if w == "Shared" else re.I
                    if re.search(rf"['\"`][^'\"`\n]*\b{w}", code, flags=flags):
                        # ligne entièrement composée de clés t('…') ? ok
                        probe = re.sub(r"(?:\b|[^\w.])(?:t|tp|bt|tx)\(\s*['\"][\w.]+['\"]", "", code)
                        if re.search(rf"['\"`][^'\"`\n]*\b{w}", probe, flags=flags):
                            # Nom on-disk imposé ('Partage' exact, cf. installeur
                            # et vfs.js), pas du texte d'interface : 'utilisez
                            # Partage/' reste signalé, 'Partage' seul non.
                            if w == "Partage" and not re.search(r"Partage[^'\"`]", probe, flags=flags):
                                continue
                            hits.append(f"{path.name}:{i}: {s[:100]}")
                        break
    check("no-hardcoded", not hits, "" if not hits else f"{len(hits)} hits, e.g. {hits[:6]}")

    return report()


def report():
    fails = [r for r in results if r[0] == "FAIL"]
    warns = [r for r in results if r[0] == "WARN"]
    passes = [r for r in results if r[0] == "PASS"]
    for level, rule, detail in results:
        if level == "PASS" and not detail:
            continue
        print(f"{level:5} {rule}" + (f" — {detail}" if detail else ""))
    print(f"\n{len(passes)} passed, {len(warns)} warnings, {len(fails)} failures")
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
