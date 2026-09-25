# USBos v2

Système « embarqué » 100 % navigateur, conçu pour tourner depuis une clé USB
via la File System Access API. Aucun serveur, Node ou Python n'est requis
à l'exécution — tout se passe dans le navigateur.

Version documentée ici : **noyau 2.3.2** (`USBos/system/kernel.js:10`,
source unique de vérité).

## Contenu du dépôt

```
USBos/
  index.html          # lanceur — écran d'allumage, charge system/* avec ?v=
  system/             # noyau, jamais touché par une app
    kernel.js         # boot, shell UI, chiffrement data:, pont RPC, pages
    kernel.css
    vfs.js            # VFS : system:/apps:/data:/config:/update:/shared:
    crypto.js         # PBKDF2 + AES-GCM (passphrase maître)
    logbus.js         # journal mémoire façon dmesg (2000 entrées)
    console.js        # API window.usbos / u + palette Ctrl+K
    updater.js        # mise à jour delta via HTTPS
    upack.js          # conteneur .upack v1 (miroir de tools/upack.py)
    lang/fr.json      # dicts UI FR (shell + 7 apps + console)
    lang/en.json      # miroir EN
    version.json      # { kernel, schema, version }
    files.json        # descripteur updater (généré, ne pas éditer à la main)
  apps/               # 7 apps sandboxées (iframe srcdoc, jamais dans le kernel)
    agenda/ 2.0.0     # calendrier Mois/Semaine/Jour + import/export .ics
    coffre/ 1.0.0     # gestionnaire d'identifiants (double chiffrement)
    gallery/ 1.0.0    # galerie + imports .upack / Partage/
    markdown/ 1.0.0   # documents Markdown + aperçu
    mesh/ 1.4.0       # chat + fichiers P2P WebRTC (PeerJS en vendor/)
    notes/ 1.0.0      # notes titre+contenu
    toolbox/ 1.0.0    # utilitaires (copie, conversions…)
    */manifest.json   # id, name, version, icon, entry, sandbox
    */index.js        # script classique, `return USBosApp`
    */version.json    # miroir de manifest.json (ne pas faire diverger)
    */files.json      # descripteur updater (généré)
  config/
    update-sources.json       # dépôts HTTPS (noyau + apps)
    wallpaper-slides/         # fonds JPG par défaut des sources (optionnel)
  data/               # données utilisateur — jamais embarquées, jamais écrasées
    <app-id>/...
  .update/            # staging updater + backups migration + journal

Partage/              # sibling de USBos/, en clair par design, commun aux apps
installer.html        # généré (ne jamais éditer à la main)
make_installer.py     # build de installer.html
_installer_template.html  # gabarit de l'installeur
tools/                # validate-versions, validate-lang, gen_files_json, upack…
skills/usbos-app/    # contrat + template + validate.py pour créer une app
```

## Prérequis navigateur

Chrome, Edge, Brave, Opera, Vivaldi — File System Access API requise
(`showDirectoryPicker`). Firefox/Safari : non supportés pour l'installation
et l'ouverture d'une clé. Contexte sécurisé exigé (`https:` ou
`http://localhost` / `file:` selon navigateur ; sinon permission refusée).

## Installation

1. `python3 make_installer.py` régénère `installer.html` depuis `USBos/`.
   Embarqués : `index.html`, `system/`, `apps/`,
   `config/update-sources.json`, `config/wallpaper-slides/*`.
   Exclus : `data/`, `.update/`, `*.log/.tmp/.bak`, `.DS_Store`, `Thumbs.db`.
   Plafonds : 20 Mo bruts (alerte dès 75 %), wallpapers 8 Mo/fichier,
   10 max, 5 Mo total, vraies images vérifiées (magic bytes).
   Payload JSON avec `<` échappé (`\u003c`) ; `preserveOnUpdate`
   (`data`, `config`) voyage dans le payload.
   Le build synchronise `system/version.json` et les `?v=` d'`index.html`
   sur `KERNEL_VERSION`.
2. Ouvrir `installer.html`, choisir le **dossier parent** (pas `USBos/`
   directement). Créés : `USBos/` + `Partage/`. En choix direct de `USBos/`,
   `Partage/` est inaccessible (pas de parent en FS API) : panneau
   d'avertissement, imports/exports « Depuis Partage/ » indisponibles,
   invité indisponible. Réparable via `Changer de clé` ou
   Réglages → Partage → Reconnecter.
