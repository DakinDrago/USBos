/* USBos â€” paquet d'application .uapp v1 (lecteur + validation).
 *
 * Un .uapp est un ZIP STANDARD renommÃ© : n'importe quel OS sait en crÃ©er un
 * (clic droit > compresser), et Chromium sait le dÃ©compresser nativement
 * (DecompressionStream 'deflate-raw'), donc aucune dÃ©pendance. Ce format est
 * distinct de .upack (conteneur mono-fichier dÃ©coupÃ© en morceaux, voir
 * upack.js) : un .upack ne peut pas transporter une app multi-fichiers.
 *
 * Contenu attendu (Ã  la racine, ou dans UN seul dossier englobant â€” ce que
 * produit Â« compresser le dossier Â» sous Windows/macOS) :
 *   manifest.json      id, name, version, entry [, icon, description, sandbox, csp]
 *   <entry>.js         code de l'app (classique, `return USBosApp`)
 *   lang/fr.json       traductions FR  } chaque app porte les siennes
 *   lang/en.json       traductions EN  }
 *   â€¦                  autres fichiers (vendor/, imagesâ€¦)
 *
 * MODÃˆLE DE MENACE : le paquet est une entrÃ©e NON FIABLE. parseUapp() valide
 * TOUT (chemins, tailles, CRC, manifeste) et ne retourne rien tant que
 * quelque chose est douteux : l'appelant n'Ã©crit donc jamais un paquet Ã 
 * moitiÃ© valide. RefusÃ©s : chemins traversants/absolus/ambigus, collisions
 * de casse (FAT/exFAT), liens symboliques et fichiers spÃ©ciaux, entrÃ©es
 * chiffrÃ©es, ZIP64/multi-disques, bombes de dÃ©compression (taille rÃ©elle
 * comptÃ©e pendant le flux, pas seulement dÃ©clarÃ©e), en-tÃªtes local/central
 * incohÃ©rents, entrÃ©es qui se chevauchent.
 *
 * Pur (aucun DOM) : utilisÃ© par le noyau et par tools/test-uapp.cjs (Node).
 * Les erreurs sont techniques ('uapp: ...') : l'appelant les habille.
 */
