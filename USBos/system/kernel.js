/*
 * USBos — system/kernel.js
 * Noyau réduit : ne connaît RIEN du contenu métier des apps.
 * Responsabilités : boot, persistance du handle de la clé (IndexedDB),
 * verrouillage/passphrase, chargement des apps depuis apps/*, shell UI,
 * délégation des mises à jour à updater.js.
 */
'use strict';

const KERNEL_VERSION = '2.3.2';
const DB_NAME = 'usbos-kernel';
const DB_STORE = 'handles';
const DB_KEY = 'root';
const DB_KEY_SHARED = 'shared'; // handle du dossier Partage/ (sibling de USBos/)

const $ = (id) => document.getElementById(id);
const h = (tag, props, ...children) => {
  const n = document.createElement(tag);
  if (props) for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v);
  }
  for (const c of children.flat()) { if (c == null) continue; n.append(c.nodeType ? c : document.createTextNode(c)); }
  return n;
};

// ---------------------------------------------------------------------
// Persistance du handle racine (survit aux rechargements de page)
// ---------------------------------------------------------------------
const IDB = {
  async open() {
    return new Promise((res, rej) => {
      const rq = indexedDB.open(DB_NAME, 1);
      rq.onupgradeneeded = () => rq.result.createObjectStore(DB_STORE);
      rq.onsuccess = () => res(rq.result);
      rq.onerror = () => rej(rq.error);
    });
  },
  async save(handle, key = DB_KEY) {
    const db = await this.open();
    return new Promise((res, rej) => {
      const tx = db.transaction(DB_STORE, 'readwrite');
      tx.objectStore(DB_STORE).put(handle, key);
      tx.oncomplete = () => { db.close(); res(); };
      tx.onerror = () => { db.close(); rej(tx.error); };
    });
  },
  async load(key = DB_KEY) {
    const db = await this.open();
    return new Promise((res, rej) => {
      const tx = db.transaction(DB_STORE, 'readonly');
      const rq = tx.objectStore(DB_STORE).get(key);
      rq.onsuccess = () => { db.close(); res(rq.result || null); };
      rq.onerror = () => { db.close(); rej(rq.error); };
    });
  },
  async clear(key = DB_KEY) {
    const db = await this.open();
    return new Promise((res, rej) => {
      const tx = db.transaction(DB_STORE, 'readwrite');
      tx.objectStore(DB_STORE).delete(key);
      tx.oncomplete = () => { db.close(); res(); };
      tx.onerror = () => { db.close(); rej(tx.error); };
    });
  },
};

// ---------------------------------------------------------------------
// État global du noyau
// ---------------------------------------------------------------------
const state = {
  vfs: null,
  usbosHandle: null,
  sharedHandle: null, // dossier Partage/ (sibling, en clair par design)
  keyId: null,         // identifiant stable de la clé (config:key.json)
  apps: new Map(),       // id -> { manifest }
  activeAppId: null,
  activeFrame: null,      // iframe sandbox de l'app active
  masterKey: null,        // CryptoKey, en mémoire uniquement, jamais persistée
  plainMode: false,      // vrai si l'utilisateur a refusé la passphrase (données en clair)
  previewVars: null,     // aperçu live d'un custom en édition (non persisté)
  guest: false,          // session invité : Partage/ seul, sans clé maître
  themePrefs: null,      // {theme:'dark'|'light'|'auto'|custom, accent, custom:[]} (config:theme.json)
  uiPrefs: null,         // {radius, fs, density, barpos, side, lang} (config:ui.json)
  dicts: null,           // {fr:{...}, en:{...}, <custom>:...} (system:lang/ + config:lang/)
  wallPrefs: null,       // {preset, slide, intervalSec, apps} (config:wallpaper.json)
  wallTimer: null,       // slideshow des fonds (nettoyé au changement de clé)
  updateTimer: null,     // vérification périodique des màj (jamais en invité)
  updateCheckRunning: false,
  lockTimer: null,       // horloge de l'écran de verrouillage
  wallIdx: 0,
  lastPlan: null,         // dernier plan de mise à jour (pour le dashboard)
  dashTimer: null,        // horloge du dashboard (nettoyée à chaque sortie)
  mq: null,               // MediaQueryList du thème système (watchSystemTheme)
  mqHandler: null,        // handler 'change' associé (évite les doublons/leaks)
  openToken: 0,           // jeton anti-race pour openApp/closeActiveApp
  migrationRunning: false, // garde anti-réentrance des migrations passphrase
};

const LEVEL_MAP = { i: 'info', w: 'warn', e: 'error' };

// ---------------------------------------------------------------------
// Thèmes : jeux complets de variables (miroir de kernel.css — test de
// cohérence dans t12). Injectés dans le srcdoc (les iframes ne voient pas
// les variables du parent) via buildThemeCSS().
// ---------------------------------------------------------------------
const THEMES = {
  dark: {
    bg: '#0d1117', panel: '#161b22', panel2: '#1c2330', border: '#2b3442',
    text: '#e6edf3', muted: '#8b98a9', accent: '#4f8cff', accent2: '#7c5cff',
    ok: '#3fb950', warn: '#d29922', err: '#f85149',
    deep: '#0a0d12', placeholder: '#5c6b7d', logtext: '#9fb0c3', hover: '#232c3d',
    topbar: 'rgba(22,27,34,.8)', side: 'rgba(22,27,34,.55)', chipbg: 'rgba(13,17,23,.6)',
  },
  light: {
    bg: '#efe9dc', panel: '#faf6ec', panel2: '#e7dfcd', border: '#d4c9ae',
    text: '#3d3325', muted: '#7a6c52', accent: '#3a6fd8', accent2: '#6a4fd8',
    ok: '#1e8e3e', warn: '#a85f00', err: '#cf352e',
    deep: '#e2d9c2', placeholder: '#a29372', logtext: '#54482f', hover: '#e0d5b8',
    topbar: 'rgba(250,246,236,.88)', side: 'rgba(250,246,236,.65)', chipbg: 'rgba(61,51,37,.07)',
  },
};
const ACCENTS = {
  blue: { dark: null, light: null }, // défauts des thèmes (pas de surcharge)
  violet: { dark: ['#8b5cf6', '#6d28d9'], light: ['#7c4de8', '#5b21c9'] },
  vert: { dark: ['#34b36b', '#1e8e5a'], light: ['#1e8e3e', '#146c2e'] },
  orange: { dark: ['#e8820c', '#c25e04'], light: ['#c25e04', '#9a4a03'] },
};
const THEME_PATH = 'config:theme.json';

