/*
 * USBos — system/console.js
 * Construit window.usbos : l'API de commandes utilisable depuis la console
 * DevTools. Appelle DIRECTEMENT les fonctions internes du noyau (même
 * scope, même processus) — pas de pont RPC ici, contrairement aux apps.
 * N'importe qui ouvrant DevTools a de toute façon déjà accès à `state`,
 * `openApp`, etc. : cette API organise et documente cet accès, elle ne
 * retire ni n'ajoute de barrière de sécurité.
 */
'use strict';

const REGISTRY = {}; // catégorie -> { nom: { run, help, destructive } }

function defineCommand(category, name, { help, destructive = false, run }) {
  if (!REGISTRY[category]) REGISTRY[category] = {};
  REGISTRY[category][name] = { help, destructive, run };
}

function K() {
  if (window.USBosKernel && window.USBosKernel.state) return window.USBosKernel;
  // Repli : bindings lexicaux inter-scripts (scripts classiques partagent
  // le scope global ; casse en modules ES — préférer USBosKernel).
  if (typeof state === 'undefined') throw new Error('Noyau indisponible');
  return {
    get state() { return state; },
    get version() { return KERNEL_VERSION; },
    openApp, goToDesktop, checkForUpdates, applyUpdatePlan,
  };
}

/** ct()/ctp() — t()/tp() du noyau avec repli sur la clé (pré-noyau). Les help: sont des clés console.*. */
function ct(path, params) {
  try {
    const k = K();
    if (k && typeof k.t === 'function') return k.t(path, params);
  } catch { /* noyau indisponible */
  }
  return path;
}
function ctp(path, count, params) {
  try {
    const k = K();
    if (k && typeof k.tp === 'function') return k.tp(path, count, params);
  } catch { /* noyau indisponible */
  }
  return `${path} (${count})`;
}
function cmode() {
  const s = K().state;
  return s.masterKey ? ct('console.system.modeEncrypted') : s.plainMode ? ct('console.system.modePlain') : ct('console.system.modeLocked');
}

function requireUnlocked() {
  if (!K().state.masterKey && !K().state.plainMode) throw new Error(ct('shell.errors.locked'));
}

function requireConnected() {
  if (!K().state.vfs) throw new Error(ct('shell.errors.noKey'));
}

/** Enveloppe une commande destructive : exige { confirm: true } en second argument. */
function guarded(fn) {
  return (...args) => {
    const last = args[args.length - 1];
    const hasConfirm = last && typeof last === 'object' && last.confirm === true;
    if (!hasConfirm) {
      return ct('console.guardedConfirm');
    }
    return fn(...args.slice(0, -1));
  };
}

// ------------------------------------------------------------------ system
defineCommand('system', 'info', {
  help: 'console.system.info',
  run: () => ({
    kernel: K().version,
    key: K().state.usbosHandle ? K().state.usbosHandle.name : null,
    keyId: K().state.keyId || null,
    mode: cmode(),
    locked: !K().state.masterKey && !K().state.plainMode,
    activeApp: K().state.activeAppId,
    appCount: K().state.apps.size,
    browser: navigator.userAgent,
  }),
});
defineCommand('system', 'reboot', {
  help: 'console.system.reboot',
  run: () => { window.location.reload(); return ct('console.system.rebooting'); },
});
defineCommand('system', 'uptime', {
  help: 'console.system.uptime',
  run: () => Date.now() - BOOT_TS,
});
defineCommand('system', 'theme', {
  help: 'console.system.theme',
  run: (theme, accent) => K().setTheme(theme, accent),
});
defineCommand('system', 'settings', {
  help: 'console.system.settings',
  run: () => K().openPage('settings'),
});
defineCommand('system', 'lang', {
  help: 'console.system.lang',
  run: async (code) => {
    if (!code) return K().availableLangs().map((c) => ({ code: c, name: K().langDisplayName(c), active: K().currentLang() === c }));
    await K().setLang(String(code));
    return K().currentLang();
  },
});