3. Choisir le mode :

   | Mode | Effet | `data/` | `config/` | Orphelins | `Partage/` |
   |---|---|---|---|---|---|
   | Réinstaller à zéro | rase `USBos/` puis réinstalle | **détruit** | réinitialisée | nettoyés | **survit** |
   | Tout mettre à jour | réécrit système + apps | préservé | fusionnée (existants gardés) | gardés | créé si absent |
   | Différence seulement | n'écrit que nouveaux/modifiés (SHA-256) | préservé | existants gardés | gardés | créé si absent |

   - Zéro exige radio + case de destruction (reset à chaque emplacement
     et après chaque apply, pas de `confirm()` natif) et refuse de raser
     un dossier qui ne ressemble pas à une install (`system/kernel.js`
     présent, ou `apps/` non-vide).
   - Sans install existante : un seul choix (installation neuve).
   - `config/` modifiée gardée + astuce loggée en `warn`, jamais écrasée
     en full/diff. Seul zéro réinitialise.
   - Échec mi-parcours : poursuite fichier par fichier,
     résumé `X écrit(s), Y échec(s)` — relancer le même mode pour reprendre.
     Chemins embarqués validés (refus `..`, `/` initial, `\`, `:`).
   - `Partage/` s'appelle toujours ainsi sur disque (affiché `Shared/`
     en anglais).
   - Scripts versionnés `?v=x.y.z` : après réinstall, `Ctrl+F5` si des
     options semblent manquer sans erreur.
   - L'installeur affiche `noyau x.y.z — construit le … (hash court)` :
     date ancienne = régénérer avant d'installer.
4. Ouvrir `USBos/index.html` pour démarrer.
5. Première connexion : **passphrase optionnelle**. Chiffrer tout (`data/`,
   AES-GCM) ou continuer en clair (case à cocher, mémorisé dans
   `config:no-passphrase`). Si un sel existe, la passphrase reste
   obligatoire. Après coup, Réglages → Sécurité ou console :
   `setPassphrase` / `changePassphrase` (ancienne vérifiée) /
   `removePassphrase`, avec `{ confirm: true }` en console. Les trois blocs
   sont affichés ; les inapplicables sont grisés avec leur raison.
   Le Coffre garde sa propre passphrase dans tous les cas.

**Release** : bumper `KERNEL_VERSION` (`x.y.z`), puis
`python tools/validate-versions.py` (0 FAIL exigé), puis
`python make_installer.py`. Ne jamais éditer `installer.html` à la main.
Ordre impératif : `gen_files_json` **en dernier**, juste avant commit —
tout edit après invalide les hash et fait refuser la bascule (« Bad hash »).

**Dépannage « options manquantes »** (Réglages incomplets, pas d'erreur) :
1. `document.querySelectorAll('.set-section').length` : `1` = vieux code
   (cache ou vieil `installer.html`), `7` = tout construit.
2. `u.version` vs `usbos.fs.cat('system:version.json')` : divergence = cache.
3. Date `installer.html` < dates `USBos/system/*` = régénérer.
4. `full`/`diff` gardent `config/` — une vieille config fige les défauts.
5. Chaque section Réglages est cloisonnée (carte d'erreur locale).

## Contrat d'une app

`apps/<id>/index.js` est un **script classique** (pas un module ES) chargé
dans une iframe `srcdoc` sandboxée via `new Function(code)` :

```js
const USBosApp = {
  id: 'mon-app',
  async mount(ctx, stage) {
    // ctx.fs.readJSON/writeJSON/readText/writeText/readBinary/writeBinary
    //   -> scopés à data/<mon-app>/… (chemins ".." rejetés,
    //      2 Mo texte/JSON côté RPC, 256 Mo binaire, 64 Mo couche chiffrée)
    // ctx.fs.readAppAsset(path) -> lecture seule apps/<mon-app>/path
    // ctx.fs.readShared/writeShared/readSharedText/writeSharedText/…
    //   -> Partage/ COMMUN, en clair par design. Mêmes plafonds.
    //      Ne jamais y mettre de secrets.
    // ctx.ui.log(message, niveau?) -> debug/info/warn/error, 2000 car. max,
    //      60 logs / 10 s par app
    // ctx.ui.toast(message) -> 200 car. max, anti-spam 1 / 2 s par app
    // stage: élément DOM où monter l'UI
  },
  async unmount() { /* timers, listeners, connexions */ },
};
return USBosApp;
```

Le kernel ne connaît que `manifest.json`. Le pont RPC utilise l'id de
**l'app active** (jamais celui déclaré par l'iframe) et rejette `..`.
Sandbox : `allow-scripts allow-forms allow-modals allow-downloads`
(+ `allow-popups` si demandé) ; `allow-same-origin` et
`allow-top-navigation` interdits et filtrés avec log.

> Créer une app : `skills/usbos-app/SKILL.md` (contrat, squelette
> `template/`, `python skills/usbos-app/validate.py USBos/apps/<id>/`,
> guide de publication). Non embarquée sur les clés.

## VFS — chemins et plafonds réels

Schémas : `system:` `apps:` `data:` `config:` `update:` (`.update/`),
`shared:` (`Partage/`). Ex. `data:notes/notes.json`, `shared:doc.md`.

- Segments : max 32, 255 octets/nom, NFC, rejet `..`/`.`, `<>:"|?*\x00-\x1f\`,
  `:`, espace/point final, noms réservés Windows (`CON`, `PRN`, `COM1`…).
