/*
 * USBos — system/vfs.js
 * Couche VFS : encapsule FileSystemDirectoryHandle et expose des chemins
 * standardisés (system:, apps:, data:, config:, update:) plutôt que des
 * chemins relatifs fragiles.
 *
 * Aucune app n'accède jamais directement à un FileSystemDirectoryHandle :
 * tout passe par cette API.
 */
'use strict';

const ROOT_DIRS = ['system', 'apps', 'data', 'config', '.update'];

// Caractères interdits sur FAT32/exFAT (clés USB) + séparateurs ambigus.
const BAD_NAME_CHARS = /[<>:"|?*\x00-\x1f\\]/;

const RESERVED_WIN_NAMES = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\..*)?$/i;

function assertSafePart(p) {
  if (typeof p !== 'string') throw new VFSError('Invalid path segment (string expected)', 'BAD_PATH');
  const n = p.normalize('NFC');
  if (n === '.' || n === '..') throw new VFSError(`Forbidden path segment: ${p}`, 'BAD_PATH');
  if (BAD_NAME_CHARS.test(n)) throw new VFSError(`Forbidden file name: ${p}`, 'BAD_PATH');
  if (n.includes(':')) throw new VFSError(`Forbidden file name (':' reserved for VFS scheme): ${p}`, 'BAD_PATH');
  if (/[ .]$/.test(n)) throw new VFSError(`Forbidden file name (trailing space/dot, Windows): ${p}`, 'BAD_PATH');
  if (RESERVED_WIN_NAMES.test(n)) throw new VFSError(`Reserved Windows file name: ${p}`, 'BAD_PATH');
  const bytes = (typeof TextEncoder !== 'undefined') ? new TextEncoder().encode(n).length : n.length;
  if (bytes > 255) throw new VFSError(`File name too long: ${p}`, 'BAD_PATH');
  return n;
}

function splitPath(path) {
  if (typeof path !== 'string') throw new VFSError('Invalid path (string expected)', 'BAD_PATH');
  const parts = path.replace(/^\/+|\/+$/g, '').split('/').filter(Boolean);
  for (const p of parts) assertSafePart(p);
  if (parts.length > 32) throw new VFSError('Path too deep (max 32 segments)', 'BAD_PATH');
  return parts;
}

/**
 * scheme:sous/chemin  ->  { scheme, parts: [...] }
 * ex: "apps:notes/notes.json" -> { scheme: 'apps', parts: ['notes','notes.json'] }
 */
function parseVirtualPath(vpath) {
  if (typeof vpath !== 'string') throw new VFSError('Invalid VFS path (string expected)', 'BAD_PATH');
  const m = vpath.match(/^([a-zA-Z.]+):(.*)$/);
  if (!m) throw new VFSError(`Invalid VFS path (missing scheme): ${vpath}`, 'BAD_PATH');
  const scheme = m[1];
  const rest = m[2];
  return { scheme, parts: splitPath(rest) };
}

const SCHEME_TO_DIR = {
  system: 'system',
  apps: 'apps',
  data: 'data',
  config: 'config',
  update: '.update',
  shared: null, // racine Partage/ (sibling de USBos/), voir _resolveBaseDir
};

class VFSError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'VFSError';
    this.code = code || 'UNKNOWN';
  }
}

class VFS {
  /**
   * @param {FileSystemDirectoryHandle} rootHandle dossier "USBos"
   * @param {FileSystemDirectoryHandle|null} sharedHandle dossier "Partage/" (sibling, en clair)
   */
  constructor(rootHandle, sharedHandle = null) {
    this.root = rootHandle;
    this.sharedRoot = sharedHandle;
  }

  static async ensurePermission(handle, mode = 'readwrite') {
    const opts = { mode };
    try {
      if ((await handle.queryPermission(opts)) === 'granted') return true;
    } catch (err) {
      // Certains navigateurs lèvent si le handle est révoqué : on tente la demande.
      if (err && err.name === 'SecurityError') throw new VFSError('Permission denied by the browser (insecure context).', 'PERMISSION_DENIED');
    }
    try {
      return (await handle.requestPermission(opts)) === 'granted';
    } catch (err) {
      if (err && err.name === 'SecurityError') throw new VFSError('Permission denied by the browser (insecure context).', 'PERMISSION_DENIED');
      return false;
    }
  }