(function (root) {
  'use strict';

  const LIMITS = Object.freeze({
    maxPackage: 40 * 1024 * 1024,   // taille du .uapp lui-mÃªme
    maxEntries: 300,
    maxFile: 25 * 1024 * 1024,      // par fichier, dÃ©compressÃ©
    maxTotal: 60 * 1024 * 1024,     // somme dÃ©compressÃ©e
    maxPathLen: 200,
    maxSegLen: 100,
    maxDepth: 6,
    maxManifest: 64 * 1024,
    maxLang: 512 * 1024,
    maxConnectSrc: 10,
  });

  const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
  // Identifiants rÃ©servÃ©s : espaces de noms du VFS et du noyau.
  const RESERVED_IDS = Object.freeze(['system', 'shell', 'console', 'config', 'data', 'shared', 'update', 'root', 'kernel', 'usbos', 'apps']);
  // Segment de chemin : pas de point initial/final ni de ".." (un point n'est
  // admis qu'entre deux caractÃ¨res), ASCII simple compatible FAT/exFAT/NTFS.
  const SEG_RE = /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/;
  const WIN_RESERVED_RE = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i;
  const SEMVER_RE = /^\d+(?:\.\d+)+(?:-[0-9A-Za-z.-]+)?$/;
  // ContrÃ´les, DEL/C1 et marques bidirectionnelles (usurpation d'affichage).
  const UNSAFE_TEXT_RE = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/;
  // HÃ´tes autorisÃ©s dans csp.connectSrc : https/wss, nom de domaine minuscule
  // dont le TLD commence par une lettre (exclut IPv4 et noms Ã  un seul
  // label : pas de LAN/localhost), port optionnel. Aucun joker, aucun
  // mot-clÃ© CSP, aucun ';' ni guillemet possible.
  // MIROIR EXACT de CONNECT_SRC_RE dans kernel.js â€” tools/test-uapp.cjs
  // vÃ©rifie que les deux littÃ©raux restent identiques.
  const CONNECT_SRC_RE = /^(?:https|wss):\/\/(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9](?::[0-9]{1,5})?$/;

  function fail(msg) { throw new Error('uapp: ' + msg); }
  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  const show = (s) => JSON.stringify(String(s).slice(0, 80));

  function isUappName(name) {
    if (typeof name !== 'string') return false;
    const n = name.toLowerCase();
    return n.endsWith('.uapp') || n.endsWith('.zip');
  }

  function sanitizeConnectSrc(list) {
    const ok = [];
    const rejected = [];
    for (const v of (Array.isArray(list) ? list : [])) {
      const s = typeof v === 'string' ? v : '';
      if (s.length <= 253 && CONNECT_SRC_RE.test(s)) {
        if (!ok.includes(s) && ok.length < LIMITS.maxConnectSrc) ok.push(s);
      } else {
        rejected.push(String(v).slice(0, 60));
      }
    }
    return { ok, rejected };
  }

  let crcTable = null;
  function crc32(u8) {
    if (!crcTable) {
      crcTable = new Uint32Array(256);
      for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        crcTable[n] = c >>> 0;
      }
    }
    let c = 0xFFFFFFFF;
    for (let i = 0; i < u8.length; i++) c = crcTable[(c ^ u8[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  async function sha256Hex(u8) {
    const d = await crypto.subtle.digest('SHA-256', u8);
    return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  const u16 = (b, o) => b[o] | (b[o + 1] << 8);
  const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16)) + b[o + 3] * 16777216;
  function latin1(b, s, e) {
    let out = '';
    for (let i = s; i < e; i++) out += String.fromCharCode(b[i]);
    return out;
  }

  function checkRelPath(p) {
    if (typeof p !== 'string' || !p || p.length > LIMITS.maxPathLen) fail('bad path length');
    const segs = p.split('/');
    if (segs.length > LIMITS.maxDepth) fail('path too deep: ' + show(p));
    for (const s of segs) {
      if (!s || s.length > LIMITS.maxSegLen || !SEG_RE.test(s) || WIN_RESERVED_RE.test(s)) {
        fail('illegal path: ' + show(p));
      }
    }
  }

  function isJunk(path) {
    const base = path.slice(path.lastIndexOf('/') + 1);
    return path.startsWith('__MACOSX/') || base === '.DS_Store' || base === 'Thumbs.db' || base === 'desktop.ini' || base.startsWith('._');
  }

  /** Lit le rÃ©pertoire central. Retourne { entries, cdOff }. */
  function readCentralDirectory(b) {
    if (b.length < 22) fail('too short');
    if (b.length > LIMITS.maxPackage) fail('package too large');
    if (!(b[0] === 0x50 && b[1] === 0x4b)) fail('not a zip (bad magic)');

    // Fin de rÃ©pertoire central : on ne retient que la signature dont
    // (position + 22 + longueur du commentaire) tombe EXACTEMENT en fin de
    // fichier â€” un faux EOCD cachÃ© dans un commentaire est ainsi ignorÃ©.
    let eocd = -1;
    const min = Math.max(0, b.length - 22 - 0xFFFF);
    for (let i = b.length - 22; i >= min; i--) {
      if (b[i] === 0x50 && b[i + 1] === 0x4b && b[i + 2] === 0x05 && b[i + 3] === 0x06 && i + 22 + u16(b, i + 20) === b.length) { eocd = i; break; }
    }
    if (eocd < 0) fail('no end-of-central-directory');

    const total = u16(b, eocd + 10);
    const cdSize = u32(b, eocd + 12);
    const cdOff = u32(b, eocd + 16);
    if (u16(b, eocd + 4) !== 0 || u16(b, eocd + 6) !== 0 || u16(b, eocd + 8) !== total) fail('multi-disk zip unsupported');
    if (total === 0xFFFF || cdSize === 0xFFFFFFFF || cdOff === 0xFFFFFFFF) fail('zip64 unsupported');
    if (total === 0) fail('empty package');
    if (total > LIMITS.maxEntries) fail('too many entries');
    if (cdOff + cdSize > eocd) fail('bad central directory bounds');

    const entries = [];
    const end = cdOff + cdSize;
    let p = cdOff;
    for (let i = 0; i < total; i++) {
      if (p + 46 > end) fail('truncated central directory');
      if (u32(b, p) !== 0x02014b50) fail('bad central header');
      const nl = u16(b, p + 28);
      const el = u16(b, p + 30);
      const cl = u16(b, p + 32);
      if (p + 46 + nl + el + cl > end) fail('truncated central directory');
      if (nl === 0 || nl > LIMITS.maxPathLen) fail('bad name length');
      entries.push({
        madeBy: u16(b, p + 4),
        flags: u16(b, p + 8),
        method: u16(b, p + 10),
        crc: u32(b, p + 16),
        comp: u32(b, p + 20),
        size: u32(b, p + 24),
        ext: u32(b, p + 38),
        lho: u32(b, p + 42),
        nameBytes: b.subarray(p + 46, p + 46 + nl),
        name: latin1(b, p + 46, p + 46 + nl),
      });
      p += 46 + nl + el + cl;
    }
    return { entries, cdOff };
  }

  /** DÃ©compresse un flux deflate brut en plafonnant la sortie Ã  `expected`. */
  async function inflateRaw(u8, expected) {
    const reader = new Blob([u8]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader();
    const out = new Uint8Array(expected);
    let n = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (n + value.length > expected) fail('entry larger than declared (decompression bomb?)');
        out.set(value, n);
        n += value.length;
      }
    } catch (e) {
      try { await reader.cancel(); } catch (_) { /* dÃ©jÃ  fermÃ© */ }
      if (e && typeof e.message === 'string' && e.message.startsWith('uapp:')) throw e;
      fail('corrupt compressed data');
    }
    if (n !== expected) fail('entry size mismatch');
    return out;
  }

  function validateManifest(m, paths) {
    if (!isObj(m)) fail('manifest is not an object');
    if (typeof m.id !== 'string' || !ID_RE.test(m.id)) fail('bad manifest id');
    if (RESERVED_IDS.includes(m.id)) fail('reserved app id: ' + m.id);
    if (typeof m.name !== 'string' || !m.name.trim() || m.name.length > 60 || UNSAFE_TEXT_RE.test(m.name)) fail('bad manifest name');
    if (typeof m.version !== 'string' || m.version.length > 40 || !SEMVER_RE.test(m.version)) fail('bad manifest version');
    if (typeof m.entry !== 'string') fail('bad manifest entry');
    checkRelPath(m.entry);
    if (!m.entry.endsWith('.js')) fail('manifest entry must be a .js file');
    if (!paths.has(m.entry)) fail('entry file missing from package: ' + show(m.entry));
    if (m.icon != null && (typeof m.icon !== 'string' || m.icon.length > 16 || UNSAFE_TEXT_RE.test(m.icon))) fail('bad manifest icon');
    if (m.description != null && (typeof m.description !== 'string' || m.description.length > 500 || UNSAFE_TEXT_RE.test(m.description))) fail('bad manifest description');
    if (m.sandbox != null && (typeof m.sandbox !== 'string' || m.sandbox.length > 200)) fail('bad manifest sandbox');
    let connectSrc = [];
    if (m.csp != null) {
      if (!isObj(m.csp)) fail('bad manifest csp');
      if (m.csp.connectSrc != null) {
        if (!Array.isArray(m.csp.connectSrc)) fail('bad csp.connectSrc');
        const r = sanitizeConnectSrc(m.csp.connectSrc);
        if (r.rejected.length || m.csp.connectSrc.length > LIMITS.maxConnectSrc) {
          fail('invalid csp.connectSrc entry: ' + show(r.rejected[0] || 'too many'));
        }
        connectSrc = r.ok;
      }
    }
    return {
      id: m.id,
      name: m.name.trim(),
      version: m.version,
      entry: m.entry,
      icon: m.icon || '',
      description: m.description || '',
      sandbox: m.sandbox || '',
      connectSrc,
    };
  }

  /**
   * Lit, valide et dÃ©compresse un .uapp. Ne retourne QUE si tout est sain.
   * @returns {Promise<{manifest, files: Map<string,Uint8Array>, sha256, size, stripped, skipped}>}
   */
  async function parseUapp(input) {
    const b = input instanceof Uint8Array ? input : new Uint8Array(input);
    const { entries, cdOff } = readCentralDirectory(b);

    // 1) Filtrage et contrÃ´les par entrÃ©e (avant toute dÃ©compression).
    const files = [];
    let skipped = 0;
    for (const e of entries) {
      if (e.name.includes('\\')) fail('backslash in path: ' + show(e.name));
      if (e.flags & 0x0001 || e.flags & 0x0040) fail('encrypted entry unsupported');
      if (e.method !== 0 && e.method !== 8) fail('unsupported compression method');
      if (e.comp === 0xFFFFFFFF || e.size === 0xFFFFFFFF) fail('zip64 unsupported');
      if ((e.madeBy >> 8) === 3) {                       // crÃ©Ã© sous Unix : le mode est dans ext>>>16
        const type = (e.ext >>> 16) & 0xF000;
        if (type === 0xA000) fail('symbolic link refused: ' + show(e.name));
        if (type !== 0 && type !== 0x8000 && type !== 0x4000) fail('special file refused: ' + show(e.name));
      }
      if (e.name.endsWith('/')) continue;                // dossier : rien Ã  extraire
      if (isJunk(e.name)) { skipped++; continue; }
      if (e.method === 0 && e.comp !== e.size) fail('stored entry size mismatch');
      if (e.size > LIMITS.maxFile) fail('file too large: ' + show(e.name));
      files.push(e);
    }
    if (!files.length) fail('package has no files');

    // 2) Dossier englobant unique (Â« compresser le dossier Â») : on le retire.
    let strip = '';
    if (!files.some((e) => e.name === 'manifest.json')) {
      const tops = new Set(files.map((e) => e.name.split('/')[0]));
      if (tops.size === 1 && files.every((e) => e.name.includes('/'))) strip = [...tops][0] + '/';
    }

    // 3) Chemins finaux : lÃ©gaux, sans doublon (casse ignorÃ©e), sans conflit fichier/dossier.
    const seen = new Map();
    let total = 0;
    for (const e of files) {
      e.rel = strip ? e.name.slice(strip.length) : e.name;
      checkRelPath(e.rel);
      const low = e.rel.toLowerCase();
      if (seen.has(low)) fail('duplicate path (case-insensitive): ' + show(e.rel));
      seen.set(low, e.rel);
      total += e.size;
    }
    if (total > LIMITS.maxTotal) fail('package too large once extracted');
    for (const low of seen.keys()) {
      for (const other of seen.keys()) {
        if (other !== low && other.startsWith(low + '/')) fail('file/directory conflict: ' + show(seen.get(low)));
      }
    }

    // 4) Extraction : en-tÃªte local cohÃ©rent, pas de chevauchement, CRC exact.
    const ranges = [];
    const out = new Map();
    for (const e of files) {
      const o = e.lho;
      if (o + 30 > cdOff) fail('bad local header offset');
      if (u32(b, o) !== 0x04034b50) fail('bad local header');
      const lnl = u16(b, o + 26);
      const lel = u16(b, o + 28);
      if (lnl !== e.nameBytes.length) fail('local/central name mismatch');
      for (let i = 0; i < lnl; i++) if (b[o + 30 + i] !== e.nameBytes[i]) fail('local/central name mismatch');
      const ds = o + 30 + lnl + lel;
      const de = ds + e.comp;
      if (de > cdOff) fail('entry data overlaps central directory');
      ranges.push([ds, de]);
      let bytes;
      if (e.size === 0) bytes = new Uint8Array(0);
      else if (e.method === 0) bytes = b.slice(ds, de);
      else bytes = await inflateRaw(b.subarray(ds, de), e.size);
      if (crc32(bytes) !== e.crc) fail('bad CRC: ' + show(e.rel));
      out.set(e.rel, bytes);
    }
    ranges.sort((x, y) => x[0] - y[0]);
    for (let i = 1; i < ranges.length; i++) if (ranges[i][0] < ranges[i - 1][1]) fail('overlapping entries');

    // 5) Manifeste + traductions obligatoires (chaque app porte les siennes).
    const mBytes = out.get('manifest.json');
    if (!mBytes) fail('manifest.json missing');
    if (mBytes.length > LIMITS.maxManifest) fail('manifest.json too large');
    let raw;
    try { raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(mBytes)); } catch (_) { fail('manifest.json is not valid JSON'); }
    const manifest = validateManifest(raw, new Set(out.keys()));
    for (const code of ['fr', 'en']) {
      const lb = out.get('lang/' + code + '.json');
      if (!lb) fail('lang/' + code + '.json missing');
      if (lb.length > LIMITS.maxLang) fail('lang/' + code + '.json too large');
      let v;
      try { v = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(lb)); } catch (_) { fail('lang/' + code + '.json is not valid JSON'); }
      if (!isObj(v)) fail('lang/' + code + '.json must be an object');
    }

    return { manifest, files: out, sha256: await sha256Hex(b), size: total, stripped: strip, skipped };
  }

  const api = {
    LIMITS, ID_RE, RESERVED_IDS, CONNECT_SRC_RE,
    isUappName, parseUapp, validateManifest, sanitizeConnectSrc, checkRelPath, crc32,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.USBosUapp = api;
})(typeof window !== 'undefined' ? window : globalThis);