// -------------------------------------------------------------------- logs
defineCommand('logs', 'tail', {
  help: 'console.logs.tail',
  run: (n = 50) => window.USBosLog.tail(n),
});
defineCommand('logs', 'filter', {
  help: 'console.logs.filter',
  run: (opts) => window.USBosLog.filter(opts || {}),
});
defineCommand('logs', 'clear', {
  help: 'console.logs.clear',
  destructive: true,
  run: guarded(() => ctp('console.logs.cleared', window.USBosLog.clear())),
});
defineCommand('logs', 'level', {
  help: 'console.logs.level',
  run: (lvl) => { window.USBosLog.setMinLevel(lvl); return ct('console.logs.minLevel', { lvl }); },
});
defineCommand('logs', 'export', {
  help: 'console.logs.export',
  run: async () => {
    requireConnected();
    if (K().state.guest) throw new Error(ct('shell.errors.locked'));
    const name = `usbos-${new Date().toISOString().replace(/[:.]/g, '-')}.log`;
    await K().state.vfs.writeText(`system:logs/${name}`, window.USBosLog.toText());
    return ct('console.logs.written', { name });
  },
});

// -------------------------------------------------------------------- apps
defineCommand('apps', 'list', {
  help: 'console.apps.list',
  run: () => [...K().state.apps.values()].map((a) => a.manifest),
});
defineCommand('apps', 'open', {
  help: 'console.apps.open',
  run: (id) => {
    if (!K().state.apps.get(id)) throw new Error(ct('shell.errors.unknownApp', { id }));
    return K().openApp(id);
  },
});
defineCommand('apps', 'close', {
  help: 'console.apps.close',
  run: () => K().goToDesktop(),
});
defineCommand('apps', 'reload', {
  help: 'console.apps.reload',
  run: async (id) => {
    if (!K().state.apps.get(id)) throw new Error(ct('shell.errors.unknownApp', { id }));
    await K().goToDesktop(); return K().openApp(id);
  },
});
defineCommand('apps', 'manifest', {
  help: 'console.apps.manifest',
  run: (id) => {
    const entry = K().state.apps.get(id);
    if (!entry) throw new Error(ct('shell.errors.unknownApp', { id }));
    return entry.manifest;
  },
});

// ---------------------------------------------------------------------- fs
defineCommand('fs', 'ls', {
  help: 'console.fs.ls',
  run: (vpath) => { requireConnected(); return K().state.vfs.list(vpath); },
});
defineCommand('fs', 'stat', {
  help: 'console.fs.stat',
  run: async (vpath) => { requireConnected(); return { vpath, exists: await K().state.vfs.exists(vpath) }; },
});
defineCommand('fs', 'cat', {
  help: 'console.fs.cat',
  run: async (vpath) => {
    requireConnected();
    if (String(vpath).startsWith('data:')) {
      requireUnlocked();
      return K().readDataText(vpath);
    }
    return K().state.vfs.readText(vpath);
  },
});
defineCommand('fs', 'rm', {
  help: 'console.fs.rm',
  destructive: true,
  run: guarded((vpath) => { requireConnected(); return K().state.vfs.remove(vpath); }),
});

// --------------------------------------------------------------- updater
defineCommand('updater', 'check', {
  help: 'console.updater.check',
  run: () => K().checkForUpdates(),
});
defineCommand('updater', 'apply', {
  help: 'console.updater.apply',
  destructive: true,
  run: guarded(async () => {
    requireConnected();
    const plan = await window.USBosUpdater.checkAll(K().state.vfs, K().version);
    if (!plan.hasUpdates) return ct('console.updater.nothing');
    return K().applyUpdatePlan(plan);
  }),
});

// -------------------------------------------------------------- security
defineCommand('security', 'status', {
  help: 'console.security.status',
  run: () => ({
    mode: cmode(),
    unlocked: !!K().state.masterKey || !!K().state.plainMode,
    shared: K().state.sharedHandle ? ct('console.security.shareOn') : ct('console.security.shareOff'),
  }),
});
defineCommand('security', 'lock', {
  help: 'console.security.lock',
  run: () => {
    if (!K().state.masterKey && K().state.plainMode) return ct('console.system.modePlain');
    K().state.masterKey = null; window.location.reload(); return ct('console.security.locked');
  },
});
defineCommand('security', 'setPassphrase', {
  help: 'console.security.setPassphrase',
  destructive: true,
  run: guarded(async (passphrase) => {
    requireConnected();
    return K().setPassphrase(passphrase);
  }),
});
defineCommand('security', 'removePassphrase', {
  help: 'console.security.removePassphrase',
  destructive: true,
  run: guarded(async (passphrase) => {
    requireConnected();
    return K().removePassphrase(passphrase);
  }),
});
defineCommand('security', 'changePassphrase', {
  help: 'console.security.changePassphrase',
  destructive: true,
  run: guarded(async (oldPhrase, newPhrase) => {
    requireConnected();
    return K().changePassphrase(oldPhrase, newPhrase);
  }),
});