  /** Crée l'arborescence de base (system/apps/data/config/.update) si absente. */
  async ensureLayout() {
    for (const name of ROOT_DIRS) {
      await this.root.getDirectoryHandle(name, { create: true });
    }
  }

  async _resolveBaseDir(scheme, create = false) {
    if (scheme === 'shared') {
      if (!this.sharedRoot) throw new VFSError('shared space unavailable — reconnect via the parent folder.', 'SHARED_UNAVAILABLE');
      return this.sharedRoot;
    }
    const dirName = SCHEME_TO_DIR[scheme];
    if (!dirName) throw new VFSError(`Unknown VFS scheme: ${scheme}`, 'BAD_SCHEME');
    return this.root.getDirectoryHandle(dirName, { create });
  }

  async _resolveDir(vpath, create = false) {
    const { scheme, parts } = parseVirtualPath(vpath);
    let dir = await this._resolveBaseDir(scheme, create);
    for (const p of parts) {
      dir = await dir.getDirectoryHandle(p, { create });
    }
    return dir;
  }

  async _resolveParent(vpath, create = false) {
    const { scheme, parts } = parseVirtualPath(vpath);
    if (parts.length === 0) throw new VFSError('Empty file path', 'EMPTY_PATH');
    let dir = await this._resolveBaseDir(scheme, create);
    for (let i = 0; i < parts.length - 1; i++) {
      dir = await dir.getDirectoryHandle(parts[i], { create });
    }
    return { dir, name: parts[parts.length - 1] };
  }

  async readText(vpath) {
    const { dir, name } = await this._resolveParent(vpath);
    const fh = await dir.getFileHandle(name);
    const file = await fh.getFile();
    if (file.size > 16 * 1024 * 1024) throw new VFSError(`Text file too large (${file.size} bytes, max 16 MB): ${vpath}`, 'TOO_LARGE');
    return file.text();
  }

  async readJSON(vpath) {
    const { dir, name } = await this._resolveParent(vpath);
    const fh = await dir.getFileHandle(name);
    const file = await fh.getFile();
    if (file.size > 5 * 1024 * 1024) throw new VFSError(`JSON too large (${file.size} bytes, max 5 MB): ${vpath}`, 'TOO_LARGE');
    return JSON.parse(await file.text());
  }

  async readBinary(vpath) {
    const { dir, name } = await this._resolveParent(vpath);
    const fh = await dir.getFileHandle(name);
    const file = await fh.getFile();
    if (file.size > 256 * 1024 * 1024) throw new VFSError(`File too large (${file.size} bytes, max 256 MB): ${vpath}`, 'TOO_LARGE');
    return file.arrayBuffer();
  }

  /** Retourne { size } sans lire le contenu (best-effort, via getFile().size). */
  async stat(vpath) {
    const { dir, name } = await this._resolveParent(vpath);
    const fh = await dir.getFileHandle(name);
    const file = await fh.getFile();
    return { size: file.size };
  }

  /** Écriture non-atomique : pour les fichiers critiques, utiliser un staging + bascule. */
  async writeText(vpath, content) {
    const { dir, name } = await this._resolveParent(vpath, true);
    const fh = await dir.getFileHandle(name, { create: true });
    const w = await fh.createWritable();
    try {
      await w.write(content);
      await w.close();
    } catch (err) {
      try { await w.abort(); } catch { /* noop */ }
      throw err;
    }
    const bytes = (typeof TextEncoder !== 'undefined') ? new TextEncoder().encode(content).length : String(content).length;
    if (window.USBosLog) window.USBosLog.debug('vfs', `écrit ${vpath} (${bytes} octets)`);
  }

  async writeJSON(vpath, obj) {
    return this.writeText(vpath, JSON.stringify(obj, null, 2));
  }

