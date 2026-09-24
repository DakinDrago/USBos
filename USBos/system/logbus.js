/*
 * USBos — system/logbus.js
 * Journal noyau façon dmesg/syslog : buffer circulaire en mémoire, niveaux,
 * export vers un fichier réel, miroir console.* coloré. Source unique de
 * vérité utilisée par le kernel, le VFS, l'updater, le pont RPC des apps
 * et la carte Alertes du dashboard. Affiché dans la console DevTools
 * (miroir temps réel + bouton « Journal » = récapitulatif à la demande).
 */
'use strict';

const LEVELS = ['debug', 'info', 'warn', 'error'];
const MAX_ENTRIES = 2000;

const STYLES = {
  debug: 'color:#8b98a9',
  info: 'color:#4f8cff',
  warn: 'color:#d29922;font-weight:600',
  error: 'color:#f85149;font-weight:600',
};

const CONSOLE_FN = { debug: 'debug', info: 'log', warn: 'warn', error: 'error' };

class LogBus {
  constructor() {
    this.entries = [];
    this.minLevel = 'debug';
    this._listeners = new Set();
  }

  _levelIndex(level) { return LEVELS.indexOf(level); }

  push(level, source, message, data) {
    if (!LEVELS.includes(level)) level = 'info';
    const entry = { ts: Date.now(), level, source, message, data: data ?? null };
    this.entries.push(entry);
    // Tronque par lots (pas un shift() à chaque push en O(n)).
    if (this.entries.length > MAX_ENTRIES + 200) this.entries.splice(0, this.entries.length - MAX_ENTRIES);

    const fn = CONSOLE_FN[level] || 'log';
    // Logs FR volontairement (fr-FR) ; message passé en %s (pas interpolé
    // dans le format) pour neutraliser les % éventuels du contenu.
    const time = new Date(entry.ts).toLocaleTimeString('fr-FR');
    const msg = `[${time}] [${source}] ${message}`;
    // eslint-disable-next-line no-console
    if (data !== undefined) console[fn]('%c%s', STYLES[level], msg, data);
    else console[fn]('%c%s', STYLES[level], msg);

    for (const listener of this._listeners) {
      try { listener(entry); } catch { /* un listener cassé ne doit pas casser le bus */ }
    }
    return entry;
  }

  debug(source, message, data) { return this.push('debug', source, message, data); }
  info(source, message, data) { return this.push('info', source, message, data); }
  warn(source, message, data) { return this.push('warn', source, message, data); }
  error(source, message, data) { return this.push('error', source, message, data); }

  /** S'abonne aux nouvelles entrées. Retourne une fonction de désabonnement. */
  subscribe(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  setMinLevel(level) {
    if (!LEVELS.includes(level)) throw new Error(`Niveau inconnu : ${level}. Valeurs : ${LEVELS.join(', ')}`);
    this.minLevel = level;
  }

  tail(n = 50) {
    if (!(n > 0)) return [];
    return this.entries.slice(-n).filter((e) => this._levelIndex(e.level) >= this._levelIndex(this.minLevel));
  }

  filter(opts) {
    const { level, source, contains } = (opts || {});
    const floor = this._levelIndex(this.minLevel);
    return this.entries.filter((e) => {
      // Sans niveau explicite, on respecte le niveau minimum configuré.
      if (level ? e.level !== level : this._levelIndex(e.level) < floor) return false;
      if (source && !e.source.includes(source)) return false;
      if (contains && !e.message.toLowerCase().includes(String(contains).toLowerCase())) return false;
      return true;
    });
  }

  clear() {
    const n = this.entries.length;
    this.entries.length = 0;
    return n;
  }

  toText() {
    return this.entries.map((e) => {
      const time = new Date(e.ts).toISOString();
      let dataStr = '';
      if (e.data != null) {
        try {
          dataStr = ' ' + JSON.stringify(e.data);
        } catch {
          dataStr = ' [données non sérialisables]';
        }
      }
      return `${time} [${e.level.toUpperCase()}] [${e.source}] ${String(e.message).replace(/\r?\n/g, '↵')}${dataStr}`;
    }).join('\n');
  }
}

const logbus = new LogBus();

// Capture tout ce qui échapperait autrement silencieusement à la console.
window.addEventListener('error', (e) => {
  logbus.error('window', e.message, { filename: e.filename, line: e.lineno, col: e.colno });
});
window.addEventListener('unhandledrejection', (e) => {
  logbus.error('promise', 'Rejet de promesse non intercepté', { reason: String(e.reason && e.reason.message || e.reason) });
});

window.USBosLog = logbus;
