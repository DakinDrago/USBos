/*
 * USBos app: gallery — visionneuse multimédia de la clé.
 * Lit les images / vidéos / audios depuis Partage/ (commun), vos fichiers
 * locaux (sélecteur, lecture directe sans copie) et vos médias importés
 * (data:gallery). Comprend le conteneur .upack v1 (vérifié morceau par
 * morceau, extraction ou lecture directe du média intérieur).
 * Plafonds : 256 Mo par média (pont RPC) ; export .upack ≤ 64 Mo.
 */
const CONFIG_MAX_BYTES = 256 * 1024 * 1024;
const UPACK_BUILD_MAX = 64 * 1024 * 1024;
const THUMB_MAX_BYTES = 8 * 1024 * 1024;
const UPACK_CHUNK = 1024 * 1024;
const MAX_LIST = 200;

const IMG_EXTS = ['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'svg'];
const VID_EXTS = ['mp4', 'webm', 'mkv', 'mov', 'avi'];
const AUD_EXTS = ['mp3', 'wav', 'ogg', 'flac', 'm4a'];

const STYLE = `
.gallery-app{width:100%;flex:1;min-height:0;display:flex;flex-direction:column;gap:14px}
.gallery-app h2{font-size:17px;margin-bottom:2px}
.gallery-app .hint{color:var(--muted);font-size:12px}
.gallery-app h3{font-size:14px;margin-top:4px}
.gallery-app .card{background:var(--panel);border:1px solid var(--border);border-radius:12px;padding:14px;display:flex;flex-direction:column;gap:10px}
.gallery-app .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:10px}
.gallery-app .thumb{background:var(--bg);border:1px solid var(--border);border-radius:10px;overflow:hidden;cursor:pointer;padding:0;text-align:left;color:inherit;font:inherit}
.gallery-app .thumb:hover{border-color:var(--accent)}
.gallery-app .thumb img{width:100%;height:96px;object-fit:cover;display:block;background:#000}
.gallery-app .thumb .cap{font-size:11.5px;padding:6px 8px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.gallery-app .rows{display:flex;flex-direction:column;gap:6px}
.gallery-app .row{background:var(--bg);border:1px solid var(--border);border-radius:10px;padding:9px 12px;display:flex;justify-content:space-between;align-items:center;gap:10px}
.gallery-app .row .n{font-weight:600;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.gallery-app .row .s{font-size:11.5px;color:var(--muted);white-space:nowrap}
.gallery-app .acts{display:flex;gap:6px;flex-wrap:wrap}
.gallery-app .btn{background:linear-gradient(135deg,var(--accent),var(--accent2));border:none;border-radius:8px;color:#fff;font-weight:600;padding:8px 14px}
.gallery-app .mini{background:var(--panel2);border:1px solid var(--border);border-radius:7px;color:var(--text);font-size:12px;padding:6px 11px}
.gallery-app .mini:hover{border-color:var(--accent)}
.gallery-app .empty{color:var(--muted);font-size:12.5px;text-align:center;padding:10px 0}
.gallery-app .viewer{position:fixed;inset:0;z-index:90;background:rgba(0,0,0,.85);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;padding:20px}
.gallery-app .viewer img,.gallery-app .viewer video{max-width:min(92vw,1100px);max-height:72vh;border-radius:10px;background:#000}
.gallery-app .viewer audio{width:min(92vw,520px)}
.gallery-app .viewer .cap{color:#fff;font-size:13px;max-width:92vw;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.gallery-app .viewer .vacts{display:flex;gap:8px;flex-wrap:wrap;justify-content:center}
.gallery-app .viewer .info{color:var(--muted);font-size:12px}
`;

function el(tag, cls, text) { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
let galleryCleanup = null;

function extOf(name) { return (String(name).split('.').pop() || '').toLowerCase(); }
function kindOf(name) {
  const e = extOf(name);
  if (IMG_EXTS.includes(e)) return 'image';
  if (VID_EXTS.includes(e)) return 'video';
  if (AUD_EXTS.includes(e)) return 'audio';
  return null;
}
function isUpack(name) { return extOf(name) === 'upack'; }
function isMedia(name) { return kindOf(name) !== null || isUpack(name); }

async function loadUpackLib(ctx) {
  if (window.USBosUpack) return window.USBosUpack;
  const code = await ctx.fs.readAppAsset('vendor/upack.js');
  const script = document.createElement('script');
  script.textContent = code;
  document.head.append(script);
  if (!window.USBosUpack) throw new Error('upack lib');
  return window.USBosUpack;
}

const USBosApp = {
  id: 'gallery',
  async mount(ctx, stage) {
    stage.append(el('style', null, STYLE));
    const t = ctx.i18n.t;
    const U = await loadUpackLib(ctx).catch(() => null);

    const wrap = el('div', 'gallery-app');
    const blobUrls = new Set();
    const track = (url) => { blobUrls.add(url); return url; };
    let viewerCloser = null;
    const closeViewerNow = () => { const f = viewerCloser; viewerCloser = null; if (f) { try { f(); } catch { /* noop */ } } };

    function human(n) {
      if (n == null) return '—';
      return n >= 1048576 ? t('gallery.sizeMo', { n: (n / 1048576).toFixed(1) }) : t('gallery.sizeKo', { n: (n / 1024).toFixed(1) });
    }

    function openViewer(build) {
      closeViewerNow();
      const ov = el('div', 'viewer');
      const closer = () => {
        document.removeEventListener('keydown', onKey);
        try { ov.remove(); } catch { /* noop */ }
      };
      const onKey = (ev) => { if (ev.key === 'Escape') closeViewerNow(); };
      document.addEventListener('keydown', onKey);
      viewerCloser = closer;
      build(ov, closer);
      wrap.append(ov);
    }

    function mediaNode(kind, url, name) {
      let m;
      if (kind === 'image') { m = document.createElement('img'); m.src = url; m.alt = name; }
      else if (kind === 'video') { m = document.createElement('video'); m.src = url; m.controls = true; m.autoplay = true; }
      else { m = document.createElement('audio'); m.src = url; m.controls = true; m.autoplay = true; }
      return m;
    }

    function viewBlob(kind, url, name, extra) {
      openViewer((ov, closer) => {
        ov.append(mediaNode(kind, url, name), el('div', 'cap', name));
        const acts = el('div', 'vacts');
        if (extra) for (const b of extra) acts.append(b);
        const dl = el('a', 'mini', t('gallery.download'));
        dl.href = url; dl.download = name;
        const close = el('button', 'mini', t('gallery.closeViewer'));
        close.onclick = () => closer();
        acts.append(dl, close);
        ov.append(acts);
      });
    }

    async function viewUpackBytes(u8, packName, saveAs) {
      if (!U) { ctx.ui.log('gallery: lib .upack indisponible'); return; }
      let parsed;
      try {
        parsed = await U.extractUpack(u8);
      } catch (err) {
        ctx.ui.log(`gallery: .upack invalide (${err.message})`);
        try { ctx.ui.toast(t('gallery.upackInvalid')); } catch { /* noop */ }
        return;
      }
      const h = parsed.header;
      const innerKind = kindOf(h.name);
      const info = t('gallery.upackInfo', { name: h.name, size: human(h.size), chunks: h.hashes.length, mime: h.mime });
      if (innerKind) {
        const url = track(URL.createObjectURL(new Blob([parsed.bytes], { type: h.mime })));
        const save = saveAs ? (() => {
          const b = el('button', 'mini', t('gallery.extract'));
          b.onclick = async () => { await saveAs(h.name, parsed.bytes); };
          return b;
        })() : null;
        openViewer((ov, closer) => {
          ov.append(mediaNode(innerKind, url, h.name), el('div', 'cap', h.name), el('div', 'info', info));
          const acts = el('div', 'vacts');
          if (save) acts.append(save);
          const dl = el('a', 'mini', t('gallery.download'));
          dl.href = url; dl.download = h.name;
          const close = el('button', 'mini', t('gallery.closeViewer'));
          close.onclick = () => closer();
          acts.append(dl, close);
          ov.append(acts);
        });
      } else {
        openViewer((ov, closer) => {
          ov.append(el('div', 'cap', h.name), el('div', 'info', info));
          const acts = el('div', 'vacts');
          if (saveAs) {
            const b = el('button', 'mini', t('gallery.extract'));
            b.onclick = async () => { await saveAs(h.name, parsed.bytes); };
            acts.append(b);
          }
          const close = el('button', 'mini', t('gallery.closeViewer'));
          close.onclick = () => closer();
          acts.append(close);
          ov.append(acts);
        });
      }
    }

    async function uniqueName(existsFn, name) {
      if (!(await existsFn(name))) return name;
      const dot = name.lastIndexOf('.');
      const base = dot > 0 ? name.slice(0, dot) : name;
      const ext = dot > 0 ? name.slice(dot) : '';
      for (let i = 2; i <= 10; i++) {
        const cand = `${base} ${i}${ext}`;
        if (!(await existsFn(cand))) return cand;
      }
      return null;
    }

    // ---- Section : fichiers locaux (lecture directe, rien n'est copié) ----
    const localCard = el('div', 'card');
    localCard.append(el('h3', null, t('gallery.localTitle')), el('p', 'hint', t('gallery.localHint')));
    const pick = el('input'); pick.type = 'file'; pick.multiple = true;
    pick.accept = 'image/*,video/*,audio/*,.upack';
    pick.hidden = true;
    const pickBtn = el('button', 'btn', t('gallery.localPick'));
    pickBtn.onclick = () => pick.click();
    const localList = el('div', 'rows');
    localCard.append(pickBtn, pick, localList);
    pick.onchange = async () => {
      for (const f of [...pick.files]) {
        if (isUpack(f.name)) {
          if (f.size > CONFIG_MAX_BYTES) { ctx.ui.log(`gallery: .upack trop gros (${f.name})`); continue; }
          try {
            const u8 = new Uint8Array(await f.arrayBuffer());
            await viewUpackBytes(u8, f.name, null);
          } catch (err) { ctx.ui.log(`gallery: lecture impossible (${err.message})`); }
          continue;
        }
        const kind = kindOf(f.name);
        if (!kind) continue;
        const url = track(URL.createObjectURL(f));
        addRow(localList, f.name, human(f.size), () => viewBlob(kind, url, f.name, null));
      }
      pick.value = '';
    };

    function addRow(box, name, sizeTxt, onView, extraActs) {
      const row = el('div', 'row');
      row.append(el('span', 'n', name), el('span', 's', sizeTxt));
      const acts = el('div', 'acts');
      if (onView) {
        const v = el('button', 'mini', t('gallery.view'));
        v.onclick = onView;
        acts.append(v);
      }
      if (extraActs) for (const b of extraActs) acts.append(b);
      row.append(acts);
      box.append(row);
      return row;
    }

    // ---- Section : Partage/ ----
    const sharedCard = el('div', 'card');
    sharedCard.append(el('h3', null, t('gallery.sharedTitle')), el('p', 'hint', t('gallery.sharedHint')));
    const sharedGrid = el('div', 'grid');
    const sharedRows = el('div', 'rows');
    const sharedEmpty = el('div', 'empty', t('gallery.sharedEmpty'));
    sharedCard.append(sharedGrid, sharedRows, sharedEmpty);

    async function readSharedWhole(name) {
      const buf = await ctx.fs.readShared(name);
      return new Uint8Array(buf);
    }

    async function importFromShared(name, bytes) {
      const data = bytes || await readSharedWhole(name).catch((err) => { ctx.ui.log(`gallery: lecture impossible (${err.message})`); return null; });
      if (!data) return;
      if (data.length > CONFIG_MAX_BYTES) {
        try { ctx.ui.toast(t('gallery.tooBig', { max: human(CONFIG_MAX_BYTES) })); } catch { /* noop */ }
        return;
      }
      const existsFn = async (n) => { try { return await ctx.fs.exists(n); } catch { return false; } };
      const dest = await uniqueName(existsFn, name);
      if (!dest) { ctx.ui.log('gallery: trop de doublons'); return; }
      try {
        await ctx.fs.writeBinary(dest, data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
        try { ctx.ui.toast(t('gallery.imported', { name: dest })); } catch { /* noop */ }
        ctx.ui.log(`gallery: importé (${dest})`);
        await renderMine();
      } catch (err) {
        ctx.ui.log(`gallery: import impossible (${err.message})`);
      }
    }

    async function viewShared(name) {
      if (isUpack(name)) {
        const u8 = await readSharedWhole(name).catch((err) => { ctx.ui.log(`gallery: lecture impossible (${err.message})`); return null; });
        if (!u8) return;
        if (u8.length > CONFIG_MAX_BYTES) {
          try { ctx.ui.toast(t('gallery.tooBig', { max: human(CONFIG_MAX_BYTES) })); } catch { /* noop */ }
          return;
        }
        await viewUpackBytes(u8, name, async (inner, bytes) => {
          const existsFn = async (n) => { try { return await ctx.fs.exists(n); } catch { return false; } };
          const dest = await uniqueName(existsFn, inner);
          if (!dest) return;
          try {
            await ctx.fs.writeBinary(dest, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
            try { ctx.ui.toast(t('gallery.extracted', { name: dest })); } catch { /* noop */ }
            await renderMine();
          } catch (err) { ctx.ui.log(`gallery: extraction impossible (${err.message})`); }
        });
        return;
      }
      const kind = kindOf(name);
      if (!kind) return;
      const u8 = await readSharedWhole(name).catch((err) => { ctx.ui.log(`gallery: lecture impossible (${err.message})`); return null; });
      if (!u8) return;
      if (u8.length > CONFIG_MAX_BYTES) {
        try { ctx.ui.toast(t('gallery.tooBig', { max: human(CONFIG_MAX_BYTES) })); } catch { /* noop */ }
        return;
      }
      const url = track(URL.createObjectURL(new Blob([u8])));
      viewBlob(kind, url, name, null);
    }

    async function renderShared() {
      sharedGrid.innerHTML = '';
      sharedRows.innerHTML = '';
      let entries = [];
      try {
        entries = (await ctx.fs.listShared('')).filter((e) => e.kind === 'file' && isMedia(e.name)).slice(0, MAX_LIST);
      } catch (err) {
        ctx.ui.log(`gallery: Partage/ inaccessible (${err.message})`);
        sharedEmpty.style.display = 'block';
        return;
      }
      sharedEmpty.style.display = entries.length ? 'none' : 'block';
      for (const e of entries) {
        if (kindOf(e.name) === 'image') {
          const cell = el('button', 'thumb');
          cell.onclick = () => { void viewShared(e.name); };
          const im = el('img'); im.alt = e.name;
          readSharedWhole(e.name).then((u8) => {
            if (u8.length > THUMB_MAX_BYTES) { im.remove(); return; }
            im.src = track(URL.createObjectURL(new Blob([u8])));
          }).catch(() => { try { im.remove(); } catch { /* noop */ } });
          cell.append(im, el('div', 'cap', e.name));
          sharedGrid.append(cell);
        } else {
          const imp = el('button', 'mini', t('gallery.import'));
          imp.onclick = async () => { await importFromShared(e.name); };
          addRow(sharedRows, e.name, kindOf(e.name) || '.upack', () => { void viewShared(e.name); }, [imp]);
        }
      }
    }

    // ---- Section : mes médias (data:gallery) ----
    const mineCard = el('div', 'card');
    mineCard.append(el('h3', null, t('gallery.mineTitle')), el('p', 'hint', t('gallery.mineHint')));
    const mineGrid = el('div', 'grid');
    const mineRows = el('div', 'rows');
    const mineEmpty = el('div', 'empty', t('gallery.mineEmpty'));
    mineCard.append(mineGrid, mineRows, mineEmpty);

    async function renderMine() {
      mineGrid.innerHTML = '';
      mineRows.innerHTML = '';
      let entries = [];
      try {
        entries = (await ctx.fs.list('')).filter((e) => e.kind === 'file' && isMedia(e.name)).slice(0, MAX_LIST);
      } catch (err) {
        ctx.ui.log(`gallery: lecture impossible (${err.message})`);
        return;
      }
      mineEmpty.style.display = entries.length ? 'none' : 'block';
      for (const e of entries) {
        const view = async () => { await viewMine(e.name); };
        if (kindOf(e.name) === 'image') {
          const cell = el('button', 'thumb');
          cell.onclick = () => { void view(); };
          const im = el('img'); im.alt = e.name;
          ctx.fs.readBinary(e.name).then((buf) => {
            const u8 = new Uint8Array(buf);
            if (u8.length > THUMB_MAX_BYTES) { im.remove(); return; }
            im.src = track(URL.createObjectURL(new Blob([u8])));
          }).catch(() => { try { im.remove(); } catch { /* noop */ } });
          cell.append(im, el('div', 'cap', e.name));
          mineGrid.append(cell);
        }
        const acts = [];
        const exp = el('button', 'mini', t('gallery.exportUpack'));
        exp.onclick = async () => { await exportUpack(e.name); };
        const del = el('button', 'mini del', t('gallery.delete'));
        del.onclick = async () => {
          if (del.textContent !== t('gallery.sure')) { del.textContent = t('gallery.sure'); return; }
          try {
            await ctx.fs.remove(e.name, { confirm: true });
            try { ctx.ui.toast(t('gallery.deleted', { name: e.name })); } catch { /* noop */ }
            await renderMine();
          } catch (err) { ctx.ui.log(`gallery: suppression impossible (${err.message})`); }
        };
        acts.push(exp, del);
        addRow(mineRows, e.name, kindOf(e.name) || '.upack', view, acts);
      }
    }

    async function viewMine(name) {
      let buf;
      try {
        buf = await ctx.fs.readBinary(name);
      } catch (err) { ctx.ui.log(`gallery: lecture impossible (${err.message})`); return; }
      const u8 = new Uint8Array(buf);
      if (u8.length > CONFIG_MAX_BYTES) {
        try { ctx.ui.toast(t('gallery.tooBig', { max: human(CONFIG_MAX_BYTES) })); } catch { /* noop */ }
        return;
      }
      if (isUpack(name)) {
        await viewUpackBytes(u8, name, null);
        return;
      }
      const kind = kindOf(name);
      if (!kind) return;
      viewBlob(kind, track(URL.createObjectURL(new Blob([u8]))), name, null);
    }

    async function exportUpack(name) {
      if (!U) { ctx.ui.log('gallery: lib .upack indisponible'); return; }
      let buf;
      try {
        buf = await ctx.fs.readBinary(name);
      } catch (err) { ctx.ui.log(`gallery: lecture impossible (${err.message})`); return; }
      const u8 = new Uint8Array(buf);
      if (u8.length > UPACK_BUILD_MAX) {
        try { ctx.ui.toast(t('gallery.upackTooBig')); } catch { /* noop */ }
        ctx.ui.log('gallery: export .upack refusé (>64 Mo en RAM)');
        return;
      }
      let packed;
      try {
        packed = await U.buildUpack({ name, mime: '', bytes: u8, chunk: UPACK_CHUNK });
      } catch (err) {
        ctx.ui.log(`gallery: emballage impossible (${err.message})`);
        return;
      }
      const dest = `${name}.upack`;
      try {
        await ctx.fs.writeShared(dest, packed.bytes.buffer.slice(0));
        try { ctx.ui.toast(t('gallery.exportedUpack', { name: dest })); } catch { /* noop */ }
        ctx.ui.log(`gallery: exporté vers Partage/ (${dest})`);
      } catch (err) {
        ctx.ui.log(`gallery: export impossible (${err.message})`);
      }
    }

    wrap.append(
      el('h2', null, t('gallery.title')),
      el('p', 'hint', t('gallery.hint')),
      localCard, sharedCard, mineCard,
      el('p', 'hint', t('gallery.helpLine'))
    );
    stage.append(wrap);

    await renderShared();
    await renderMine();

    let galleryCleanupFn = () => {
      closeViewerNow();
      for (const u of blobUrls) { try { URL.revokeObjectURL(u); } catch { /* noop */ } }
      blobUrls.clear();
    };
    galleryCleanup = galleryCleanupFn;
  },
  async unmount() { if (galleryCleanup) { try { galleryCleanup(); } catch { /* noop */ } galleryCleanup = null; } },
};
return USBosApp;