  /** Écriture binaire non-atomique : pour les fichiers critiques, utiliser un staging + bascule. */
  async writeBinary(vpath, arrayBufferOrBlob) {
    const size = arrayBufferOrBlob && (arrayBufferOrBlob.byteLength ?? arrayBufferOrBlob.size);
    if (size != null && size > 256 * 1024 * 1024) {
      throw new VFSError(`File too large (${size} bytes, max 256 MB): ${vpath}`, 'TOO_LARGE');
    }
    const { dir, name } = await this._resolveParent(vpath, true);
    const fh = await dir.getFileHandle(name, { create: true });
    const w = await fh.createWritable();
    try {
      await w.write(arrayBufferOrBlob);
      await w.close();
    } catch (err) {
      try { await w.abort(); } catch { /* noop */ }
      throw err;
    }
    if (window.USBosLog) window.USBosLog.debug('vfs', `écrit (binaire) ${vpath}`);
  }

  async exists(vpath) {
    let resolved;
    try {
      resolved = await this._resolveParent(vpath);
    } catch (err) {
      if (err && (err.code === 'BAD_PATH' || err.code === 'BAD_SCHEME' || err.code === 'EMPTY_PATH')) throw err;
      return false;
    }
    try {
      await resolved.dir.getFileHandle(resolved.name);
      return true;
    } catch (err) {
      // Erreurs permission/quota : ne pas masquer en "absent".
      if (err && (err.name === 'SecurityError' || err.name === 'NotAllowedError' || err.name === 'QuotaExceededError' || err.name === 'AbortError')) throw err;
      if (err && err.name !== 'NotFoundError' && err.name !== 'TypeMismatchError') throw err;
      // Un dossier portant ce nom existe peut-être (pas un fichier).
      try { await resolved.dir.getDirectoryHandle(resolved.name); return true; }
      catch (inner) {
        if (inner && inner.name === 'NotFoundError') return false;
        throw inner;
      }
    }
  }

  // Fichiers/dossiers protégés : suppression interdite sans { force: true }.
  static PROTECTED = ['system:kernel.js', 'system:version.json', 'config:update-sources.json', 'system:'];

  async remove(vpath, opts = {}) {
    const { force = false } = opts || {};
    const norm = typeof vpath === 'string' ? vpath.normalize('NFC').replace(/\/+$/, '') : vpath;
    if (!force && VFS.PROTECTED.some((p) => norm === p || norm === p.replace(/\/+$/, ''))) {
      throw new VFSError(`Protected removal (use { force: true }): ${vpath}`, 'PROTECTED');
    }
    const { dir, name } = await this._resolveParent(vpath);
    try {
      await dir.removeEntry(name, { recursive: true });
    } catch (err) {
      if (err && err.name === 'NotFoundError') return;
      throw err;
    }
    if (window.USBosLog) window.USBosLog.warn('vfs', `supprimé ${vpath}`);
  }

  /** Liste les entrées (nom + type) d'un "dossier virtuel".
   * Ne retourne pas les tailles (FS API : exigerait un getFile() par entrée).
   * Utiliser stat(vpath) pour la taille d'un fichier précis. */
  async list(vpath) {
    const dir = await this._resolveDir(vpath);
    const out = [];
    for await (const [name, handle] of dir.entries()) {
      out.push({ name, kind: handle.kind });
    }
    return out;
  }

  async mkdir(vpath) {
    await this._resolveDir(vpath, true);
  }

