#!/usr/bin/env node
/*
 * USBos — tools/test-upack.cjs
 * Roundtrip + rejets du conteneur .upack v1 (miroir de tools/upack.py).
 * Usage : node tools/test-upack.cjs
 * Sortie TAP : lignes "ok ..." ; exit 1 au premier échec.
 */
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'USBos', 'system', 'upack.js'), 'utf8');
const factory = new Function(`${SRC}; return USBosUpack;`);
const U = factory();

let n = 0;
function ok(cond, label) {
  n++;
  if (!cond) { console.log(`not ok ${n} ${label}`); process.exit(1); }
  console.log(`ok ${n} ${label}`);
}

(async () => {
  const sample = new Uint8Array(300000);
  for (let i = 0; i < sample.length; i++) sample[i] = (i * 31 + 7) & 255;

  // Roundtrip multi-morceaux.
  const { bytes, header } = await U.buildUpack({ name: 'film.mp4', mime: 'video/mp4', bytes: sample, chunk: 65536 });
  ok(bytes.length > sample.length, 'pack bigger than payload');
  ok(header.hashes.length === 5, `5 chunks (got ${header.hashes.length})`);
  ok(header.sha.length === 64, 'global sha present');
  const parsed = U.parseUpack(bytes);
  ok(parsed.header.name === 'film.mp4' && parsed.header.size === 300000, 'header parsed');
  const { bytes: out } = await U.extractUpack(bytes);
  ok(out.length === sample.length && out.every((v, i) => v === sample[i]), 'extract identical');

  // Fichier vide.
  const e0 = await U.buildUpack({ name: 'vide.bin', bytes: new Uint8Array(0), chunk: 1024 });
  ok(e0.header.hashes.length === 1, 'empty file = 1 chunk');
  const x0 = await U.extractUpack(e0.bytes);
  ok(x0.bytes.length === 0, 'empty extract');

  // Rejets.
  const badMagic = bytes.slice();
  badMagic[0] ^= 0xff;
  let threw = false;
  try { U.parseUpack(badMagic); } catch (e) { threw = /bad magic/.test(e.message); }
  ok(threw, 'bad magic rejected');

  const tampered = bytes.slice();
  tampered[parsed.dataOffset + 10] ^= 0xff;
  threw = false;
  try { await U.extractUpack(tampered); } catch (e) { threw = /corrupt chunk 0/.test(e.message); }
  ok(threw, 'corrupt chunk rejected');

  const truncated = bytes.slice(0, parsed.dataOffset + 100);
  threw = false;
  try { await U.extractUpack(truncated); } catch (e) { threw = true; }
  ok(threw, 'truncated rejected');

  ok(!U.isUpackName('film.mp4') && U.isUpackName('FILM.UPACK'), 'extension check');

  console.log(`\nALL UPACK JS TESTS PASSED (${n} assertions)`);
})().catch((e) => { console.log(`not ok ${n + 1} harness (${e && e.message})`); process.exit(1); });