// ------------------------------------------------------------------- mesh
defineCommand('mesh', 'note', {
  help: 'console.mesh.note',
  run: () => ct('console.mesh.open'),
});

// --------------------------------------------------------------------- dev
defineCommand('dev', 'dumpState', {
  help: 'console.dev.dumpState',
  run: () => ({
    kernel: K().version,
    apps: [...K().state.apps.keys()],
    activeApp: K().state.activeAppId,
    mode: cmode(),
    unlocked: !!K().state.masterKey || !!K().state.plainMode,
    key: K().state.usbosHandle ? K().state.usbosHandle.name : null,
    lastErrors: window.USBosLog.filter({ level: 'error' }).slice(-10).map((e) => ({ ts: e.ts, source: e.source, message: e.message })),
  }),
});
defineCommand('dev', 'version', { help: 'console.dev.version', run: () => K().version });

// ------------------------------------------------------------------- help
function buildHelp(category) {
  const cats = category ? [category] : Object.keys(REGISTRY);
  const lines = [];
  if (!category) {
    lines.push(ct('console.help.header'));
  }
  for (const cat of cats) {
    if (!REGISTRY[cat]) { lines.push(ct('console.help.unknownCat', { cat })); continue; }
    lines.push(`\n=== usbos.${cat} ===`);
    for (const [name, cmd] of Object.entries(REGISTRY[cat])) {
      lines.push(`  ${cat}.${name}()${cmd.destructive ? '  ' + ct('console.help.destructive') : ''} — ${ct(cmd.help)}`);
    }
  }
  return lines.join('\n');
}

// --------------------------------------------------------- construction
function safeArg(a) {
  try {
    const s = JSON.stringify(a);
    return s === undefined ? String(a) : s;
  } catch {
    return ct('console.notSerializable');
  }
}

// Passphrases : jamais en clair dans le journal (ni DevTools ni palette).
const REDACT = [['security', 'setPassphrase'], ['security', 'changePassphrase'], ['security', 'removePassphrase']];
function isSensitive(cat, name) { return REDACT.some(([c, n]) => c === cat && n === name); }
function formatArgs(cat, name, args) {
  if (isSensitive(cat, name)) return '(***)';
  return args.map(safeArg).join(', ');
}

const BOOT_TS = Date.now();
const usbos = { help: (category) => console.log(buildHelp(category)) };
for (const [cat, commands] of Object.entries(REGISTRY)) {
  usbos[cat] = {};
  for (const [name, cmd] of Object.entries(commands)) {
    usbos[cat][name] = (...args) => {
      window.USBosLog.debug('console', `usbos.${cat}.${name}(${formatArgs(cat, name, args)})`);
      try {
        const r = cmd.run(...args);
        if (r && typeof r.catch === 'function') {
          return r.catch((err) => { window.USBosLog.error('console', `usbos.${cat}.${name} : ${err.message}`); throw err; });
        }
        return r;
      } catch (err) {
        window.USBosLog.error('console', `usbos.${cat}.${name} : ${err.message}`);
        throw err;
      }
    };
  }
}
window.usbos = usbos;

// ------------------------------------------------- formes courtes `u.*`
// `u` = même API en plus court : miroirs de catégories (u.logs.tail(100))
// + getters LECTURE SEULE sans parenthèses (u.info, u.tail...). Aucun
// getter sur ce qui modifie (clear/lock/rm/apply...) : un simple survol
// dans la console pourrait les déclencher via l'aperçu.
const U_GETTERS = {
  info: ['system', 'info', []],
  apps: ['apps', 'list', []],
  tail: ['logs', 'tail', [50]],
  errors: ['logs', 'filter', [{ level: 'error' }], (r) => r.slice(-20)],
  uptime: ['system', 'uptime', []],
  version: ['dev', 'version', []],
  status: ['security', 'status', []],
  help: [null, null, [], (r) => r],
};

