# USBos

**[Français](README.md) | [English](README.en.md)**

**Ton bureau, tes apps, tes données — sur une clé USB, sans rien installer sur l'ordinateur.**

USBos est un « système » qui tourne entièrement dans le navigateur. Tu le lances depuis une clé USB (ou n'importe quel dossier), et il te donne un bureau avec agenda, notes, gestionnaire de mots de passe, galerie, documents Markdown et chat de fichiers en pair-à-pair — le tout chiffré, et utilisable sur n'importe quel ordinateur où tu branches ta clé.

Aucun serveur, aucune installation, aucun compte à créer. Ce qui est sur la clé reste sur la clé.

## En un coup d'œil

- 🔌 **Portable** — tout vit dans un dossier `USBos/` sur ta clé (ou ton disque). Débranche, rebranche ailleurs, ça continue de fonctionner.
- 🔒 **Chiffré par défaut** — une passphrase optionnelle protège tes données (AES-GCM). Sans elle, tout reste lisible en clair ; avec elle, même quelqu'un qui vole la clé ne peut rien lire.
- 🧩 **7 applications intégrées** — Agenda, Coffre (mots de passe), Galerie, Markdown, Mesh (chat/fichiers P2P), Notes, Boîte à outils.
- 🌐 **Bilingue** — français et anglais, à changer d'un clic.
- 🔄 **Mises à jour automatiques** — USBos vérifie et applique les mises à jour du système et des apps tout seul, en tâche de fond.
- 🚫 **Pas de compte, pas de cloud** — tes données ne quittent jamais ta clé, sauf si tu utilises Mesh pour les envoyer volontairement à quelqu'un.

## À quoi ça ressemble

*(ajoute ici une ou deux captures d'écran du bureau et d'une app — ex. `docs/screenshot-dashboard.png`)*

## Ce dont tu as besoin

- Un navigateur **Chrome, Edge, Brave, Opera ou Vivaldi** (récent). USBos utilise la *File System Access API*, qui n'existe pas sur Firefox ni Safari — tu ne pourras pas installer ou ouvrir une clé avec ces navigateurs.
- Une connexion sécurisée : ouvrir les fichiers depuis `https://`, `http://localhost`, ou directement depuis le disque (`file:`), selon ce que ton navigateur autorise. Un site en `http://` normal refusera la permission.
- Une clé USB, un disque externe, ou même simplement un dossier sur ton ordinateur — tout fonctionne pareil.

## Installer USBos sur une clé

1. Va dans l'onglet **Releases** du dépôt (à droite sur GitHub, ou via le lien direct `.../releases/latest`), télécharge le fichier **`installer.html`** de la dernière version, et ouvre-le dans ton navigateur — pas besoin de cloner ou de télécharger tout le dépôt.
2. Clique sur **Choisir un dossier**, et sélectionne le **dossier parent** où tu veux installer USBos (par exemple la racine de ta clé USB) — pas un dossier `USBos` existant, l'installeur le crée lui-même.
   > Choisir directement un dossier `USBos/` déjà existant limite certaines fonctions de partage — vise toujours le dossier *au-dessus*.
3. Choisis le mode d'installation :

   | Mode | Que fait-il | Quand l'utiliser |
   |---|---|---|
   | **Installation neuve** | Crée USBos à partir de zéro | Première installation |
   | **Différence seulement** | Ne met à jour que ce qui a changé | Mise à jour courante, la plus sûre |
   | **Tout mettre à jour** | Réécrit tout le système et les apps | Après un souci, pour repartir propre (tes données sont conservées) |
   | **Réinstaller à zéro** | Efface tout et recommence | Dernier recours — **détruit tes données** |

4. Une fois l'installation terminée, ouvre **`USBos/index.html`** — c'est ton point d'entrée à partir de maintenant.
5. Au premier lancement, on te propose de définir une **passphrase** pour chiffrer tes données. Tu peux :
   - la définir maintenant (recommandé si tu comptes garder des infos sensibles, ex. dans le Coffre) ;
   - ou cocher « continuer sans passphrase » et l'ajouter plus tard depuis **Réglages → Sécurité**.

   ⚠️ Si tu oublies ta passphrase, tes données chiffrées sont **définitivement perdues** — il n'y a pas de récupération possible, par conception.

## Utiliser USBos au quotidien

- **Rouvrir ta clé** : rebranche-la sur n'importe quel ordinateur compatible, ouvre `USBos/index.html`, entre ta passphrase si tu en as une.
- **Le tableau de bord** : ta page d'accueil — vue rapide sur ton agenda du jour, tes dernières notes et documents, l'état de ton Coffre, et les mises à jour disponibles.
- **Réglages (⚙️)** : apparence (thèmes clair/sombre/sable), sécurité (passphrase), gestion du dossier `Partage/`, informations système.
- **Mises à jour** : USBos vérifie automatiquement en arrière-plan et propose une mise à jour quand une nouvelle version du système ou d'une app est disponible — un bandeau te prévient, rien ne se passe sans ton accord pour un redémarrage.
- **Verrouiller** : le cadenas 🔒 dans l'en-tête reverrouille ta session sans fermer le navigateur.
- **Mode invité** : depuis l'écran de verrouillage, quelqu'un peut consulter/déposer des fichiers dans le dossier `Partage/` sans accéder à tes notes, ton Coffre ou tes réglages.
- **Raccourcis utiles** : `Ctrl+K` ouvre la palette de commandes, `Ctrl+S` sauvegarde, `/` lance une recherche.

### Le dossier `Partage/`

À côté de `USBos/`, l'installeur crée un dossier **`Partage/`** (visible en anglais sous le nom `Shared/`). C'est un espace commun, **volontairement non chiffré**, que toutes les apps peuvent utiliser pour importer ou exporter des fichiers (photos, documents `.md`, agendas `.ics`, etc.) — pratique pour faire entrer ou sortir des fichiers de ta clé sans passer par une app en particulier. N'y mets jamais rien de confidentiel : tout ce qui est dans `Partage/` est lisible sans passphrase.

## Les 7 applications

| App | Ce qu'elle fait |
|---|---|
| 📅 **Agenda** | Calendrier Mois/Semaine/Jour, import/export au format `.ics` (compatible Google, Outlook, Apple) |
| 🔐 **Coffre** | Gestionnaire d'identifiants (utilisateur/mot de passe), protégé par sa propre passphrase en plus du chiffrement général |
| 🖼️ **Galerie** | Stockage et visionnage d'images et de vidéos |
| 📝 **Markdown** | Rédaction de documents avec aperçu, export/import `.md` |
| 📡 **Mesh** | Chat et transfert de fichiers directs entre deux clés USBos, en pair-à-pair (WebRTC) — aucun fichier ne transite par un serveur central |
| 🗒️ **Notes** | Notes rapides avec titre et contenu, recherche intégrée |
| 🧰 **Boîte à outils** | Petits utilitaires (copie, conversions…) |

## Sécurité et vie privée — ce qu'il faut savoir

- Le contenu de tes apps (`data/`) est chiffré avec **AES-GCM** (clé dérivée de ta passphrase par PBKDF2, 210 000 itérations) — un standard robuste et éprouvé.
- Le système lui-même (`system/`, `apps/`) et le dossier `Partage/` restent **non chiffrés** : ce sont des composants du logiciel et des fichiers destinés à l'échange, pas des données personnelles.
- Le Coffre applique un **second chiffrement** avec sa propre passphrase, en plus de celle du système.
- Les mises à jour sont vérifiées par hash (SHA-256) pour garantir qu'elles n'ont pas été corrompues en transit, mais ne sont pas signées cryptographiquement — la confiance repose sur le dépôt source des mises à jour que tu configures.
- USBos ne t'envoie aucune donnée : tout reste local, sauf ce que tu partages toi-même via Mesh.

## Ça ne marche pas ? (dépannage rapide)

- **« Ce navigateur n'est pas supporté »** → utilise Chrome, Edge, Brave, Opera ou Vivaldi. Firefox et Safari ne sont pas compatibles.
- **« Permission refusée » à l'ouverture** → assure-toi d'ouvrir le fichier depuis une adresse `https://`, `http://localhost`, ou en local (`file:`) selon ton navigateur.
- **Des options ou des boutons semblent manquants après une mise à jour** → fais `Ctrl+F5` pour forcer le rechargement (le navigateur garde parfois une ancienne version en cache).
- **Le dossier `Partage/` est indisponible** → tu as probablement choisi directement le dossier `USBos/` au lieu de son parent lors de l'installation. Va dans **Réglages → Partage → Reconnecter**, ou choisis `Changer de clé` et sélectionne le bon dossier parent.
- **J'ai oublié ma passphrase** → il n'y a malheureusement pas de récupération : les données chiffrées sont perdues par conception (aucune porte dérobée n'existe).

---

## Pour les développeurs

Cette section est un résumé technique. Le détail complet (contrat d'une app, format des mises à jour, outils de validation) reste disponible dans le code et dans `skills/usbos-app/SKILL.md`.

### Structure du dépôt

```
USBos/
├── README.md
├── installer.html                    # généré — ne jamais éditer à la main
├── _installer_template.html          # gabarit de l'installeur
├── make_installer.py                 # build de installer.html
│
├── USBos/                            # ce qui est réellement déployé sur la clé
│   ├── index.html                    # lanceur — écran d'allumage
│   │
│   ├── system/                       # noyau — jamais touché par une app
│   │   ├── kernel.js                 # boot, shell UI, chiffrement, pont RPC
│   │   ├── kernel.css
│   │   ├── vfs.js                    # système de fichiers virtuel
│   │   ├── crypto.js                 # PBKDF2 + AES-GCM
│   │   ├── logbus.js                 # journal mémoire (dmesg-like)
│   │   ├── console.js                # API window.usbos / u + palette
│   │   ├── updater.js                # mise à jour delta via HTTPS
│   │   ├── upack.js                  # conteneur .upack (JS)
│   │   ├── version.json
│   │   ├── files.json                # descripteur updater (généré)
│   │   └── lang/
│   │       ├── fr.json
│   │       └── en.json
│   │
│   ├── apps/                         # 7 apps sandboxées (iframe srcdoc)
│   │   ├── agenda/
│   │   │   ├── index.js
│   │   │   ├── manifest.json
│   │   │   ├── version.json
│   │   │   └── files.json
│   │   ├── coffre/
│   │   │   └── … (mêmes 4 fichiers)
│   │   ├── gallery/
│   │   │   ├── vendor/upack.js
│   │   │   └── … (mêmes 4 fichiers)
│   │   ├── markdown/
│   │   │   └── … (mêmes 4 fichiers)
│   │   ├── mesh/
│   │   │   ├── vendor/peerjs.min.js
│   │   │   └── … (mêmes 4 fichiers)
│   │   ├── notes/
│   │   │   └── … (mêmes 4 fichiers)
│   │   └── toolbox/
│   │       └── … (mêmes 4 fichiers)
│   │
│   └── config/
│       └── update-sources.json       # dépôts HTTPS (noyau + apps)
│
├── skills/
│   └── usbos-app/                    # guide pour créer une nouvelle app
│       ├── SKILL.md
│       ├── contract.md
│       ├── publishing.md
│       ├── validate.py
│       └── template/
│           ├── index.js
│           ├── manifest.json
│           └── version.json
│
└── tools/                            # scripts de build et de validation
    ├── validate-versions.py
    ├── validate-lang.py
    ├── gen_files_json.py
    ├── upack.py
    ├── test-lang.cjs
    └── test-upack.cjs
```

**Non versionné mais généré/créé à l'usage** (absent de l'arbre ci-dessus) :
- `USBos/data/` — données utilisateur chiffrées
- `USBos/.update/` — staging et sauvegardes de l'updater
- `Partage/` — sibling de `USBos/`, créé par l'installeur

### Contrat d'une application

Chaque app est un script classique chargé dans une iframe `srcdoc` isolée (sandbox strict, sans `allow-same-origin`) :

```js
const USBosApp = {
  id: 'mon-app',
  async mount(ctx, stage) {
    // ctx.fs.readJSON/writeJSON/readText/writeText/readBinary/writeBinary
    //   -> données propres à l'app, dans data/<mon-app>/
    // ctx.fs.readShared/writeShared/...  -> Partage/, commun, en clair
    // ctx.ui.log(message, niveau?) / ctx.ui.toast(message)
    // stage: élément DOM où monter l'interface
  },
  async unmount() { /* nettoyage : timers, écouteurs, connexions */ },
};
return USBosApp;
```

Le noyau communique avec chaque app via `postMessage` uniquement ; l'app n'a jamais d'accès direct au système de fichiers ni au DOM du noyau. Voir `skills/usbos-app/SKILL.md` pour le gabarit complet et le script de validation (`validate.py`).

### Publier une nouvelle mise à jour

Une seule commande, un seul endroit à éditer avant de la lancer :

- pour le noyau : `const KERNEL_VERSION` dans `system/kernel.js` ;
- pour une app : le champ `"version"` de `apps/<id>/manifest.json`.

```bash
python tools/release.py
```

Ça régénère automatiquement, pour le noyau **et** chaque app (pas besoin de préciser lesquels ont changé) : les `version.json` miroirs, les `?v=` de `index.html`, tous les `files.json`/hash, et `installer.html` — puis lance `validate-versions.py` et affiche le résultat. Si rien n'a changé quelque part, la sortie est identique (aucun bruit dans git). Il ne reste qu'à committer et pousser sur `main`.

### Outils utiles

```bash
python tools/validate-versions.py      # cohérence des versions dans tout le dépôt
python tools/validate-lang.py          # symétrie des dictionnaires FR/EN
node tools/test-lang.cjs               # tests runtime sur les traductions
python tools/release.py                # la commande unique : synchronise tout et reconstruit installer.html
python tools/upack.py pack|verify|unpack ...   # conteneur .upack (exports/imports)
python skills/usbos-app/validate.py USBos/apps/<id>/   # valider une nouvelle app
```

### Limites connues

- Les descripteurs de mise à jour (`files.json`/`version.json`) sont vérifiés par hash mais **non signés** — la sécurité des mises à jour dépend de la confiance accordée au dépôt source configuré.
- Les noms de fichiers publiables dans une mise à jour sont restreints à `A-Za-z0-9._-/` (pas d'espaces ni d'accents).
- L'export des journaux (`usbos.logs.export()`) produit un fichier en clair — à anonymiser avant de le partager pour un rapport de bug.

## Contribuer

Les retours, rapports de bugs et idées d'apps sont bienvenus via les **Issues** du dépôt. Pour proposer une nouvelle app, commence par `skills/usbos-app/SKILL.md`.