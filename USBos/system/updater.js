/*
 * USBos — system/updater.js
 * Mise à jour automatique, "négative" (ne télécharge que ce qui a changé),
 * via GitHub raw (dépôts publics, séparés : un pour le kernel, un par app).
 * Sécurité : HTTPS exigé, chemins distants validés (anti traversal), hash
 * SHA-256 vérifié AVANT bascule, staging dans .update/staging puis bascule.
 * Limite connue : files.json/version.json ne sont pas signés — un dépôt
 * compromis peut fournir des hash assortis. Ne pas présenter le hash seul
 * comme preuve d'authenticité.
 *
 * Configuration attendue dans config/update-sources.json :
 * {
 *   "kernel": "https://raw.githubusercontent.com/<user>/usbos-kernel/main",
 *   "apps": {
 *     "notes": "https://raw.githubusercontent.com/<user>/usbos-app-notes/main",
 *     "mesh":  "https://raw.githubusercontent.com/<user>/usbos-app-mesh/main"
 *   }
 * }
 *
 * Chaque dépôt distant doit exposer à sa racine :
 *   version.json  -> { "version": "1.2.3" }
 *   files.json    -> { "files": { "kernel.js": "sha256hex", ... } }  (chemins relatifs à system/ ou apps/<id>/)
 *   ...les fichiers eux-mêmes.
 */
'use strict';

const FETCH_TIMEOUT_MS = 20000;
const MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024; // garde-fou par fichier distant
const MAX_JSON_BYTES = 1 * 1024 * 1024;
const MAX_FILES = 500;
const MAX_TOTAL_BYTES = 200 * 1024 * 1024;