const u = {};
for (const [cat, commands] of Object.entries(REGISTRY)) {
  u[cat] = usbos[cat];
}
for (const [name, [cat, cmd, args, post]] of Object.entries(U_GETTERS)) {
  Object.defineProperty(u, name, {
    enumerable: true,
    get: () => {
      window.USBosLog.debug('console', `u.${name}`);
      try {
        if (name === 'help') { usbos.help(); return undefined; }
        const out = REGISTRY[cat][cmd].run(...args);
        if (out && typeof out.then === 'function') {
          return out.then((v) => (typeof post === 'function' ? post(v) : v)).catch((err) => { window.USBosLog.error('console', `u.${name} : ${err.message}`); throw err; });
        }
        return typeof post === 'function' ? post(out) : out;
      } catch (err) {
        window.USBosLog.error('console', `u.${name} : ${err.message}`);
        throw err;
      }
    },
  });
}
window.u = u;
window.$help = (category) => usbos.help(category);
window.USBosLog.info('console', 'Console de commandes prête — tapez usbos.help(), u.help ou $help() dans DevTools.');

// ------------------------------------------------- palette de commandes
// Overlay façon IDE (bouton ⌘ / Ctrl+K) : fantôme gris + TAB + ↑↓ + historique.
// Indexe REGISTRY + alias courts. Exécution via les mêmes cmd.run (mêmes
// gardes) ; les destructives demandent une confirmation inline (2e Entrée).
const PALETTE_ALIASES = {
  info: ['system', 'info', []], apps: ['apps', 'list', []], tail: ['logs', 'tail', [50]],
  errors: ['logs', 'filter', [{ level: 'error' }]], uptime: ['system', 'uptime', []],
  version: ['dev', 'version', []], status: ['security', 'status', []],
  updates: ['updater', 'check', []], help: [null, null, []],
};

function paletteIndex() {
  const out = [];
  for (const [cat, commands] of Object.entries(REGISTRY)) {
    for (const [name, cmd] of Object.entries(commands)) {
      out.push({ path: `${cat} ${name}`, cat, name, help: cmd.help, destructive: !!cmd.destructive, run: cmd.run, args: [] });
    }
  }
  for (const [alias, [cat, cmd, args]] of Object.entries(PALETTE_ALIASES)) {
    if (alias === 'help') {
      out.push({ path: 'help', cat: null, name: 'help', help: 'console.help.palette', destructive: false, run: null, args: [] });
      continue;
    }
    const src = REGISTRY[cat][cmd];
    out.push({ path: alias, cat, name: cmd, help: src.help, destructive: !!src.destructive, run: src.run, args: args || [] });
  }
  return out;
}

function paletteRank(entry, q) {
  const p = entry.path.toLowerCase();
  if (p.startsWith(q)) return 0;
  if (p.split(' ').some((w) => w.startsWith(q))) return 1;
  if (p.includes(q)) return 2;
  return -1;
}

function paletteParseArgs(text) {
  const tokens = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(text))) tokens.push(m[1] ?? m[2] ?? m[3]);
  return tokens.map((t) => {
    try { return JSON.parse(t); } catch { return t; }
  });
}

  function paletteFormat(value) {
  if (value === undefined) return ct('console.palette.ok');
  try {
    const s = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    return String(s).slice(0, 4000);
  } catch {
    return ct('console.notSerializable');
  }
}