// ---------------------------------------------------------------------
// Couleurs : parsing/mélange pour la dérivation des thèmes custom.
// ---------------------------------------------------------------------
function hexToRgb(hex) {
  const m = /^#([0-9a-f]{6})$/i.exec(String(hex || '').trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function rgbToHex(r, g, b) {
  const c = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`.toLowerCase();
}
function mixHex(a, b, t) {
  const ca = hexToRgb(a), cb = hexToRgb(b);
  if (!ca || !cb || !(t >= 0) || !(t <= 1)) return null;
  return rgbToHex(ca[0] + (cb[0] - ca[0]) * t, ca[1] + (cb[1] - ca[1]) * t, ca[2] + (cb[2] - ca[2]) * t);
}
function rgbaOf(hex, alpha) {
  const c = hexToRgb(hex);
  if (!c) return null;
  const a = Math.max(0, Math.min(1, Number(alpha)));
  if (!isFinite(a)) return null;
  return `rgba(${c[0]},${c[1]},${c[2]},${a})`;
}
// Dérive un jeu complet depuis 4 couleurs (fond, panneaux, texte, accent).
// États ok/warn/err conservés du mode de base (sauf surcharge explicite).
function deriveThemeVars(base, seed) {
  const need = ['bg', 'panel', 'text', 'accent'];
  for (const k of need) if (!hexToRgb(seed[k])) return null;
  const panel2 = mixHex(seed.panel, seed.text, 0.07);
  const border = mixHex(seed.bg, seed.text, 0.20);
  const muted = mixHex(seed.text, seed.bg, 0.45);
  const deep = mixHex(seed.bg, seed.text, 0.04);
  const placeholder = mixHex(seed.text, seed.bg, 0.60);
  const logtext = mixHex(seed.text, seed.bg, 0.25);
  const hover = mixHex(seed.panel2 || seed.panel, seed.text, 0.08);
  const accent2 = mixHex(seed.accent, seed.bg, 0.25);
  if (!panel2 || !border || !muted || !deep || !placeholder || !logtext || !hover || !accent2) return null;
  return {
    bg: seed.bg.toLowerCase(), panel: seed.panel.toLowerCase(), panel2,
    border, text: seed.text.toLowerCase(), muted,
    accent: seed.accent.toLowerCase(), accent2,
    ok: seed.ok && hexToRgb(seed.ok) ? seed.ok.toLowerCase() : base.ok,
    warn: seed.warn && hexToRgb(seed.warn) ? seed.warn.toLowerCase() : base.warn,
    err: seed.err && hexToRgb(seed.err) ? seed.err.toLowerCase() : base.err,
    deep, placeholder, logtext, hover,
    topbar: rgbaOf(seed.panel, 0.85), side: rgbaOf(seed.panel, 0.6), chipbg: rgbaOf(seed.text, 0.07),
  };
}

const VAR_KEYS = ['bg', 'panel', 'panel2', 'border', 'text', 'muted', 'accent', 'accent2', 'ok', 'warn', 'err', 'deep', 'placeholder', 'logtext', 'hover'];
const RGBA_KEYS = ['topbar', 'side', 'chipbg'];
function isCssColorVar(k, v) {
  if (!VAR_KEYS.includes(k) && !RGBA_KEYS.includes(k)) return false;
  if (VAR_KEYS.includes(k)) return !!hexToRgb(v);
  return /^rgba\(\d{1,3},\d{1,3},\d{1,3},(0|1|0?\.\d+)\)$/.test(String(v || '').replace(/\s+/g, ''));
}
/** Valide un thème custom complet {name, dark:{...}, light:{...}} (18 vars chacun). */
function validateCustomTheme(obj) {
  if (!obj || typeof obj !== 'object') return t('shell.errors.badObject');
  const name = String(obj.name || '').trim();
  if (name.length < 1 || name.length > 40) return t('shell.errors.nameLen');
  if (['dark', 'light', 'auto'].includes(name.toLowerCase())) return t('shell.errors.nameReserved');
  if (!/^[a-zA-Z0-9 _-]+$/.test(name)) return t('shell.errors.themeSimpleName');
  for (const mode of ['dark', 'light']) {
    const set = obj[mode];
    if (!set || typeof set !== 'object') return t('shell.errors.themeBlockMissing', { mode });
    for (const k of [...VAR_KEYS, ...RGBA_KEYS]) {
      if (!isCssColorVar(k, set[k])) return t('shell.errors.themeBadVar', { mode, key: k });
    }
  }
  return null; // valide
}

function currentThemePrefs() {
  const p = state.themePrefs || {};
  const custom = Array.isArray(p.custom) ? p.custom.filter((c) => !validateCustomTheme(c)) : [];
  return {
    theme: typeof p.theme === 'string' ? p.theme : 'auto',
    accent: ACCENTS[p.accent] ? p.accent : 'blue',
    custom,
  };
}
function findCustomTheme(name) {
  return currentThemePrefs().custom.find((c) => c.name === name) || null;
}
/** Jeu de variables résolu (custom ou natif + surcharge accent). Aperçu prioritaire. */
function resolveThemeVars() {
  const prefs = currentThemePrefs();
  const mode = resolveThemeName();
  if (state.previewVars && (state.previewVars.dark || state.previewVars.light)) {
    const pv = state.previewVars[mode] || state.previewVars.dark || state.previewVars.light;
    if (pv) return { vars: pv, mode, preview: true };
  }
  const custom = findCustomTheme(prefs.theme);
  const base = custom ? { ...custom[mode] } : { ...THEMES[mode] };
  const acc = (ACCENTS[prefs.accent] || ACCENTS.blue)[mode];
  if (acc) { base.accent = acc[0]; base.accent2 = acc[1]; }
  return { vars: base, mode, preview: false, custom: custom ? custom.name : null };
}
function resolveThemeName() {
  const themeName = currentThemePrefs().theme;
  if (themeName === 'light' || themeName === 'dark') return themeName;
  try {
    return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}
function buildThemeCSS() {
  const { vars } = resolveThemeVars();
  // Les vars sont déjà filtrées (hex/rgba validées) ; échappe quand même
  // une éventuelle fermeture </style> par défense en profondeur.
  const safe = (v) => String(v).replace(/<\/style/gi, '<\\/style');
  return `:root{${Object.entries(vars).map(([k, v]) => `--${k}:${safe(v)}`).join(';')}}`;
}
/** Applique les vars résolues en inline (shell) : les customs marchent comme les natifs. */
function applyResolvedVars() {
  const { vars } = resolveThemeVars();
  const st = document.documentElement.style;
  for (const [k, v] of Object.entries(vars)) st.setProperty(`--${k}`, v);
}
async function loadThemePrefs() {
  try {
    const p = await state.vfs.readJSON(THEME_PATH);
    const custom = Array.isArray(p.custom) ? p.custom.filter((c) => !validateCustomTheme(c)) : [];
    if (custom.length !== (Array.isArray(p.custom) ? p.custom.length : 0)) {
      log('Thème(s) custom invalide(s) ignoré(s).', 'w');
    }
    const theme = p.theme === 'dark' || p.theme === 'light' || p.theme === 'auto' || custom.some((c) => c.name === p.theme)
      ? p.theme : 'auto';
    state.themePrefs = { theme, accent: ACCENTS[p.accent] ? p.accent : 'blue', custom };
    return;
  } catch { /* défaut */ }
  state.themePrefs = { theme: 'auto', accent: 'blue', custom: [] };
}
async function applyTheme(verbose = false) {
  const name = resolveThemeName();
  document.documentElement.dataset.theme = name;
  document.documentElement.dataset.accent = currentThemePrefs().accent;
  applyResolvedVars();
  try {
    await state.vfs.writeJSON(THEME_PATH, currentThemePrefs());
  } catch { /* best effort */ }
  pushThemeToActiveApp();
  if (verbose) {
    const label = currentThemePrefs().theme;
    log(`Thème : ${label} (${name}) · accent ${currentThemePrefs().accent}.`);
  }
}
async function setTheme(theme, accent) {
  const prefs = currentThemePrefs();
  if (theme && (['dark', 'light', 'auto'].includes(theme) || findCustomTheme(theme))) prefs.theme = theme;
  if (accent && ACCENTS[accent]) prefs.accent = accent;
  state.themePrefs = prefs;
  await applyTheme(true);
}
/** Aperçu live d'un custom en cours d'édition (non persisté). */
function previewCustomTheme(darkVars, lightVars) {
  // Ne garde que les vars valides (hex/rgba) : ignore + warn le reste.
  const filterVars = (vars) => {
    if (!vars || typeof vars !== 'object') return null;
    const out = {};
    for (const [k, v] of Object.entries(vars)) {
      if (isCssColorVar(k, v)) out[k] = v;
      else log(`Aperçu thème : variable ignorée ${k}.`, 'w');
    }
    return Object.keys(out).length ? out : null;
  };
  state.previewVars = { dark: filterVars(darkVars), light: filterVars(lightVars) };
  const name = resolveThemeName();
  document.documentElement.dataset.theme = name;
  applyResolvedVars();
  pushThemeToActiveApp();
}
function clearCustomPreview() {
  if (!state.previewVars) return;
  state.previewVars = null;
  const name = resolveThemeName();
  document.documentElement.dataset.theme = name;
  applyResolvedVars();
  pushThemeToActiveApp();
}
/** Ajoute un thème custom validé (rejette doublons et réservés). */
async function addCustomTheme(obj) {
  const err = validateCustomTheme(obj);
  if (err) throw new Error(err);
  const name = String(obj.name).trim();
  const prefs = currentThemePrefs();
  if (prefs.custom.some((c) => c.name.toLowerCase() === name.toLowerCase())) {
    throw new Error(t('shell.errors.nameUsed'));
  }
  prefs.custom = [...prefs.custom, { name, dark: obj.dark, light: obj.light }];
  state.themePrefs = prefs;
  try {
    await state.vfs.writeJSON(THEME_PATH, prefs);
  } catch (e) {
    throw new Error(t('shell.errors.writeFailed', { error: e.message }));
  }
  return name;
}
async function removeCustomTheme(name) {
  const prefs = currentThemePrefs();
  prefs.custom = prefs.custom.filter((c) => c.name !== name);
  if (prefs.theme === name) prefs.theme = 'auto';
  state.themePrefs = prefs;
  await applyTheme(true);
}
function watchSystemTheme() {
  try {
    // Détache l'ancien listener avant de ré-attacher (évite les doublons).
    unwatchSystemTheme();
    const mq = window.matchMedia('(prefers-color-scheme: light)');
    const onChange = () => { if (currentThemePrefs().theme === 'auto') applyTheme(false); };
    if (mq.addEventListener) mq.addEventListener('change', onChange);
    else if (mq.addListener) mq.addListener(onChange);
    state.mq = mq;
    state.mqHandler = onChange;
  } catch { /* non supporté : reste sur le défaut */ }
}
function unwatchSystemTheme() {
  try {
    if (state.mq && state.mqHandler) {
      if (state.mq.removeEventListener) state.mq.removeEventListener('change', state.mqHandler);
      else if (state.mq.removeListener) state.mq.removeListener(state.mqHandler);
    }
  } catch { /* noop */ }
  state.mq = null;
  state.mqHandler = null;
}

// ---------------------------------------------------------------------
// Fonds d'écran : presets de dégradés (+ slides), shell + opt-in par app.
// config:wallpaper.json est en clair -> lisible AVANT déverrouillage, le
// verrou s'affiche donc déjà sur le fond choisi.
// ---------------------------------------------------------------------
const WALLPAPERS = {
  defaut: { dark: null, light: null },
  aurore: {
    dark: 'radial-gradient(1000px 500px at 20% 0%, rgba(124,92,255,.25), transparent 60%), radial-gradient(800px 600px at 90% 100%, rgba(79,140,255,.22), transparent 60%)',
    light: 'radial-gradient(1000px 500px at 20% 0%, rgba(194,94,4,.20), transparent 60%), radial-gradient(800px 600px at 90% 100%, rgba(124,92,255,.14), transparent 60%)',
  },
  coucher: {
    dark: 'linear-gradient(180deg, #2b1a4d 0%, #7c2d5b 55%, #d97706 135%)',
    light: 'linear-gradient(180deg, #e8d9b8 0%, #d9a05b 70%, #b4632a 135%)',
  },
  ocean: {
    dark: 'radial-gradient(1200px 700px at 80% 0%, rgba(34,180,200,.25), transparent 60%), linear-gradient(180deg, #0b1e33 0%, #0d3b4e 120%)',
    light: 'linear-gradient(180deg, #dfe9e4 0%, #aecfc6 80%, #7fb5a8 135%)',
  },
  foret: {
    dark: 'radial-gradient(1200px 700px at 15% 10%, rgba(52,179,107,.22), transparent 60%), linear-gradient(180deg, #0d1f16 0%, #14331f 120%)',
    light: 'linear-gradient(180deg, #e6e4cd 0%, #c9cba0 80%, #9aa06b 135%)',
  },
  desert: {
    dark: 'linear-gradient(180deg, #241a12 0%, #6b4a2a 90%, #a8793f 140%)',
    light: 'linear-gradient(180deg, #f0e6d2 0%, #e0c9a0 75%, #c8a06a 135%)',
  },
};
const WALL_SLIDES = ['aurore', 'coucher', 'ocean', 'foret', 'desert'];
const WALL_INTERVALS = [15, 30, 60];
const WALL_PATH = 'config:wallpaper.json';
// Scènes SVG intégrées (défauts "images", zéro poids, offline, nettes partout).
// Clé publique 'svg:<id>' utilisable comme preset (galerie + slides).
const WALLPAPER_SVG = {
  montagnes: { svg: `<svg xmlns='http://www.w3.org/2000/svg' width='1600' height='900' viewBox='0 0 1600 900'><defs><linearGradient id='s' x1='0' y1='0' x2='0' y2='1'><stop offset='0' stop-color='#1b2340'/><stop offset='.6' stop-color='#4a2d63'/><stop offset='1' stop-color='#c65f3c'/></linearGradient></defs><rect width='1600' height='900' fill='url(#s)'/><circle cx='1150' cy='600' r='90' fill='#f5c86e' opacity='.9'/><path d='M0 620L320 320L560 560L840 280L1120 600L1400 360L1600 540L1600 900L0 900Z' fill='#141b33'/><path d='M0 720L400 520L760 700L1100 540L1600 720L1600 900L0 900Z' fill='#0d1428'/></svg>` },
  vagues: { svg: `<svg xmlns='http://www.w3.org/2000/svg' width='1600' height='900' viewBox='0 0 1600 900'><defs><linearGradient id='s' x1='0' y1='0' x2='0' y2='1'><stop offset='0' stop-color='#0b2a3d'/><stop offset='1' stop-color='#0e4a5e'/></linearGradient></defs><rect width='1600' height='900' fill='url(#s)'/><path d='M0 420Q200 360 400 420T800 420T1200 420T1600 420L1600 900L0 900Z' fill='#15616f' opacity='.8'/><path d='M0 540Q200 480 400 540T800 540T1200 540T1600 540L1600 900L0 900Z' fill='#0e4653'/><path d='M0 660Q200 610 400 660T800 660T1200 660T1600 660L1600 900L0 900Z' fill='#0a2e3a'/></svg>` },
  dunes: { svg: `<svg xmlns='http://www.w3.org/2000/svg' width='1600' height='900' viewBox='0 0 1600 900'><defs><linearGradient id='s' x1='0' y1='0' x2='0' y2='1'><stop offset='0' stop-color='#f0dfb8'/><stop offset='.6' stop-color='#d9b06e'/><stop offset='1' stop-color='#a8793f'/></linearGradient></defs><rect width='1600' height='900' fill='url(#s)'/><circle cx='1250' cy='220' r='80' fill='#fff3d6' opacity='.9'/><path d='M0 560Q400 460 800 560T1600 540L1600 900L0 900Z' fill='#c49a5c'/><path d='M0 700Q400 620 800 700T1600 680L1600 900L0 900Z' fill='#8f6535'/></svg>` },
  boreale: { svg: `<svg xmlns='http://www.w3.org/2000/svg' width='1600' height='900' viewBox='0 0 1600 900'><defs><linearGradient id='s' x1='0' y1='0' x2='0' y2='1'><stop offset='0' stop-color='#060b18'/><stop offset='1' stop-color='#0d2136'/></linearGradient><radialGradient id='g' cx='.5' cy='.5' r='.5'><stop offset='0' stop-color='#5ef2b8' stop-opacity='.8'/><stop offset='1' stop-color='#5ef2b8' stop-opacity='0'/></radialGradient></defs><rect width='1600' height='900' fill='url(#s)'/><ellipse cx='800' cy='330' rx='620' ry='190' fill='url(#g)' opacity='.55'/><path d='M200 260Q500 120 760 250T1300 200' stroke='#7dfcd0' stroke-width='10' fill='none' opacity='.5'/><path d='M0 760L1600 760L1600 900L0 900Z' fill='#081018'/></svg>` },
  soleil: { svg: `<svg xmlns='http://www.w3.org/2000/svg' width='1600' height='900' viewBox='0 0 1600 900'><defs><linearGradient id='s' x1='0' y1='0' x2='0' y2='1'><stop offset='0' stop-color='#2b1a4d'/><stop offset='.55' stop-color='#93355f'/><stop offset='1' stop-color='#e8820c'/></linearGradient></defs><rect width='1600' height='900' fill='url(#s)'/><circle cx='800' cy='560' r='150' fill='#ffd98a'/><rect x='0' y='560' width='1600' height='340' fill='#1c1030' opacity='.55'/><rect x='0' y='600' width='1600' height='14' fill='#1c1030' opacity='.5'/><rect x='0' y='650' width='1600' height='22' fill='#1c1030' opacity='.5'/><rect x='0' y='720' width='1600' height='34' fill='#1c1030' opacity='.5'/></svg>` },
};
const WALL_SLIDES_SVG = ['svg:montagnes', 'svg:vagues', 'svg:dunes', 'svg:boreale', 'svg:soleil'];
const WALL_IMG_DIR = 'config:wallpaper-slides';
const WALL_IMG_MAX = 8 * 1024 * 1024; // 8 Mo par image (réduite à 2048 px à l'import)
const WALL_IMG_MAX_DIM = 2048;
const WALL_IMG_COUNT = 10;
const WALL_IMG_EXTS = ['jpg', 'jpeg', 'png', 'webp', 'gif'];
const WALL_IMG_MIME = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif' };

function wallImageName(name) {
  const s = String(name || '').trim();
  if (!s || s.length > 128) return null;
  if (s === '.' || s === '..' || s.includes('/') || s.includes('\\')) return null;
  if (/[<>:"|?*\x00-\x1f]/.test(s)) return null;
  const ext = (s.split('.').pop() || '').toLowerCase();
  if (!WALL_IMG_EXTS.includes(ext)) return null;
  return s;
}
/** Valide type (magic bytes) + taille. Retourne null si OK, sinon le motif. */
function validateWallImage(buf, name) {
  if (!wallImageName(name)) return t('shell.settings.wallImgName');
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  if (bytes.byteLength > WALL_IMG_MAX) return t('shell.settings.wallTooBig');
  if (bytes.byteLength < 12) return t('shell.settings.wallTooSmall');
  const isJpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const isPng = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  const isGif = bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 &&
    ((bytes[3] === 0x38 && (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61));
  const isWebp = bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50;
  if (!(isJpeg || isPng || isGif || isWebp)) return t('shell.settings.wallBadType');
  return null;
}
function sanitizeWallImages(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const n of list) {
    const s = wallImageName(n);
    if (s && !out.includes(s)) out.push(s);
    if (out.length >= WALL_IMG_COUNT) break;
  }
  return out;
}

function wallSvgUrl(id) {
  const s = WALLPAPER_SVG[id];
  if (!s) return null;
  return 'data:image/svg+xml,' + encodeURIComponent(s.svg);
}
/** Clé de fond valide : preset dégradé ou scène svg:. */
function isWallPreset(key) {
  if (WALLPAPERS[key]) return true;
  return typeof key === 'string' && key.startsWith('svg:') && !!WALLPAPER_SVG[key.slice(4)];
}
/** CSS de fond pour une sélection (dégradé ou url data SVG). */
function wallSelectionCSS(preset, themeName) {
  if (typeof preset === 'string' && preset.startsWith('svg:')) {
    const url = wallSvgUrl(preset.slice(4));
    if (url) return `url("${url}") center/cover no-repeat`;
    return null;
  }
  return wallCSS(preset, themeName);
}
function currentWallPrefs() {
  const p = state.wallPrefs || {};
  return {
    preset: isWallPreset(p.preset) ? p.preset : 'defaut',
    slide: !!p.slide,
    intervalSec: WALL_INTERVALS.includes(p.intervalSec) ? p.intervalSec : 30,
    apps: p.apps && typeof p.apps === 'object' && !Array.isArray(p.apps) ? p.apps : {},
    source: p.source === 'images' ? 'images' : 'presets',
    images: sanitizeWallImages(p.images),
  };
}
function wallCSS(preset, themeName) {
  const w = WALLPAPERS[preset] || WALLPAPERS.defaut;
  return (w && w[themeName]) || null;
}
function wallImageMime(name) {
  return WALL_IMG_MIME[(String(name).split('.').pop() || '').toLowerCase()] || 'application/octet-stream';
}
/** (Re)charge les blob URLs des images (révoque les anciennes). */
async function refreshWallBlobs() {
  if (state.wallBlobs) {
    for (const u of state.wallBlobs.values()) {
      try { URL.revokeObjectURL(u); } catch { /* noop */ }
    }
  }
  state.wallBlobs = new Map();
  for (const name of currentWallPrefs().images) {
    try {
      const buf = await state.vfs.readBinary(`${WALL_IMG_DIR}/${name}`);
      const url = URL.createObjectURL(new Blob([buf], { type: wallImageMime(name) }));
      state.wallBlobs.set(name, url);
    } catch {
      if (window.USBosLog) window.USBosLog.warn('wallpaper', `Image illisible : ${name}`);
    }
  }
}
function wallImageList() {
  const prefs = currentWallPrefs();
  return prefs.images.filter((n) => state.wallBlobs && state.wallBlobs.has(n));
}
function applyWallpaper() {
  const prefs = currentWallPrefs();
  const root = document.documentElement;
  if (prefs.source === 'images') {
    const list = wallImageList();
    if (list.length) {
      const name = list[(state.wallIdx || 0) % list.length];
      root.style.setProperty('--wall', `url("${state.wallBlobs.get(name)}") center/cover no-repeat`);
      return;
    }
  }
  const css = wallSelectionCSS(prefs.preset, resolveThemeName());
  if (css) root.style.setProperty('--wall', css);
  else root.style.removeProperty('--wall');
}
async function loadWallpaper() {
  try {
    const p = await state.vfs.readJSON(WALL_PATH);
    state.wallPrefs = {
      preset: isWallPreset(p.preset) ? p.preset : 'defaut',
      slide: !!p.slide,
      intervalSec: WALL_INTERVALS.includes(p.intervalSec) ? p.intervalSec : 30,
      apps: p.apps && typeof p.apps === 'object' && !Array.isArray(p.apps) ? p.apps : {},
      source: p.source === 'images' ? 'images' : 'presets',
      images: sanitizeWallImages(p.images),
    };
  } catch {
    state.wallPrefs = { preset: 'defaut', slide: false, intervalSec: 30, apps: {}, source: 'presets', images: [] };
  }
  await refreshWallBlobs();
  applyWallpaper();
  startWallSlideshow();
}
async function saveWallpaper(patch) {
  const next = { ...currentWallPrefs(), ...patch };
  next.images = sanitizeWallImages(next.images).slice(0, WALL_IMG_COUNT);
  if (next.source !== 'images') next.source = 'presets';
  state.wallPrefs = next;
  try {
    await state.vfs.writeJSON(WALL_PATH, state.wallPrefs);
  } catch { /* best effort */ }
  await refreshWallBlobs();
  applyWallpaper();
  startWallSlideshow();
}
function stopWallSlideshow() {
  if (state.wallTimer) { clearInterval(state.wallTimer); state.wallTimer = null; }
  state.wallIdx = 0;
}
/** Révoque les blob URLs des fonds (changement de clé). refreshWallBlobs gère déjà le remplacement. */
function clearWallBlobs() {
  if (state.wallBlobs) {
    for (const u of state.wallBlobs.values()) {
      try { URL.revokeObjectURL(u); } catch { /* noop */ }
    }
    state.wallBlobs = null;
  }
}
/** Alias public (console/tests) de saveWallpaper. */
async function setWallpaper(patch) {
  return saveWallpaper(patch || {});
}
/** Avance d'un cran (testable) ; le timer appelle en boucle. */
function stepWallpaper() {
  const prefs = currentWallPrefs();
  if (!prefs.slide) return null;
  if (prefs.source === 'images') {
    const list = wallImageList();
    if (!list.length) return null;
    state.wallIdx = ((state.wallIdx || 0) + 1) % list.length;
    applyWallpaper();
    return list[state.wallIdx];
  }
  const rotation = wallRotation();
  state.wallIdx = ((state.wallIdx || 0) + 1) % rotation.length;
  applyWallpaperPresetOnly(rotation[state.wallIdx]);
  return rotation[state.wallIdx];
}
/** Erreur invité : clé i18n si elle existe, sinon message FR dur. */
function guestDeniedError() {
  const k = 'shell.errors.guestDenied';
  let s = null;
  try { s = tx(k); } catch { s = null; }
  return new Error(s && s !== k ? s : 'Guest session: action denied.');
}
/** Importe une image (validée, réduite si géante) dans les slides. Retourne le nom stocké. */
async function importWallImage(name, buf) {
  if (!state.vfs) throw new Error(t('shell.errors.noKey'));
  if (state.guest) throw guestDeniedError();
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const safe = wallImageName(name);
  if (!safe) throw new Error(t('shell.settings.wallImgName'));
  // Réduction auto (JPEG/PNG/WebP > 2048 px -> JPEG 2048 px) : un fond
  // de 8 Mo décodé pèserait ~100 Mo de pixels. GIF conservés tels quels
  // (animation). Tout échec -> on garde l'original (validé ensuite).
  let data = bytes;
  try {
    data = await downscaleWallImage(bytes, safe);
  } catch { data = bytes; }
  const err = validateWallImage(data, name);
  if (err) throw new Error(err);
  const prefs = currentWallPrefs();
  if (prefs.images.length >= WALL_IMG_COUNT && !prefs.images.includes(safe)) {
    throw new Error(t('shell.settings.wallMaxN', { n: WALL_IMG_COUNT }));
  }
  await state.vfs.writeBinary(`${WALL_IMG_DIR}/${safe}`, data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
  const images = prefs.images.includes(safe) ? prefs.images : [...prefs.images, safe];
  await saveWallpaper({ images });
  return safe;
}
/** Réduit une image trop grande (retourne l'original si inutile/impossible). */
async function downscaleWallImage(bytes, name) {
  const ext = (String(name).split('.').pop() || '').toLowerCase();
  if (ext === 'gif') return bytes; // animation préservée
  if (typeof createImageBitmap !== 'function' || typeof document === 'undefined') return bytes;
  const bmp = await createImageBitmap(new Blob([bytes]));
  try {
    if (bmp.width <= WALL_IMG_MAX_DIM && bmp.height <= WALL_IMG_MAX_DIM) return bytes;
    const scale = WALL_IMG_MAX_DIM / Math.max(bmp.width, bmp.height);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bmp.width * scale));
    canvas.height = Math.max(1, Math.round(bmp.height * scale));
    const g = canvas.getContext('2d');
    if (!g) return bytes;
    g.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    const blob = canvas.convertToBlob
      ? await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.9 })
      : await new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('encode'))), 'image/jpeg', 0.9));
    return new Uint8Array(await blob.arrayBuffer());
  } finally {
    try { bmp.close(); } catch { /* noop */ }
  }
}
async function removeWallImage(name) {
  if (state.guest) throw guestDeniedError();
  const safe = wallImageName(name);
  if (!safe) throw new Error(t('shell.settings.wallImgName'));
  const prefs = currentWallPrefs();
  await state.vfs.remove(`${WALL_IMG_DIR}/${safe}`);
  await saveWallpaper({ images: prefs.images.filter((n) => n !== safe) });
}
function applyWallpaperPresetOnly(preset) {
  const css = wallSelectionCSS(preset, resolveThemeName());
  const root = document.documentElement;
  if (css) root.style.setProperty('--wall', css);
  else root.style.removeProperty('--wall');
  if (window.USBosLog) window.USBosLog.debug('wallpaper', `Fond : ${preset}`);
}
/** Rotation complète : dégradés puis scènes SVG. */
function wallRotation() {
  return [...WALL_SLIDES, ...WALL_SLIDES_SVG];
}
function startWallSlideshow() {
  stopWallSlideshow();
  if (!currentWallPrefs().slide) return;
  state.wallTimer = setInterval(stepWallpaper, currentWallPrefs().intervalSec * 1000);
}

// ---------------------------------------------------------------------
// Mise en page : coins, taille, densité, disposition (config:ui.json).
// Appliqué via dataset sur <html> (shell) + transmis à l'iframe.
// ---------------------------------------------------------------------
const UI_RADIUS = ['carre', 'doux', 'rond'];
const UI_FS = ['s', 'm', 'l'];
const UI_DENSITY = ['compact', 'confort'];
const UI_BARPOS = ['haut', 'bas'];
const UI_SIDE = ['gauche', 'droite'];
const UI_PATH = 'config:ui.json';
// Langues : codes FR/EN natifs + customs chargés (validés). Défaut fixe : fr.
function uiLangOk(l) {
  return l === 'fr' || l === 'en' || !!((state.dicts || {})[l]);
}

function currentUiPrefs() {
  const p = state.uiPrefs || {};
  return {
    radius: UI_RADIUS.includes(p.radius) ? p.radius : 'doux',
    fs: UI_FS.includes(p.fs) ? p.fs : 'm',
    density: UI_DENSITY.includes(p.density) ? p.density : 'confort',
    barpos: UI_BARPOS.includes(p.barpos) ? p.barpos : 'haut',
    side: UI_SIDE.includes(p.side) ? p.side : 'droite',
    lang: uiLangOk(p.lang) ? p.lang : 'fr',
  };
}
async function loadUiPrefs() {
  try {
    const p = await state.vfs.readJSON(UI_PATH);
    state.uiPrefs = {
      radius: UI_RADIUS.includes(p.radius) ? p.radius : 'doux',
      fs: UI_FS.includes(p.fs) ? p.fs : 'm',
      density: UI_DENSITY.includes(p.density) ? p.density : 'confort',
      barpos: UI_BARPOS.includes(p.barpos) ? p.barpos : 'haut',
      side: UI_SIDE.includes(p.side) ? p.side : 'droite',
      lang: uiLangOk(p.lang) ? p.lang : 'fr',
    };
  } catch {
    state.uiPrefs = { radius: 'doux', fs: 'm', density: 'confort', barpos: 'haut', side: 'droite', lang: 'fr' };
  }
  applyUiPrefs();
}
function applyUiPrefs() {
  const p = currentUiPrefs();
  const root = document.documentElement;
  root.dataset.radius = p.radius;
  root.dataset.fs = p.fs;
  root.dataset.density = p.density;
  root.dataset.barpos = p.barpos;
  root.dataset.side = p.side;
  root.lang = langLocale().split('-')[0];
}
async function setUiPrefs(patch) {
  const next = { ...currentUiPrefs() };
  for (const [k, v] of Object.entries(patch || {})) {
    if (k === 'lang') {
      if (uiLangOk(v)) next.lang = v;
      continue;
    }
    const allow = { radius: UI_RADIUS, fs: UI_FS, density: UI_DENSITY, barpos: UI_BARPOS, side: UI_SIDE }[k];
    if (allow && allow.includes(v)) next[k] = v;
  }
  state.uiPrefs = next;
  applyUiPrefs();
  pushUiToActiveApp();
  try {
    await state.vfs.writeJSON(UI_PATH, next);
  } catch { /* best effort */ }
}
/** Pousse la mise en page vers l'iframe active (même mécanisme que le thème). */
function pushUiToActiveApp() {
  if (!state.activeFrame) return;
  try {
    const p = currentUiPrefs();
    state.activeFrame.contentWindow.postMessage({ __usbosUi: p }, '*');
  } catch { /* iframe en cours de destruction : ignoré */ }
}

function log(msg, level = 'i') {
  const busLevel = LEVEL_MAP[level] || 'info';
  window.USBosLog.push(busLevel, 'kernel', msg);
  // Plus de panneau intégré : le journal vit dans la console DevTools
  // (miroir temps réel) + bouton « Journal » (récapitulatif à la demande).
}

// ---------------------------------------------------------------------
// i18n : dictionnaires JSON (system/lang/*.json + customs config:lang/),
// t(path, params) avec repli lang -> en -> fr -> clé, pluriels via
// Intl.PluralRules, dates via Intl + locale active. Les logs restent en FR.
// ---------------------------------------------------------------------
const LANG_BUILTIN = ['fr', 'en'];
const LANG_DIR = 'system:lang';
const LANG_CUSTOM_DIR = 'config:lang';
const LANG_MAX_BYTES = 200 * 1024;
const LANG_CODE_RE = /^[a-z]{2,3}(-[A-Z]{2})?$/;

// Bootstrap i18n pré-vfs : les écrans boot/connexion s'affichent AVANT le
// montage (system/lang/*.json inaccessibles). Mini-duplicat FR/EN des seules
// chaînes de ces écrans (mêmes chemins que les JSON — toute modif doit être
// reportée des deux côtés). Langue = indice localStorage, défaut fr fixe.
const BOOTSTRAP_I18N = {
  fr: {
    'shell.boot.incompleteTitle': 'Installation incomplète',
    'shell.boot.incompleteBody': "Un fichier système manque (vfs/crypto/logbus/updater). Réinstallez USBos via installer.html, sans toucher à data/.",
    'shell.unsupported.title': 'Navigateur non compatible',
    'shell.unsupported.body': "USBos nécessite la File System Access API (Chrome, Edge, Brave, Opera, Vivaldi).",
    'shell.connect.title': 'Allumer USBos',
    'shell.connect.body': "Sélectionnez le dossier USBos (s'il existe déjà) ou son dossier parent (pour une nouvelle installation).",
    'shell.connect.chooseKey': 'Choisir la clé…',
    'shell.connect.guestHint': 'Pas le propriétaire ? Accédez aux fichiers partagés sans mot de passe :',
    'shell.connect.guestBtn': '👤 Explorer en invité…',
    'shell.connect.directWarnTitle': 'Dossier USBos choisi directement',
    'shell.connect.directWarnBody': 'Sans le dossier parent, l’espace Partage/ reste indisponible :',
    'shell.connect.directWarnList1': 'Accès invité depuis l’écran de verrouillage indisponible',
    'shell.connect.directWarnList2': 'Exports vers Partage/ indisponibles',
    'shell.connect.directWarnList3': 'Imports « Depuis Partage/ » indisponibles',
    'shell.connect.directWarnList4': 'Entrée invité dès l’allumage indisponible',
    'shell.connect.directWarnList5': 'Réglages affichera Partage/ : Inactif',
    'shell.connect.directWarnParent': 'Choisir le dossier parent',
    'shell.connect.directWarnContinue': 'Continuer quand même',
    'shell.guest.pickParent': 'Pour l’invité, choisissez le dossier parent (qui contient USBos/).',
    'shell.guest.pickTitle': 'Dossier USBos choisi directement',
    'shell.guest.pickBtn': 'Choisir le dossier parent',
    'shell.topbar.homeTitle': 'Accueil',
    'shell.topbar.homeAria': 'Accueil',
    'shell.topbar.keyNone': 'Clé non connectée',
    'shell.topbar.paletteAria': 'Palette de commandes',
    'shell.topbar.paletteTitle': 'Palette de commandes (Ctrl+K)',
    'shell.topbar.switchKey': 'Changer de clé',
    'shell.topbar.settingsAria': 'Réglages',
    'shell.topbar.settingsTitle': 'Réglages',
    'shell.side.apps': 'Applications',
    'shell.journal.btn': 'Journal',
    'shell.journal.btnAria': 'Journal (console DevTools)',
    'shell.journal.btnTitle': 'Imprime le journal dans la console DevTools (F12)',
    'shell.foot.kernel': 'noyau',
  },
  en: {
    'shell.boot.incompleteTitle': 'Incomplete installation',
    'shell.boot.incompleteBody': 'A system file is missing (vfs/crypto/logbus/updater). Reinstall USBos via installer.html without touching data/.',
    'shell.unsupported.title': 'Unsupported browser',
    'shell.unsupported.body': 'USBos requires the File System Access API (Chrome, Edge, Brave, Opera, Vivaldi).',
    'shell.connect.title': 'Power on USBos',
    'shell.connect.body': 'Select the USBos folder (if it already exists) or its parent folder (for a fresh install).',
    'shell.connect.chooseKey': 'Choose the key…',
    'shell.connect.guestHint': 'Not the owner? Access shared files with no password:',
    'shell.connect.guestBtn': '👤 Continue as guest…',
    'shell.connect.directWarnTitle': 'USBos folder selected directly',
    'shell.connect.directWarnBody': 'Without the parent folder, the Shared/ space stays unavailable:',
    'shell.connect.directWarnList1': 'Guest access from the lock screen unavailable',
    'shell.connect.directWarnList2': 'Exports to Shared/ unavailable',
    'shell.connect.directWarnList3': 'Imports “From Shared/” unavailable',
    'shell.connect.directWarnList4': 'Guest entry at power-on unavailable',
    'shell.connect.directWarnList5': 'Settings will show Shared/ as Inactive',
    'shell.connect.directWarnParent': 'Choose the parent folder',
    'shell.connect.directWarnContinue': 'Continue anyway',
    'shell.guest.pickParent': 'For guest mode, choose the parent folder (containing USBos/).',
    'shell.guest.pickTitle': 'USBos folder selected directly',
    'shell.guest.pickBtn': 'Choose the parent folder',
    'shell.topbar.homeTitle': 'Home',
    'shell.topbar.homeAria': 'Home',
    'shell.topbar.keyNone': 'Key not connected',
    'shell.topbar.paletteAria': 'Command palette',
    'shell.topbar.paletteTitle': 'Command palette (Ctrl+K)',
    'shell.topbar.switchKey': 'Switch key',
    'shell.topbar.settingsAria': 'Settings',
    'shell.topbar.settingsTitle': 'Settings',
    'shell.side.apps': 'Applications',
    'shell.journal.btn': 'Log',
    'shell.journal.btnAria': 'Log (DevTools console)',
    'shell.journal.btnTitle': 'Print the log to the DevTools console (F12)',
    'shell.foot.kernel': 'kernel',
  },
};
function bootLang() {
  try {
    const l = localStorage.getItem('usbos-lang-hint');
    if (l === 'en' || l === 'fr') return l;
  } catch { /* stockage indisponible : défaut fr */ }
  return 'fr';
}
/** bt('shell.connect.title') — t() pré-vfs (bootstrap embarqué, voir ci-dessus). */
function bt(path) {
  const L = BOOTSTRAP_I18N[bootLang()] || BOOTSTRAP_I18N.fr;
  if (typeof L[path] === 'string') return L[path];
  if (typeof BOOTSTRAP_I18N.fr[path] === 'string') return BOOTSTRAP_I18N.fr[path];
  return path;
}

function availableLangs() {
  const out = [...LANG_BUILTIN];
  for (const code of Object.keys(state.dicts || {})) {
    if (!out.includes(code)) out.push(code);
  }
  return out;
}
function currentLang() {
  const l = state.uiPrefs && state.uiPrefs.lang;
  if (l && (state.dicts || {})[l]) return l;
  return 'fr';
}
function langLocale() {
  const l = currentLang();
  if (l === 'fr') return 'fr-FR';
  if (l === 'en') return 'en-US';
  const custom = (state.dicts || {})[l];
  if (custom && typeof custom.locale === 'string') return custom.locale;
  return 'fr-FR';
}
function getPath(obj, path) {
  let cur = obj;
  for (const part of String(path).split('.')) {
    if (!cur || typeof cur !== 'object') return undefined;
    cur = cur[part];
  }
  return cur;
}
function fmtStr(s, params) {
  return String(s).replace(/\{(\w+)\}/g, (_, k) => (params && params[k] != null ? String(params[k]) : `{${k}}`));
}
/** t('shell.desktop.empty') — repli lang -> en -> fr -> clé. */
function t(path, params) {
  const dicts = state.dicts || {};
  for (const l of [currentLang(), 'en', 'fr']) {
    const v = getPath((dicts[l] || {}).dict, path);
    if (typeof v === 'string') return fmtStr(v, params);
  }
  return path;
}
/** tp('shell.files.n', count) — pluriels {one, other} (+ few/many si fournis). */
function tp(path, count, params) {
  const n = Number(count) || 0;
  let form = 'other';
  try {
    form = new Intl.PluralRules(currentLang()).select(n);
  } catch { /* repli other */ }
  const dicts = state.dicts || {};
  for (const l of [currentLang(), 'en', 'fr']) {
    const v = getPath((dicts[l] || {}).dict, path);
    if (v && typeof v === 'object') {
      const s = v[form] || v.other;
      if (typeof s === 'string') return fmtStr(s, { ...(params || {}), n });
    }
  }
  return `${path} (${n})`;
}
/** tx(path) = t() après montage, bt() avant (mêmes chemins) — pour les flux mixtes (ex. invité). */
function tx(path, params) {
  const d = state.dicts || {};
  if (d[currentLang()] || d.en || d.fr) return t(path, params);
  const s = bt(path);
  return params ? fmtStr(s, params) : s;
}
/** Enregistre un pack custom validé (config:lang/<code>.json) puis recharge. */
async function saveLangPack(obj) {
  const err = validateLangPack(obj);
  if (err) throw new Error(err);
  const pack = { kind: 'usbos-lang', lang: obj.lang, dict: obj.dict };
  if (typeof obj.locale === 'string' && obj.locale) pack.locale = obj.locale.slice(0, 32);
  await state.vfs.writeJSON(`${LANG_CUSTOM_DIR}/${obj.lang}.json`, pack);
  await loadLangs();
  return obj.lang;
}
async function removeLangPack(code) {
  if (LANG_BUILTIN.includes(code)) throw new Error(t('shell.errors.nativeLang'));
  await state.vfs.remove(`${LANG_CUSTOM_DIR}/${code}.json`);
  await loadLangs();
  if (currentLang() !== code) return;
  await setLang('fr');
}
/** Exporte un pack (natif ou custom) vers Partage/ comme modèle modifiable. */
async function exportLangPack(code) {
  const entry = (state.dicts || {})[code];
  if (!entry || !entry.dict) throw new Error(t('shell.errors.unknownLang', { lang: code }));
  const pack = { kind: 'usbos-lang', lang: code, dict: entry.dict };
  if (entry.locale) pack.locale = entry.locale;
  const safe = String(code).replace(/[^a-zA-Z0-9-]/g, '-');
  await state.vfs.writeText(`shared:${safe}.usbos-lang.json`, JSON.stringify(pack, null, 2));
  return `${safe}.usbos-lang.json`;
}
async function importLangPackText(text) {
  let obj;
  try {
    obj = JSON.parse(text);
  } catch {
    throw new Error(t('shell.errors.badJSON'));
  }
  return saveLangPack(obj);
}
function validateLangPack(obj) {
  if (!obj || typeof obj !== 'object') return t('shell.errors.badObject');
  if (obj.kind && obj.kind !== 'usbos-lang') return t('shell.errors.langNotPack');
  const code = String(obj.lang || '').trim();
  if (!LANG_CODE_RE.test(code)) return t('shell.errors.langBadCode');
  if (['fr', 'en'].includes(code)) return t('shell.errors.nativeLang');
  if (!obj.dict || typeof obj.dict !== 'object') return t('shell.errors.langNoDict');
  let text = '';
  try {
    text = JSON.stringify(obj.dict);
  } catch {
    return t('shell.errors.dictNotSerializable');
  }
  if (text.length > LANG_MAX_BYTES) return t('shell.errors.dictTooBig');
  if (/<\s*script/i.test(text)) return t('shell.errors.langBadContent');
  return null;
}
async function loadLangs() {
  const dicts = {};
  for (const code of LANG_BUILTIN) {
    try {
      // Natifs enveloppés comme les customs ({dict}) : t()/tp()/iframe uniformes.
      dicts[code] = { dict: await state.vfs.readJSON(`${LANG_DIR}/${code}.json`) };
    } catch (err) {
      log(`Dictionnaire manquant : ${code}.json (${err.message})`, 'w');
    }
  }
  try {
    const entries = await state.vfs.list(LANG_CUSTOM_DIR);
    for (const e of entries) {
      if (e.kind !== 'file' || !e.name.endsWith('.json')) continue;
      try {
        const obj = await state.vfs.readJSON(`${LANG_CUSTOM_DIR}/${e.name}`);
        const err = validateLangPack(obj);
        if (err) {
          log(`Pack de langue ignoré (${e.name}) : ${err}`, 'w');
          continue;
        }
        dicts[obj.lang] = { locale: obj.locale, dict: obj.dict };
      } catch (err) {
        log(`Pack de langue illisible (${e.name}) : ${err.message}`, 'w');
      }
    }
  } catch { /* aucun custom : normal */ }
  state.dicts = dicts;
}
function langDisplayName(code) {
  if (code === 'fr') return t('shell.lang.french');
  if (code === 'en') return t('shell.lang.english');
  return code;
}
async function setLang(lang) {
  if (!availableLangs().includes(lang)) throw new Error(t('shell.errors.unknownLang', { lang }));
  await setUiPrefs({ lang });
  try { localStorage.setItem('usbos-lang-hint', lang === 'en' ? 'en' : 'fr'); } catch { /* pré-vfs restera en FR */ }
  document.documentElement.lang = langLocale().split('-')[0];
  // Le shell se repeint via re-rendu ; l'app ouverte rouvre (brouillon perdu — signalé).
  if (state.activeAppId) {
    toast(t('shell.lang.reopenWarn'));
    const id = state.activeAppId;
    await closeActiveApp();
    await openApp(id);
  } else if (state.activePage) {
    await openPage(state.activePage);
  }
  refreshChromeLabels();
}

// ---------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------
async function boot() {
  renderShellSkeleton();

  if (!window.USBosVFS || !window.USBosCrypto || !window.USBosLog || !window.USBosUpdater) {
    const stage = $('stage');
    if (stage) stage.append(h('div', { class: 'connect' },
      h('h2', {}, bt('shell.boot.incompleteTitle')),
      h('p', {}, bt('shell.boot.incompleteBody'))
    ));
    return;
  }

  if (typeof window.showDirectoryPicker !== 'function') {
    renderUnsupported();
    return;
  }

  let saved = null;
  try {
    saved = await IDB.load();
  } catch {
    saved = null;
  }
  if (saved) {
    let ok = false;
    try {
      ok = await window.USBosVFS.VFS.ensurePermission(saved, 'readwrite');
    } catch {
      ok = false;
    }
    let valid = false;
    try {
      valid = ok && (await window.USBosVFS.looksLikeUSBosRoot(saved));
    } catch {
      valid = false;
    }
    if (valid) {
      try {
        let shared = null;
        try {
          const s = await IDB.load(DB_KEY_SHARED);
          if (s && (await window.USBosVFS.VFS.ensurePermission(s, 'readwrite'))) shared = s;
        } catch { shared = null; }
        await attachRoot(saved, shared);
      } catch (err) {
        if (err && err.message === 'cancelled') return; // retour à l'écran de connexion déjà affiché
        log(`Échec de connexion à la clé mémorisée : ${err && err.message}`, 'e');
        await IDB.clear().catch(() => {});
        await IDB.clear(DB_KEY_SHARED).catch(() => {});
        renderConnectScreen();
      }
      return;
    }
    if (ok && !valid) {
      log('Le dossier précédemment mémorisé ne semble plus être une installation USBos valide — oublié.', 'w');
    }
    await IDB.clear().catch(() => {});
    await IDB.clear(DB_KEY_SHARED).catch(() => {});
  }
  renderConnectScreen();
}

const KEY_ID_PATH = 'config:key.json';
// Identifiant stable de la clé (socle comptes/Mesh/auth) : créé au premier
// montage, en clair (config:), indépendant du nom de dossier (renommable).
// Note : tirage par modulo (biais négligeable pour un identifiant non secret).
function genKeyId() {
  const alpha = 'ABCDEFGHJKMNPQRSTUVWXYZ'; // sans 0/O/1/I ambigus
  const buf = new Uint32Array(10);
  crypto.getRandomValues(buf);
  let s = '';
  for (let i = 0; i < 4; i++) s += alpha[buf[i] % alpha.length];
  s += '-';
  for (let i = 4; i < 10; i++) s += String(buf[i] % 10);
  return s;
}
async function loadKeyId() {
  try {
    const k = await state.vfs.readJSON(KEY_ID_PATH);
    if (k && typeof k.keyId === 'string' && /^[A-HJ-NP-Z]{4}-[0-9]{6}$/.test(k.keyId)) {
      state.keyId = k.keyId;
      return k.keyId;
    }
  } catch { /* absent ou illisible : (re)créé ci-dessous */ }
  const id = genKeyId();
  try { await state.vfs.writeJSON(KEY_ID_PATH, { keyId: id, createdAt: Date.now() }); } catch { /* best effort */ }
  state.keyId = id;
  return id;
}

async function attachRoot(usbosHandle, sharedHandle = null) {
  state.usbosHandle = usbosHandle;
  state.sharedHandle = sharedHandle;
  state.masterKey = null;
  state.plainMode = false;
  state.guest = false;
  state.vfs = new window.USBosVFS.VFS(usbosHandle, sharedHandle);
  await state.vfs.ensureLayout();
  await loadKeyId(); // en clair : identité stable avant tout déverrouillage
  await IDB.save(usbosHandle);
  if (sharedHandle) await IDB.save(sharedHandle, DB_KEY_SHARED).catch(() => {});
  else log('Espace Partage/ inactif — reconnectez via le dossier parent pour l’activer.');
  log(`Clé connectée : ${usbosHandle.name} [${state.keyId}]`);
  // Cohérence version : le noyau en mémoire doit correspondre à system:version.json.
  try {
    const v = await state.vfs.readJSON('system:version.json');
    if (v && v.kernel && v.kernel !== KERNEL_VERSION) {
      log(`Version noyau en mémoire (${KERNEL_VERSION}) ≠ version sur clé (${v.kernel}) — rechargez la page après mise à jour.`, 'w');
    }
  } catch { /* version.json absent : première install, ignoré */ }
  await loadWallpaper(); // en clair : le verrou s'affiche déjà sur le fond choisi
  await loadLangs(); // en clair : verrou + invité traduits avant déverrouillage
  await loadUiPrefs(); // en clair (config:) : la langue du verrou/setup suit la préférence
  try {
    await ensureMasterKey(); // bloque jusqu'à déverrouillage/création/invité
  } catch (err) {
    if (err && err.message === 'guest') {
      state.guest = true;
      log('Session invité — Partage/ uniquement, sans déverrouillage.');
      await openPage('guest');
      return;
    }
    throw err;
  }
  await loadThemePrefs();
  await applyTheme(false);
  watchSystemTheme();
  await loadInstalledApps();
  renderDesktop();
  // Vérification réseau APRÈS l'affichage du bureau, en arrière-plan,
  // puis revérification périodique silencieuse (jamais en invité).
  void checkForUpdates().catch(() => {});
  startUpdateChecker();
}

let toastTimer = null;
function toast(msg) {
  document.querySelectorAll('.toast').forEach((n) => n.remove());
  const el = h('div', { class: 'toast', role: 'status' }, msg);
  document.body.append(el);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.remove(), 4000);
}

/** Pousse le thème courant vers l'iframe active (live, sans recharger l'app). */
function pushThemeToActiveApp() {
  if (!state.activeFrame) return;
  try {
    state.activeFrame.contentWindow.postMessage({
      __usbosTheme: { css: buildThemeCSS(), name: resolveThemeName(), accent: currentThemePrefs().accent },
    }, '*');
  } catch { /* iframe en cours de destruction : ignoré */ }
}
// Le bouton « Journal » n'ouvre plus un panneau dans le site : il imprime
// un récapitulatif dans la console DevTools (le temps réel y est déjà
// miroiré par le bus) et indique comment l'ouvrir. On ne peut pas ouvrir
// DevTools par code — seul l'utilisateur le peut (F12).
function openJournalInConsole() {
  try {
    const entries = window.USBosLog.tail(200);
    const n = entries.length;
    // t()/tp() pré-déverrouillage peuvent retourner la clé brute : repli FR dur.
    let title = null;
    try { title = tp('shell.journal.groupTitle', n); } catch { title = null; }
    if (!title || title.includes('shell.journal.groupTitle')) {
      try { title = bt('shell.journal.groupTitle'); } catch { title = null; }
      if (!title || title.includes('.')) title = `USBos log (${n} entries)`;
    }
    console.groupCollapsed(`%c${title}`, 'color:#4f8cff;font-weight:600');
    const fnFor = { debug: 'debug', info: 'log', warn: 'warn', error: 'error' };
    for (const e of entries) {
      console[fnFor[e.level] || 'log'](
        `[${new Date(e.ts).toLocaleTimeString(langLocale())}] [${e.source}] ${e.message}`,
        e.data ?? ''
      );
    }
    console.groupEnd();
  } catch { /* console indisponible : le toast suffit */ }
  toast(t('shell.journal.sentToast'));
}

function stopDashClock() {
  if (state.dashTimer) { clearInterval(state.dashTimer); state.dashTimer = null; }
}
function stopLockClock() {
  if (state.lockTimer) { clearInterval(state.lockTimer); state.lockTimer = null; }
}
function startLockClock() {
  stopLockClock();
  const tick = () => {
    const c = $('lock-clock');
    if (c) c.textContent = dashClock();
    const d = document.querySelector('.lock-date');
    if (d) { try { d.textContent = dashTodayLong(); } catch { /* noop */ } }
    if (!c && !d) stopLockClock();
    else if (!c && d) { /* horloge absente mais date présente : on continue */ }
  };
  state.lockTimer = setInterval(tick, 20000);
}

/** Coquille commune aux écrans verrou/setup : horloge, date, avatar, carte. */
function lockShell(keyName, card, opts = {}) {
  const stage = $('stage');
  stage.classList.remove('app-open');
  stage.innerHTML = '';
  const screen = h('div', { class: 'lock-screen' });
  screen.append(
    h('div', { class: 'lock-clock', id: 'lock-clock' }, dashClock()),
    h('div', { class: 'lock-date' }, dashTodayLong()),
    h('div', { class: 'lock-avatar' }, (keyName || 'U').charAt(0).toUpperCase()),
    card
  );
  // Entrée invité BIEN VISIBLE sous la carte (pas un lien discret).
  if (opts.onGuest) {
    const box = h('div', { class: 'lock-guest' });
    const or = h('div', { class: 'lock-or' }, t('shell.lock.or'));
    const go = h('button', { class: 'btn guest-cta', onclick: opts.onGuest }, t('shell.lock.guestCta'));
    go.type = 'button';
    box.append(or, go, h('div', { class: 'sub' }, t('shell.lock.guestSub')));
    screen.append(box);
  }
  stage.append(screen);
  startLockClock();
  return screen;
}

async function switchKeyFlow() {
  const wasGuest = state.guest;
  state.openToken++;
  await closeActiveApp();
  // En invité, les handles ne sont jamais persistés : ne pas effacer
  // le handle proprio mémorisé en IndexedDB.
  if (!wasGuest) {
    await IDB.clear().catch(() => {});
    await IDB.clear(DB_KEY_SHARED).catch(() => {});
  }
  unwatchSystemTheme();
  try { toastThrottle.clear(); } catch { /* noop */ }
  try { logThrottle.clear(); } catch { /* noop */ }
  stopDashClock();
  stopWallSlideshow();
  clearWallBlobs();
  stopLockClock();
  stopUpdateChecker();
  state.usbosHandle = null;
  state.sharedHandle = null;
  state.vfs = null;
  state.apps.clear();
  state.masterKey = null;
  state.plainMode = false;
  state.guest = false;
  const actions = $('actions');
  if (actions) actions.innerHTML = '';
  const dot = $('dot');
  if (dot) dot.className = 'dot off';
  const label = $('devlabel');
  if (label) label.textContent = t('shell.topbar.keyNone');
  const side = $('side');
  if (side) { side.classList.add('hidden'); side.innerHTML = ''; }
  renderConnectScreen();
}

function renderDirectChoice(picked) {
  const stage = $('stage');
  stage.classList.remove('app-open');
  stage.innerHTML = '';
  const box = h('div', { class: 'connect' });
  box.append(
    h('h2', {}, tx('shell.connect.directWarnTitle')),
    h('p', {}, tx('shell.connect.directWarnBody'))
  );
  const ul = h('ul', { class: 'hint', style: 'text-align:left' });
  ul.append(
    h('li', {}, tx('shell.connect.directWarnList1')),
    h('li', {}, tx('shell.connect.directWarnList2')),
    h('li', {}, tx('shell.connect.directWarnList3')),
    h('li', {}, tx('shell.connect.directWarnList4')),
    h('li', {}, tx('shell.connect.directWarnList5'))
  );
  box.append(ul);
  const row = h('div', { class: 'set-row', style: 'justify-content:center' });
  const parentBtn = h('button', { class: 'btn primary', onclick: () => { void connectFlow(); } }, tx('shell.connect.directWarnParent'));
  parentBtn.type = 'button';
  const contBtn = h('button', { class: 'btn', onclick: async () => {
    try {
      await attachRoot(picked, null);
    } catch (err) {
      log(`Direct attach failed: ${err && err.message}`, 'e');
      renderConnectScreen();
    }
  } }, tx('shell.connect.directWarnContinue'));
  contBtn.type = 'button';
  row.append(parentBtn, contBtn);
  box.append(row);
  stage.append(box);
}

async function connectFlow() {
  try {
    const picked = await window.USBosVFS.pickInstallParentDirectory();
    const alreadyRoot = await window.USBosVFS.looksLikeUSBosRoot(picked);
    // Si le dossier choisi est déjà "USBos" (déjà installé), on l'utilise
    // directement. Sinon on suppose que c'est un dossier parent et on
    // crée/réutilise les sous-dossiers "USBos" + "Partage" dedans.
    // Note : en choix direct de USBos/, le dossier parent est inaccessible
    // (pas de getParent dans la FS API) donc Partage/ reste indisponible.
    let sharedHandle = null;
    let usbosHandle;
    if (alreadyRoot) {
      log('Direct USBos folder selected: Shared/ unavailable — parent folder recommended.', 'w');
      renderDirectChoice(picked);
      return;
    }
    usbosHandle = await window.USBosVFS.ensureUSBosSubdir(picked);
    sharedHandle = await window.USBosVFS.ensureSharedSubdir(picked);
    await attachRoot(usbosHandle, sharedHandle);
  } catch (err) {
    if (err && err.name === 'AbortError') log('Connexion annulée.', 'w');
    else log(`Connexion annulée ou refusée : ${err.message}`, 'e');
  }
}

// ---------------------------------------------------------------------
// Passphrase maître — chiffre TOUTES les données d'apps par défaut
// (pas seulement le Coffre). Clé dérivée en mémoire uniquement, jamais
// écrite sur disque ni dans IndexedDB.
// ---------------------------------------------------------------------
const MASTER_SALT_PATH = 'config:master.salt';
const MASTER_CHECK_PATH = 'config:master.check';
const MASTER_CHECK_PLAINTEXT = 'USBOS-MASTER-OK';
const MIG_JOURNAL_PATH = 'update:mig.json'; // {dir:'encrypt'|'decrypt'|'change'} pendant une migration

async function ensureMasterKey() {
  // Reprise de migration AVANT tout (peut restaurer des fichiers).
  await restoreMigBackup();
  const hasSalt = await state.vfs.exists(MASTER_SALT_PATH);
  if (!hasSalt) {
    // Choix "sans passphrase" mémorisé : pas d'écran, données en clair.
    // Le sel gagne toujours en cas d'état mixte (jamais de downgrade).
    if (await state.vfs.exists(PLAIN_MARKER_PATH)) {
      state.masterKey = null;
      state.plainMode = true;
      log('Session sans passphrase (choix mémorisé) — données stockées en clair.', 'w');
      return;
    }
    await renderSetupPassphrase();
  } else {
    await renderUnlockPassphrase();
  }
}

function renderSetupPassphrase() {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (fn) => { if (done) return; done = true; stopLockClock(); fn(); };
    const stage = $('stage');
    stage.classList.remove('app-open');
    stage.innerHTML = '';
    const p1 = h('input', { type: 'password', placeholder: t('shell.setup.p1'), autocomplete: 'new-password', autocapitalize: 'off', spellcheck: 'false' });
    const p2 = h('input', { type: 'password', placeholder: t('shell.setup.p2'), autocomplete: 'new-password', autocapitalize: 'off', spellcheck: 'false' });
    const err = h('p', { class: 'hint', style: 'color:var(--err)' });
    const submit = async () => {
      if (!p1.value || p1.value.length < 8) { err.textContent = t('shell.setup.min8'); return; }
      if (p1.value !== p2.value) { err.textContent = t('shell.setup.mismatch'); return; }
      try {
        const salt = crypto.getRandomValues(new Uint8Array(16));
        const key = await window.USBosCrypto.deriveMasterKey(p1.value, salt);
        p1.value = ''; p2.value = '';
        const checkBuf = await window.USBosCrypto.encryptBuffer(key, new TextEncoder().encode(MASTER_CHECK_PLAINTEXT));
        await state.vfs.writeBinary(MASTER_SALT_PATH, salt.buffer);
        await state.vfs.writeBinary(MASTER_CHECK_PATH, checkBuf);
        state.masterKey = key;
        log('Passphrase maître créée — toutes les données seront chiffrées (AES-GCM).');
        finish(resolve);
      } catch (e) {
        err.textContent = (e && e.message) || t('shell.errors.failed');
        log(`Création passphrase impossible : ${err.textContent}`, 'e');
      }
    };
    const btn = h('button', { class: 'btn primary', onclick: submit }, t('shell.setup.createBtn'));
    const skipBtn = h('button', { class: 'btn', onclick: () => {
      skipBox.hidden = !skipBox.hidden;
    } }, t('shell.setup.skipBtn'));
    const skipBox = h('div', { class: 'hint', hidden: true });
    const skipCheck = h('input', { type: 'checkbox' });
    const skipWarn = h('span', {}, t('shell.setup.skipWarn'));
    const skipGo = h('button', { class: 'btn', onclick: async () => {
      if (!skipCheck.checked) { err.textContent = t('shell.setup.skipNeedCheck'); return; }
      try {
        state.masterKey = null;
        state.plainMode = true;
        await state.vfs.writeText(PLAIN_MARKER_PATH, 'plain');
        log('Session sans passphrase — données stockées en clair (non chiffrées).', 'w');
        finish(resolve);
      } catch (e) {
        err.textContent = (e && e.message) || t('shell.errors.failed');
        log(`Mode sans passphrase impossible : ${err.textContent}`, 'e');
      }
    } }, t('shell.setup.skipGo'));
    skipBox.append(skipCheck, skipWarn, skipGo);
    const cancel = h('button', { class: 'lock-link', onclick: async () => { await IDB.clear().catch(() => {}); await IDB.clear(DB_KEY_SHARED).catch(() => {}); finish(() => { reject(new Error('cancelled')); switchKeyFlow(); }); } }, t('shell.lock.changeKey'));
    cancel.type = 'button';
    p1.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
    p2.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
    const card = h('div', { class: 'lock-card' });
    card.append(
      h('h2', {}, t('shell.setup.title')),
      h('p', { class: 'hint' }, t('shell.setup.body')),
      p1, p2, err, btn, skipBtn, skipBox
    );
    const links = h('div', { class: 'lock-links' });
    links.append(cancel);
    card.append(links);
    lockShell(state.usbosHandle ? state.usbosHandle.name : 'USBos', card,
      state.sharedHandle ? { onGuest: () => finish(() => reject(new Error('guest'))) } : {});
  });
}

const PLAIN_MARKER_PATH = 'config:no-passphrase';

function renderUnlockPassphrase() {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (fn) => { if (done) return; done = true; stopLockClock(); fn(); };
    const keyName = state.usbosHandle ? state.usbosHandle.name : 'USBos';
    const pass = h('input', { type: 'password', placeholder: t('shell.lock.passPlaceholder'), autocomplete: 'current-password', autocapitalize: 'off', spellcheck: 'false', 'aria-label': t('shell.lock.passAria') });
    const eye = h('button', { class: 'btn lock-eye', 'aria-label': t('shell.lock.showPass'), title: t('shell.lock.showPass') }, '👁');
    eye.type = 'button';
    eye.onclick = () => {
      const show = pass.type === 'password';
      pass.type = show ? 'text' : 'password';
      eye.textContent = show ? '🙈' : '👁';
      const lab = show ? t('shell.lock.hidePass') : t('shell.lock.showPass');
      eye.setAttribute('aria-label', lab);
      eye.title = lab;
      pass.focus();
    };
    const err = h('p', { class: 'lock-err' });
    const caps = h('p', { class: 'lock-caps', style: 'display:none' }, t('shell.lock.capsLock'));
    const card = h('div', { class: 'lock-card' });
    const submit = async () => {
      try {
        const salt = new Uint8Array(await state.vfs.readBinary(MASTER_SALT_PATH));
        const key = await window.USBosCrypto.deriveMasterKey(pass.value, salt);
        pass.value = '';
        const checkBuf = await state.vfs.readBinary(MASTER_CHECK_PATH);
        const plain = new TextDecoder().decode(await window.USBosCrypto.decryptBuffer(key, checkBuf));
        if (plain !== MASTER_CHECK_PLAINTEXT) throw new Error('bad');
        state.masterKey = key;
        log('Clé déverrouillée.');
        finish(resolve);
      } catch {
        err.textContent = t('shell.lock.wrongPass');
        card.classList.remove('shake');
        void card.offsetWidth;
        card.classList.add('shake');
      }
    };
    const btn = h('button', { class: 'btn primary', onclick: submit }, t('shell.lock.unlockBtn'));
    const links = h('div', { class: 'lock-links' });
    const cancel = h('button', { class: 'lock-link', onclick: async () => { await IDB.clear().catch(() => {}); await IDB.clear(DB_KEY_SHARED).catch(() => {}); finish(() => { reject(new Error('cancelled')); switchKeyFlow(); }); } }, t('shell.lock.changeKey'));
    cancel.type = 'button';
    links.append(cancel);
    const passRow = h('div', { class: 'lock-passrow' });
    passRow.append(pass, eye);
    card.append(h('h2', {}, keyName), passRow, caps, err, btn, links);
    pass.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
    pass.addEventListener('keyup', (e) => {
      try {
        caps.style.display = (e.getModifierState && e.getModifierState('CapsLock')) ? 'block' : 'none';
      } catch { /* noop */ }
    });
    lockShell(keyName, card, state.sharedHandle ? { onGuest: () => finish(() => reject(new Error('guest'))) } : {});
    pass.focus();
  });
}


async function loadInstalledApps() {
  state.apps.clear();
  let entries = [];
  try {
    entries = await state.vfs.list('apps:');
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.kind !== 'directory') continue;
    const id = entry.name;
    try {
      const manifest = await state.vfs.readJSON(`apps:${id}/manifest.json`);
      if (manifest.id !== id) {
        log(`App ${id} : id du manifeste incohérent, ignorée`, 'w');
        continue;
      }
      state.apps.set(id, { manifest, instance: null });
    } catch (err) {
      log(`App ${id} : manifest.json illisible (${err.message})`, 'w');
    }
  }
  log(`${state.apps.size} app(s) détectée(s)`);
}

/**
 * Chiffrement transparent des données d'apps (scheme "data:" uniquement).
 * system:/apps:/config: restent en clair (nécessaire au fonctionnement du
 * noyau et de l'updater). Deux régimes : clé maître déverrouillée (AES-GCM)
 * ou mode clair explicite (plainMode, choisi à la création). Sinon refus.
 * Plafonds : 64 Mo par fichier (pré-check via stat si dispo + vérification
 * de la taille du buffer à l'écriture ; le chiffré reste en mémoire le temps
 * du round-trip, d'où ce garde-fou anti-OOM).
 */
async function encryptedWriteBinary(vpath, buf) {
  const size = buf ? (buf.byteLength ?? buf.size ?? buf.length ?? 0) : 0;
  if (size > 64 * 1024 * 1024) throw new Error(t('shell.errors.binTooBig'));
  if (state.masterKey) {
    const enc = await window.USBosCrypto.encryptBuffer(state.masterKey, buf);
    return state.vfs.writeBinary(vpath, enc);
  }
  if (state.plainMode) return state.vfs.writeBinary(vpath, buf);
  throw new Error(t('shell.errors.masterLocked'));
}
async function encryptedReadBinary(vpath) {
  // Pré-check best-effort (si VFS expose stat) pour éviter de charger 100 Mo.
  if (state.vfs && typeof state.vfs.stat === 'function') {
    try {
      const st = await state.vfs.stat(vpath);
      if (st && typeof st.size === 'number' && st.size > 64 * 1024 * 1024) {
        throw new Error(t('shell.errors.binTooBig'));
      }
    } catch (e) {
      if (e && /volumineux|too big|64/i.test(e.message || '')) throw e;
      /* stat indisponible ou fichier absent : on laisse readBinary trancher */
    }
  }
  if (state.masterKey) {
    const enc = await state.vfs.readBinary(vpath);
    return window.USBosCrypto.decryptBuffer(state.masterKey, enc);
  }
  if (state.plainMode) return state.vfs.readBinary(vpath);
  throw new Error(t('shell.errors.masterLocked'));
}

/** Nettoyage post-migration : clearDir d'abord, journal supprimé seulement si OK. */
async function migCleanupSafe() {
  try {
    // create:true : le dossier peut ne pas exister (migration sans fichiers).
    await state.vfs.clearDir('update:mig-backup', true);
  } catch (e) {
    log(`Nettoyage migration impossible : ${e && e.message} — journal conservé pour reprise.`, 'w');
    throw e;
  }
  await state.vfs.remove(MIG_JOURNAL_PATH);
}

/**
 * Ajoute une passphrase APRÈS COUP sur une clé restée en clair : chiffre
 * tout data/ existant. Ordre de bascule sûr : lecture claire complète,
 * chiffrement en mémoire, réécriture des fichiers, puis sel+check EN
 * DERNIER et suppression du marqueur clair. Une panne avant la fin laisse
 * les données lisibles (jamais chiffrées à moitié avec sel manquant :
 * tant que le sel n'est pas écrit, plainMode reste la vérité).
 */
async function setPassphrase(passphrase) {
  if (!state.vfs) throw new Error(t('shell.errors.noKey'));
  if (state.migrationRunning) throw new Error(t('shell.errors.failed', { error: 'migration en cours' }));
  if (state.masterKey) throw new Error(t('shell.errors.alreadyEncrypted'));
  if (!state.plainMode) throw new Error(t('shell.errors.plainOnly'));
  if (!passphrase || String(passphrase).length < 8) throw new Error(t('shell.errors.min8'));
  state.migrationRunning = true;
  log('Migration : chiffrement en cours…');
  try {
    const files = await state.vfs.walk('data:');
    if (files.length >= 5000) throw new Error(t('shell.errors.tooManyFiles'));
    const blobs = [];
    for (const f of files) blobs.push([f, await state.vfs.readBinary(f)]);
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const key = await window.USBosCrypto.deriveMasterKey(passphrase, salt);
    const checkBuf = await window.USBosCrypto.encryptBuffer(key, new TextEncoder().encode(MASTER_CHECK_PLAINTEXT));
    const staged = [];
    for (const [f, buf] of blobs) staged.push([f, await window.USBosCrypto.encryptBuffer(key, buf)]);
    // Sauvegarde claire AVANT bascule (reprise auto au boot si panne).
    await state.vfs.writeJSON(MIG_JOURNAL_PATH, { dir: 'encrypt' });
    for (const [f, buf] of blobs) {
      await state.vfs.writeBinary(`update:mig-backup/${f.replace(/^data:/, '')}`, buf);
    }
    for (const [f, enc] of staged) await state.vfs.writeBinary(f, enc);
    await state.vfs.writeBinary(MASTER_SALT_PATH, salt.buffer);
    await state.vfs.writeBinary(MASTER_CHECK_PATH, checkBuf);
    await state.vfs.remove(PLAIN_MARKER_PATH);
    await migCleanupSafe();
    state.masterKey = key;
    state.plainMode = false;
    log(`Passphrase ajoutée — ${staged.length} fichier(s) chiffré(s).`);
    return tp('shell.errors.migrated', staged.length);
  } finally {
    state.migrationRunning = false;
  }
}

/**
 * Retire la passphrase : re-chiffre... déchiffre tout data/ vers le clair.
 * La passphrase est VÉRIFIÉE contre master.check (jamais de suppression
 * aveugle). Ordre sûr : journal + sauvegarde des originaux chiffrés,
 * réécriture en clair, marqueur clair, suppression sel+check, nettoyage.
 * Chaque état de panne est reprenable (voir restoreMigBackup) : la clé
 * secrète n'est requise qu'ici, jamais au boot.
 */
async function removePassphrase(passphrase) {
  if (!state.vfs) throw new Error(t('shell.errors.noKey'));
  if (state.migrationRunning) throw new Error(t('shell.errors.failed', { error: 'migration en cours' }));
  if (!state.masterKey) throw new Error(t('shell.errors.notEncrypted'));
  if (!passphrase) throw new Error(t('shell.errors.needPass'));
  // Vérifie SANS toucher aux données (même contrôle que l'écran de déverrouillage).
  let key;
  try {
    const salt = new Uint8Array(await state.vfs.readBinary(MASTER_SALT_PATH));
    key = await window.USBosCrypto.deriveMasterKey(passphrase, salt);
    const checkBuf = await state.vfs.readBinary(MASTER_CHECK_PATH);
    const plain = new TextDecoder().decode(await window.USBosCrypto.decryptBuffer(key, checkBuf));
    if (plain !== MASTER_CHECK_PLAINTEXT) throw new Error('bad');
  } catch (err) {
    if (err && err.message === t('shell.lock.wrongPass')) throw err;
    throw new Error(t('shell.lock.wrongPass'));
  }
  state.migrationRunning = true;
  log('Migration : déchiffrement en cours…');
  try {
    const files = await state.vfs.walk('data:');
    if (files.length >= 5000) throw new Error(t('shell.errors.tooManyFiles'));
    // Stocke [f, enc, plain] : enc réutilisé pour le backup (évite la double lecture).
    const blobs = [];
    for (const f of files) {
      const enc = await state.vfs.readBinary(f);
      blobs.push([f, enc, await window.USBosCrypto.decryptBuffer(state.masterKey, enc)]);
    }
    await state.vfs.writeJSON(MIG_JOURNAL_PATH, { dir: 'decrypt' });
    for (const [f, enc] of blobs) {
      await state.vfs.writeBinary(`update:mig-backup/${f.replace(/^data:/, '')}`, enc);
    }
    for (const [f, , plain] of blobs) await state.vfs.writeBinary(f, plain);
    await state.vfs.writeText(PLAIN_MARKER_PATH, 'plain');
    await state.vfs.remove(MASTER_SALT_PATH);
    await state.vfs.remove(MASTER_CHECK_PATH);
    await migCleanupSafe();
    state.masterKey = null;
    state.plainMode = true;
    log(`Passphrase retirée — ${blobs.length} fichier(s) en clair. Redémarrez pour continuer sans protection.`);
    return tp('shell.errors.decryptedN', blobs.length);
  } finally {
    state.migrationRunning = false;
  }
}

/**
 * Change la passphrase (session chiffrée) : vérifie l'ancienne, re-chiffre
 * tout data/ avec la nouvelle. Sauvegarde COMPLÈTE avant bascule (fichiers
 * + sel + check, journal {dir:'change'}) : toute panne se reprend par
 * restauration totale (voir restoreMigBackup) — l'ancienne phrase rouvre.
 */
async function changePassphrase(oldPhrase, newPhrase) {
  if (!state.vfs) throw new Error(t('shell.errors.noKey'));
  if (state.migrationRunning) throw new Error(t('shell.errors.failed', { error: 'migration en cours' }));
  if (!state.masterKey) throw new Error(t('shell.errors.needChange'));
  if (!oldPhrase) throw new Error(t('shell.errors.needOld'));
  if (!newPhrase || String(newPhrase).length < 8) throw new Error(t('shell.errors.newMin8'));
  if (String(newPhrase) === String(oldPhrase)) throw new Error(t('shell.errors.samePass'));
  try {
    const salt = new Uint8Array(await state.vfs.readBinary(MASTER_SALT_PATH));
    const k = await window.USBosCrypto.deriveMasterKey(oldPhrase, salt);
    const checkBuf = await state.vfs.readBinary(MASTER_CHECK_PATH);
    if (new TextDecoder().decode(await window.USBosCrypto.decryptBuffer(k, checkBuf)) !== MASTER_CHECK_PLAINTEXT) throw new Error('bad');
  } catch (err) {
    if (err && err.message === t('shell.lock.wrongPass')) throw err;
    throw new Error(t('shell.lock.wrongPass'));
  }
  state.migrationRunning = true;
  log('Migration : changement de passphrase en cours…');
  try {
    const files = await state.vfs.walk('data:');
    if (files.length >= 5000) throw new Error(t('shell.errors.tooManyFiles'));
    // Stocke [f, enc, plain] : enc réutilisé pour le backup (évite la relecture).
    const blobs = [];
    for (const f of files) {
      const enc = await state.vfs.readBinary(f);
      blobs.push([f, enc, await window.USBosCrypto.decryptBuffer(state.masterKey, enc)]);
    }
    const newSalt = crypto.getRandomValues(new Uint8Array(16));
    const newKey = await window.USBosCrypto.deriveMasterKey(newPhrase, newSalt);
    const newCheck = await window.USBosCrypto.encryptBuffer(newKey, new TextEncoder().encode(MASTER_CHECK_PLAINTEXT));
    const staged = [];
    for (const [f, , plain] of blobs) staged.push([f, await window.USBosCrypto.encryptBuffer(newKey, plain)]);
    await state.vfs.writeJSON(MIG_JOURNAL_PATH, { dir: 'change' });
    for (const [f, enc] of blobs) {
      await state.vfs.writeBinary(`update:mig-backup/${f.replace(/^data:/, '')}`, enc);
    }
    await state.vfs.writeBinary('update:mig-backup/__config__/master.salt', await state.vfs.readBinary(MASTER_SALT_PATH));
    await state.vfs.writeBinary('update:mig-backup/__config__/master.check', await state.vfs.readBinary(MASTER_CHECK_PATH));
    for (const [f, enc] of staged) await state.vfs.writeBinary(f, enc);
    await state.vfs.writeBinary(MASTER_SALT_PATH, newSalt.buffer);
    await state.vfs.writeBinary(MASTER_CHECK_PATH, newCheck);
    await migCleanupSafe();
    state.masterKey = newKey;
    log(`Passphrase changée — ${staged.length} fichier(s) re-chiffré(s).`);
    return tp('shell.errors.rechiffred', staged.length);
  } finally {
    state.migrationRunning = false;
  }
}

/**
 * Reprise après panne de migration (set, remove ou change), selon le journal :
 * - backup vide : rien (nettoie un journal résiduel) ;
 * - journal change : changement interrompu -> restauration TOTALE (fichiers
 *   vers data:, __config__/ vers config:), l'ancienne phrase rouvre ;
 * - sel + journal decrypt : suppression interrompue -> restaure les
 *   originaux chiffrés, l'écran de déverrouillage suit normalement ;
 * - sel + autre : résidu d'ajout -> simple nettoyage ;
 * - sans sel + journal decrypt : résidu post-bascule (fichiers déjà en
 *   clair) -> nettoyage ;
 * - sans sel + autre : ajout interrompu -> restaure le clair.
 */
async function restoreMigBackup() {
  let backup = [];
  try {
    backup = await state.vfs.walk('update:mig-backup');
  } catch {
    return;
  }
  let dir = 'encrypt';
  try {
    const j = await state.vfs.readJSON(MIG_JOURNAL_PATH);
    if (j && (j.dir === 'decrypt' || j.dir === 'encrypt' || j.dir === 'change')) dir = j.dir;
  } catch { /* journal absent : comportement historique */ }
  const cleanup = async () => {
    await migCleanupSafe();
  };
  if (!backup.length) {
    try { await state.vfs.remove(MIG_JOURNAL_PATH); } catch { /* noop */ }
    return;
  }
  if (dir === 'change') {
    let fails = 0;
    for (const b of backup) {
      try {
        const rel = b.replace(/^update:mig-backup\//, '');
        if (!rel || rel.includes('..')) continue;
        const buf = await state.vfs.readBinary(b);
        if (rel.startsWith('__config__/')) await state.vfs.writeBinary(`config:${rel.slice('__config__/'.length)}`, buf);
        else await state.vfs.writeBinary(`data:${rel}`, buf);
      } catch (e) {
        fails++;
        log(`Restauration migration impossible (${b}) : ${e && e.message}`, 'e');
      }
    }
    if (fails > 0) {
      log(`Restauration incomplète (${fails} échec(s)) — journal conservé pour retry.`, 'e');
      throw new Error(t('shell.errors.migRestoreIncomplete', { fails }));
    }
    await cleanup();
    log('Changement interrompu détecté — état précédent restauré (ancienne passphrase).', 'w');
    return;
  }
  const hasSalt = await state.vfs.exists(MASTER_SALT_PATH);
  if (hasSalt && dir === 'decrypt') {
    let fails = 0;
    for (const b of backup) {
      try {
        const rel = b.replace(/^update:mig-backup\//, '');
        if (!rel || rel.includes('..')) continue;
        await state.vfs.writeBinary(`data:${rel}`, await state.vfs.readBinary(b));
      } catch (e) {
        fails++;
        log(`Restauration migration impossible (${b}) : ${e && e.message}`, 'e');
      }
    }
    if (fails > 0) {
      log(`Restauration incomplète (${fails} échec(s)) — journal conservé pour retry.`, 'e');
      throw new Error(t('shell.errors.migRestoreIncomplete', { fails }));
    }
    await cleanup();
    log('Suppression interrompue détectée — originaux chiffrés restaurés.', 'w');
    return;
  }
  if (hasSalt) {
    await cleanup();
    log('Sauvegarde de migration résiduelle nettoyée.', 'w');
    return;
  }
  if (dir === 'decrypt') {
    await cleanup();
    log('Résidu de suppression nettoyé (données déjà en clair).', 'w');
    return;
  }
  {
    let fails = 0;
    for (const b of backup) {
      try {
        const rel = b.replace(/^update:mig-backup\//, '');
        if (!rel || rel.includes('..')) continue;
        const buf = await state.vfs.readBinary(b);
        await state.vfs.writeBinary(`data:${rel}`, buf);
      } catch (e) {
        fails++;
        log(`Restauration migration impossible (${b}) : ${e && e.message}`, 'e');
      }
    }
    if (fails > 0) {
      log(`Restauration incomplète (${fails} échec(s)) — journal conservé pour retry.`, 'e');
      throw new Error(t('shell.errors.migRestoreIncomplete', { fails }));
    }
  }
  await cleanup();
  log('Migration interrompue détectée — données restaurées en clair.', 'w');
}

/**
 * Construit le pont RPC (postMessage) exposé à une app sandboxée. L'iframe
 * n'a AUCUN accès direct à window.USBosVFS, indexedDB ou au handle racine :
 * sandbox="allow-scripts" sans "allow-same-origin" lui donne une origine
 * opaque, distincte de celle du noyau. Toute opération fichier passe par
 * ce pont, scopée ici à data:<activeAppId>/... — c'est une vraie frontière.
 *
 * Règles anti-abus :
 * - l'id d'app utilisé est TOUJOURS state.activeAppId (jamais celui déclaré
 *   par l'iframe, qui serait forgeable) ;
 * - chaque chemin relatif est validé (rejet de "..", caractères interdits) ;
 * - tailles plafonnées (256 Mo par écriture binaire RPC, 2 Mo pour texte/JSON).
 *   Le binaire transite en RAM : au-delà de 256 Mo, passez par Partage/
 *   (dépôt direct, sans pont) ou découpez en .upack.
 */
const RPC_MAX_BINARY = 256 * 1024 * 1024;
const RPC_MAX_TEXT = 2 * 1024 * 1024;
const toastThrottle = new Map(); // appId -> timestamp du dernier toast
const logThrottle = new Map(); // appId -> {n, ts} (max 60 logs/10s par app)

function assertRpcRelPath(p) {
  const s = String(p || '');
  if (!s || s.length > 1024) throw new Error('Chemin RPC invalide.');
  // Validation via le VFS (rejette "..", caractères interdits, profondeur).
  window.USBosVFS.parseVirtualPath(`data:x/${s}`);
  if (s.startsWith('/') || s.includes('\\')) throw new Error(t('shell.errors.rpcBadPath'));
  return s;
}

function handleAppRPC(id, method, args) {
  // L'appelant réel est l'app active : on ignore tout appId forgé.
  const realId = state.activeAppId;
  if (!realId) return Promise.reject(new Error(t('shell.errors.rpcNoApp')));
  if (id !== realId) return Promise.reject(new Error(t('shell.errors.appMismatch')));
  const safeArgs = Array.isArray(args) ? args : [];
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  switch (method) {
    case 'fs.readText': return encryptedReadBinary(`data:${id}/${assertRpcRelPath(safeArgs[0])}`).then((b) => {
      if (b.byteLength > RPC_MAX_TEXT) throw new Error(t('shell.errors.rpcFileTooBig'));
      return dec.decode(b);
    });
    case 'fs.writeText': {
      const text = String(safeArgs[1] ?? '');
      if (enc.encode(text).length > RPC_MAX_TEXT) return Promise.reject(new Error(t('shell.errors.rpcTextTooBig')));
      return encryptedWriteBinary(`data:${id}/${assertRpcRelPath(safeArgs[0])}`, enc.encode(text).buffer);
    }
    case 'fs.readJSON': return encryptedReadBinary(`data:${id}/${assertRpcRelPath(safeArgs[0])}`).then((b) => {
      if (b.byteLength > RPC_MAX_TEXT) throw new Error(t('shell.errors.rpcJsonTooBig'));
      return JSON.parse(dec.decode(b));
    });
    case 'fs.writeJSON': {
      const raw = JSON.stringify(safeArgs[1]);
      if (enc.encode(raw).length > RPC_MAX_TEXT) return Promise.reject(new Error(t('shell.errors.rpcJsonWriteTooBig')));
      return encryptedWriteBinary(`data:${id}/${assertRpcRelPath(safeArgs[0])}`, enc.encode(raw).buffer);
    }
    case 'fs.readBinary': return encryptedReadBinary(`data:${id}/${assertRpcRelPath(safeArgs[0])}`);
    case 'fs.writeBinary': {
      const buf = safeArgs[1];
      const size = buf && (buf.byteLength ?? buf.size);
      if (size != null && size > RPC_MAX_BINARY) return Promise.reject(new Error(t('shell.errors.binTooBig')));
      return encryptedWriteBinary(`data:${id}/${assertRpcRelPath(safeArgs[0])}`, buf);
    }
    case 'fs.exists': return state.vfs.exists(`data:${id}/${assertRpcRelPath(safeArgs[0])}`);
    case 'fs.remove': return state.vfs.remove(`data:${id}/${assertRpcRelPath(safeArgs[0])}`);
    case 'fs.list': {
      const sub = safeArgs[0] ? assertRpcRelPath(safeArgs[0]) : '';
      return state.vfs.list(`data:${id}/${sub}`);
    }
    // Espace Partage/ : COMMUN à toutes les apps (échange + extérieur),
    // en clair par design. Mêmes validations et plafonds que data:.
    case 'fs.readShared': return state.vfs.readBinary(`shared:${assertRpcRelPath(safeArgs[0])}`);
    case 'fs.writeShared': {
      const buf = safeArgs[1];
      const size = buf && (buf.byteLength ?? buf.size);
      if (size != null && size > RPC_MAX_BINARY) return Promise.reject(new Error(t('shell.errors.binTooBig')));
      return state.vfs.writeBinary(`shared:${assertRpcRelPath(safeArgs[0])}`, buf);
    }
    case 'fs.readSharedText': return state.vfs.readText(`shared:${assertRpcRelPath(safeArgs[0])}`).then((txt) => {
      if (new TextEncoder().encode(txt).length > RPC_MAX_TEXT) throw new Error(t('shell.errors.rpcFileTooBig'));
      return txt;
    });
    case 'fs.writeSharedText': {
      const text = String(safeArgs[1] ?? '');
      if (new TextEncoder().encode(text).length > RPC_MAX_TEXT) return Promise.reject(new Error(t('shell.errors.rpcTextTooBig')));
      return state.vfs.writeText(`shared:${assertRpcRelPath(safeArgs[0])}`, text);
    }
    case 'fs.listShared': {
      const sub = safeArgs[0] ? assertRpcRelPath(safeArgs[0]) : '';
      return state.vfs.list(`shared:${sub}`);
    }
    case 'fs.existsShared': return state.vfs.exists(`shared:${assertRpcRelPath(safeArgs[0])}`);
    case 'fs.removeShared': return state.vfs.remove(`shared:${assertRpcRelPath(safeArgs[0])}`);
    // Lecture seule des propres assets statiques de l'app (ex: vendor/lib.js), jamais chiffrés.
    case 'fs.readAppAsset': {
      const rel = assertRpcRelPath(safeArgs[0]);
      return state.vfs.readText(`apps:${id}/${rel}`).then((txt) => {
        if (new TextEncoder().encode(txt).length > RPC_MAX_TEXT) throw new Error(t('shell.errors.rpcAssetTooBig'));
        return txt;
      });
    }
    case 'ui.log': {
      const now = Date.now();
      let rec = logThrottle.get(id);
      if (!rec || now - rec.ts > 10000) { rec = { n: 0, ts: now, warned: false }; logThrottle.set(id, rec); }
      if (rec.n >= 60) {
        if (!rec.warned) { rec.warned = true; window.USBosLog.warn('kernel', `ui.log saturé pour ${id} — logs suivants ignorés (10s).`); }
        return Promise.resolve(null);
      }
      rec.n++;
      const lvl = ['debug', 'info', 'warn', 'error'].includes(safeArgs[1]) ? safeArgs[1] : 'info';
      window.USBosLog.push(lvl, `app:${id}`, String(safeArgs[0]).slice(0, 2000));
      return Promise.resolve(null);
    }
    // Toast shell depuis une app (plafond + anti-spam 1/2s par app).
    case 'ui.toast': {
      const now = Date.now();
      if (now - (toastThrottle.get(id) || 0) < 2000) return Promise.resolve(null);
      toastThrottle.set(id, now);
      toast(String(safeArgs[0]).slice(0, 200));
      return Promise.resolve(null);
    }
    default: return Promise.reject(new Error(t('shell.errors.rpcUnknown', { method })));
  }
}

function escapeForInlineScript(jsonString) {
  return jsonString.replace(/<\/script/gi, '<\\/script').replace(/<!--/g, '<\\!--');
}

// Tokens sandbox autorisés : jamais allow-same-origin / allow-top-navigation*,
// qui casseraient l'isolation (même origine que le noyau).
const SANDBOX_ALLOWLIST = new Set(['allow-scripts', 'allow-forms', 'allow-modals', 'allow-downloads', 'allow-popups']);
const SANDBOX_DEFAULT = 'allow-scripts allow-forms allow-modals allow-downloads';

function sanitizeSandbox(value) {
  const raw = String(value || SANDBOX_DEFAULT).split(/\s+/).filter(Boolean);
  const kept = raw.filter((t) => SANDBOX_ALLOWLIST.has(t));
  if (!kept.includes('allow-scripts')) kept.unshift('allow-scripts');
  if (kept.length !== raw.length) {
    window.USBosLog.warn('kernel', `Tokens sandbox refusés (${raw.filter((t) => !SANDBOX_ALLOWLIST.has(t)).join(', ')}) — allow-same-origin est interdit.`);
  }
  return kept.join(' ');
}

/** Construit le document HTML isolé (srcdoc, pas de fetch réseau) exécutant le code de l'app. */
function buildSandboxSrcdoc(id, manifest, code) {
  const appCodeJson = escapeForInlineScript(JSON.stringify(code));
  const manifestJson = escapeForInlineScript(JSON.stringify(manifest));
  const idJson = escapeForInlineScript(JSON.stringify(id));
  // Opt-in wallpaper : fond transparent -> le fond du shell transparaît
  // (slideshow live inclus, sans message). Défaut : fond uni var(--bg).
  const wallOptIn = !!(currentWallPrefs().apps && currentWallPrefs().apps[id]);
  const uip = currentUiPrefs();
  const appLang = currentLang();
  // L'iframe reçoit son namespace + shell (erreurs communes, ex. échec de montage).
  const fullDict = (((state.dicts || {})[appLang] || {}).dict || {});
  const fullFallback = ((((state.dicts || {}).en || {}).dict || {}));
  const appDict = { ...(fullDict[id] || {}), shell: fullDict.shell || {} };
  const appFallback = { ...(fullFallback[id] || {}), shell: fullFallback.shell || {} };
  const i18nLangJson = escapeForInlineScript(JSON.stringify(appLang));
  const i18nLocaleJson = escapeForInlineScript(JSON.stringify(langLocale()));
  const i18nDictJson = escapeForInlineScript(JSON.stringify(appDict));
  const i18nFallbackJson = escapeForInlineScript(JSON.stringify(appFallback));
  const keyIdJson = escapeForInlineScript(JSON.stringify(state.keyId || null));
  return `<!DOCTYPE html><html lang="${appLang}" data-theme="${resolveThemeName()}" data-accent="${currentThemePrefs().accent}" data-radius="${uip.radius}" data-fs="${uip.fs}" data-density="${uip.density}" data-barpos="${uip.barpos}" data-side="${uip.side}"><head><meta charset="UTF-8">
<style id="usbos-theme">
${buildThemeCSS()}
</style>
<style>
body.optwall{background:transparent}
html,body{height:100%}
html,body{margin:0;background:var(--bg);color:var(--text);font:14px/1.5 system-ui,-apple-system,'Segoe UI',Roboto,sans-serif}
*,*::before,*::after{box-sizing:border-box}
/* Le scroll vit sur #stage (div interne), PAS sur body : l'overflow de body
   est propagé au viewport, que scrolling="no" désactive (contenu bloqué).
   #stage porte aussi la safe-area (avec encoches mobiles via env()). */
body{overflow:hidden;padding:0}
#stage{height:100%;overflow-y:auto;display:flex;flex-direction:column;padding:20px 22px;padding:max(20px,env(safe-area-inset-top)) max(22px,env(safe-area-inset-right)) max(20px,env(safe-area-inset-bottom)) max(22px,env(safe-area-inset-left))}
/* L'app remplit tout l'espace ; un seul scroll (celui-ci), fin et stylé. */
#stage>div{flex:1 0 auto;width:100%;display:flex;flex-direction:column;min-height:0}
*{scrollbar-width:thin;scrollbar-color:var(--border) transparent}
*::-webkit-scrollbar{width:10px;height:10px}
*::-webkit-scrollbar-track{background:transparent}
*::-webkit-scrollbar-thumb{background:var(--border);border-radius:6px;border:2px solid transparent;background-clip:content-box}
*::-webkit-scrollbar-thumb:hover{background:var(--accent);background-clip:content-box;border:2px solid transparent}
/* Accessibilité : focus toujours visible, même dans les apps. */
*:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
/* Mise en page (config:ui.json) : coins + taille. */
html[data-radius="carre"] *{border-radius:0!important}
html[data-fs="s"] body{zoom:.92}html[data-fs="l"] body{zoom:1.1}
@media (prefers-reduced-motion: reduce){*{animation:none!important;transition:none!important}}
</style>
</head><body class="${wallOptIn ? 'optwall' : ''}"><div id="stage"></div>
<script>
(function(){
  const APP_ID = ${idJson};
  const MANIFEST = ${manifestJson};
  const I18N_LANG = ${i18nLangJson};
  const I18N_LOCALE = ${i18nLocaleJson};
  const I18N_DICT = ${i18nDictJson};
  const I18N_FALLBACK = ${i18nFallbackJson};
  let seq = 0;
  const pending = new Map();
  const RPC_TIMEOUT_MS = 30000;
  function call(method, args) {
    return new Promise((resolve, reject) => {
      const id = ++seq;
      const timer = setTimeout(() => {
        if (pending.has(id)) { pending.delete(id); reject(new Error(ctx.i18n.t('shell.errors.rpcTimeout'))); }
      }, RPC_TIMEOUT_MS);
      pending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
      parent.postMessage({ __usbosCall: true, appId: APP_ID, id, method, args }, '*');
    });
  }
  window.addEventListener('message', (e) => {
    if (e.origin !== 'null' && e.origin !== window.location.origin) return;
    const data = e.data;
    if (!data || !data.__usbosReply) return;
    const p = pending.get(data.id);
    if (!p) return;
    pending.delete(data.id);
    if (data.error) p.reject(new Error(data.error)); else p.resolve(data.result);
  });
  const ctx = {
    appId: APP_ID,
    manifest: MANIFEST,
    keyId: ${keyIdJson},
    fs: {
      readText: (p) => call('fs.readText', [p]),
      writeText: (p, c) => call('fs.writeText', [p, c]),
      readJSON: (p) => call('fs.readJSON', [p]),
      writeJSON: (p, o) => call('fs.writeJSON', [p, o]),
      exists: (p) => call('fs.exists', [p]),
      remove: (p) => call('fs.remove', [p]),
      list: (p) => call('fs.list', [p || '']),
      readBinary: (p) => call('fs.readBinary', [p]),
      writeBinary: (p, b) => call('fs.writeBinary', [p, b]),
      readAppAsset: (p) => call('fs.readAppAsset', [p]),
      // Partage/ : espace commun en clair (intérieur + extérieur).
      readShared: (p) => call('fs.readShared', [p]),
      writeShared: (p, b) => call('fs.writeShared', [p, b]),
      readSharedText: (p) => call('fs.readSharedText', [p]),
      writeSharedText: (p, c) => call('fs.writeSharedText', [p, c]),
      listShared: (p) => call('fs.listShared', [p || '']),
      existsShared: (p) => call('fs.existsShared', [p]),
      removeShared: (p) => call('fs.removeShared', [p]),
    },
    ui: { log: (msg, level) => call('ui.log', [msg, level]), toast: (msg) => call('ui.toast', [msg]) },
    i18n: {
      lang: I18N_LANG,
      locale: I18N_LOCALE,
      t: (key, params) => {
        for (const d of [I18N_DICT, I18N_FALLBACK]) {
          const v = String(key).split('.').reduce((o, p) => (o && typeof o === 'object' ? o[p] : undefined), d);
          if (typeof v === 'string') {
            return v.replace(/\{(\w+)\}/g, (m, k) => (params && params[k] != null ? String(params[k]) : m));
          }
        }
        return key;
      },
      tp: (key, count, params) => {
        const n = Number(count) || 0;
        let form = 'other';
        try { form = new Intl.PluralRules(I18N_LANG).select(n); } catch { /* repli other */ }
        for (const d of [I18N_DICT, I18N_FALLBACK]) {
          const v = String(key).split('.').reduce((o, p) => (o && typeof o === 'object' ? o[p] : undefined), d);
          if (v && typeof v === 'object' && typeof (v[form] || v.other) === 'string') {
            return (v[form] || v.other).replace(/\{(\w+)\}/g, (m, k) => (k === 'n' ? String(n) : (params && params[k] != null ? String(params[k]) : m)));
          }
        }
        return key + ' (' + n + ')';
      },
    },
  };
  const stage = document.getElementById('stage');
  let appInstance = null;
  try {
    const factory = new Function(${appCodeJson});
    appInstance = factory();
    if (!appInstance || typeof appInstance.mount !== 'function') throw new Error(ctx.i18n.t('shell.errors.appNoMount'));
    Promise.resolve(appInstance.mount(ctx, stage)).catch((err) => { stage.textContent = ctx.i18n.t('shell.errors.appMount', { error: err.message }); });
  } catch (err) {
    stage.textContent = ctx.i18n.t('shell.errors.appLoad', { id: APP_ID, error: err.message });
  }
  window.addEventListener('message', (e) => {
    if ((e.origin !== 'null' && e.origin !== window.location.origin)) return;
    if (e.data && e.data.__usbosUnmount && appInstance && appInstance.unmount) {
      Promise.resolve(appInstance.unmount()).catch(() => {});
      parent.postMessage({ __usbosUnmounted: true }, '*');
    }
    // Thème live : remplace le bloc de variables sans recharger l'app
    // (les formulaires en cours survivent). Origine vérifiée ci-dessus.
    if (e.data && e.data.__usbosTheme && typeof e.data.__usbosTheme.css === 'string') {      const doc = document.documentElement;
      doc.setAttribute('data-theme', e.data.__usbosTheme.name || '');
      doc.setAttribute('data-accent', e.data.__usbosTheme.accent || '');
      let st = document.getElementById('usbos-theme');
      if (!st) {
        st = document.createElement('style');
        st.id = 'usbos-theme';
        document.head.append(st);
      }
      st.textContent = e.data.__usbosTheme.css;
    }
    // Mise en page live (même mécanisme, valeurs blanchies).
    if (e.data && e.data.__usbosUi && typeof e.data.__usbosUi === 'object') {
      const allow = { radius: ['carre', 'doux', 'rond'], fs: ['s', 'm', 'l'], density: ['compact', 'confort'], barpos: ['haut', 'bas'], side: ['gauche', 'droite'] };
      const doc = document.documentElement;
      for (const [k, vals] of Object.entries(allow)) {
        if (vals.includes(e.data.__usbosUi[k])) doc.dataset[k] = e.data.__usbosUi[k];
      }
    }
  });
})();
<\/script></body></html>`;
}

let rpcListenerInstalled = false;
function installRPCListenerOnce() {
  if (rpcListenerInstalled) return;
  rpcListenerInstalled = true;
  window.addEventListener('message', async (e) => {
    const data = e.data;
    if (!data || !data.__usbosCall) return;
    // N'accepte que les messages venant réellement de l'iframe actif —
    // empêche une autre fenêtre/frame de se faire passer pour une app.
    // Les iframes srcdoc ont une origine opaque ("null") : on l'exige.
    if (e.origin !== 'null' && e.origin !== window.location.origin) return;
    if (!state.activeFrame || e.source !== state.activeFrame.contentWindow) return;
    // L'id réel est celui de l'app active, pas celui déclaré par l'iframe.
    const realId = state.activeAppId;
    if (!realId) return;
    try {
      const result = await handleAppRPC(realId, data.method, data.args);
      state.activeFrame.contentWindow.postMessage({ __usbosReply: true, id: data.id, result }, '*');
    } catch (err) {
      state.activeFrame.contentWindow.postMessage({ __usbosReply: true, id: data.id, error: err.message }, '*');
    }
  });
}

async function openApp(id) {
  const entry = state.apps.get(id);
  if (!entry) { log(`App inconnue : ${id}`, 'e'); return; }
  const tok = ++state.openToken;
  if (state.activeAppId) {
    await closeActiveApp();
    if (tok !== state.openToken) return;
  }
  const stage = $('stage');
  if (tok !== state.openToken) return;
  stage.innerHTML = '';
  stopDashClock();
  try {
    const entryFile = entry.manifest.entry || 'index.js';
    const code = await state.vfs.readText(`apps:${id}/${entryFile}`);
    if (tok !== state.openToken) return;
    installRPCListenerOnce();
    const iframe = document.createElement('iframe');
    // Sandbox le plus strict par défaut (pas d'accès à indexedDB/DOM parent :
    // origine opaque). sanitizeSandbox() interdit allow-same-origin /
    // allow-top-navigation : un manifeste compromis ne peut pas casser
    // l'isolation silencieusement (refus loggé).
    iframe.setAttribute('sandbox', sanitizeSandbox(entry.manifest.sandbox));
    iframe.setAttribute('allow', 'clipboard-write');
    // Pas de scroll natif de l'iframe (non stylé + doublon avec le shell) :
    // le seul scroll vit dans le document srcdoc, déjà stylé.
    iframe.setAttribute('scrolling', 'no');
    iframe.style.cssText = 'width:100%;height:100%;border:none;background:transparent;flex:1;min-height:0;';
    iframe.srcdoc = buildSandboxSrcdoc(id, entry.manifest, code);
    stage.append(iframe);
    stage.classList.add('app-open');
    state.activeFrame = iframe;
    state.activeAppId = id;
    state.activePage = null;
    highlightActiveApp(id);
    highlightActivePage(null);
  } catch (err) {
    stage.classList.remove('app-open');
    stage.append(h('div', { class: 'empty' }, t('shell.errors.appLoad', { id, error: err.message })));
    log(`Erreur app ${id}: ${err.message}`, 'e');
  }
}

async function closeActiveApp() {
  if (state.activeFrame) {
    const frame = state.activeFrame;
    // Handshake : on demande à l'app de se nettoyer et on lui laisse
    // 500 ms pour répondre avant de détruire l'iframe (sinon le message
    // posté juste avant remove() n'est jamais délivré).
    await new Promise((resolve) => {
      let timer = null;
      const done = () => { if (timer) clearTimeout(timer); window.removeEventListener('message', onMsg); resolve(); };
      const onMsg = (e) => {
        if (e.source === frame.contentWindow && e.data && e.data.__usbosUnmounted) done();
      };
      window.addEventListener('message', onMsg);
      try { frame.contentWindow.postMessage({ __usbosUnmount: true }, '*'); } catch { done(); return; }
      timer = setTimeout(done, 500);
    });
    frame.remove();
    state.activeFrame = null;
  }
  state.activeAppId = null;
  const st = $('stage');
  if (st) st.classList.remove('app-open');
}

// ---------------------------------------------------------------------
// Mises à jour (délégué à updater.js)
// ---------------------------------------------------------------------
async function checkForUpdates() {
  if (!window.USBosUpdater || !state.vfs || state.guest) return null;
  try {
    const plan = await window.USBosUpdater.checkAll(state.vfs, KERNEL_VERSION);
    state.lastPlan = plan;
    if (plan && plan.hasUpdates) {
      renderUpdateBanner(plan);
    } else {
      clearUpdateBanner();
    }
    // Rafraîchit la carte "Mises à jour" si le dashboard est affiché.
    const dashPlan = $('dash-update');
    if (dashPlan) renderDashUpdate(dashPlan);
    return plan;
  } catch (err) {
    log(`Vérification de mise à jour impossible (hors-ligne ?) : ${err.message}`, 'w');
    return null;
  }
}

function isIntegrityFailure(err) {
  return /integrity failure|bad hash/i.test(String((err && err.message) || err || ''));
}

async function doApplyPlan(plan) {
  log('Mise à jour en cours…');
  const result = await window.USBosUpdater.apply(state.vfs, plan);
  log('Mise à jour terminée.');
  clearUpdateBanner();
  if (result.kernelChanged) {
    log('Redémarrage requis (noyau modifié).');
    window.location.reload();
  } else {
    await loadInstalledApps();
    renderDesktop();
  }
  return result;
}

async function applyUpdatePlan(plan) {
  try {
    // Le plan du bandeau peut être périmé (descripteurs republiés entre la
    // vérification et le clic) : toujours repartir d'un plan frais.
    let usePlan = plan;
    try {
      const fresh = await checkForUpdates();
      if (fresh && fresh.hasUpdates) {
        usePlan = fresh;
      } else if (fresh && !fresh.hasUpdates) {
        log('Déjà à jour (revérifié avant application).');
        return { kernelChanged: false, alreadyUpToDate: true };
      }
      // fresh null (hors-ligne) : on tente avec le plan du bandeau,
      // l'échec réseau remontera une erreur claire.
    } catch { /* on tente avec le plan du bandeau */ }
    try {
      return await doApplyPlan(usePlan);
    } catch (err) {
      if (!isIntegrityFailure(err)) throw err;
      // Mélange transitoire possible (CDN entre deux générations de
      // descripteurs) : UN seul nouvel essai sur plan refait à neuf.
      // La vérification SHA-256 s'applique à chaque essai : aucun
      // affaiblissement d'intégrité.
      log('Intégrité refusée, nouvelle vérification avant nouvel essai…');
      await new Promise((r) => setTimeout(r, 5000));
      const retry = await checkForUpdates();
      if (retry && retry.hasUpdates) return await doApplyPlan(retry);
      throw err;
    }
  } catch (err) {
    log(`Mise à jour impossible : ${err && err.message}`, 'e');
    try { toast(t('shell.settings.exportFailed', { error: err && err.message })); } catch { /* noop */ }
    throw err;
  }
}

// Vérification périodique silencieuse (bandeau seulement si màj dispo).
const UPDATE_CHECK_MS = 4 * 3600 * 1000;
const UPDATE_JITTER_MS = 10 * 60 * 1000;
function startUpdateChecker() {
  stopUpdateChecker();
  const jitter = Math.floor(Math.random() * UPDATE_JITTER_MS);
  state.updateTimer = setInterval(() => {
    if (state.updateCheckRunning || state.guest || !state.vfs) return;
    state.updateCheckRunning = true;
    checkForUpdates().finally(() => { state.updateCheckRunning = false; });
  }, UPDATE_CHECK_MS + jitter);
}
function stopUpdateChecker() {
  if (state.updateTimer) { clearInterval(state.updateTimer); state.updateTimer = null; }
  state.updateCheckRunning = false;
}

// ---------------------------------------------------------------------
// UI — shell minimal (topbar, sidebar liste d'apps, stage)
// ---------------------------------------------------------------------
function renderShellSkeleton() {
  document.body.innerHTML = '';
  try { document.documentElement.lang = bootLang(); } catch { /* noop */ }
  const app = h('div', { id: 'app' },
    h('header', { class: 'topbar' },
      h('div', { class: 'brand brand-home', role: 'button', tabindex: '0', title: bt('shell.topbar.homeTitle'), 'aria-label': bt('shell.topbar.homeAria'), onclick: () => goToDesktop(), onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); goToDesktop(); } } }, h('div', { class: 'logo', text: 'U' }), 'USBos'),
      h('div', { class: 'dev', id: 'devline' }, h('span', { class: 'dot off', id: 'dot' }), h('span', { id: 'devlabel', text: bt('shell.topbar.keyNone') })),
      h('div', { class: 'actions', id: 'actions' })
    ),
    h('div', { class: 'main' },
      h('aside', { class: 'side hidden', id: 'side' }),
      h('main', { class: 'stage', id: 'stage' })
    ),
    h('footer', { id: 'foot' }, `${bt('shell.foot.kernel')} v${KERNEL_VERSION}`)
  );
  document.body.append(app);
}

function renderUnsupported() {
  $('stage').append(h('div', { class: 'connect' },
    h('h2', {}, bt('shell.unsupported.title')),
    h('p', {}, bt('shell.unsupported.body'))
  ));
}

function renderConnectScreen() {
  const stage = $('stage');
  stage.classList.remove('app-open');
  stage.innerHTML = '';
  stage.append(h('div', { class: 'connect' },
    h('h2', {}, bt('shell.connect.title')),
    h('p', {}, bt('shell.connect.body')),
    h('button', { class: 'btn primary', onclick: connectFlow }, bt('shell.connect.chooseKey')),
    h('p', { class: 'hint' }, bt('shell.connect.guestHint')),
    h('button', { class: 'btn', onclick: guestPickFlow }, bt('shell.connect.guestBtn'))
  ));
}

/**
 * Entrée invité depuis l'allumage : choisit un emplacement, exige une
 * installation USBos valide + Partage/ (créé s'il manque), puis session
 * invité éphémère (handles NON mémorisés : re-sélection à chaque fois).
 */
async function guestPickFlow() {
  if (typeof window.showDirectoryPicker !== 'function') {
    log('File System Access API indisponible dans ce navigateur.', 'e');
    return;
  }
  try {
    const picked = await window.USBosVFS.pickInstallParentDirectory();
    const alreadyRoot = await window.USBosVFS.looksLikeUSBosRoot(picked);
    let usbosHandle, sharedHandle;
    if (alreadyRoot) {
      log('Direct USBos folder selected for guest: Shared/ unreachable — parent folder required.', 'e');
      const stage = $('stage');
      stage.classList.remove('app-open');
      stage.innerHTML = '';
      const box = h('div', { class: 'connect' });
      box.append(
        h('h2', {}, tx('shell.guest.pickTitle')),
        h('p', {}, tx('shell.guest.pickParent'))
      );
      const again = h('button', { class: 'btn primary', onclick: () => { void guestPickFlow(); } }, tx('shell.guest.pickBtn'));
      again.type = 'button';
      box.append(again);
      stage.append(box);
      return;
    }
    try {
      usbosHandle = await picked.getDirectoryHandle('USBos');
    } catch {
      log('Aucune installation USBos dans ce dossier.', 'e');
      return;
    }
    if (!(await window.USBosVFS.looksLikeUSBosRoot(usbosHandle))) {
      log('Dossier USBos non reconnu.', 'e');
      return;
    }
    sharedHandle = await window.USBosVFS.ensureSharedSubdir(picked);
    await guestAttach(usbosHandle, sharedHandle);
  } catch (err) {
    if (err && err.name === 'AbortError') log('Sélection annulée.', 'w');
    else log(`Invité impossible : ${err.message}`, 'e');
  }
}

/** Attache minimale invité : VFS + page, sans clé maître, sans persistance. */
async function guestAttach(usbosHandle, sharedHandle) {
  state.usbosHandle = usbosHandle;
  state.sharedHandle = sharedHandle;
  state.masterKey = null;
  state.plainMode = false;
  state.guest = true;
  state.vfs = new window.USBosVFS.VFS(usbosHandle, sharedHandle);
  // Lecture seule en invité : ne JAMAIS créer config:key.json (pas d'écriture).
  try {
    const k = await state.vfs.readJSON(KEY_ID_PATH);
    if (k && typeof k.keyId === 'string' && /^[A-HJ-NP-Z]{4}-[0-9]{6}$/.test(k.keyId)) state.keyId = k.keyId;
    else state.keyId = null;
  } catch { state.keyId = null; }
  log(`Session invité sur « ${usbosHandle.name} » [${state.keyId || '?'}] — Partage/ uniquement.`);
  await openPage('guest');
}

/** Re-étiquette le chrome persistant (topbar, sidebar, pied) — appelé au montage et après setLang. */
function refreshChromeLabels() {
  const brand = document.querySelector('.brand-home');
  if (brand) { brand.title = t('shell.topbar.homeTitle'); brand.setAttribute('aria-label', t('shell.topbar.homeAria')); }
  const foot = $('foot');
  if (foot && state.usbosHandle) foot.textContent = `${t('shell.foot.kernel')} v${KERNEL_VERSION}`;
  const q = (sel, text, aria, title) => {
    const el = document.querySelector(sel);
    if (!el) return;
    if (text != null) el.textContent = text;
    if (aria != null) el.setAttribute('aria-label', aria);
    if (title != null) el.title = title;
  };
  q('.mini-log', t('shell.journal.btn'), t('shell.journal.btnAria'), t('shell.journal.btnTitle'));
  q('.pal-btn', null, t('shell.topbar.paletteAria'), t('shell.topbar.paletteTitle'));
  q('.switch-btn', t('shell.topbar.switchKey'));
  q('.set-btn', null, t('shell.topbar.settingsAria'), t('shell.topbar.settingsTitle'));
  q('.lock-btn', t('shell.topbar.lockBtn'), t('shell.topbar.lockAria'), t('shell.topbar.lockAria'));
  const sideH = document.querySelector('#side h3');
  if (sideH) sideH.textContent = t('shell.side.apps');
}

function renderDesktop() {
  $('dot').className = 'dot on';
  $('devlabel').textContent = state.usbosHandle.name;
  const actions = $('actions');
  if (!actions.querySelector('.switch-btn')) {
    const logBtn = h('button', { class: 'btn mini-log', 'aria-label': t('shell.journal.btnAria'), onclick: openJournalInConsole, title: t('shell.journal.btnTitle') }, t('shell.journal.btn'));
    const palBtn = h('button', { class: 'btn pal-btn', 'aria-label': t('shell.topbar.paletteAria'), onclick: () => { if (window.USBosPalette) window.USBosPalette.toggle(); }, title: t('shell.topbar.paletteTitle') }, '⌘');
    const switchBtn = h('button', { class: 'btn switch-btn', onclick: switchKeyFlow }, t('shell.topbar.switchKey'));
    const setBtn = h('button', { class: 'btn set-btn', 'aria-label': t('shell.topbar.settingsAria'), onclick: () => openPage('settings'), title: t('shell.topbar.settingsTitle') }, '⚙️');
    const lockBtn = h('button', { class: 'btn lock-btn', 'aria-label': t('shell.topbar.lockAria'), onclick: () => {
      if (!state.masterKey && state.plainMode) { toast(t('shell.topbar.lockPlainNote')); return; }
      try { state.masterKey = null; } catch { /* noop */ }
      window.location.reload();
    }, title: t('shell.topbar.lockAria') }, t('shell.topbar.lockBtn'));
    actions.append(logBtn, palBtn, switchBtn, setBtn, lockBtn);
  }
  refreshChromeLabels();
  const side = $('side');
  side.classList.remove('hidden');
  side.innerHTML = '';
  side.append(h('section', {},
    h('h3', {}, t('shell.side.apps')),
    h('div', { class: 'modlist' },
      ...[...state.apps.values()].map((entry) =>
        h('div', { class: 'mitem', role: 'button', tabindex: '0', 'data-app-id': entry.manifest.id, 'aria-label': entry.manifest.name || entry.manifest.id, onclick: () => openApp(entry.manifest.id), onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openApp(entry.manifest.id); } } },
          h('div', { class: 't' }, entry.manifest.icon ? h('span', { class: 'ic' }, entry.manifest.icon) : null, entry.manifest.name || entry.manifest.id),
          h('div', { class: 'v' }, entry.manifest.version || '')
        )
      )
    )
  ));
  showEmptyStage();
}

function showEmptyStage() {
  const stage = $('stage');
  stage.classList.remove('app-open');
  stage.innerHTML = '';
  stopDashClock();
  state.activePage = 'dashboard';
  highlightActivePage('dashboard');
  renderDashboard(stage);
}

// ---------------------------------------------------------------------
// Pages (vues du noyau : usage & expérience) VS Apps (iframes sandboxées
// : fonctionnel). Registre extensible : toute customisation vit ici.
// ---------------------------------------------------------------------
function accentPair(name) {
  const mode = resolveThemeName();
  const pair = (ACCENTS[name] || ACCENTS.blue)[mode];
  if (pair) return pair;
  return [THEMES[mode].accent, THEMES[mode].accent2];
}

/** Page Réglages : toute la customisation (apparence, sécurité, partage, système). */
function renderSettings(stage) {
  const wrap = h('div', { class: 'dash' });
  const hero = h('div', { class: 'dash-hero' });
  hero.append(
    h('div', { class: 'dash-title' }, h('h2', {}, t('shell.settings.title'))),
    h('p', { class: 'hint' }, t('shell.settings.hint'))
  );
  wrap.append(hero);
  const grid = h('div', { class: 'set-list' });
  wrap.append(grid);
  stage.append(wrap);

  /** Une section = carte + lignes OS (icône, titre+detail, contrôle à droite). */
  function setSection(title) {
    const card = h('div', { class: 'set-section' });
    card.append(h('h3', {}, title));
    grid.append(card);
    return card;
  }
  function setItem(card, icon, title, detail) {
    const row = h('div', { class: 'set-item' });
    row.append(h('span', { class: 'set-ic' }, icon));
    const tx = h('div', { class: 'set-tx' });
    tx.append(h('div', { class: 'set-t' }, title));
    if (detail) tx.append(h('div', { class: 'set-d' }, detail));
    const ctl = h('div', { class: 'set-ctl' });
    row.append(tx, ctl);
    card.append(row);
    return ctl;
  }
  // Cloisonnement : chaque section est rendue isolément — une section en
  // échec affiche une carte d'erreur locale au lieu de faire disparaître
  // toute la suite de la page (symptôme "un seul tableau").
  function sectionGuard(name, fn) {
    try { fn(); }
    catch (err) {
      const msg = `Settings section failed: ${name} (${err && err.message})`;
      try {
        const card = setSection(String(name));
        card.append(h('div', { class: 'dash-empty' }, t('shell.settings.sectionFailed', { error: String((err && err.message) || err) })));
        log(msg, 'e');
      } catch {
        try { log(msg, 'e'); } catch { /* bus log indisponible : abandon silencieux */ }
      }
    }
  }

  // Apparence
  sectionGuard(t('shell.settings.appearance'), () => {
    const card = setSection(t('shell.settings.appearance'));
    const segCtl = setItem(card, '◐', t('shell.settings.themeTitle'), t('shell.settings.themeDetail'));
    const seg = h('div', { class: 'segmented' });
    for (const [v, label] of [['dark', t('shell.settings.themeDark')], ['light', t('shell.settings.themeLight')], ['auto', t('shell.settings.themeAuto')]]) {
      const b = h('button', { class: 'seg' + (currentThemePrefs().theme === v ? ' on' : ''), 'aria-pressed': currentThemePrefs().theme === v ? 'true' : 'false' }, label);
      b.type = 'button';
      b.onclick = () => setTheme(v).then(() => openPage('settings'));
      seg.append(b);
    }
    segCtl.append(seg);
    const accCtl = setItem(card, '🎨', t('shell.settings.accentTitle'), t('shell.settings.accentDetail'));
    const sw = h('div', { class: 'set-row' });
    for (const a of Object.keys(ACCENTS)) {
      const [c1, c2] = accentPair(a);
      const aname = t(`shell.ui.accents.${a}`);
      const b = h('button', {
        class: 'swatch' + (currentThemePrefs().accent === a ? ' active' : ''),
        style: `background:linear-gradient(135deg, ${c1}, ${c2})`, title: aname, 'aria-label': t('shell.settings.accentAria', { name: aname }), 'aria-pressed': currentThemePrefs().accent === a ? 'true' : 'false',
      });
      b.type = 'button';
      b.onclick = () => { setTheme(null, a).then(() => openPage('settings')); };
      sw.append(b);
    }
    accCtl.append(sw);
    const customCtl = setItem(card, '🧑‍🎨', t('shell.settings.customTitle'), t('shell.settings.customDetail'));
    const customBox = h('div', { class: 'set-form' });
    customCtl.append(customBox);
    renderCustoms();
    function renderCustoms() {
      customBox.innerHTML = '';
      const mine = currentThemePrefs().custom;
      if (!mine.length) customBox.append(h('div', { class: 'muted' }, t('shell.settings.customEmpty')));
      for (const c of mine) {
        const row = h('div', { class: 'set-row' });
        const [c1, c2] = accentPairFrom(c);
        const thumb = h('span', { class: 'swatch', style: `background:linear-gradient(135deg, ${c1}, ${c2});display:inline-block;vertical-align:middle` });
        const use = h('button', { class: 'btn mini', onclick: () => setTheme(c.name).then(() => openPage('settings')) }, t('shell.settings.use'));
        use.type = 'button';
        const exp = h('button', { class: 'btn mini', onclick: () => exportCustomTheme(c) }, t('shell.settings.export'));
        exp.type = 'button';
        const del = h('button', { class: 'btn mini del', onclick: async () => {
          if (del.textContent !== t('shell.settings.sure')) { del.textContent = t('shell.settings.sure'); return; }
          await removeCustomTheme(c.name);
          openPage('settings');
        } }, t('shell.settings.delete'));
        del.type = 'button';
        row.append(thumb, h('span', {}, c.name + (currentThemePrefs().theme === c.name ? ' ✓' : '')), use, exp, del);
        customBox.append(row);
      }
      const newBtn = h('button', { class: 'btn', onclick: () => renderThemeEditor() }, t('shell.settings.newTheme'));
      newBtn.type = 'button';
      customBox.append(newBtn);
      const impRow = h('div', { class: 'set-row' });
      const pick = h('input', { type: 'file', accept: '.json,application/json', 'aria-label': t('shell.settings.importFileAria') });
      pick.hidden = true;
      const pickBtn = h('button', { class: 'btn mini', onclick: () => pick.click() }, t('shell.settings.importFile'));
      pickBtn.type = 'button';
      const scanBtn = h('button', { class: 'btn mini', onclick: () => renderSharedThemes() }, t('shell.settings.scanShared'));
      scanBtn.type = 'button';
      pick.onchange = async () => {
        const f = pick.files[0];
        pick.value = '';
        if (!f) return;
        try {
          if (f.size > 200 * 1024) throw new Error(t('shell.errors.dictTooBig'));
          await importCustomThemeText(await f.text());
          toast(t('shell.settings.themeImported'));
          openPage('settings');
        } catch (err) {
          toast(t('shell.settings.importRefused', { error: err.message }));
        }
      };
      impRow.append(pickBtn, pick, scanBtn);
      customBox.append(impRow);
    }
    function accentPairFrom(c) {
      const mode = resolveThemeName();
      const set = (c[mode] && c[mode].accent && c[mode].accent2) ? c[mode] : THEMES[mode];
      return [set.accent, set.accent2];
    }
    async function exportCustomTheme(c) {
      const safe = c.name.replace(/[<>:"|?*\\/]+/g, '-').slice(0, 60) || 'theme';
      try {
        await state.vfs.writeText(`shared:${safe}.usbos-theme.json`, JSON.stringify({ kind: 'usbos-theme', version: 1, name: c.name, dark: c.dark, light: c.light }, null, 2));
        toast(t('shell.settings.themeExported', { file: `${safe}.usbos-theme.json` }));
      } catch (err) {
        toast(t('shell.settings.exportFailed', { error: err.message }));
      }
    }
    async function importCustomThemeText(text) {
      let obj;
      try {
        obj = JSON.parse(text);
      } catch {
        throw new Error(t('shell.errors.badJSON'));
      }
      if (obj && obj.kind && obj.kind !== 'usbos-theme') throw new Error(t('shell.errors.notTheme'));
      const err = validateCustomTheme(obj);
      if (err) throw new Error(err);
      let name = obj.name.trim(), i = 2;
      const taken = (n) => currentThemePrefs().custom.some((c) => c.name.toLowerCase() === n.toLowerCase());
      while (taken(name) && i < 10) { name = `${obj.name.trim()} ${i}`; i++; }
      await addCustomTheme({ name, dark: obj.dark, light: obj.light });
      return name;
    }
    async function renderSharedThemes() {
      customBox.querySelectorAll('.shared-theme-row').forEach((n) => n.remove());
      let files = [];
      try {
        files = (await state.vfs.list('shared:')).filter((e) => e.kind === 'file' && e.name.endsWith('.usbos-theme.json'));
      } catch {
        toast(t('shell.settings.sharedNoAccess'));
        return;
      }
      if (!files.length) {
        toast(t('shell.settings.sharedNoTheme'));
        return;
      }
      for (const f of files) {
        const row = h('div', { class: 'set-row shared-theme-row' });
        row.append(h('span', {}, f.name));
        const go = h('button', { class: 'btn mini', onclick: async () => {
          try {
            const name = await importCustomThemeText(await state.vfs.readText(`shared:${f.name}`));
            toast(t('shell.settings.themeImportedName', { name }));
            openPage('settings');
          } catch (err) {
            toast(t('shell.settings.importRefused', { error: err.message }));
          }
        } }, t('shell.settings.importBtn'));
        go.type = 'button';
        row.append(go);
        customBox.append(row);
      }
    }
    function renderThemeEditor() {
      clearCustomPreview();
      customBox.innerHTML = '';
      const nameIn = h('input', { type: 'text', placeholder: t('shell.settings.editorName'), 'aria-label': t('shell.settings.editorNameAria') });
      customBox.append(nameIn);
      const modes = {};
      for (const mode of ['dark', 'light']) {
        customBox.append(h('div', { class: 'muted' }, mode === 'dark' ? t('shell.settings.baseDark') : t('shell.settings.baseLight')));
        const base = THEMES[mode];
        const fields = {};
        for (const [key, label] of [['bg', t('shell.settings.fieldBg')], ['panel', t('shell.settings.fieldPanel')], ['text', t('shell.settings.fieldText')], ['accent', t('shell.settings.fieldAccent')]]) {
          const l = h('label', { class: 'set-row' });
          const inp = h('input', { type: 'color', value: base[key], 'aria-label': `${label} (${mode})` });
          inp.oninput = previewFromEditor;
          l.append(h('span', {}, label), inp);
          customBox.append(l);
          fields[key] = inp;
        }
        modes[mode] = fields;
      }
      const msg = h('div', { class: 'muted' });
      const row = h('div', { class: 'set-row' });
      const save = h('button', { class: 'btn primary', onclick: async () => {
        msg.textContent = '';
        const seeds = currentSeeds();
        const dark = deriveThemeVars(THEMES.dark, seeds.dark);
        const light = deriveThemeVars(THEMES.light, seeds.light);
        if (!dark || !light) { msg.textContent = t('shell.settings.badColors'); return; }
        const name = nameIn.value.trim();
        if (!name) { msg.textContent = t('shell.settings.needName'); return; }
        try {
          clearCustomPreview();
          await addCustomTheme({ name, dark, light });
          await setTheme(name);
          openPage('settings');
        } catch (err) {
          msg.textContent = t('shell.settings.refused', { error: err.message });
        }
      } }, t('shell.settings.save'));
      save.type = 'button';
      const cancel = h('button', { class: 'btn', onclick: () => { clearCustomPreview(); openPage('settings'); } }, t('shell.settings.cancel'));
      cancel.type = 'button';
      row.append(save, cancel);
      customBox.append(row, msg);
      nameIn.focus();
      function currentSeeds() {
        const out = {};
        for (const mode of ['dark', 'light']) {
          out[mode] = {
            bg: modes[mode].bg.value, panel: modes[mode].panel.value,
            text: modes[mode].text.value, accent: modes[mode].accent.value,
          };
        }
        return out;
      }
      function previewFromEditor() {
        const seeds = currentSeeds();
        const dark = deriveThemeVars(THEMES.dark, seeds.dark);
        const light = deriveThemeVars(THEMES.light, seeds.light);
        if (dark && light) previewCustomTheme(dark, light);
      }
    }
    const wallCtl = setItem(card, '🖼️', t('shell.settings.wallTitle'), t('shell.settings.wallDetail'));
    const wallBox = h('div', { class: 'set-form' });
    const wallGrid = h('div', { class: 'wall-grid' });
    const wp = currentWallPrefs();
    for (const key of Object.keys(WALLPAPERS)) {
      const thumb = wallCSS(key, resolveThemeName()) || 'var(--panel2)';
      const wlabel = t('shell.wallpaper.labels.' + key);
      const b = h('button', {
        class: 'wall-swatch' + (wp.preset === key ? ' active' : ''),
        style: `background:${thumb}`, title: wlabel, 'aria-label': t('shell.settings.wallBgAria', { label: wlabel }), 'aria-pressed': wp.preset === key ? 'true' : 'false',
      });
      b.type = 'button';
      b.onclick = () => { saveWallpaper({ preset: key }).then(() => openPage('settings')); };
      const lab = h('div', { class: 'set-d' }, wlabel);
      const cell = h('div', {});
      cell.append(b, lab);
      wallGrid.append(cell);
    }
    wallBox.append(wallGrid);
    wallBox.append(h('div', { class: 'muted' }, t('shell.settings.svgBuiltins')));
    const svgGrid = h('div', { class: 'wall-grid' });
    for (const key of Object.keys(WALLPAPER_SVG)) {
      const sel = `svg:${key}`;
      const wlabel = t('shell.wallpaper.labels.' + key);
      const url = wallSvgUrl(key);
      const b = h('button', {
        class: 'wall-swatch' + (wp.preset === sel ? ' active' : ''),
        style: `background:url("${url}") center/cover no-repeat`, title: wlabel, 'aria-label': t('shell.settings.wallBgAria', { label: wlabel }), 'aria-pressed': wp.preset === sel ? 'true' : 'false',
      });
      b.type = 'button';
      b.onclick = () => { saveWallpaper({ preset: sel }).then(() => openPage('settings')); };
      const lab = h('div', { class: 'set-d' }, wlabel);
      const cell = h('div', {});
      cell.append(b, lab);
      svgGrid.append(cell);
    }
    wallBox.append(svgGrid);
    // Source : dégradés ou images importées.
    const srcCtl = setItem(card, '🖼️', t('shell.settings.srcTitle'), t('shell.settings.srcDetail'));
    const srcSeg = h('div', { class: 'segmented' });
    for (const [v, label] of [['presets', t('shell.settings.srcPresets')], ['images', t('shell.settings.srcImages')]]) {
      const b = h('button', { class: 'seg' + (wp.source === v ? ' on' : ''), 'aria-pressed': wp.source === v ? 'true' : 'false' }, label);
      b.type = 'button';
      b.onclick = () => { saveWallpaper({ source: v }).then(() => openPage('settings')); };
      srcSeg.append(b);
    }
    srcCtl.append(srcSeg);
    const imgCtl = setItem(card, '📷', t('shell.settings.imgTitle'), t('shell.settings.imgDetail'));
    const imgBox = h('div', { class: 'set-form' });
    imgCtl.append(imgBox);
    function renderWallImages() {
      imgBox.innerHTML = '';
      const names = currentWallPrefs().images;
      if (!names.length) imgBox.append(h('div', { class: 'muted' }, t('shell.settings.imgEmpty')));
      for (const name of names) {
        const row = h('div', { class: 'set-row' });
        const thumb = h('img', { class: 'wall-thumb', alt: name });
        const _url = (state.wallBlobs && state.wallBlobs.get(name)) || null;
        if (_url) thumb.src = _url; else thumb.removeAttribute('src');
        const del = h('button', { class: 'btn mini del', onclick: async () => {
          if (del.textContent !== t('shell.settings.sure')) { del.textContent = t('shell.settings.sure'); return; }
          await removeWallImage(name);
          openPage('settings');
        } }, t('shell.settings.delete'));
        del.type = 'button';
        row.append(thumb, h('span', {}, name), del);
        imgBox.append(row);
      }
      const impRow = h('div', { class: 'set-row' });
      const pick = h('input', { type: 'file', accept: '.jpg,.jpeg,.png,.webp,.gif', 'aria-label': t('shell.settings.imgPickAria') });
      pick.multiple = true;
      pick.hidden = true;
      const pickBtn = h('button', { class: 'btn mini', onclick: () => pick.click() }, t('shell.settings.imgPickBtn'));
      pickBtn.type = 'button';
      const scanBtn = h('button', { class: 'btn mini', onclick: () => renderWallShared(imgBox) }, t('shell.settings.wallFromShared'));
      scanBtn.type = 'button';
      pick.onchange = async () => {
        const files = [...pick.files];
        pick.value = '';
        let ok = 0, ko = null, fails = 0;
        for (const f of files) {
          try {
            if (f.size > WALL_IMG_MAX) throw new Error(t('shell.settings.wallTooBig'));
            await importWallImage(f.name, new Uint8Array(await f.arrayBuffer()));
            ok++;
          } catch (err) {
            fails++;
            if (!ko) ko = err.message;
            continue;
          }
        }
        toast(ok ? (fails ? `${tp('shell.settings.imgImportedN', ok)} (${ko})` : tp('shell.settings.imgImportedN', ok)) : t('shell.settings.importRefused', { error: ko || t('shell.settings.unknownErr') }));
        openPage('settings');
      };
      impRow.append(pickBtn, pick, scanBtn);
      imgBox.append(impRow);
    }
    async function renderWallShared(box) {
      box.querySelectorAll('.shared-wall-row').forEach((n) => n.remove());
      let files = [];
      try {
        files = (await state.vfs.list('shared:')).filter((e) => e.kind === 'file' && wallImageName(e.name));
      } catch {
        toast(t('shell.settings.sharedNoAccess'));
        return;
      }
      const mine = new Set(currentWallPrefs().images);
      files = files.filter((e) => !mine.has(e.name));
      if (!files.length) {
        toast(t('shell.settings.sharedNoFile'));
        return;
      }
      for (const f of files.slice(0, 20)) {
        const row = h('div', { class: 'set-row shared-wall-row' });
        row.append(h('span', {}, f.name));
        const go = h('button', { class: 'btn mini', onclick: async () => {
          try {
            await importWallImage(f.name, new Uint8Array(await state.vfs.readBinary(`shared:${f.name}`)));
            toast(t('shell.settings.imgImportedOne', { name: f.name }));
            openPage('settings');
          } catch (err) {
            toast(t('shell.settings.importRefused', { error: err.message }));
          }
        } }, t('shell.settings.importBtn'));
        go.type = 'button';
        row.append(go);
        box.append(row);
      }
    }
    renderWallImages();
    const slideRow = h('label', { class: 'switch' });
    const slideCb = h('input', { type: 'checkbox', 'aria-label': t('shell.settings.slideAria') });
    slideCb.checked = wp.slide;
    const slideTrack = h('span', { class: 'track' });
    slideRow.append(slideCb, slideTrack, h('span', {}, t('shell.settings.slideLabel')));
    const intRow = h('div', { class: 'set-row' });
    intRow.append(h('span', { class: 'muted' }, t('shell.settings.everyLabel')));
    const intSel = h('select', { class: 'btn', 'aria-label': t('shell.settings.intervalAria') });
    for (const s of WALL_INTERVALS) {
      const o = h('option', { value: String(s) }, t('shell.settings.secShort', { n: s }));
      intSel.append(o);
    }
    intSel.value = String(wp.intervalSec);
    intRow.append(intSel);
    wallBox.append(slideRow, intRow);
    slideCb.onchange = () => saveWallpaper({ slide: slideCb.checked });
    intSel.onchange = () => saveWallpaper({ intervalSec: parseInt(intSel.value, 10) });
    const appsCtl = setItem(card, '🧩', t('shell.settings.appsOptIn'), t('shell.settings.appsOptInDetail'));
    const appsBox = h('div', { class: 'set-form' });
    for (const entry of [...state.apps.values()]) {
      const idm = entry.manifest.id;
      const l = h('label', { class: 'switch' });
      const c = h('input', { type: 'checkbox', 'aria-label': t('shell.settings.fondInApp', { name: entry.manifest.name || idm }) });
      c.checked = !!(wp.apps && wp.apps[idm]);
      const track = h('span', { class: 'track' });
      l.append(c, track, h('span', {}, `${entry.manifest.icon ? entry.manifest.icon + ' ' : ''}${entry.manifest.name || idm}`));
      c.onchange = () => {
        const apps = { ...(currentWallPrefs().apps || {}) };
        if (c.checked) apps[idm] = true;
        else delete apps[idm];
        saveWallpaper({ apps });
      };
      appsBox.append(l);
    }
    wallCtl.append(wallBox);
    appsCtl.append(appsBox);
  });

  // Mise en page
  sectionGuard(t('shell.settings.layoutTitle'), () => {
    const card = setSection(t('shell.settings.layoutTitle'));
    const ui = currentUiPrefs();
    const rows = [
      ['radius', '🔲', t('shell.settings.radiusTitle'), t('shell.settings.radiusDetail'), [['carre', t('shell.settings.radiusCarre')], ['doux', t('shell.settings.radiusDoux')], ['rond', t('shell.settings.radiusRond')]]],
      ['fs', '🔠', t('shell.settings.fsTitle'), t('shell.settings.fsDetail'), [['s', 'S'], ['m', 'M'], ['l', 'L']]],
      ['density', '↕️', t('shell.settings.densityTitle'), t('shell.settings.densityDetail'), [['compact', t('shell.settings.densityCompact')], ['confort', t('shell.settings.densityComfort')]]],
      ['barpos', '🧭', t('shell.settings.barposTitle'), t('shell.settings.barposDetail'), [['haut', t('shell.settings.barposTop')], ['bas', t('shell.settings.barposBottom')]]],
      ['side', '📑', t('shell.settings.sideTitle'), t('shell.settings.sideDetail'), [['gauche', t('shell.settings.sideLeft')], ['droite', t('shell.settings.sideRight')]]],
    ];
    for (const [key, icon, title, detail, opts] of rows) {
      const ctl = setItem(card, icon, title, detail);
      const seg = h('div', { class: 'segmented' });
      for (const [v, label] of opts) {
        const b = h('button', { class: 'seg' + (ui[key] === v ? ' on' : ''), 'aria-pressed': ui[key] === v ? 'true' : 'false' }, label);
        b.type = 'button';
        b.onclick = () => { setUiPrefs({ [key]: v }).then(() => openPage('settings')); };
        seg.append(b);
      }
      ctl.append(seg);
    }
  });

  // Langue
  sectionGuard(t('shell.settings.langTitle'), () => {
    const card = setSection(t('shell.settings.langTitle'));
    const ctl = setItem(card, '🌐', t('shell.settings.langTitle'), t('shell.settings.langDetail'));
    const box = h('div', { class: 'set-form' });
    ctl.append(box);
    function renderLangs() {
      box.innerHTML = '';
      const cur = currentLang();
      for (const code of availableLangs()) {
        const row = h('div', { class: 'set-row' });
        const name = code === 'fr' ? t('shell.lang.french') : code === 'en' ? t('shell.lang.english') : langDisplayName(code);
        row.append(h('span', {}, name + (cur === code ? ' ✓' : '')));
        if (cur !== code) {
          const use = h('button', { class: 'btn mini', onclick: () => setLang(code).then(() => openPage('settings')) }, t('shell.settings.langUse'));
          use.type = 'button';
          row.append(use);
        }
        const exp = h('button', { class: 'btn mini', onclick: async () => {
          try {
            const f = await exportLangPack(code);
            toast(t('shell.settings.langModelExport', { file: f }));
          } catch (err) { toast(t('shell.settings.exportFailed', { error: err.message })); }
        } }, t('shell.settings.langExport'));
        exp.type = 'button';
        row.append(exp);
        if (!LANG_BUILTIN.includes(code)) {
          const del = h('button', { class: 'btn mini del', onclick: async () => {
            if (del.textContent !== t('shell.settings.sure')) { del.textContent = t('shell.settings.sure'); return; }
            try { await removeLangPack(code); toast(t('shell.settings.langRemoved')); openPage('settings'); }
            catch (err) { toast(t('shell.settings.secFailed', { error: err.message })); }
          } }, t('shell.settings.langDelete'));
          del.type = 'button';
          row.append(del);
        }
        box.append(row);
      }
      if (!availableLangs().some((c) => !LANG_BUILTIN.includes(c))) box.append(h('div', { class: 'muted' }, t('shell.settings.langEmpty')));
      const impRow = h('div', { class: 'set-row' });
      const pick = h('input', { type: 'file', accept: '.json,application/json', 'aria-label': t('shell.settings.langImportFileAria') });
      pick.hidden = true;
      const pickBtn = h('button', { class: 'btn mini', onclick: () => pick.click() }, t('shell.settings.langImportFile'));
      pickBtn.type = 'button';
      const scanBtn = h('button', { class: 'btn mini', onclick: () => renderSharedLangs() }, t('shell.settings.langScan'));
      scanBtn.type = 'button';
      pick.onchange = async () => {
        const f = pick.files[0];
        pick.value = '';
        if (!f) return;
        try {
          if (f.size > 200 * 1024) throw new Error(t('shell.errors.dictTooBig'));
          const code = await importLangPackText(await f.text());
          toast(t('shell.settings.langImported', { name: langDisplayName(code) }));
          openPage('settings');
        } catch (err) {
          toast(t('shell.settings.importRefused', { error: err.message }));
        }
      };
      impRow.append(pickBtn, pick, scanBtn);
      box.append(impRow);
    }
    async function renderSharedLangs() {
      box.querySelectorAll('.shared-lang-row').forEach((n) => n.remove());
      let files = [];
      try {
        files = (await state.vfs.list('shared:')).filter((e) => e.kind === 'file' && e.name.endsWith('.usbos-lang.json'));
      } catch {
        toast(t('shell.settings.sharedNoAccess'));
        return;
      }
      if (!files.length) {
        toast(t('shell.settings.langSharedNone'));
        return;
      }
      for (const f of files.slice(0, 20)) {
        const row = h('div', { class: 'set-row shared-lang-row' });
        row.append(h('span', {}, f.name));
        const go = h('button', { class: 'btn mini', onclick: async () => {
          try {
            const code = await importLangPackText(await state.vfs.readText(`shared:${f.name}`));
            toast(t('shell.settings.langImported', { name: langDisplayName(code) }));
            openPage('settings');
          } catch (err) {
            toast(t('shell.settings.importRefused', { error: err.message }));
          }
        } }, t('shell.settings.importBtn'));
        go.type = 'button';
        row.append(go);
        box.append(row);
      }
    }
    renderLangs();
  });

  // Sécurité
  sectionGuard(t('shell.settings.securityTitle'), () => {
    const card = setSection(t('shell.settings.securityTitle'));
    const mode = state.masterKey ? t('shell.settings.secEncrypted') : state.plainMode ? t('shell.settings.secPlain') : t('shell.settings.secLockedNote');
    const modeCtl = setItem(card, '🔐', t('shell.settings.secModeTitle'), t('shell.settings.secModeDetail'));
    modeCtl.append(h('span', { class: (state.plainMode && !state.masterKey) ? 'warnline' : 'muted' }, mode));
    const markDisabled = (root) => {
      root.classList.add('disabled');
      root.querySelectorAll('input, button').forEach((el) => {
        try { el.disabled = true; } catch { /* noop */ }
        try { el.setAttribute('aria-disabled', 'true'); } catch { /* noop */ }
      });
    };
    const buildAddActive = (ctl) => {
      const box = h('div', { class: 'set-form' });
      const p1 = h('input', { type: 'password', placeholder: t('shell.settings.secAddPass'), autocomplete: 'new-password', 'aria-label': t('shell.settings.secAddPass') });
      const p2 = h('input', { type: 'password', placeholder: t('shell.settings.secAddConfirm'), autocomplete: 'new-password', 'aria-label': t('shell.settings.secAddConfirm') });
      const chk = h('label', { class: 'switch' });
      const cb = h('input', { type: 'checkbox', 'aria-label': t('shell.settings.secUnderstandShort') });
      const track = h('span', { class: 'track' });
      chk.append(cb, track, h('span', {}, t('shell.settings.secAddUnderstand')));
      const msg = h('div', { class: 'muted' });
      const go = h('button', { class: 'btn primary', onclick: async () => {
        msg.textContent = '';
        if (!p1.value || p1.value.length < 8) { msg.textContent = t('shell.settings.secNeed8Add'); return; }
        if (p1.value !== p2.value) { msg.textContent = t('shell.settings.secNeedMatchAdd'); return; }
        if (!cb.checked) { msg.textContent = t('shell.settings.secNeedConfirm'); return; }
        try {
          const done = await setPassphrase(p1.value);
          p1.value = ''; p2.value = ''; cb.checked = false;
          msg.textContent = done + ' ' + t('shell.settings.secReloadLock');
          toast(t('shell.settings.secAdded'));
        } catch (err) {
          p1.value = ''; p2.value = '';
          msg.textContent = t('shell.settings.secFailed', { error: err.message });
        }
      } }, t('shell.settings.secAddBtn'));
      box.append(p1, p2, chk, msg, go);
      ctl.append(box);
    };
    const buildAddDisabled = (ctl, reasonKey) => {
      const box = h('div', { class: 'set-form' });
      const p1 = h('input', { type: 'password', placeholder: t('shell.settings.secAddPass'), autocomplete: 'new-password', 'aria-label': t('shell.settings.secAddPass') });
      const p2 = h('input', { type: 'password', placeholder: t('shell.settings.secAddConfirm'), autocomplete: 'new-password', 'aria-label': t('shell.settings.secAddConfirm') });
      const chk = h('label', { class: 'switch' });
      const cb = h('input', { type: 'checkbox', 'aria-label': t('shell.settings.secUnderstandShort') });
      const track = h('span', { class: 'track' });
      chk.append(cb, track, h('span', {}, t('shell.settings.secAddUnderstand')));
      const go = h('button', { class: 'btn primary' }, t('shell.settings.secAddBtn'));
      go.type = 'button';
      box.append(p1, p2, chk, h('div', { class: 'muted' }, t(reasonKey)), go);
      ctl.append(box);
      markDisabled(box);
    };
    const buildChangeActive = (ctl) => {
      const boxChange = h('div', { class: 'set-form' });
      const po = h('input', { type: 'password', placeholder: t('shell.settings.secCurPass'), autocomplete: 'current-password', 'aria-label': t('shell.settings.secCurPass') });
      const pn1 = h('input', { type: 'password', placeholder: t('shell.settings.secNewPass'), autocomplete: 'new-password', 'aria-label': t('shell.settings.secNewPass') });
      const pn2 = h('input', { type: 'password', placeholder: t('shell.settings.secNewPassConfirm'), autocomplete: 'new-password', 'aria-label': t('shell.settings.secNewPassConfirm') });
      const msgc = h('div', { class: 'muted' });
      const goChange = h('button', { class: 'btn primary', onclick: async () => {
        msgc.textContent = '';
        if (!po.value) { msgc.textContent = t('shell.settings.secNeedCur'); return; }
        if (!pn1.value || pn1.value.length < 8) { msgc.textContent = t('shell.settings.secNeed8'); return; }
        if (pn1.value !== pn2.value) { msgc.textContent = t('shell.settings.secNeedMatch'); return; }
        try {
          const done = await changePassphrase(po.value, pn1.value);
          po.value = ''; pn1.value = ''; pn2.value = '';
          msgc.textContent = done;
          toast(t('shell.settings.secChanged'));
        } catch (err) {
          po.value = ''; pn1.value = ''; pn2.value = '';
          msgc.textContent = t('shell.settings.secFailed', { error: err.message });
        }
      } }, t('shell.settings.secChangeBtn'));
      boxChange.append(po, pn1, pn2, msgc, goChange);
      ctl.append(boxChange);
    };
    const buildChangeDisabled = (ctl, reasonKey) => {
      const boxChange = h('div', { class: 'set-form' });
      const po = h('input', { type: 'password', placeholder: t('shell.settings.secCurPass'), autocomplete: 'current-password', 'aria-label': t('shell.settings.secCurPass') });
      const pn1 = h('input', { type: 'password', placeholder: t('shell.settings.secNewPass'), autocomplete: 'new-password', 'aria-label': t('shell.settings.secNewPass') });
      const pn2 = h('input', { type: 'password', placeholder: t('shell.settings.secNewPassConfirm'), autocomplete: 'new-password', 'aria-label': t('shell.settings.secNewPassConfirm') });
      const goChange = h('button', { class: 'btn primary' }, t('shell.settings.secChangeBtn'));
      goChange.type = 'button';
      boxChange.append(po, pn1, pn2, h('div', { class: 'muted' }, t(reasonKey)), goChange);
      ctl.append(boxChange);
      markDisabled(boxChange);
    };
    const buildRemoveActive = (ctl) => {
      const box = h('div', { class: 'set-form' });
      const pc = h('input', { type: 'password', placeholder: t('shell.settings.secCurPass'), autocomplete: 'current-password', 'aria-label': t('shell.settings.secCurPass') });
      const chk = h('label', { class: 'switch' });
      const cb = h('input', { type: 'checkbox', 'aria-label': t('shell.settings.secUnderstandShort') });
      const track = h('span', { class: 'track' });
      chk.append(cb, track, h('span', {}, t('shell.settings.secUnderstand')));
      const msg = h('div', { class: 'muted' });
      const go = h('button', { class: 'btn', onclick: async () => {
        msg.textContent = '';
        if (!pc.value) { msg.textContent = t('shell.settings.secNeedCur'); return; }
        if (!cb.checked) { msg.textContent = t('shell.settings.secNeedConfirm'); return; }
        try {
          const done = await removePassphrase(pc.value);
          pc.value = ''; cb.checked = false;
          msg.textContent = done + ' ' + t('shell.settings.secReloadPlain');
          toast(t('shell.settings.secRemoved'));
        } catch (err) {
          pc.value = '';
          msg.textContent = t('shell.settings.secFailed', { error: err.message });
        }
      } }, t('shell.settings.secDecryptBtn'));
      box.append(pc, chk, msg, go);
      ctl.append(box);
    };
    const buildRemoveDisabled = (ctl, reasonKey) => {
      const box = h('div', { class: 'set-form' });
      const pc = h('input', { type: 'password', placeholder: t('shell.settings.secCurPass'), autocomplete: 'current-password', 'aria-label': t('shell.settings.secCurPass') });
      const chk = h('label', { class: 'switch' });
      const cb = h('input', { type: 'checkbox', 'aria-label': t('shell.settings.secUnderstandShort') });
      const track = h('span', { class: 'track' });
      chk.append(cb, track, h('span', {}, t('shell.settings.secUnderstand')));
      const go = h('button', { class: 'btn' }, t('shell.settings.secDecryptBtn'));
      go.type = 'button';
      box.append(pc, chk, h('div', { class: 'muted' }, t(reasonKey)), go);
      ctl.append(box);
      markDisabled(box);
    };
    if (state.masterKey) {
      setItem(card, 'ℹ️', t('shell.settings.secLockedInfo'), t('shell.settings.secLockedInfoDetail'));
      const ctlAdd = setItem(card, '🛡️', t('shell.settings.secAddTitle'), t('shell.settings.secAddDetail'));
      buildAddDisabled(ctlAdd, 'shell.settings.secNeedPlain');
      const ctlChange = setItem(card, '🔑', t('shell.settings.secChangeTitle'), t('shell.settings.secChangeDetail'));
      buildChangeActive(ctlChange);
      const ctl2 = setItem(card, '🔓', t('shell.settings.secRemoveTitle'), t('shell.settings.secRemoveDetail'));
      buildRemoveActive(ctl2);
    } else if (state.plainMode) {
      const ctl = setItem(card, '🛡️', t('shell.settings.secAddTitle'), t('shell.settings.secAddDetail'));
      buildAddActive(ctl);
      const ctlChange = setItem(card, '🔑', t('shell.settings.secChangeTitle'), t('shell.settings.secChangeDetail'));
      buildChangeDisabled(ctlChange, 'shell.settings.secNeedEncrypted');
      const ctl2 = setItem(card, '🔓', t('shell.settings.secRemoveTitle'), t('shell.settings.secRemoveDetail'));
      buildRemoveDisabled(ctl2, 'shell.settings.secNeedEncrypted');
    } else {
      const ctl = setItem(card, '🛡️', t('shell.settings.secAddTitle'), t('shell.settings.secAddDetail'));
      buildAddDisabled(ctl, 'shell.settings.secNeedUnlocked');
      const ctlChange = setItem(card, '🔑', t('shell.settings.secChangeTitle'), t('shell.settings.secChangeDetail'));
      buildChangeDisabled(ctlChange, 'shell.settings.secNeedUnlocked');
      const ctl2 = setItem(card, '🔓', t('shell.settings.secRemoveTitle'), t('shell.settings.secRemoveDetail'));
      buildRemoveDisabled(ctl2, 'shell.settings.secNeedUnlocked');
    }
  });

  // Partage & données
  sectionGuard(t('shell.settings.shareTitle'), () => {
    const card = setSection(t('shell.settings.shareTitle'));
    const shareCtl = setItem(card, '📂', t('shell.settings.shareStatus'), state.sharedHandle ? t('shell.settings.shareActive') : t('shell.settings.shareInactive'));
    if (!state.sharedHandle) {
      const reBtn = h('button', { class: 'btn', onclick: () => { void switchKeyFlow(); } }, t('shell.settings.shareReconnect'));
      reBtn.type = 'button';
      shareCtl.append(reBtn);
    }
    const countsCtl = setItem(card, '🗂️', t('shell.settings.countsTitle'), t('shell.settings.countsDetail'));
    const counts = h('div', { class: 'muted' }, t('shell.settings.countsLoading'));
    countsCtl.append(counts);
    (async () => {
      const [notes, md, ag] = await Promise.all([
        dashReadJSON('notes', 'notes.json'),
        dashReadJSON('markdown', 'markdown.json'),
        dashReadJSON('agenda', 'agenda.json'),
      ]);
      let shared = null;
      try {
        const lst = await state.vfs.list('shared:');
        shared = lst.length;
      } catch { shared = null; }
      const unlocked = !!(state.masterKey || state.plainMode);
      const countOr = (data, getLen) => {
        if (data == null) return unlocked ? 0 : null;
        const n = getLen(data);
        return (typeof n === 'number') ? n : null;
      };
      const notesN = countOr(notes, (d) => (Array.isArray(d) ? d.length : null));
      const docsN = countOr(md, (d) => (d && Array.isArray(d.docs) ? d.docs.length : null));
      const eventsN = countOr(ag, (d) => (d && Array.isArray(d.events) ? d.events.length : null));
      const f = (v) => (v == null ? '—' : String(v));
      counts.textContent = t('shell.settings.countsLine', {
        notes: f(notesN),
        docs: f(docsN),
        events: f(eventsN),
        shared: f(shared),
      });
    })();
    const expCtl = setItem(card, '📥', t('shell.settings.exportLogTitle'), t('shell.settings.exportLogDetail'));
    const exp = h('button', { class: 'btn', onclick: async () => {
      try {
        const name = `usbos-${new Date().toISOString().replace(/[:.]/g, '-')}.log`;
        await state.vfs.writeText(`system:logs/${name}`, window.USBosLog.toText());
        toast(t('shell.settings.exportedLog', { name }));
      } catch (err) {
        toast(t('shell.settings.exportFailed', { error: err.message }));
      }
    } }, t('shell.settings.exportBtn'));
    exp.type = 'button';
    expCtl.append(exp);
  });

  // Système
  sectionGuard(t('shell.settings.sysTitle'), () => {
    const card = setSection(t('shell.settings.sysTitle'));
    setItem(card, '💽', t('shell.settings.sysKernel'), t('shell.settings.sysKernelDetail', { v: KERNEL_VERSION }));
    setItem(card, '🔑', t('shell.settings.sysKey'), state.usbosHandle ? state.usbosHandle.name : '—');
    setItem(card, '🆔', t('shell.settings.sysKeyId'), state.keyId || '—');
    const updCtl = setItem(card, '🔄', t('shell.settings.sysUpdateTitle'), t('shell.settings.sysUpdateDetail'));
    const msg = h('div', { class: 'muted' });
    const chk = h('button', { class: 'btn', onclick: async () => {
      msg.textContent = t('shell.settings.sysChecking');
      try {
        const plan = await checkForUpdates();
        msg.textContent = !plan ? t('shell.settings.sysOffline') : plan.hasUpdates ? t('shell.settings.sysUpdateAvail', { summary: plan.summary }) : t('shell.settings.sysUpToDate');
      } catch (err) {
        msg.textContent = t('shell.settings.sysOffline');
        log(`Vérification màj impossible : ${err && err.message}`, 'w');
      }
    } }, t('shell.settings.sysCheckBtn'));
    chk.type = 'button';
    updCtl.append(chk);
    updCtl.append(msg);
    const appsCtl = setItem(card, '🧩', t('shell.settings.sysApps'), tp('shell.settings.sysAppsCount', state.apps.size));
    appsCtl.append(h('span', { class: 'muted' }, [...state.apps.values()].map((a) => a.manifest.name || a.manifest.id).join(', ') || '—'));
  });

  // Shortcuts
  sectionGuard(t('shell.settings.keysTitle'), () => {
    const card = setSection(t('shell.settings.keysTitle'));
    card.append(h('p', { class: 'hint' }, t('shell.settings.keysHint')));
    setItem(card, '💾', t('shell.settings.keysSave'));
    setItem(card, '⌘', t('shell.settings.keysPalette'));
    setItem(card, '🔍', t('shell.settings.keysSearch'));
    setItem(card, '⎋', t('shell.settings.keysEsc'));
    setItem(card, '🖥️', t('shell.settings.keysConsole'));
  });
}

const PAGES = {
  dashboard: { render: (stage) => renderDashboard(stage) },
  settings: { render: (stage) => renderSettings(stage) },
  guest: { render: (stage) => renderGuest(stage) },
};

function guestIcon(kind, name) {
  if (kind === 'directory') return '📁';
  const ext = (name.split('.').pop() || '').toLowerCase();
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'].includes(ext)) return '🖼️';
  if (['mp4', 'webm', 'mkv', 'avi', 'mov'].includes(ext)) return '🎬';
  if (['mp3', 'wav', 'ogg', 'flac', 'm4a'].includes(ext)) return '🎵';
  if (['pdf'].includes(ext)) return '📕';
  if (['zip', '7z', 'rar', 'tar', 'gz'].includes(ext)) return '📦';
  if (['txt', 'md', 'log', 'json', 'csv', 'ics'].includes(ext)) return '📄';
  return '📄';
}
/** Unités de taille localisées (repli ultime codé FR si dicts absents). */
function guestUnits() {
  const d = state.dicts || {};
  for (const l of [currentLang(), 'en', 'fr']) {
    const v = getPath((d[l] || {}).dict, 'shell.guest.units');
    if (Array.isArray(v) && v.length === 4) return v;
  }
  return ['o', 'Ko', 'Mo', 'Go'];
}
function guestHumanSize(n) {
  if (n == null || isNaN(n)) return '—';
  const units = guestUnits();
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return (i ? (n < 10 ? n.toFixed(1) : Math.round(n)) : n) + ' ' + units[i];
}
/** MIME pour téléchargement Partage/ (par extension, défaut octet-stream). */
function sharedMime(name) {
  const ext = (String(name).split('.').pop() || '').toLowerCase();
  const map = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', svg: 'image/svg+xml', bmp: 'image/bmp',
    pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown', json: 'application/json', csv: 'text/csv', log: 'text/plain',
    ics: 'text/calendar', html: 'text/html', css: 'text/css', js: 'text/javascript',
    mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', flac: 'audio/flac', m4a: 'audio/mp4',
    mp4: 'video/mp4', webm: 'video/webm', mkv: 'video/x-matroska', avi: 'video/x-msvideo', mov: 'video/quicktime',
    zip: 'application/zip',
  };
  return map[ext] || 'application/octet-stream';
}
/** Type prévisualisable dans l'espace invité (image/video/audio), sinon null. */
function guestPreviewKind(name) {
  const ext = (String(name).split('.').pop() || '').toLowerCase();
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'].includes(ext)) return 'image';
  if (['mp4', 'webm', 'mkv', 'avi', 'mov'].includes(ext)) return 'video';
  if (['mp3', 'wav', 'ogg', 'flac', 'm4a'].includes(ext)) return 'audio';
  return null;
}
/** Joint un nom à une base shared: sans jamais produire 'shared:/' ambigu. */
function joinShared(base, name) {
  return base === 'shared:' ? `shared:${name}` : `${base}/${name}`;
}
function guestCheckName(name) {
  const s = String(name || '').trim();
  if (!s || s.length > 128) return null;
  if (s === '.' || s === '..' || s.includes('/') || s.includes('\\')) return null;
  if (/[<>:"|?*\x00-\x1f]/.test(s)) return null;
  return s;
}

/**
 * Page invité : explorateur du seul Partage/ (lecture-écriture), sans
 * jamais toucher à data:/apps:/system:/config:. Les segments de chemin
 * viennent uniquement du listage (jamais d'une saisie) : traversal
 * impossible par construction.
 */
function renderGuest(stage) {
  const devlabel = $('devlabel');
  if (devlabel) devlabel.textContent = (state.usbosHandle ? state.usbosHandle.name : t('shell.guest.keyFallback')) + t('shell.guest.devSuffix');
  const wrap = h('div', { class: 'dash' });
  wrap.append(
    h('div', { class: 'dash-hero' },
      h('div', { class: 'dash-title' }, h('h2', {}, t('shell.guest.heroTitle'))),
      h('p', { class: 'hint' }, t('shell.guest.heroHint'))
    )
  );
  const bar = h('div', { class: 'guest-bar' });
  const crumbs = h('div', { class: 'crumbs' });
  const quit = h('button', { class: 'btn', onclick: () => switchKeyFlow(), title: t('shell.guest.quitTitle') }, t('shell.guest.quit'));
  quit.type = 'button';
  bar.append(crumbs, quit);
  wrap.append(bar);
  const list = h('div', {});
  wrap.append(list);
  const drop = h('div', { class: 'guest-drop' }, t('shell.guest.dropHint'));
  const pick = h('input', { type: 'file', 'aria-label': t('shell.guest.dropAria') });
  pick.multiple = true;
  drop.append(pick);
  wrap.append(drop);
  const msg = h('div', { class: 'muted' });
  wrap.append(msg);
  stage.append(wrap);

  let path = []; // segments validés issus du listage
  const vpath = () => (path.length ? 'shared:' + path.join('/') : 'shared:');
  let previewUrl = null;
  let previewCloser = null;
  const revokePreviewUrl = () => {
    if (previewUrl) { try { URL.revokeObjectURL(previewUrl); } catch { /* noop */ } previewUrl = null; }
  };
  const closePreviewNow = () => {
    const f = previewCloser;
    previewCloser = null;
    if (f) { try { f(); } catch { /* noop */ } }
  };

  async function previewSharedFile(name) {
    closePreviewNow();
    const kind = guestPreviewKind(name);
    if (!kind) return;
    let buf;
    try {
      buf = await state.vfs.readBinary(joinShared(vpath(), name));
    } catch (err) {
      toast(t('shell.guest.previewFailed', { error: err.message }));
      return;
    }
    if (buf.byteLength > 100 * 1024 * 1024) {
      toast(t('shell.guest.previewTooBig'));
      return;
    }
    const url = URL.createObjectURL(new Blob([buf], { type: sharedMime(name) }));
    previewUrl = url;
    const ov = h('div', { class: 'guest-preview' });
    let media;
    if (kind === 'image') {
      media = document.createElement('img');
      media.src = url; media.alt = name;
    } else if (kind === 'video') {
      media = document.createElement('video');
      media.src = url; media.controls = true; media.autoplay = true;
    } else {
      media = document.createElement('audio');
      media.src = url; media.controls = true; media.autoplay = true;
    }
    const closePreview = () => {
      document.removeEventListener('keydown', onKey);
      try { ov.remove(); } catch { /* noop */ }
      revokePreviewUrl();
    };
    const onKey = (ev) => { if (ev.key === 'Escape') closePreviewNow(); };
    document.addEventListener('keydown', onKey);
    previewCloser = closePreview;
    const close = h('button', { class: 'btn', onclick: () => closePreview(), title: t('shell.guest.previewClose') }, t('shell.guest.previewClose'));
    close.type = 'button';
    ov.onclick = (ev) => { if (ev.target === ov) closePreview(); };
    ov.append(media, h('div', { class: 'cap' }, name), close);
    wrap.append(ov);
  }

  function renderCrumbs() {
    crumbs.innerHTML = '';
    const root = h('button', { class: 'crumb' + (path.length ? '' : ' cur'), onclick: () => { path = []; renderDir(); } }, t('shell.guest.crumbRoot'));
    root.type = 'button';
    crumbs.append(root);
    path.forEach((seg, i) => {
      crumbs.append(h('span', { class: 'muted' }, '›'));
      const b = h('button', { class: 'crumb' + (i === path.length - 1 ? ' cur' : ''), onclick: () => { path = path.slice(0, i + 1); renderDir(); } }, seg);
      b.type = 'button';
      crumbs.append(b);
    });
  }

  async function renderDir() {
    renderCrumbs();
    list.innerHTML = '';
    let entries = [];
    try {
      entries = await state.vfs.list(vpath());
    } catch (err) {
      list.append(h('div', { class: 'dash-empty' }, t('shell.guest.inaccessible', { error: err.message })));
      return;
    }
    entries.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'directory' ? -1 : 1));
    const shown = entries.slice(0, 200);
    if (!shown.length) list.append(h('div', { class: 'dash-empty' }, t('shell.guest.emptyDir')));
    for (const e of shown) {
      const row = h('div', { class: e.kind === 'directory' ? 'guest-row dir' : 'guest-row' });
      row.append(h('span', { class: 'guest-ic' }, guestIcon(e.kind, e.name)));
      row.append(h('span', { class: 'guest-name' }, e.name));
      const sizeEl = h('span', { class: 'guest-size' }, e.kind === 'directory' ? '' : '…');
      row.append(sizeEl);
      if (e.kind === 'directory') {
        row.onclick = () => { path = [...path, e.name]; renderDir(); };
      } else {
        const kind = guestPreviewKind(e.name);
        if (kind) {
          row.classList.add('media');
          row.onclick = () => { void previewSharedFile(e.name); };
          const pv = h('button', { class: 'btn mini', onclick: async (ev) => {
            ev.stopPropagation();
            await previewSharedFile(e.name);
          } }, t('shell.guest.preview'));
          pv.type = 'button';
          row.append(pv);
        }
        const dl = h('button', { class: 'btn mini', onclick: async (ev) => {
          ev.stopPropagation();
          try {
            const buf = await state.vfs.readBinary(joinShared(vpath(), e.name));
            const blob = new Blob([buf], { type: sharedMime(e.name) });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url; a.download = e.name;
            list.append(a); a.click(); a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 5000);
          } catch (err) {
            toast(t('shell.guest.downloadFailed', { error: err.message }));
          }
        } }, t('shell.guest.download'));
        dl.type = 'button';
        const del = h('button', { class: 'btn mini del', onclick: async (ev) => {
          if (ev) ev.stopPropagation();
          if (del.textContent !== t('shell.guest.sure')) { del.textContent = t('shell.guest.sure'); return; }
          try {
            await state.vfs.remove(joinShared(vpath(), e.name));
            toast(t('shell.guest.deleted'));
            renderDir();
          } catch (err) {
            toast(t('shell.guest.deleteFailed', { error: err.message }));
          }
        } }, t('shell.guest.delete'));
        del.type = 'button';
        row.append(dl, del);
        // Taille paresseuse (lecture seule du fichier lui-même).
        state.vfs.readBinary(joinShared(vpath(), e.name))
          .then((buf) => { sizeEl.textContent = guestHumanSize(buf.byteLength); })
          .catch(() => { sizeEl.textContent = '—'; });
      }
      list.append(row);
    }
    if (entries.length > shown.length) list.append(h('div', { class: 'dash-empty' }, tp('shell.guest.moreOthers', entries.length - shown.length)));
  }

  const addBtn = h('button', { class: 'btn mini', onclick: () => { mkRow.hidden = !mkRow.hidden; if (!mkRow.hidden) mkName.focus(); } }, t('shell.guest.addFolder'));
  addBtn.type = 'button';
  const mkRow = h('div', { class: 'guest-row', hidden: true });
  const mkName = h('input', { type: 'text', placeholder: t('shell.guest.folderName'), 'aria-label': t('shell.guest.folderNameAria') });
  const mkOk = h('button', { class: 'btn mini', onclick: async () => {
    const name = guestCheckName(mkName.value);
    if (!name) { toast(t('shell.guest.badFolderName')); return; }
    try {
      await state.vfs.mkdir(joinShared(vpath(), name));
      mkName.value = ''; mkRow.hidden = true;
      renderDir();
    } catch (err) {
      toast(t('shell.guest.createFailed', { error: err.message }));
    }
  } }, t('shell.guest.create'));
  mkOk.type = 'button';
  mkRow.append(mkName, mkOk);
  wrap.insertBefore(mkRow, drop);
  bar.append(addBtn);

  async function sendFiles(files) {
    let ok = 0, skipped = 0;
    for (const f of files) {
      const name = guestCheckName(f.name);
      if (!name) { skipped++; continue; }
      if (f.size > 100 * 1024 * 1024) { skipped++; continue; }
      try {
        await state.vfs.writeBinary(joinShared(vpath(), name), await f.arrayBuffer());
        ok++;
      } catch { skipped++; }
    }
    msg.textContent = ok || skipped ? t('shell.guest.sentLine', { ok, skipped: skipped ? t('shell.guest.sentSkipped', { n: skipped }) : '' }) : '';
    if (ok) { toast(t('shell.guest.sentToast', { n: ok })); renderDir(); }
  }
  pick.addEventListener('change', () => { sendFiles([...pick.files]); pick.value = ''; });
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('drag'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('drag'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault(); drop.classList.remove('drag');
    if (e.dataTransfer && e.dataTransfer.files) sendFiles([...e.dataTransfer.files]);
  });

  // Coquille shell : pas de sidebar en invité, topbar minimale.
  const side = $('side');
  if (side) { side.classList.add('hidden'); side.innerHTML = ''; }
  renderDir();
}

async function openPage(name) {
  if (!PAGES[name]) return;
  if (state.activeAppId) await closeActiveApp();
  stopDashClock();
  const stage = $('stage');
  if (!stage) {
    try { log(`Page failed: ${name} (no stage element)`, 'e'); } catch { /* noop */ }
    return;
  }
  stage.classList.remove('app-open');
  stage.innerHTML = '';
  state.activePage = name;
  highlightActivePage(name);
  try {
    await PAGES[name].render(stage);
  } catch (err) {
    // La page ne doit jamais rester vide : carte d'erreur + journal.
    const msg = `Page failed: ${name} (${err && err.message})`;
    try {
      stage.append(h('div', { class: 'dash' },
        h('div', { class: 'dash-hero' }, h('div', { class: 'dash-title' }, h('h2', {}, String(name)))),
        h('div', { class: 'dash-card' }, h('div', { class: 'dash-body' },
          h('div', { class: 'dash-empty' }, t('shell.errors.pageFailed', { error: String((err && err.message) || err) }))))));
      log(msg, 'e');
    } catch {
      try { log(msg, 'e'); } catch { /* noop */ }
    }
  }
}

function highlightActivePage(id) {
  document.querySelectorAll('[data-page-id]').forEach((el) => {
    el.classList.toggle('active', el.getAttribute('data-page-id') === id);
  });
  if (id) {
    document.querySelectorAll('.mitem').forEach((el) => el.classList.remove('active'));
  }
}

// ---------------------------------------------------------------------
// Tableau de bord (menu démarrer) : lecture seule, chaque carte échoue
// indépendamment. Les données data: sont lues déchiffrées via la clé
// maître de session (même privilège que usbos.fs.cat) — rien n'est écrit.
// ---------------------------------------------------------------------
function dashGreeting(date = new Date()) {
  const h = date.getHours();
  if (h < 18) return h < 12 ? t('shell.greet.morning') : t('shell.greet.afternoon');
  return t('shell.greet.evening');
}
function dashTodayLong(date = new Date()) {
  try {
    const s = date.toLocaleDateString(langLocale(), { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
    return s.charAt(0).toUpperCase() + s.slice(1);
  } catch {
    return date.toDateString();
  }
}
function dashClock(date = new Date()) {
  try {
    return date.toLocaleTimeString(langLocale(), { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}
function dashToISODate(dt) {
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}
function dashAddDaysISO(iso, n) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
  const dt = m ? new Date(+m[1], +m[2] - 1, +m[3]) : new Date();
  dt.setDate(dt.getDate() + n);
  return dashToISODate(dt);
}
function dashShortDay(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
  if (!m) return iso;
  try {
    return new Date(+m[1], +m[2] - 1, +m[3]).toLocaleDateString(langLocale(), { weekday: 'short', day: 'numeric', month: 'numeric' });
  } catch {
    return iso;
  }
}
// Trie + regroupe les événements à venir (aujourd'hui + `days` jours).
function dashUpcoming(events, todayISO, days = 7) {
  const end = dashAddDaysISO(todayISO, days);
  const list = (Array.isArray(events) ? events : [])
    .filter((e) => e && typeof e.date === 'string' && e.date >= todayISO && e.date <= end)
    .sort((a, b) => (a.date || '').localeCompare(b.date || '') || (a.allDay ? '' : a.start || '99').localeCompare(b.allDay ? '' : b.start || '99'))
    .slice(0, 60);
  const groups = new Map();
  for (const e of list) {
    if (!groups.has(e.date)) groups.set(e.date, []);
    if (groups.get(e.date).length < 5) groups.get(e.date).push(e);
  }
  return [...groups.entries()].map(([iso, items]) => ({ iso, items, more: list.filter((e) => e.date === iso).length - items.length }));
}
function dashFmtWhen(e) {
  if (!e || e.allDay || !e.start) return t('shell.dash.dayAll');
  return e.end && e.end > e.start ? `${e.start}–${e.end}` : e.start;
}
function dashFmtDateTime(ts) {
  try {
    return new Date(ts).toLocaleDateString(langLocale(), { day: 'numeric', month: 'numeric' });
  } catch {
    return '';
  }
}
function dashRelTime(ts, now) {
  const d = Math.max(0, (now || Date.now()) - ts);
  const m = Math.floor(d / 60000);
  if (m < 1) return t('shell.dash.relNow');
  if (m < 60) return t('shell.dash.relMin', { n: m });
  const h = Math.floor(m / 60);
  if (h < 24) return t('shell.dash.relHour', { n: h });
  const j = Math.floor(h / 24);
  if (j < 7) return t('shell.dash.relDay', { n: j });
  return dashFmtDateTime(ts);
}

async function dashReadJSON(appId, file) {
  try {
    const buf = await encryptedReadBinary(`data:${appId}/${file}`);
    return JSON.parse(new TextDecoder().decode(buf));
  } catch {
    return null;
  }
}

function dashCard(title, onclick) {
  const c = h('div', { class: 'dash-card' + (onclick ? ' clickable' : '') });
  c.append(h('h3', {}, title));
  const body = h('div', { class: 'dash-body' });
  c.append(body);
  if (onclick) {
    c.addEventListener('click', onclick);
    c.setAttribute('role', 'button');
    c.setAttribute('tabindex', '0');
    c.setAttribute('aria-label', title);
    c.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onclick(e); }
    });
  }
  return { card: c, body };
}
function dashEmpty(body, text) {
  body.append(h('div', { class: 'dash-empty' }, text));
}

function renderDashUpdate(box) {
  box.innerHTML = '';
  const plan = state.lastPlan;
  if (plan && plan.hasUpdates) {
    box.append(h('div', { class: 'dash-update-yes' }, t('shell.update.available', { summary: plan.summary })));
    const btn = h('button', { class: 'btn primary', onclick: (e) => { e.stopPropagation(); applyUpdatePlan(plan).catch((err) => log(`Mise à jour impossible : ${err && err.message}`, 'e')); } }, t('shell.update.applyBtn'));
    box.append(btn);
  } else if (plan) {
    box.append(h('div', { class: 'dash-ok' }, t('shell.update.upToDate')));
    const btn = h('button', { class: 'btn', onclick: (e) => { e.stopPropagation(); void checkForUpdates().catch(() => {}); } }, t('shell.update.recheck'));
    box.append(btn);
  } else {
    box.append(h('div', { class: 'dash-empty' }, t('shell.update.unknown')));
    const btn = h('button', { class: 'btn', onclick: (e) => { e.stopPropagation(); void checkForUpdates().catch(() => {}); } }, t('shell.update.checkNow'));
    box.append(btn);
  }
}

function renderDashboard(stage) {
  const wrap = h('div', { class: 'dash' });

  // Hero système
  const hero = h('div', { class: 'dash-hero' });
  const titleRow = h('div', { class: 'dash-title' });
  titleRow.append(h('h2', {}, `${dashGreeting()} — ${dashTodayLong()}`));
  const clock = h('span', { class: 'dash-clock', id: 'dash-clock' }, dashClock());
  titleRow.append(clock);
  hero.append(titleRow);
  const meta = h('div', { class: 'dash-meta' });
  meta.append(
    h('span', { class: 'chip' }, t('shell.dash.key', { name: state.usbosHandle ? state.usbosHandle.name : '—' })),
    h('span', { class: 'chip' }, t('shell.dash.keyId', { id: state.keyId || '?' })),
    h('span', { class: 'chip' }, t('shell.dash.kernel', { version: KERNEL_VERSION })),
    h('span', { class: 'chip' }, state.masterKey ? t('shell.dash.encrypted') : state.plainMode ? t('shell.dash.plain') : t('shell.dash.locked')),
    h('span', { class: 'chip' }, tp('shell.dash.appsCount', state.apps.size))
  );
  hero.append(meta);
  wrap.append(hero);

  const grid = h('div', { class: 'dash-grid' });
  wrap.append(grid);
  stage.append(wrap);

  // Horloge vivante, nettoyée à la sortie (openApp/switchKeyFlow).
  stopDashClock();
  state.dashTimer = setInterval(() => {
    const el = $('dash-clock');
    if (el) el.textContent = dashClock();
    else stopDashClock();
  }, 30000);

  // Carte Agenda
  {
    const { card, body } = dashCard(t('shell.dash.agendaTitle'), () => openApp('agenda'));
    grid.append(card);
    (async () => {
      const data = await dashReadJSON('agenda', 'agenda.json');
      if (!data) { dashEmpty(body, t('shell.dash.noData')); return; }
      if (data.version !== 2 || !Array.isArray(data.events)) {
        dashEmpty(body, t('shell.dash.migrate'));
        return;
      }
      const today = dashToISODate(new Date());
      const groups = dashUpcoming(data.events, today, 7);
      if (!groups.length) { dashEmpty(body, t('shell.dash.nothingComing')); return; }
      for (const g of groups.slice(0, 4)) {
        const day = h('div', { class: 'dash-day' });
        day.append(h('div', { class: 'dash-daytitle' }, g.iso === today ? t('shell.dash.today') : dashShortDay(g.iso)));
        for (const e of g.items) {
          const row = h('div', { class: 'dash-ev' + (e.done ? ' done' : '') });
          row.append(h('span', { class: 't' }, dashFmtWhen(e)), h('span', {}, String(e.title || t('shell.dash.untitled')).slice(0, 80)));
          day.append(row);
        }
        if (g.more > 0) day.append(h('div', { class: 'dash-more' }, tp('shell.dash.moreOthers', g.more)));
        body.append(day);
      }
    })();
  }

  // Carte Notes (3 dernières)
  {
    const { card, body } = dashCard(t('shell.dash.notesTitle'), () => openApp('notes'));
    grid.append(card);
    (async () => {
      const data = await dashReadJSON('notes', 'notes.json');
      const list = Array.isArray(data) ? [...data].sort((a, b) => (b.created || 0) - (a.created || 0)).slice(0, 3) : [];
      if (!list.length) { dashEmpty(body, t('shell.dash.noNotes')); return; }
      for (const n of list) {
        const row = h('div', { class: 'dash-row' });
        row.append(h('b', {}, String(n.title || t('shell.dash.untitled')).slice(0, 60)));
        if (n.created) row.append(h('span', { class: 'muted' }, dashRelTime(n.created)));
        body.append(row);
      }
    })();
  }

  // Carte Documents markdown
  {
    const { card, body } = dashCard(t('shell.dash.docsTitle'), () => openApp('markdown'));
    grid.append(card);
    (async () => {
      const data = await dashReadJSON('markdown', 'markdown.json');
      const docs = data && Array.isArray(data.docs) ? data.docs.slice(0, 4) : [];
      if (!docs.length) { dashEmpty(body, t('shell.dash.noDocs')); return; }
      for (const d of docs) {
        const row = h('div', { class: 'dash-row' });
        row.append(h('b', {}, String(d.name || t('shell.dash.noname')).slice(0, 60)));
        if (d.updated) row.append(h('span', { class: 'muted' }, dashRelTime(d.updated)));
        body.append(row);
      }
    })();
  }

  // Carte Mesh (code cliquable = copier)
  {
    const { card, body } = dashCard(t('shell.dash.meshTitle'), () => openApp('mesh'));
    grid.append(card);
    (async () => {
      const cfg = await dashReadJSON('mesh', 'mesh.json');
      if (!cfg || !cfg.myId) { dashEmpty(body, t('shell.dash.meshEmpty')); return; }
      const code = h('button', { class: 'dash-code', title: t('shell.dash.meshCopyHint') }, String(cfg.myId));
      code.onclick = async (e) => {
        e.stopPropagation();
        try {
          await navigator.clipboard.writeText(String(cfg.myId));
          code.textContent = t('shell.dash.copied');
          const _id = String(cfg.myId);
          setTimeout(() => { if (code.isConnected) code.textContent = _id; }, 1200);
        } catch {
          code.textContent = String(cfg.myId);
        }
      };
      body.append(h('div', { class: 'muted' }, t('shell.dash.meshCodeLabel')), code);
    })();
  }

  // Carte Coffre (existence seule — le noyau ne connaît pas sa passphrase)
  {
    const { card, body } = dashCard(t('shell.dash.coffreTitle'), () => openApp('coffre'));
    grid.append(card);
    (async () => {
      let exists = false;
      try { exists = await state.vfs.exists('data:coffre/coffre.bin'); } catch { exists = false; }
      dashEmpty(body, exists
        ? t('shell.dash.coffreLocked')
        : t('shell.dash.coffreNone'));
    })();
  }

  // Carte Mises à jour
  {
    const c = h('div', { class: 'dash-card' });
    c.append(h('h3', {}, t('shell.dash.updateTitle')));
    const box = h('div', { class: 'dash-body', id: 'dash-update' });
    c.append(box);
    grid.append(c);
    renderDashUpdate(box);
  }

  // Carte Alertes (dernières erreurs)
  {
    const { card, body } = dashCard(t('shell.dash.alertsTitle'));
    grid.append(card);
    try {
      const errs = window.USBosLog.filter({ level: 'error' }).slice(-5).reverse();
      if (!errs.length) { dashEmpty(body, t('shell.dash.noErrors')); }
      for (const e of errs) {
        const row = h('div', { class: 'dash-err' });
        row.append(h('span', { class: 't' }, new Date(e.ts).toLocaleTimeString(langLocale())));
        row.append(h('span', {}, `[${e.source}] ${String(e.message).slice(0, 120)}`));
        body.append(row);
      }
    } catch {
      dashEmpty(body, t('shell.dash.logGone'));
    }
  }
}

/** Ferme l'app active et revient à l'écran vide, sans changer de clé ni recharger la page. */
async function goToDesktop() {
  await closeActiveApp();
  document.querySelectorAll('.mitem').forEach((el) => el.classList.remove('active'));
  showEmptyStage();
}

function highlightActiveApp(id) {
  document.querySelectorAll('.mitem').forEach((el) => {
    el.classList.toggle('active', el.getAttribute('data-app-id') === id);
  });
}

function renderUpdateBanner(plan) {
  const actions = $('actions');
  if (!actions) return;
  const old = actions.querySelector('.update-btn');
  if (old) old.remove();
  const btn = h('button', { class: 'btn primary update-btn', onclick: () => { applyUpdatePlan(plan).catch((e) => log(`Mise à jour impossible : ${e && e.message}`, 'e')); } },
    t('shell.update.banner', { summary: plan.summary }));
  actions.prepend(btn);
}

function clearUpdateBanner() {
  const actions = $('actions');
  if (!actions) return;
  const old = actions.querySelector('.update-btn');
  if (old) old.remove();
}

// Exposé pour console.js / DevTools sans dépendre de bindings lexicaux
// inter-scripts (robuste si passage en modules ES un jour).
window.USBosKernel = {
  get state() { return state; },
  get version() { return KERNEL_VERSION; },
  get keyId() { return state.keyId; },
  openApp, closeActiveApp, goToDesktop, checkForUpdates, applyUpdatePlan, switchKeyFlow, connectFlow, guestPickFlow,
  setPassphrase, removePassphrase, changePassphrase, setTheme, setWallpaper, importWallImage, removeWallImage, addCustomTheme, removeCustomTheme,
  previewCustomTheme, clearCustomPreview, setUiPrefs, openPage, renderDesktop,
  t, tp, tx, currentLang, langLocale, availableLangs, langDisplayName, setLang, loadLangs, validateLangPack,
  saveLangPack, removeLangPack, exportLangPack, importLangPackText,
  __updateChecker: { start: startUpdateChecker, stop: stopUpdateChecker },
  dashboard: () => showEmptyStage(),
  journal: () => openJournalInConsole(),
  // Lecture déchiffrée d'un fichier data: (exige session déverrouillée).
  readDataText: async (vpath) => {
    const buf = await encryptedReadBinary(vpath);
    return new TextDecoder().decode(buf);
  },
};

// ---------------------------------------------------------------------
let _booted = false;
function bootOnce() { if (_booted) return; _booted = true; boot(); }
window.addEventListener('DOMContentLoaded', bootOnce);
if (document.readyState !== 'loading') bootOnce();