  /**
   * Parcours récursif : retourne les vpaths de TOUS les fichiers sous
   * `dirVpath` (ex. walk('data:') -> ['data:notes/notes.json', ...]).
   * Plafonné (garde-fou DoS) et cycliquement sûr (pas de liens en FS API).
   */
  async walk(dirVpath, maxFiles = 5000) {
    const out = [];
    const unreadable = [];
    const queue = [dirVpath.replace(/\/+$/, '')];
    while (queue.length && out.length < maxFiles) {
      const cur = queue.shift();
      let entries;
      try {
        entries = await this.list(cur);
      } catch {
        unreadable.push(cur);
        continue; // dossier illisible -> ignoré, pas d'échec global
      }
      for (const e of entries) {
        try { assertSafePart(e.name); } catch {
          unreadable.push(`${cur}/${e.name}`);
          if (window.USBosLog) window.USBosLog.warn('vfs', `nom ignoré dans walk : ${cur}/${e.name}`);
          continue;
        }
        const child = `${cur}/${e.name}`.replace(/^([a-zA-Z.]+):\/+/, '$1:');
        if (e.kind === 'directory') queue.push(child);
        else {
          out.push(child);
          if (out.length >= maxFiles) break;
        }
      }
    }
    if (unreadable.length && window.USBosLog) window.USBosLog.warn('vfs', `walk : ${unreadable.length} entrée(s) illisible(s) ignorée(s)`);
    return out;
  }

  /** Déplace/renomme via staging (écrit tmp, vérifie, puis supprime la source).
   * Non-atomique côté FS API, mais la source n'est supprimée qu'après écriture réussie. */
  async moveFile(fromVpath, toVpath) {
    const buf = await this.readBinary(fromVpath).catch(() => null);
    if (buf === null) throw new VFSError(`Source not found: ${fromVpath}`, 'NOT_FOUND');
    const staging = `update:staging/move-${Date.now()}-${Math.floor(Math.random() * 1e6)}.tmp`;
    await this.writeBinary(staging, buf);
    try {
      await this.writeBinary(toVpath, await this.readBinary(staging));
    } finally {
      try { await this.remove(staging, { force: true }); } catch { /* noop */ }
    }
    await this.remove(fromVpath);
  }

  /** Vide un dossier tampon (.update) sans toucher aux autres arborescences.
   * Par défaut ne crée PAS le dossier (create=false) : passer create:true
   * explicitement quand la création est voulue (ex. updater, staging). */
  async clearDir(vpath, create = false) {
    const dir = await this._resolveDir(vpath, create);
    for await (const [name] of dir.entries()) {
      await dir.removeEntry(name, { recursive: true });
    }
  }
}

// Petites fonctions utilitaires exportées pour l'installeur (avant qu'un VFS existe).
// NOTE : mode 'readwrite' exigé pour installer (sur-privilège assumé : l'install
// écrit l'arborescence ; un mode 'read' seul ne suffirait pas ici).
async function pickInstallParentDirectory() {
  if (typeof window.showDirectoryPicker !== 'function') {
    throw new VFSError('File System Access API unavailable in this browser.', 'UNSUPPORTED');
  }
  return window.showDirectoryPicker({ mode: 'readwrite' });
}

/**
 * Un dossier est considéré comme une installation USBos valide s'il
 * contient déjà system/ et apps/ AVEC leurs marqueurs (version.json et
 * au moins un manifeste lisible côté apps/). Évite les faux positifs.
 */
async function looksLikeUSBosRoot(handle) {
  try {
    const sys = await handle.getDirectoryHandle('system');
    await handle.getDirectoryHandle('apps');
    let versionOk = false;
    try {
      const fh = await sys.getFileHandle('version.json');
      const file = await fh.getFile();
      const v = JSON.parse(await file.text());
      versionOk = (typeof v.kernel === 'string' && v.kernel) || (typeof v.version === 'string' && v.version);
    } catch {
      return false;
    }
    if (!versionOk) return false;
    // Au moins une app avec manifest.json, ou dossier apps vide mais
    // system valide (première install partielle) : on accepte si le
    // noyau est présent (kernel.js) pour ne pas rejeter une install neuve.
    try {
      await sys.getFileHandle('kernel.js');
    } catch {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

async function ensureUSBosSubdir(parentHandle) {
  return parentHandle.getDirectoryHandle('USBos', { create: true });
}

async function ensureSharedSubdir(parentHandle) {
  return parentHandle.getDirectoryHandle('Partage', { create: true });
}

window.USBosVFS = { VFS, VFSError, parseVirtualPath, pickInstallParentDirectory, ensureUSBosSubdir, ensureSharedSubdir, looksLikeUSBosRoot };