async function sha256Hex(buffer) {
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function fetchWithTimeout(url, wantJson) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { cache: 'no-store', signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} sur ${url}`);
    const declared = res.headers ? res.headers.get('content-length') : null;
    const declaredLen = declared != null ? parseInt(declared, 10) : NaN;
    if (Number.isFinite(declaredLen)) {
      if (wantJson && declaredLen > MAX_JSON_BYTES) throw new Error(`Remote JSON too large: ${url}`);
      if (!wantJson && declaredLen > MAX_DOWNLOAD_BYTES) throw new Error(`Remote file too large: ${url}`);
    }
    if (wantJson) {
      const text = await res.text();
      if (text.length > MAX_JSON_BYTES) throw new Error(`Remote JSON too large: ${url}`);
      try { return JSON.parse(text); } catch { throw new Error(`Remote JSON invalid: ${url}`); }
    }
    const buf = await res.arrayBuffer();
    if (buf.byteLength > MAX_DOWNLOAD_BYTES) throw new Error(`Remote file too large: ${url}`);
    return buf;
  } catch (err) {
    if (err && err.name === 'AbortError') throw new Error(`Timeout (20s) on ${url}`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJSON(url) {
  return fetchWithTimeout(url, true);
}

async function fetchBuffer(url) {
  return fetchWithTimeout(url, false);
}

function assertHttps(baseUrl) {
  let u;
  try {
    u = new URL(baseUrl);
  } catch {
    throw new Error(`Invalid update URL: ${baseUrl}`);
  }
  if (u.protocol !== 'https:') throw new Error(`Non-HTTPS update URL rejected: ${baseUrl}`);
  if (u.username || u.password) throw new Error(`Update URL with credentials rejected: ${baseUrl}`);
  if (u.search || u.hash) throw new Error(`Update URL with query/hash rejected: ${baseUrl}`);
  if (window.USBosLog) window.USBosLog.debug('updater', `source https : ${u.host}`);
  return baseUrl.replace(/\/+$/, '');
}

/** Un chemin distant ne doit jamais sortir de sa racine (anti traversal). */
function assertSafeRelPath(relPath) {
  if (typeof relPath !== 'string') throw new Error(`Invalid remote path: ${relPath}`);
  const s = relPath;
  if (!s || s.length > 512) throw new Error(`Invalid remote path: ${relPath}`);
  if (s.startsWith('/') || s.includes('\\') || s.split('/').some((p) => p === '.' || p === '..' || p === '')) {
    throw new Error(`Forbidden remote path: ${relPath}`);
  }
  if (/[<>:"|?*\x00-\x1f]/.test(s)) throw new Error(`Forbidden remote path: ${relPath}`);
  if (/[%#?&;+:]/.test(s)) throw new Error(`Forbidden remote path: ${relPath}`);
  if (/[ .]$/.test(s) || s.split('/').some((p) => /[ .]$/.test(p))) throw new Error(`Forbidden remote path: ${relPath}`);
  if (!/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/.test(s)) throw new Error(`Forbidden remote path: ${relPath}`);
  return s;
}

/** Compare deux versions "x.y.z" (retourne true si `remote` > `local`). */
function parseVersionPart(x) {
  const n = parseInt(String(x).trim().replace(/^v/i, '').split('-')[0], 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function isNewer(remote, local) {
  const a = String(remote).split('.').map(parseVersionPart);
  const b = String(local).split('.').map(parseVersionPart);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] || 0, y = b[i] || 0;
    if (x > y) return true;
    if (x < y) return false;
  }
  return false;
}

async function localFileHash(vfs, vpath) {
  try {
    const buf = await vfs.readBinary(vpath);
    return sha256Hex(buf);
  } catch (err) {
    if (err && err.name === 'NotFoundError') return null; // absent localement -> à télécharger
    throw err; // permission/quota : ne pas masquer (évite un écrasement aveugle)
  }
}

async function getLocalAppVersion(vfs, appId) {
  try {
    const v = await vfs.readJSON(`apps:${appId}/version.json`);
    if (v && typeof v.version === 'string') return v.version;
  } catch { /* noop */ }
  try {
    const m = await vfs.readJSON(`apps:${appId}/manifest.json`);
    if (m && typeof m.version === 'string') return m.version;
  } catch { /* noop */ }
  return '0.0.0';
}

/**
 * Calcule le plan de mise à jour pour une "source" (kernel ou une app) :
 * uniquement les fichiers dont le hash distant diffère du hash local.
 * Les chemins distants sont validés (anti traversal) avant tout usage.
 */
async function planForSource(vfs, baseUrl, localPrefix, expectDestSegment) {
  const safeBase = assertHttps(baseUrl);
  const [remoteVersion, remoteFiles] = await Promise.all([
    fetchJSON(`${safeBase}/version.json`),
    fetchJSON(`${safeBase}/files.json`),
  ]);
  if (!remoteVersion || typeof remoteVersion.version !== 'string') {
    throw new Error(`Invalid version.json on ${safeBase}`);
  }
  const entries = (remoteFiles && remoteFiles.files) || {};
  const entryList = Object.entries(entries);
  if (entryList.length > MAX_FILES) throw new Error(`files.json too large (${entryList.length} files, max ${MAX_FILES}) on ${safeBase}`);
  if (remoteFiles && remoteFiles.version != null && remoteFiles.version !== remoteVersion.version) {
    throw new Error(`files.json/version.json mismatch (${remoteFiles.version} vs ${remoteVersion.version}) on ${safeBase}`);
  }
  const toFetch = [];
  for (const [rawRel, remoteHash] of entryList) {
    const relPath = assertSafeRelPath(rawRel);
    if (typeof remoteHash !== 'string' || !/^[0-9a-f]{64}$/i.test(remoteHash)) {
      throw new Error(`Invalid remote hash for ${relPath}`);
    }
    const localVpath = `${expectDestSegment}:${localPrefix}${relPath}`;
    const localHash = await localFileHash(vfs, localVpath);
    if (localHash !== remoteHash.toLowerCase()) {
      const url = `${safeBase}/${relPath.split('/').map(encodeURIComponent).join('/')}`;
      toFetch.push({ relPath, remoteHash: remoteHash.toLowerCase(), url, localVpath });
    }
  }
  return { version: remoteVersion.version, toFetch };
}

async function checkAll(vfs, kernelVersion) {
  let sources;
  try {
    sources = await vfs.readJSON('config:update-sources.json');
  } catch (err) {
    if (err && err.name === 'NotFoundError') return { hasUpdates: false, reason: 'no-config' };
    try { await vfs.stat('config:update-sources.json'); } catch { return { hasUpdates: false, reason: 'no-config' }; }
    return { hasUpdates: false, reason: 'config-corrupt', errors: [`config:update-sources.json unreadable: ${err.message}`] };
  }
  if (!sources || typeof sources !== 'object' || Array.isArray(sources)) {
    return { hasUpdates: false, reason: 'config-corrupt', errors: ['config:update-sources.json invalid (object expected)'] };
  }
  if (sources.kernel != null && typeof sources.kernel !== 'string') {
    return { hasUpdates: false, reason: 'config-corrupt', errors: ['config:update-sources.json invalid (kernel must be an https URL)'] };
  }
  if (sources.apps != null && (typeof sources.apps !== 'object' || Array.isArray(sources.apps))) {
    return { hasUpdates: false, reason: 'config-corrupt', errors: ['config:update-sources.json invalid (apps must be an object)'] };
  }

  const plan = { kernel: null, apps: {}, hasUpdates: false, summary: '', errors: [] };
  let parts = [];

  if (sources.kernel) {
    try {
      const localVer = await vfs.readJSON('system:version.json').then((v) => v.kernel || v.version).catch(() => kernelVersion);
      const res = await planForSource(vfs, sources.kernel, '', 'system');
      if (res.toFetch.length > 0) {
        if (isNewer(res.version, localVer) || res.version === localVer) {
          plan.kernel = { baseUrl: assertHttps(sources.kernel), version: res.version, toFetch: res.toFetch };
          plan.hasUpdates = true;
          parts.push(`noyau ${res.version}`);
        } else {
          plan.errors.push(`kernel: downgrade rejected (local ${localVer} > remote ${res.version})`);
          if (window.USBosLog) window.USBosLog.warn('updater', `Downgrade noyau refusé : local ${localVer}, distant ${res.version}`);
        }
      } else if (isNewer(res.version, localVer)) {
        // Version bump sans fichiers changés : on met juste à jour le marqueur.
        plan.kernel = { baseUrl: assertHttps(sources.kernel), version: res.version, toFetch: [] };
        plan.hasUpdates = true;
        parts.push(`noyau ${res.version} (marqueur)`);
      }
    } catch (err) {
      plan.errors.push(`noyau: ${err.message}`);
      if (window.USBosLog) window.USBosLog.warn('updater', `Source noyau ignorée : ${err.message}`);
    }
  }

  for (const [appId, baseUrl] of Object.entries(sources.apps || {})) {
    if (!/^[a-z0-9-]{1,64}$/i.test(appId)) {
      plan.errors.push(`app "${appId}": invalid id, skipped`);
      continue;
    }
    if (typeof baseUrl !== 'string') {
      plan.errors.push(`app "${appId}": invalid URL, skipped`);
      continue;
    }
    try {
      const localVer = await getLocalAppVersion(vfs, appId);
      const res = await planForSource(vfs, baseUrl, `${appId}/`, 'apps');
      if (res.toFetch.length > 0) {
        if (isNewer(res.version, localVer) || res.version === localVer) {
          plan.apps[appId] = { baseUrl: assertHttps(baseUrl), version: res.version, toFetch: res.toFetch };
          plan.hasUpdates = true;
          parts.push(`${appId} ${res.version}`);
        } else {
          plan.errors.push(`${appId}: downgrade rejected (local ${localVer} > remote ${res.version})`);
          if (window.USBosLog) window.USBosLog.warn('updater', `Downgrade ${appId} refusé : local ${localVer}, distant ${res.version}`);
        }
      } else if (isNewer(res.version, localVer)) {
        plan.apps[appId] = { baseUrl: assertHttps(baseUrl), version: res.version, toFetch: [] };
        plan.hasUpdates = true;
        parts.push(`${appId} ${res.version} (marqueur)`);
      }
    } catch (err) {
      plan.errors.push(`${appId}: ${err.message}`);
      if (window.USBosLog) window.USBosLog.warn('updater', `Source ${appId} ignorée : ${err.message}`);
    }
  }

  plan.summary = parts.join(', ') || 'aucune';
  if (window.USBosLog) window.USBosLog.info('updater', `Vérification : ${plan.summary}`);
  return plan;
}

async function syncManifestVersion(vfs, appId, version) {
  try {
    const m = await vfs.readJSON(`apps:${appId}/manifest.json`);
    if (!m || typeof m !== 'object' || typeof m.id !== 'string') {
      if (window.USBosLog) window.USBosLog.warn('updater', `Manifeste ${appId} invalide, non synchronisé`);
      return;
    }
    if (m.version !== version) {
      m.version = version;
      await vfs.writeJSON(`apps:${appId}/manifest.json`, m);
    }
  } catch { /* manifeste illisible : on garde version.json seul */ }
}

async function apply(vfs, plan) {
  const doApply = async () => {
  let kernelChanged = false;

  // 1) Télécharge + vérifie TOUT dans .update/ (staging). Aucune écriture
  // en place avant que tous les hash soient validés.
  const staged = [];
  let stagedTotal = 0;
  const stageSource = async (kind, id, source) => {
    for (const item of source.toFetch) {
      const relPath = assertSafeRelPath(item.relPath); // re-validation (ne pas faire confiance au plan)
      const buf = await fetchBuffer(item.url);
      stagedTotal += buf.byteLength;
      if (stagedTotal > MAX_TOTAL_BYTES) throw new Error(`Update too large (max 200 MB)`);
      const hash = await sha256Hex(buf);
      if (hash !== item.remoteHash) {
        if (window.USBosLog) window.USBosLog.error('updater', `Hash invalide pour ${relPath} — mise à jour refusée`);
        throw new Error(`Bad hash for ${relPath} (integrity failure)`);
      }
      const stagePath = `update:staging/${kind === 'kernel' ? 'kernel' : `apps/${id}`}/${relPath}`;
      await vfs.writeBinary(stagePath, buf);
      staged.push({ stagePath, localVpath: item.localVpath, relPath, remoteHash: item.remoteHash });
      if (window.USBosLog) window.USBosLog.info('updater', `Vérifié : ${relPath}`);
    }
  };

  try {
    if (plan.kernel && plan.kernel.toFetch.length > 0) await stageSource('kernel', null, plan.kernel);
    for (const [appId, source] of Object.entries(plan.apps || {})) {
      if (source.toFetch.length > 0) await stageSource('app', appId, source);
    }
  } catch (err) {
    try { await vfs.clearDir('update:staging', true); } catch { /* noop */ }
    throw err;
  }

  // Snapshot + journal avant bascule (rollback best-effort en cas d'échec).
  const toBackup = (v) => `update:backup/${v.replace(':', '/')}`;
  for (const s of staged) {
    try {
      const orig = await vfs.readBinary(s.localVpath);
      await vfs.writeBinary(toBackup(s.localVpath), orig);
    } catch { /* absent localement ou illisible : rien à sauvegarder */ }
  }
  const pending = staged.map((s) => s.localVpath);
  try { await vfs.writeJSON('update:journal.json', { started: new Date().toISOString(), applied: [], pending }); } catch { /* noop */ }

  // 2) Bascule : copie staging -> destination avec vérification post-écriture.
  // En cas d'échec : on garde le staging (retry) et on tente un rollback.
  const applied = [];
  try {
    for (const s of staged) {
      const buf = await vfs.readBinary(s.stagePath);
      await vfs.writeBinary(s.localVpath, buf);
      const verify = await sha256Hex(await vfs.readBinary(s.localVpath));
      if (verify !== s.remoteHash) throw new Error(`Post-write check failed for ${s.localVpath}`);
      applied.push(s.localVpath);
      try { await vfs.writeJSON('update:journal.json', { started: new Date().toISOString(), applied: [...applied], pending }); } catch { /* noop */ }
    }
  } catch (err) {
    if (window.USBosLog) window.USBosLog.error('updater', `Bascule interrompue après ${applied.length}/${staged.length} fichiers : ${err.message}`);
    let rollbackFailures = 0;
    for (const vpath of applied) {
      try {
        const bak = await vfs.readBinary(toBackup(vpath));
        await vfs.writeBinary(vpath, bak);
      } catch { rollbackFailures++; }
    }
    if (rollbackFailures && window.USBosLog) window.USBosLog.error('updater', `Rollback partiel : ${rollbackFailures} fichier(s) non restaurés`);
    // Staging conservé pour retry (pas de clear ici).
    throw new Error(`Update aborted (${applied.length}/${staged.length} applied): ${err.message}`);
  }

  try { await vfs.clearDir('update:staging', true); } catch { /* noop */ }

  // 3) Marqueurs de version (version.json + manifest.json synchronisés, schéma préservé).
  if (plan.kernel && (plan.kernel.toFetch.length > 0 || plan.kernel.version)) {
    const hasKernelFiles = staged.some((s) => s.localVpath.startsWith('system:'));
    if (hasKernelFiles || plan.kernel.toFetch.length === 0) {
      let cur = {};
      try { cur = await vfs.readJSON('system:version.json'); } catch { cur = {}; }
      await vfs.writeJSON('system:version.json', { ...cur, kernel: plan.kernel.version });
    }
    kernelChanged = hasKernelFiles;
  }

  for (const [appId, source] of Object.entries(plan.apps || {})) {
    await vfs.writeJSON(`apps:${appId}/version.json`, { version: source.version });
    await syncManifestVersion(vfs, appId, source.version);
  }

  try { await vfs.writeJSON('update:journal.json', { started: new Date().toISOString(), applied, pending: [] }); } catch { /* noop */ }
  return { kernelChanged };
  };
  if (typeof navigator !== 'undefined' && navigator.locks && typeof navigator.locks.request === 'function') {
    return navigator.locks.request('usbos:update', () => doApply());
  }
  return doApply();
}

window.USBosUpdater = { checkAll, apply, isNewer, sha256Hex };
