# USBos v2

Système « embarqué » 100% navigateur, conçu pour tourner depuis une clé USB
via la File System Access API. Aucune dépendance serveur/Node/Python n'est
requise à l'exécution — tout se passe dans le navigateur.

## Arborescence installée

```
<emplacement choisi>/
  USBos/
    index.html          # lanceur — aucune logique, juste l'écran d'allumage
    system/              # noyau, jamais touché par une app (façon /system32 ou /usr)
      kernel.js           # boot, chargeur d'apps, shell UI, verrouillage
      kernel.css
      lang/fr.json        # dicts UI FR (namespaces shell + apps + console)
      lang/en.json        # dicts UI EN (miroir)
      vfs.js               # VFS : system:/apps:/data:/config:/shared: (+ walk)
      crypto.js            # PBKDF2 + AES-GCM (passphrase maître)
      logbus.js            # journal en mémoire façon dmesg/syslog
      console.js           # API window.usbos pour DevTools
      updater.js           # mise à jour delta via GitHub raw
      version.json
    apps/                 # applications — jamais dans le kernel, ajoutables/supprimables
      notes/  agenda/  coffre/  markdown/  toolbox/  mesh/
        manifest.json      # id, name, version, icon (emoji), point d'entrée (+ note sandbox)
        index.js            # script classique : définit USBosApp puis `return USBosApp`
        version.json       # version synchronisée avec manifest.json (ne pas diverger)
    data/                 # données utilisateur — jamais écrasées par une mise à jour
      <app-id>/...
    config/               # update-sources.json, sel maître, préférences
      lang/               # packs de langue customs (*.usbos-lang.json, jamais écrasés)
    .update/              # zone tampon de l'updater (staging puis vidée après bascule)
  Partage/              # espace d'échange COMMUN, hors USBos, en clair par design
```

## Installation

1. `python3 make_installer.py` régénère `installer.html` à partir du contenu
   réel de `USBos/`. Seuls `index.html`, `system/`, `apps/`,
   `config/update-sources.json` et `config/wallpaper-slides/*` (fonds
   par défaut : vraies images vérifiées, 2 Mo/fichier, 10 max, 5 Mo
   total, installés à neuf et **jamais écrasés**) sont embarqués —
   **jamais `data/`** (données personnelles du poste de dev) ni
   `.update/`. Plafond total : 20 Mo bruts (alerte dès 75 %).
   Le payload JSON est injecté avec `<` échappé (`\u003c`, anti-`</script>`)
   et la liste des dossiers préservés (`preserveOnUpdate`) voyage dans le
   payload — l'installeur la lit (défaut `data` + `config`).
2. Ouvrir `installer.html` dans un navigateur compatible (Chrome, Edge, Brave,
   Opera, Vivaldi — nécessite la File System Access API).
3. Choisir l'emplacement (clé USB ou dossier). Deux dossiers y sont
   créés : `USBos/` (système) et `Partage/` (échange, jamais effacé).
   **Choisissez le dossier parent** (pas `USBos/` directement) : en choix
   direct, `Partage/` est inaccessible (pas de dossier parent en FS API)
   et l'OS vous le signale par un panneau (invité, exports et imports
   `Depuis Partage/` indisponibles). Réparable après coup via
   `Changer de clé` ou Réglages → Partage → Reconnecter.
