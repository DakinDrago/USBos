/* USBos — conteneur .upack v1 (miroir de tools/upack.py).
 * Fichier unique : magic 'USBOS1' + longueur en-tête uint32 BE + en-tête
 * JSON {v,name,mime,size,chunk,hashes,sha} + morceaux concaténés.
 * Pur (aucun DOM) : utilisable dans le noyau, en vendor/ des apps
 * (mesh, gallery) et sous Node pour les tests (tools/test-upack.cjs).
 * Les erreurs sont techniques ('upack: ...') : l'appelant les mappe vers
 * ses propres chaînes i18n.
 */
(function (root) {
  'use strict';
  const MAGIC = [0x55, 0x53, 0x42, 0x4f, 0x53, 0x31]; // 'USBOS1'
  const VERSION = 1;
  const DEFAULT_CHUNK = 1024 * 1024;
  const MAX_HEADER = 1024 * 1024;
  const MAX_CHUNKS = 100000;

  function fail(msg) { throw new Error('upack: ' + msg); }

  async function sha256Hex(u8) {
    const d = await crypto.subtle.digest('SHA-256', u8);
    return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  function isUpackName(name) {
    return typeof name === 'string' && name.toLowerCase().endsWith('.upack');
  }

  function parseUpack(u8) {
    const b = u8 instanceof Uint8Array ? u8 : new Uint8Array(u8);
    if (b.length < 10) fail('too short');
    for (let i = 0; i < 6; i++) if (b[i] !== MAGIC[i]) fail('bad magic');
    const hlen = (b[6] * 16777216) + (b[7] << 16) + (b[8] << 8) + b[9];
    if (!(hlen > 0) || hlen > MAX_HEADER || 10 + hlen > b.length) fail('bad header length');
    let header;
    try {
      header = JSON.parse(new TextDecoder().decode(b.subarray(10, 10 + hlen)));
    } catch (e) { fail('unreadable header'); }
    if (!header || typeof header !== 'object' || header.v !== VERSION) fail('unsupported version');
    for (const k of ['name', 'mime', 'size', 'chunk', 'hashes', 'sha']) {
      if (!(k in header)) fail('incomplete header (' + k + ')');
    }
    if (!Number.isInteger(header.chunk) || header.chunk <= 0 || header.chunk > 64 * 1024 * 1024) fail('bad chunk');
    if (!Number.isInteger(header.size) || header.size < 0) fail('bad size');
    const expect = header.size === 0 ? 1 : Math.ceil(header.size / header.chunk);
    if (!Array.isArray(header.hashes) || header.hashes.length !== expect || expect > MAX_CHUNKS) fail('bad hashes');
    return { header, dataOffset: 10 + hlen };
  }

  function chunkAt(u8, header, dataOffset, idx) {
    const start = dataOffset + idx * header.chunk;
    const end = Math.min(start + header.chunk, dataOffset + header.size);
    if (start > u8.length || end > u8.length) fail('truncated chunk ' + idx);
    return u8.subarray(start, end);
  }

  async function verifyUpack(u8) {
    const { header, dataOffset } = parseUpack(u8);
    const total = [];
    for (let i = 0; i < header.hashes.length; i++) {
      const c = chunkAt(u8, header, dataOffset, i);
      if (await sha256Hex(c) !== String(header.hashes[i]).toLowerCase()) fail('corrupt chunk ' + i);
      total.push(c);
    }
    return { header, parts: total };
  }

  async function extractUpack(u8) {
    const { header, parts } = await verifyUpack(u8);
    const out = new Uint8Array(header.size);
    let off = 0;
    for (const c of parts) { out.set(c, off); off += c.length; }
    if (await sha256Hex(out) !== String(header.sha).toLowerCase()) fail('bad global sha');
    return { header, bytes: out };
  }

  async function buildUpack({ name, mime, bytes, chunk }) {
    const src = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const ch = chunk || DEFAULT_CHUNK;
    if (!Number.isInteger(ch) || ch <= 0 || ch > 64 * 1024 * 1024) fail('bad chunk');
    const n = src.length === 0 ? 1 : Math.ceil(src.length / ch);
    if (n > MAX_CHUNKS) fail('too many chunks');
    const hashes = [];
    for (let i = 0; i < n; i++) {
      hashes.push(await sha256Hex(src.subarray(i * ch, Math.min((i + 1) * ch, src.length))));
    }
    const header = {
      v: VERSION,
      name: String(name || 'file').slice(0, 255),
      mime: String(mime || 'application/octet-stream').slice(0, 128),
      size: src.length,
      chunk: ch,
      hashes,
      sha: await sha256Hex(src),
    };
    const hb = new TextEncoder().encode(JSON.stringify(header));
    const out = new Uint8Array(10 + hb.length + src.length);
    out.set(MAGIC, 0);
    out[6] = (hb.length >>> 24) & 255; out[7] = (hb.length >>> 16) & 255;
    out[8] = (hb.length >>> 8) & 255; out[9] = hb.length & 255;
    out.set(hb, 10);
    out.set(src, 10 + hb.length);
    return { bytes: out, header };
  }

  root.USBosUpack = {
    MAGIC: 'USBOS1', VERSION, DEFAULT_CHUNK, MAX_CHUNKS,
    parseUpack, verifyUpack, extractUpack, buildUpack, sha256Hex, isUpackName, chunkAt,
  };
})(typeof window !== 'undefined' ? window : globalThis);