const Palette = (() => {
  let els = null;
  let matches = [];
  let activeIdx = 0;
  let cycleIdx = -1;
  let cycleBase = null;
  let history = [];
  let histIdx = -1;
  let pending = null; // { entry, args } en attente de confirmation destructive

  function build() {
    const overlay = document.createElement('div');
    overlay.className = 'pal-overlay hidden';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-label', ct('console.palette.aria'));
    overlay.innerHTML = '';
    const box = document.createElement('div');
    box.className = 'pal-box';
    const wrap = document.createElement('div');
    wrap.className = 'pal-wrap';
    const ghost = document.createElement('div');
    ghost.className = 'pal-ghost';
    ghost.setAttribute('aria-hidden', 'true');
    const input = document.createElement('input');
    input.className = 'pal-input';
    input.setAttribute('placeholder', ct('console.palette.placeholder'));
    input.setAttribute('autocomplete', 'off');
    input.setAttribute('spellcheck', 'false');
    wrap.append(ghost, input);
    const hint = document.createElement('div');
    hint.className = 'pal-hint';
    hint.textContent = ct('console.palette.hint');
    const list = document.createElement('div');
    list.className = 'pal-list';
    list.setAttribute('role', 'listbox');
    const out = document.createElement('div');
    out.className = 'pal-out';
    box.append(wrap, hint, list, out);
    overlay.append(box);
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
    input.addEventListener('input', () => { pending = null; cycleIdx = -1; cycleBase = null; histIdx = -1; refresh(); });
    input.addEventListener('keydown', onKey);
    document.body.append(overlay);
    els = { overlay, input, ghost, list, out, hint };
  }

  function index() { return paletteIndex(); }

  function currentMatches(q) {
    const query = q.trim().toLowerCase();
    if (!query) return index().slice(0, 8);
    return index()
      .map((e) => ({ e, r: paletteRank(e, query) }))
      .filter((x) => x.r >= 0)
      .sort((a, b) => a.r - b.r)
      .slice(0, 8)
      .map((x) => x.e);
  }

  function ghostFor() {
    const typed = els.input.value;
    const first = matches[0];
    if (!typed || !first) return { typed, rest: '' };
    const p = first.path;
    if (p.toLowerCase().startsWith(typed.toLowerCase())) {
      return { typed, rest: p.slice(typed.length) };
    }
    return { typed, rest: '' };
  }

  function refresh() {
    matches = currentMatches(els.input.value);
    activeIdx = 0;
    const g = ghostFor();
    els.ghost.innerHTML = '';
    const t = document.createElement('span');
    t.textContent = g.typed;
    t.style.visibility = 'hidden';
    const r = document.createElement('span');
    r.className = 'rest';
    r.textContent = g.rest;
    els.ghost.append(t, r);
    els.list.innerHTML = '';
    if (pending) {
      els.hint.textContent = ct('console.palette.pendingHint', { path: pending.entry.path });
    } else {
      els.hint.textContent = ct('console.palette.hint');
    }
    matches.forEach((e, i) => {
      const b = document.createElement('button');
      b.className = 'pal-item' + (i === activeIdx ? ' active' : '') + (e.destructive ? ' destructive' : '');
      b.type = 'button';
      b.setAttribute('role', 'option');
      b.setAttribute('aria-selected', i === activeIdx ? 'true' : 'false');
      const p = document.createElement('span');
      p.className = 'p';
      p.textContent = e.path + (e.destructive ? '  ' + ct('console.palette.destructiveBadge') : '');
      const d = document.createElement('span');
      d.className = 'd';
      d.textContent = ct(e.help);
      b.append(p, d);
      b.onclick = () => { els.input.value = e.path + ' '; els.input.focus(); pending = null; cycleIdx = -1; cycleBase = null; refresh(); };
      els.list.append(b);
    });
  }

  function paintActive() {
    [...els.list.children].forEach((b, i) => {
      b.classList.toggle('active', i === activeIdx);
      b.setAttribute('aria-selected', i === activeIdx ? 'true' : 'false');
    });
    const g = ghostFor();
    els.ghost.innerHTML = '';
    const t = document.createElement('span');
    t.textContent = g.typed;
    t.style.visibility = 'hidden';
    const r = document.createElement('span');
    r.className = 'rest';
    r.textContent = g.rest;
    els.ghost.append(t, r);
  }

  function complete() {
    if (!matches.length) return;
    // Premier TAB : fige la base de cycle sur la requête actuelle ; les TAB
    // suivants cyclent dans cette base (pas dans les matchs recalculés).
    const typed = els.input.value;
    if (!cycleBase || !typed.startsWith(cycleBase.q)) {
      cycleBase = { q: typed, list: matches.slice() };
      cycleIdx = -1;
    }
    cycleIdx = (cycleIdx + 1) % cycleBase.list.length;
    els.input.value = cycleBase.list[cycleIdx].path + ' ';
    pending = null;
    refresh();
    els.input.value = cycleBase.list[cycleIdx].path + ' ';
    activeIdx = matches.findIndex((e) => e.path === cycleBase.list[cycleIdx].path);
    if (activeIdx < 0) activeIdx = 0;
    paintActive();
  }

  function showOut(text, isErr) {
    els.out.textContent = text;
    els.out.classList.toggle('err', !!isErr);
  }

  async function execute(raw) {
    const text = raw.trim();
    if (!text) return;
    // Les chemins contiennent un espace ("logs tail") : on matche le PLUS
    // LONG préfixe, en forme espace ou pointée ("logs.tail"), sinon le
    // premier mot ("logs") serait cherché comme commande.
    const lower = text.toLowerCase();
    let entry = null, rest = '', best = -1;
    for (const e of index()) {
      for (const form of [e.path, e.path.replace(' ', '.')]) {
        if (lower === form && form.length > best) { entry = e; rest = ''; best = form.length; }
        else if (lower.startsWith(form + ' ') && form.length > best) { entry = e; rest = text.slice(form.length + 1); best = form.length; }
      }
    }
    if (!entry) { showOut(ct('console.palette.unknownCmd', { cmd: text.split(' ')[0] }), true); return; }
    if (entry.name === 'help' && !entry.run) { showOut(buildHelp(), false); pushHistory(text); return; }
    // Args frappés par l'utilisateur remplacent les défauts de l'alias
    // (ex. `tail 100` -> [100], pas [50, 100]).
    const args = rest ? paletteParseArgs(rest) : [...(entry.args || [])];
    // Destructif : confirmation inline AVANT tout run (le flag suffit —
    // certains run ne sont pas enveloppés par guarded()).
    if (entry.destructive) {
      pending = { entry, args };
      refresh();
      showOut(ct('console.palette.confirmDestructive', { path: entry.path }), false);
      return;
    }
    window.USBosLog.debug('palette', `pal ${entry.path}(${formatArgs(entry.cat, entry.name, args)})`);
    try {
      const out = await entry.run(...args);
      pending = null;
      pushHistory(text);
      showOut(paletteFormat(out), false);
    } catch (err) {
      window.USBosLog.error('palette', `pal ${entry.path} : ${err.message}`);
      showOut(ct('console.palette.error', { error: err.message }), true);
    }
  }

  async function confirmPending() {
    const { entry, args } = pending;
    pending = null;
    refresh();
    window.USBosLog.debug('palette', `pal ${entry.path} (confirmé${isSensitive(entry.cat, entry.name) ? ' (***)' : ''})`);
    try {
      const out = await entry.run(...args, { confirm: true });
      pushHistory(els.input.value);
      showOut(paletteFormat(out), false);
    } catch (err) {
      pending = null;
      refresh();
      window.USBosLog.error('palette', `pal ${entry.path} : ${err.message}`);
      showOut(ct('console.palette.error', { error: err.message }), true);
    }
  }

  function pushHistory(text) {
    if (history[history.length - 1] !== text) history.push(text);
    if (history.length > 100) history.shift();
    histIdx = -1;
  }

  function onKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); close(); return; }
    if (e.key === 'Tab') {
      e.preventDefault();
      if (pending) return;
      complete();
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (pending) { confirmPending(); return; }
      const target = matches[activeIdx];
      const raw = els.input.value;
      // Entrée sur une proposition surlignée sans args frappés -> prend la proposition
      if (target && !raw.includes(' ') && raw.trim().toLowerCase() !== target.path) {
        els.input.value = target.path + ' ';
        pending = null; cycleIdx = -1; cycleBase = null; refresh();
        return;
      }
      execute(raw);
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const dir = e.key === 'ArrowDown' ? 1 : -1;
      if (els.input.value.trim() && matches.length) {
        activeIdx = (activeIdx + dir + matches.length) % matches.length;
        paintActive();
      } else if (history.length) {
        if (histIdx < 0) histIdx = dir > 0 ? 0 : history.length - 1;
        else histIdx = (histIdx + dir + history.length) % history.length;
        els.input.value = history[histIdx];
        pending = null; cycleIdx = -1; cycleBase = null; refresh();
      }
      return;
    }
  }

  function open() {
    if (!els) build();
    // Libellés persistants : re-traduits à chaque ouverture (changement de langue).
    els.overlay.setAttribute('aria-label', ct('console.palette.aria'));
    els.input.setAttribute('placeholder', ct('console.palette.placeholder'));
    els.overlay.classList.remove('hidden');
    els.input.value = '';
    els.out.textContent = '';
    els.out.classList.remove('err');
    pending = null; cycleIdx = -1; cycleBase = null; histIdx = -1;
    refresh();
    els.input.focus();
  }
  function close() {
    if (!els) return;
    els.overlay.classList.add('hidden');
    pending = null;
  }
  function toggle() {
    if (!els || els.overlay.classList.contains('hidden')) open();
    else close();
  }

  return { open, close, toggle, _internals: { paletteIndex, paletteRank, paletteParseArgs, paletteFormat } };
})();

window.USBosPalette = Palette;
window.addEventListener('keydown', (e) => {
  const tag = (e.target && e.target.tagName) || '';
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    e.preventDefault();
    Palette.toggle();
  }
});
window.USBosLog.info('console', 'Console de commandes prête — DevTools : usbos.help(), u.help ou $help(). Palette : bouton ⌘ ou Ctrl+K.');