4. Choisir comment installer :

   | Mode | Ce qu'il fait | `data/` | `config/` | Orphelins | `Partage/` |
   |---|---|---|---|---|---|
   | Réinstaller à zéro | rase `USBos/` puis réinstalle tout | **détruit** | réinitialisée | nettoyés | **survit** |
   | Tout mettre à jour | réécrit système + apps | préservé | fusionnée | gardés | créé si absent |
   | Différence seulement | n'écrit que fichiers nouveaux/modifiés (SHA-256) | préservé | existants gardés | gardés | créé si absent |

   - Le mode zéro exige **radio + case de destruction** (reset à chaque
     emplacement et après chaque apply, pas de `confirm()` natif) et refuse
     de raser un dossier qui ne ressemble pas à une install (`system/kernel.js`
     présent, ou `apps/` non-vide — un `apps/` vide ne suffit pas).
   - Sans install existante, un seul choix (installation neuve).
   - En full comme en diff, un `config/` modifié par l'utilisateur est gardé
     et signalé (astuce loggée en `warn`), jamais écrasé.
   - Échec mi-parcours : l'installeur continue fichier par fichier et résume
     `X écrit(s), Y échec(s)` — relancez le même mode pour reprendre
     (seul le wipe initial reste fatal). Les chemins embarqués sont validés
     (refus de `..`, `/` initial, `\`, `:`).
    - Le disque d'échange s'appelle toujours **`Partage/`** sur disque
      (même en anglais : l'installeur EN l'affiche `Partage/ (shown as Shared/)`).
    - Les scripts sont versionnés (`?v=x.y.z` = `KERNEL_VERSION`, source
      unique : `USBos/system/kernel.js:10` — `make_installer.py` synchronise
      `system/version.json` et les `?v=` au build, `tools/validate-versions.py`
      vérifie) : après une réinstall, forcer le rechargement
      (`Ctrl+F5`) si des options semblent manquer sans erreur.
    - L'installeur affiche son contenu (`noyau x.y.z — construit le …`) :
      si la date Composition est ancienne, régénérer avant d'installer.

    **Release** : bumper `KERNEL_VERSION` (`x.y.z`), puis
    `python tools/validate-versions.py` (checks, 0 FAIL exigé) puis
    `python make_installer.py` (sync + payload + meta). Ne jamais éditer
    `installer.html` à la main.
    Ordre impératif : `gen_files_json` **en dernier**, juste avant commit —
    tout edit de source après un `gen` invalide ses hash et fait refuser
    la bascule aux clés (« Bad hash »).

    **Dépannage « il manque des options »** (Réglages incomplets, pas
    d'erreur rouge en console) :
    1. `document.querySelectorAll('.set-section').length` en console (F12) :
       `1` = vieux code exécuté (cache ou vieil `installer.html`) ;
       `7` = tout est construit (regarder CSS/scroll).
    2. `u.version` vs `usbos.fs.cat('system:version.json')` : divergence =
       cache — `Ctrl+F5`, fermer les onglets, rouvrir.
    3. Date de l'`installer.html` utilisé < dates de `USBos/system/*` =
       réinstaller avec le fichier régénéré (`python make_installer.py`).
    4. Mode `full`/`diff` : `config/` gardée — une vieille config fige les
       défauts ; seul `zéro` réinitialise (détruit `data/`).
    5. Chaque section Réglages est cloisonnée : une section en échec
       affiche sa propre carte d'erreur au lieu de masquer la suite.
5. Ouvrir `USBos/index.html` pour démarrer.
6. À la première connexion : **passphrase optionnelle**. Soit on chiffre
   tout (`data/`, AES-GCM), soit on continue en clair (case à cocher,
   choix mémorisé dans `config:no-passphrase`). Si un sel existe déjà,
   la passphrase reste obligatoire (données illisibles sans elle).
   Après coup, Réglages → Sécurité (ou console) : ajouter
   (`setPassphrase`), **changer** (`changePassphrase`, ancienne vérifiée,
   sauvegarde totale fichiers+sel+check, reprise auto à l'ancienne phrase)
   ou **retirer** (`removePassphrase`) — avec `{ confirm: true }` en
   console. Les trois blocs sont toujours affichés ; les inapplicables
   sont grisés avec leur raison (ex. « Changer » exige une session
   chiffrée). Le Coffre garde sa propre phrase dans tous les cas.

## Contrat d'une app

`apps/<id>/index.js` est un **script classique** (pas un module ES) chargé
dans une iframe `srcdoc` sandboxée via `new Function(code)` : le `return`
final de premier niveau est donc légal. Structure attendue :

```js
const USBosApp = {
  id: 'mon-app',
  async mount(ctx, stage) {
    // ctx.fs.readJSON/writeJSON/readText/writeText/readBinary/writeBinary
    //   -> scopés automatiquement à data/<mon-app>/... (chemins ".." rejetés,
    //      25 Mo max par écriture binaire, 2 Mo pour texte/JSON)
    // ctx.fs.readAppAsset(path) -> lecture seule de apps/<mon-app>/path (ex: vendor/lib.js)
    // ctx.fs.readShared/writeShared/readSharedText/writeSharedText/listShared/existsShared/removeShared(path, …)
    //   -> espace Partage/ COMMUN à toutes les apps, en clair par design (intérieur + extérieur) ;
    //      mêmes validations et plafonds (25 Mo binaire / 2 Mo texte). Ne jamais y mettre de secrets.
    // ctx.ui.log(message, niveau?) -> niveau parmi debug/info/warn/error (défaut info), 2000 car. max
    // ctx.ui.toast(message) -> notification shell (200 car. max, anti-spam 1/2 s par app)
    // stage: élément DOM où monter l'UI
  },
  async unmount() { /* nettoyage : timers, connexions, listeners globaux */ },
};
return USBosApp;
```

Le kernel ne connaît jamais le contenu métier d'une app — seulement son
`manifest.json`. Une app ne peut pas lire les données d'une autre app :
le pont RPC utilise l'id de **l'app active** (jamais celui déclaré par
l'iframe) et rejette les chemins `..`. La sandbox est blanchie par le noyau
(`allow-scripts allow-forms allow-modals allow-downloads`, `allow-popups`) :
`allow-same-origin` et `allow-top-navigation` sont **interdits** car ils
casseraient l'isolation.

> **Créer une app ?** Pour les humains comme pour les IA : la skill
> [`skills/usbos-app/SKILL.md`](skills/usbos-app/SKILL.md) (en anglais) —
> contrat exact, squelette copiable (`template/`), script de validation
> (`python skills/usbos-app/validate.py USBos/apps/<id>/`) et guide de
> publication. Non embarquée sur les clés (dev via GitHub uniquement).

## Mise à jour automatique (delta, via GitHub)

Un dépôt GitHub **public** par composant (le kernel et chaque app séparément).
Chaque dépôt expose à sa racine :

```
version.json   { "version": "1.2.3" }
files.json     { "files": { "kernel.js": "<sha256 hex>", ... } }
<les fichiers eux-mêmes, mêmes chemins relatifs>
```

`config/update-sources.json` sur la clé :

```json
{
  "kernel": "https://raw.githubusercontent.com/<compte>/usbos-kernel/main",
  "apps": {
    "notes": "https://raw.githubusercontent.com/<compte>/usbos-app-notes/main",
    "mesh":  "https://raw.githubusercontent.com/<compte>/usbos-app-mesh/main"
  }
}
```

Au démarrage (en arrière-plan, après l'affichage du bureau), le kernel
compare les hash locaux aux hash distants et ne télécharge que ce qui a
changé, puis **revérifie toutes les 4 h** (silencieusement, jamais en
invité, sans chevauchement). Ordonancement : téléchargement + vérification SHA-256 dans
`.update/staging/`, puis bascule vers la destination, puis mise à jour des
marqueurs (`version.json` **et** `manifest.json` synchronisés).
`version.json` a deux formes : en local (`USBos/system/version.json`)
`{ "kernel": "2.3.0", "schema": 1 }` (+ `version` posée par l'updater
lors d'une bascule noyau), contre `{ "version": "1.2.3" }` seul côté
dépôt publié. À la bascule, l'updater **fusionne** (merge) au lieu
d'écraser, pour préserver `schema` et les champs locaux.
Un bandeau
propose « Mettre à jour » — un clic suffit ; le noyau redémarre seulement si
lui-même a changé, sinon l'app modifiée est simplement rechargée. Seul HTTPS
est accepté et les chemins distants (`..`, absolus, caractères interdits)
sont refusés ; chaque source en échec est ignorée sans bloquer les autres
(délai 20 s par requête, 50 Mo max par fichier).

Limite connue : `files.json`/`version.json` ne sont **pas signés** — le hash
vérifie l'intégrité du transfert, pas l'authenticité du dépôt. Un dépôt
compromis peut fournir des hash assortis. Les dépôts se configurent dans
les sources (`USBos/config/update-sources.json`) et arrivent sur les clés
via `installer.html` : **aucune édition ni affichage des dépôts dans
l'interface** (ni URLs visibles, ni modification) — seul le résultat
(versions disponibles) est montré.

Pour publier un composant, générez ses descripteurs (jamais à la main) :

```
python tools/gen_files_json.py USBos/system --version 2.2.1
python tools/gen_files_json.py USBos/apps/notes
```

puis déposez le contenu du dossier + `version.json` + `files.json` à la
racine du dépôt GitHub correspondant.

`raw.githubusercontent.com` est gratuit et ne nécessite aucun token pour des
dépôts publics.

## Tableau de bord

Le bureau (clic sur la marque **USBos** en haut à gauche, ou fermeture
d'une app) affiche un tableau
de bord façon menu démarrer : salutation + date + horloge, infos clé/noyau,
aujourd'hui et 7 prochains jours de l'Agenda, notes récentes, documents,
code Mesh (clic = copier), état du Coffre, mises à jour et dernières
erreurs. Chaque carte cliquable ouvre l'app concernée. Lecture seule :
le dashboard lit les `data:` déchiffrés en session (même privilège que
`usbos.fs.cat`) mais n'écrit jamais ; chaque carte en échec affiche un
repli au lieu de casser l'ensemble. Le Coffre n'est jamais déchiffré
(existence seule). `usbos.system.dashboard()` / `u` + palette y mènent
aussi. Pas de bouton « Bureau » : la marque est l'accueil.

## Pages vs apps — page Réglages

Deux registres distincts : les **apps** (`apps/*/`, iframes sandboxées,
fonctionnel, extensibles) et les **pages** (vues du noyau : usage et
expérience — `dashboard`, `settings`, …). La page **⚙️ Réglages**
(bouton en bout de barre d'en-tête, pas de doublon en sidebar) centralise
toute la customisation sous forme de liste façon OS (lignes icône +
titre + détail + contrôle à droite : segmenté, pastilles, switch,
boutons) : apparence (thème + accents, live partout), sécurité (mode,
ajout / changement / retrait de passphrase — les trois blocs toujours
visibles, les inapplicables grisés avec leur raison), partage & données
(état + bouton Reconnecter si inactif, compteurs `0` quand vide,
export du journal), système (versions, vérification des mises à jour,
récapitulatif des raccourcis).
`usbos.system.settings()` l'ouvre aussi. Aucun contrôle de
customisation ne reste dans l'en-tête (compact : marque-accueil,
statut, Journal, palette, clé, Verrouiller, Réglages).

## Interface : thèmes, recherche, raccourcis

- **Thèmes complets** : sombre / clair **« sable »** (beige-brun, plus de
  blanc pur) / auto (suit le système), persistés dans `config:theme.json`.
  Réglages → Apparence (segmenté + pastilles) ou
  `usbos.system.theme('light')` / `theme('dark','violet')`.
  Les apps suivent **en direct**, sans être rechargées (pont `__usbosTheme`).
  Mouvements désactivés si `prefers-reduced-motion`.
- **Recherche** (`/` pour focus, `Échap` pour effacer) : notes
  (titre+contenu), documents (nom+contenu), agenda (titre+lieu+desc,
  toutes dates, clic = saut au jour), coffre (nom+identifiant
  **uniquement**, jamais mot de passe ni note).
  Chaque app affiche sa ligne d'aide (raccourcis + limites) sous sa
  barre d'outils ; Réglages → Système → Raccourcis les récapitule.
- **Raccourcis** : `Ctrl+S` sauvegarde (notes, markdown, agenda),
  `Ctrl+K` palette, `F12` console. **Verrouiller** : bouton 🔒 en bout
  de barre d'en-tête (recharge verrouillée ; en session en clair, simple
  rappel — rien à verrouiller).
- **Imports depuis `Partage/`** : agenda (`.ics`), notes (`.json`),
  documents (`.md`) proposent « Depuis Partage/ » à côté de l'import par
  fichier — lecture seule, fusion sans écraser, `Partage/` requis
  (voir Installation §3).
- **Thèmes personnels** : Réglages → Apparence → « Mes thèmes » —
  éditeur guidé (fond, panneaux, texte, accent × sombre/clair, aperçu
  live, le reste auto-dérivé) ou JSON complet. Format
  `*.usbos-theme.json` : `{name, dark:{…17 vars}, light:{…17 vars}}`
  (noms simples, hex `#rrggbb` ou `rgba()`, customs namespacés).
  Export vers `Partage/`, import par fichier ou depuis `Partage/`
  (validé, doublons renommés).
- **Mise en page** (`config:ui.json`) : coins (carré/doux/rond), texte
  (S/M/L), densité (compacte/confortable), barre (haut/bas), sidebar
  (droite par défaut, gauche possible) — live shell + apps, persisté,
  valeurs invalides ignorées.
- **Suppressions en deux temps** partout (« Suppr. » → « Sûr ? »,
  expiration 4 s) + toast de confirmation. Focus clavier toujours visible ;
  boutons iconiques étiquetés (ARIA).

## Langue (FR/EN + packs)

- **Français par défaut (fixe, pas d'auto-navigateur)**, anglais commutable :
  Réglages → Langue, ou `usbos.system.lang('en')` (`usbos.system.lang()`
  liste les langues). Le changement **repeint le shell et rouvre l'app
  en cours** (brouillon non sauvegardé perdu — signalé par toast).
- **Tout le français visible est traduit** : écrans (allumage, verrou,
  setup, bureau, Réglages, invité), 6 apps, console (`help:` + retours),
  palette, installeur (bascule FR/EN intégrée). **Seuls les logs restent
  en français** (`USBosLog`, journal DevTools, `ctx.ui.log`) — volontaire.
- **Technique** : dicts JSON namespacés (`system/lang/fr.json|en.json` :
  `shell`, `notes`, `agenda`, `coffre`, `markdown`, `toolbox`, `mesh`,
  `console`), `t(clé,{params})` + `tp()` pluriels `Intl.PluralRules` +
  dates `Intl` (`ctx.i18n = {lang,locale,t,tp}` figé par montage d'app,
  `shell` fusionné dans chaque iframe). Repli `langue → en → fr → clé`.
  Écrans pré-montage (allumage) via mini-bootstrap embarqué FR/EN
  (indice `localStorage`, mêmes chemins — parité testée).
- **Packs custom** (`*.usbos-lang.json` : `{kind:'usbos-lang', lang,
  locale?, dict}`) : import par fichier ou depuis `Partage/`, export
  (le modèle EN complet sert de base à traduire), suppression en 2 temps.
  Validés (code BCP-47 court, clés ⊆ EN, pas de `<script`, 200 Ko max),
  stockés dans `config:lang/` (jamais écrasés : ni updater, ni installeur
  full/diff — le mode zéro rase tout, comme pour les thèmes customs).
- **Garde-fous** : `python tools/validate-lang.py` (clés, pluriels,
  placeholders + parité fr/en, parité bootstrap, symétrie installeur, zéro
  français en dur — EN y est la référence) + `node tools/test-lang.cjs`
  (33 assertions runtime comptées dynamiquement sur le vrai noyau : repli,
  pluriels, customs, `setLang` — plus sondes `tx`/`bt` hors compteur).
  Pas de RTL v1 (prévu).

## Verrouillage, fonds d'écran, invité

- **Écran de verrouillage façon OS** : horloge + date en grand, avatar
  (initiale de la clé), champ avec voir/masquer, `Entrée` pour valider,
  shake + message en cas d'erreur, alerte Verr Maj, lien invité.
- **Fonds d'écran** (`config:wallpaper.json` + `config:wallpaper-slides/`,
  en clair — visibles dès le verrou) : 6 dégradés prédéfinis + 5 scènes
  SVG intégrées (montagnes, vagues, dunes, boréale, soleil — zéro poids,
  offline) + **vos images** (JPG/PNG/WebP/GIF vérifiées par magic bytes,
  2 Mo max, 10 max, import par fichier ou depuis `Partage/`).
  Diaporama presets et/ou images (15/30/60 s), opt-in par app.
  Vos JPG par défaut : déposez-les dans `config/wallpaper-slides/` des
  **sources** — embarqués par `make_installer.py` (5 Mo total max, jamais
  écrasés à l'install).
- **Espace invité** : gros bouton « 👤 Continuer en invité » sur
  l'écran de verrouillage (et dès l'écran d'allumage via « Explorer en
   invité… » : choisissez le dossier parent) — explorateur du seul
   `Partage/` (fil d'Ariane, téléchargement, dépôt ≤ 25 Mo, dossiers,
   suppression en 2 temps), **sans** déverrouillage et **sans** accès à
   `data:/apps:/system:/config:` (garanti par construction + testé).
   Sortie = retour à l'écran d'allumage. `Partage/` reste en clair par design.
   En choix direct du dossier `USBos/`, `Partage/` est inaccessible
   (pas de dossier parent en FS API) : l'OS affiche un panneau
   d'avertissement et propose de choisir le dossier parent ; à défaut,
   Réglages → Partage → Reconnecter répare après coup.

## App Agenda

Vrai calendrier : vues **Mois / Semaine / Jour**, événements datés avec
heures de début/fin, journée entière, lieu et description. **Import/export
iCalendar (.ics, RFC 5545)** compatibles Google Agenda, Outlook et Apple :
export en un clic, import d'un fichier `.ics` **ou depuis `Partage/`
(« Depuis Partage/ », sans écraser)** avec confirmation (dédupliqué
sur `UID`). Le fuseau horaire est **détecté automatiquement** (`Intl`) :
stockage en heure locale, export converti en UTC, import reconverti en heure
locale. Migration automatique des anciennes données v1 (semaine type +
échéances → événements datés). Limites connues : récurrence `RRULE`
importée en occurrence unique, `TZID` distant inconnu gardé en heure
affichée (signalé dans la fiche).

## App Mesh

Renommée depuis l'ancien module « P2P/QR » : c'est un canal direct entre
clés USBos (chat + envoi de fichiers), en WebRTC via la signalisation
publique gratuite de PeerJS — pas de scan QR, juste un code court à
communiquer (ex. `LAC-4821`), dans l'esprit LocalSend.

Règles : toute connexion **entrante** doit être acceptée manuellement
(expiration après 60 s) ; le code est une adresse, pas un secret. Envois
plafonnés à **25 Mo** (pas de chunking : au-delà, l'envoi est refusé plutôt
que de saturer la RAM). Dépôt de fichier par drag-drop **ou** sélecteur
(mobile).

## Apps retirées du noyau

`qrcode-generator` et `jsQR` ont été supprimés du projet (demande explicite).
`PeerJS` a été extrait du kernel monolithique vers `apps/mesh/vendor/` :
il n'est chargé qu'à l'ouverture de l'app Mesh, jamais au boot.

## Journal & console — guide d'utilisation

USBos tient un journal unique en mémoire (`system/logbus.js`, façon
`dmesg`) : tout y passe — noyau, VFS, updater, apps (via `ctx.ui.log`),
erreurs JS non interceptées. Deux façons de le consulter :

**1. Bouton « Journal »** (barre du haut) : imprime les 200 dernières
entrées dans la console DevTools (groupe replié « USBos — journal ») et
affiche un rappel `F12`. Le temps réel y est déjà miroiré en continu
(`info` bleu / `warn` jaune / `error` rouge). Il n'y a plus de panneau
dans le site : une page web ne peut pas ouvrir DevTools par code, seul
l'utilisateur le peut. C'est le premier réflexe quand une app affiche
une erreur.

**2. Console DevTools** (`F12` → onglet Console) : API `usbos.*`
(`usbos.help()` liste tout). Formes courtes : `u.<catégorie>.<commande>()`
(ex. `u.logs.tail(100)`), et getters lecture seule **sans parenthèses** :
`u.info` `u.apps` `u.tail` `u.errors` `u.uptime` `u.version` `u.status`
`u.updates` `u.help`. DevTools complète nativement après `u.` (TAB) —
pas de fantôme gris là-bas (limite du navigateur) :

```
usbos.system.info()                    // état : clé, verrou, app active, version
usbos.logs.tail(100)                   // 100 dernières entrées
usbos.logs.filter({ level: 'error' })  // que les erreurs
usbos.logs.filter({ source: 'updater' }) // une source : kernel, vfs, updater,
                                       // console, app:<id>, window, promise
usbos.logs.filter({ contains: 'mesh' })  // recherche plein texte
usbos.logs.level('warn')               // masque debug/info (défaut 'debug')
usbos.logs.export()                    // écrit system/logs/usbos-<date>.log sur la clé
usbos.logs.clear()                     // vide la mémoire (rien sur disque)
usbos.dev.dumpState()                  // résumé safe à coller dans un rapport de bug
usbos.fs.ls('apps:')                   // inspecter la clé (data: déchiffré si déverrouillé)
```

**À savoir** : le journal vit en mémoire (2000 entrées max, au-delà les
anciennes sont jetées) — pour garder une trace, `logs.export()` **avant**
de recharger. `logs.clear()` n'efface rien sur disque. `system.uptime()`
est mesuré au chargement de la console (écart de quelques ms avec le vrai
boot). Les commandes marquées `[destructif]` exigent `{ confirm: true }`
(ex. `usbos.fs.rm('data:notes/x', { confirm: true })`). Côté apps :
`ctx.ui.log(message, niveau?)` avec niveau `debug/info/warn/error`
(défaut `info`, 2000 caractères max).

**3. Palette de commandes** (bouton `⌘` ou `Ctrl+K`) : la façon la plus
rapide — autocomplétion avec fantôme gris, `TAB` pour compléter (répété :
cycle), `↑↓` pour naviguer ou rappeler l'historique, `Entrée` pour
exécuter (`tail 100`, `open notes`, `ls 'apps:'`), `Échap` pour fermer.
Les commandes destructives demandent une 2e `Entrée` de confirmation.
Mêmes commandes et mêmes gardes que `usbos.*`, sans parenthèses à retenir
pour la lecture (`info`, `tail`, `apps`…).