- Lecture : texte 16 Mo, JSON 5 Mo, binaire 256 Mo.
- Écriture VFS : binaire 256 Mo (texte non plafonné côté VFS — le plafond
  2 Mo est appliqué côté pont RPC, pas côté `usbos.fs` direct).
- Couche chiffrée `data:` : 64 Mo par fichier (pré-check `stat` + vérif buffer).
- `walk()` : 5000 fichiers max, dossiers illisibles ignorés + `warn`.
- `remove()` : `system:kernel.js`, `system:version.json`,
  `config:update-sources.json`, `system:` protégés sans `{ force: true }`.
- `Partage/` indisponible sans dossier parent : erreur `SHARED_UNAVAILABLE`.

## Chiffrement et passphrase

- `data/` seul est chiffré (transparent). `system:/apps:/config:/shared:`
  restent en clair (fonctionnement noyau/updater + fonds visibles au verrou).
- PBKDF2 210 000 itérations SHA-256 + AES-GCM 256, sel 16 o, IV 12 o.
  Format v2 `U1 01 + IV + ct`, lecture legacy v1 (IV||ct) conservée.
  Passphrase 8–512 caractères, sel min 16 o.
- Pas de normalisation NFKC (compat) : une passphrase accentuée saisie
  différemment selon l'OS peut dériver une autre clé — à connaître.
- `setPassphrase` / `removePassphrase` / `changePassphrase` : journal
  `update:mig.json` + sauvegarde `update:mig-backup/`, reprise auto au boot
  (`restoreMigBackup`). Migration d'un gros `data/` charge tout en RAM :
  éviter les très gros volumes pendant ces opérations.
- Le Coffre (`coffre.bin` + `coffre.salt` dans son `data/`) est chiffré
  **deux fois** (clé maître + sa propre passphrase PBKDF2 210k). Persist
  refusé au-delà de 25 Mo.

## Mise à jour delta (GitHub raw)

Un dépôt public par composant (noyau + chaque app). Racine distante :

```
version.json   { "version": "1.2.3" }
files.json     { "version": "1.2.3", "files": { "kernel.js": "<sha256>", … } }
<fichiers, mêmes chemins relatifs>
```

`config/update-sources.json` pointe par défaut vers le monorepo
`DakinDrago/USBos` (`USBos/system`, `USBos/apps/<id>`). `{}` désactive
un composant.

Au démarrage (arrière-plan, après bureau) + toutes les 4 h (sans
chevauchement, jamais en invité) : comparaison hash locaux/distants,
téléchargement des seuls fichiers changés, staging dans
`.update/staging/`, vérif SHA-256, sauvegarde `update:backup/`, bascule
avec vérif post-écriture + rollback best-effort, marqueurs
(`version.json` **et** `manifest.json` synchronisés, `schema` préservé
par merge). Bandeau « Mettre à jour » ; reboot noyau seulement si le
noyau a changé.

Gardes : HTTPS seul (sans credentials/query/hash), chemins distants validés
(caractères `A-Za-z0-9._-/` uniquement — donc pas d'espaces/accents dans
les fichiers publiables), hash `^[0-9a-f]{64}$`, downgrade refusé,
20 s/requête, 50 Mo/fichier, JSON 1 Mo, 500 fichiers/source, 200 Mo total,
`navigator.locks('usbos:update')` anti-concurrence.

Limite connue : `files.json`/`version.json` **non signés** — le hash prouve
l'intégrité du transfert, pas l'authenticité du dépôt. Aucune URL de dépôt
visible/modifiable dans l'UI (seul le résultat est montré).

Publication :

```
python tools/gen_files_json.py USBos/system --version 2.3.2
python tools/gen_files_json.py USBos/apps/notes
```

puis dépôt du dossier + descripteurs à la racine du dépôt distant.

