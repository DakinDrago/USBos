#!/usr/bin/env python3
"""
USBos — tools/release.py

LA seule commande à connaître pour publier une mise à jour :

    python tools/release.py

Un seul endroit à éditer avant de la lancer :
  - noyau      -> const KERNEL_VERSION dans USBos/system/kernel.js
  - une app    -> le champ "version" de USBos/apps/<id>/manifest.json

Tout le reste (system/version.json, les ?v= d'index.html, tous les
version.json miroirs, tous les files.json/hash, installer.html) est
recalculé automatiquement, pour le noyau ET chaque app, à chaque
exécution — que tu aies touché un seul fichier ou dix. Pas d'ordre à
retenir, pas de commande à choisir selon ce que tu as modifié.

Si rien n'a changé depuis le dernier appel, la sortie est identique
(mêmes octets réécrits) : aucun bruit dans git.

En fin de course, tools/validate-versions.py tourne automatiquement et
son résultat (0 FAIL attendu) est affiché — c'est ta confirmation que
tout est cohérent et publiable.
"""
import pathlib
import subprocess
import sys

ROOT = pathlib.Path(__file__).parent.parent
sys.path.insert(0, str(ROOT))          # pour importer make_installer
sys.path.insert(0, str(ROOT / "tools"))  # pour importer gen_files_json

import make_installer     # noqa: E402
import gen_files_json      # noqa: E402


def main() -> int:
    print("== 1/3 · Synchronisation des versions ==")
    kernel_version = make_installer.read_kernel_version()
    print(f"Noyau (source : kernel.js) : {kernel_version}")
    make_installer.sync_versions(kernel_version)

    print("\n== 2/3 · Régénération des descripteurs (system + chaque app) ==")
    system_dir = ROOT / "USBos" / "system"
    if gen_files_json.generate(system_dir) != 0:
        print("Échec sur system/ — arrêt.")
        return 1

    apps_dir = ROOT / "USBos" / "apps"
    app_dirs = sorted(p for p in apps_dir.iterdir() if p.is_dir()) if apps_dir.is_dir() else []
    for app_dir in app_dirs:
        if gen_files_json.generate(app_dir) != 0:
            print(f"Échec sur {app_dir} — arrêt.")
            return 1

    print("\n== 3/3 · Reconstruction de installer.html ==")
    make_installer.main()

    print("\n== Validation finale ==")
    result = subprocess.run([sys.executable, str(ROOT / "tools" / "validate-versions.py")], cwd=ROOT)
    if result.returncode != 0:
        print("\n⚠ validate-versions.py a trouvé des incohérences (voir ci-dessus).")
        return result.returncode

    print("\n✔ Tout est cohérent. Il ne reste qu'à committer et pousser sur main.")
    return 0


if __name__ == "__main__":
    sys.exit(main())