## Tableau de bord

Clic marque **USBos** ou fermeture d'app : salutation + date + horloge,
infos clé/noyau, Agenda (aujourd'hui + 7 jours), notes récentes, documents,
code Mesh (clic = copier), état Coffre, MAJ, dernières erreurs. Cartes
cliquables, lecture seule, repli par carte. Coffre jamais déchiffré
(existence seule). `usbos.system.dashboard()` / `u` + palette aussi.

## Pages vs apps — Réglages

Apps (iframes) vs **pages** noyau (`dashboard`, `settings`…).
**⚙️ Réglages** (bouton en bout d'en-tête) : Apparence (thème+accents live),
Sécurité (3 blocs passphrase), Partage & données (état + Reconnecter,
compteurs, export journal), Système (versions, MAJ, raccourcis).
`usbos.system.settings()`. En-tête compact : marque, statut, Journal,
palette, clé, Verrouiller, Réglages.

## Interface : thèmes, recherche, raccourcis

- Thèmes sombre / clair **sable** / auto (`config:theme.json`),
  `usbos.system.theme('light')`. Apps suivies en direct (`__usbosTheme`),
  `prefers-reduced-motion` respecté.
- Recherche (`/` focus, `Échap` efface) : notes, documents, agenda
  (toutes dates), coffre (nom+identifiant uniquement).
- Raccourcis : `Ctrl+S` sauvegarde, `Ctrl+K` palette, `F12` console,
  `🔒` Verrouiller (en clair : simple rappel).
- Imports « Depuis Partage/ » : agenda (`.ics`), notes (`.json`),
  documents (`.md`) — fusion sans écraser, `Partage/` requis.
- Thèmes personnels (`*.usbos-theme.json`, `{name,dark:{17},light:{17}}`) :
  éditeur guidé ou JSON, export/import `Partage/`, doublons renommés.
- Mise en page (`config:ui.json`) : coins, texte S/M/L, densité,
  barre haut/bas, sidebar droite/gauche — live, valeurs invalides ignorées.
- Suppressions en deux temps (« Suppr. » → « Sûr ? », 4 s) + toast.
  Focus visible, boutons ARIA.

## Langue (FR/EN + packs)

Français par défaut fixe, anglais commutable (Réglages → Langue,
`usbos.system.lang('en')`). Changement = repaint shell + reopen app
(brouillon perdu, toast). Tout le FR visible est traduit sauf logs
(`USBosLog`, `ctx.ui.log` volontaires). Technique : dicts namespacés
(`shell`, 7 apps, `console`), `t()` + `tp()` (`Intl.PluralRules`) + dates
`Intl`, repli `langue → en → fr → clé`, bootstrap FR/EN pré-montage.
Packs `*.usbos-lang.json` (`{kind,lang,locale?,dict}`) dans `config:lang/`
(validés, 200 Ko max, jamais écrasés sauf mode zéro). Gardes :
`python tools/validate-lang.py` + `node tools/test-lang.cjs`.
Pas de RTL v1.

## Verrouillage, fonds, invité

- Verrou façon OS : horloge + date, avatar (initiale clé), voir/masquer,
  `Entrée`, shake, alerte Verr Maj, lien invité.
- Fonds (`config:wallpaper.json` + `config:wallpaper-slides/`, en clair) :
  6 dégradés + 5 scènes SVG + images JPG/PNG/WebP/GIF (magic bytes,
  8 Mo max, 10 max, 2048 px à l'import, par fichier ou `Partage/`).
  Diaporama 15/30/60 s, opt-in par app. Défauts déposés dans
  `config/wallpaper-slides/` des sources (5 Mo total, jamais écrasés).
- Invité : « 👤 Continuer en invité » (verrou ou allumage) — seul `Partage/`
  (fil d'Ariane, dépôt ≤ 100 Mo, suppression 2 temps), sans `data:/apps:/
  system:/config:`. Sortie = retour allumage.

## Les 7 apps

- **Agenda** (2.0.0) : Mois/Semaine/Jour, heures, journée entière, lieu/desc,
  import/export `.ics` RFC 5545 (Google/Outlook/Apple), dédup `UID`,
  fuseau auto (`Intl`, stock local / export UTC), migration v1 auto.
  Limites : `RRULE` → occurrence unique, `TZID` inconnu gardé affiché.
- **Coffre** (1.0.0) : identifiants, recherche nom+login, mot de passe
  masqué + copie, verrouillage manuel, double chiffrement.
- **Gallery** (1.0.0) : images/vidéos, imports `.upack` et `Partage/`.
- **Markdown** (1.0.0) : docs (500 Ko/doc, persist 2 Mo), aperçu HTML
  sanitizé (liens `https:/mailto:/#//` uniquement), export/import `.md`.
- **Mesh** (1.4.0, ex-P2P/QR) : chat + fichiers WebRTC via PeerJS
  (`apps/mesh/vendor/`, chargé à l'ouverture uniquement). Code `XXX-000000`,
  acceptation entrante manuelle (60 s), direct ≤ 8 Mo (dur 25 Mo),
  morcelé jusqu'à 256 Mo (256 Ko/morceau, 1 en vol, accusés), salons
  `GRP-000000` en maillage complet, drag-drop + sélecteur mobile.
- **Notes** (1.0.0) : titre+contenu, recherche, import/export JSON.
- **Toolbox** (1.0.0) : utilitaires, copie presse-papiers.

Retirés du noyau : `qrcode-generator`, `jsQR`. PeerJS extrait vers Mesh.

## Journal & console

Journal unique mémoire (`system/logbus.js`) : noyau, VFS, updater, apps,
erreurs globales. 2000 entrées max (+200 de tolérance), niveaux
debug/info/warn/error.

1. **Bouton Journal** : imprime les 200 dernières dans DevTools + rappel F12.
   Miroir temps réel coloré.
2. **DevTools** (`usbos.*`, `u.*`) :

```
usbos.system.info()                    // clé, verrou, app active, version
usbos.logs.tail(100)
usbos.logs.filter({ level: 'error' })
usbos.logs.filter({ source: 'updater' })  // kernel, vfs, updater, console, app:<id>, window, promise
usbos.logs.filter({ contains: 'mesh' })
usbos.logs.level('warn')               // défaut 'debug'
usbos.logs.export()                    // system/logs/usbos-<date>.log (en clair)
usbos.logs.clear()                     // mémoire uniquement
usbos.dev.dumpState()                  // résumé safe pour rapport de bug
usbos.fs.ls('apps:')
```

Getters sans parenthèses : `u.info` `u.apps` `u.tail` `u.errors`
`u.uptime` `u.version` `u.status` `u.updates` `u.help`. Destructifs
exigent `{ confirm: true }`. `system.uptime()` mesuré au chargement
console (quelques ms d'écart). `ctx.ui.log()` côté apps.

3. **Palette** (`⌘` ou `Ctrl+K`) : fantôme gris, `TAB` cycle, `↑↓`
   naviguer/historique, `Entrée` exécuter (`tail 100`, `open notes`,
   `ls 'apps:'`), `Échap` fermer. Destructifs = 2e `Entrée`.
   Passphrases jamais loggées (`(***)`).

## Outils dev et contrôles

```
python tools/validate-versions.py  # KERNEL_VERSION == version.json == ?v=,
                                   # manifest == version.json, semver,
                                   # files.json frais, arbre tout-LF
python tools/validate-lang.py      # symétrie fr/en, clés utilisées,
                                   # bootstrap, installeur, pas de FR en dur
node tools/test-lang.cjs           # 33 assertions runtime sur vrai noyau
python tools/gen_files_json.py USBos/system --version x.y.z
python tools/gen_files_json.py USBos/apps/<id>
python tools/upack.py pack IN OUT [--chunk N] [--mime T]
python tools/upack.py verify F.upack
python tools/upack.py unpack F.upack [--out DIR]
node tools/test-upack.cjs          # roundtrip JS
python skills/usbos-app/validate.py USBos/apps/<id>/
```

Format `.upack` v1 : `USBOS1` + uint32 BE + JSON
`{v,name,mime,size,chunk,hashes,sha}` + morceaux. `MAX_CHUNKS` 100 000,
chunk ≤ 64 Mo. Refuser tout `.upack` au nom sortant (`..`, absolu) côté
appelant — `unpack` Python refuse d'écraser l'existant.

## Limites connues (revue)

- `files.json`/`version.json` non signés : dépôt compromis = hash assortis.
- `update:backup/` non purgé après succès (à surveiller côté quota).
- Noms publiables restreints (`A-Za-z0-9._-/`) : pas d'espaces/accents
  dans les fichiers d'apps destinés aux MAJ.
- `writeText` VFS sans plafond (le 2 Mo est côté RPC) ; migrations
  passphrase tout-en-RAM ; `writeBinary` RPC attend `ArrayBuffer`/vue
  (convertir `Blob` via `arrayBuffer()` avant envoi).
- Export logs en clair dans `system:logs/` (anonymiser avant partage).
