/*
 * USBos app: gallery — visionneuse multimédia de la clé.
 * Lit les images / vidéos / audios depuis Partage/ (commun), vos fichiers
 * locaux (sélecteur, lecture directe sans copie) et vos médias importés
 * (data:gallery). Comprend le conteneur .upack v1 (vérifié morceau par
 * morceau, extraction ou lecture directe du média intérieur).
 *
 * Plafonds — deux ceilings DIFFÉRENTS, à ne plus confondre :
 * - DATA_MAX_BYTES 64 Mo : écrire dans data:gallery/ passe par le chiffrement
 *   du noyau, qui refuse au-delà de 64 Mo par fichier. C'est la VRAI limite
 *   d'un média importé (l'ancien 256 MoIci mentait : l'import échouait au
 *   dernier moment, sans message, après avoir chargé le fichier en RAM).
 * - SHARED_MAX_BYTES 256 Mo : Partage/ est en clair, d'où la limite du pont.
 * - UPACK_BUILD_MAX 64 Mo : taille d'un .upack construit.
 */
const DATA_MAX_BYTES = 64 * 1024 * 1024;
const SHARED_MAX_BYTES = 256 * 1024 * 1024;
const UPACK_BUILD_MAX = 64 * 1024 * 1024;
const THUMB_MAX_BYTES = 8 * 1024 * 1024;
const UPACK_CHUNK = 1024 * 1024;
const MAX_LIST = 200;
// Vignettes : reads sérialisés avec un petit pool. Avant, 200 vignettes
// partaient en 200 lectures COMPLÈTES simultanées (jusqu'à 64 Mo chacune).
const THUMB_CONCURRENCY = 4;

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

const MIME_BY_EXT = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp',
  gif: 'image/gif', bmp: 'image/bmp', svg: 'image/svg+xml',
  mp4: 'video/mp4', webm: 'video/webm', mkv: 'video/x-matroska', mov: 'video/quicktime', avi: 'video/x-msvideo',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', flac: 'audio/flac', m4a: 'audio/mp4',
};
function mimeOf(name) { return MIME_BY_EXT[extOf(name)] || 'application/octet-stream'; }

const USBosApp = {
  id: 'gallery',
  async mount(ctx, stage) {
    stage.append(el('style', null, STYLE));
    const t = ctx.i18n.t;
    const U = await loadUpackLib(ctx).catch(() => null);
    if (!U) {
      // Signalé au montage : sinon les entrées .upack s'affichent avec des
      // boutons qui ne font RIEN (échec silencieux jusqu'au premier clic).
      try { ctx.ui.toast(t('gallery.upackUnavailable')); } catch { /* noop */ }
    }

    const wrap = el('div', 'gallery-app');
    const blobUrls = new Set();
    const track = (url) => { blobUrls.add(url); return url; };
    // Purge des URLs blob d'un rendu : sans ça, chaque re-rendin (import,
    // extraction, suppression) créait une nouvelle génération de vignettes
    // sans révoquer les précédentes -> croissance monotone de la RAM.
    const releaseThumbs = () => {
      for (const u of blobUrls) { try { URL.revokeObjectURL(u); } catch { /* noop */ } }
      blobUrls.clear();
    };
    let viewerCloser = null;
    const closeViewerNow = () => { const f = viewerCloser; viewerCloser = null; if (f) { try { f(); } catch { /* noop */ } } };

    function human(n) {
      if (n == null) return '—';
      return n >= 1048576 ? t('gallery.sizeMo', { n: (n / 1048576).toFixed(1) }) : t('gallery.sizeKo', { n: (n / 1024).toFixed(1) });
    }

    function openViewer(build) {
      closeViewerNow();
      const ov = el('div', 'viewer');
      let media = null;
      const closer = () => {
        document.removeEventListener('keydown', onKey);
        // pause() explicite : s'appuyer sur « retiré du document = pause » est
        // dépendant de la spec, et une vidéo en lecture garde son son.
        if (media && typeof media.pause === 'function') { try { media.pause(); } catch { /* noop */ } }
        try { ov.remove(); } catch { /* noop */ }
      };
      const onKey = (ev) => { if (ev.key === 'Escape') closeViewerNow(); };
      document.addEventListener('keydown', onKey);
      viewerCloser = closer;
      build(ov, (m) => { media = m; });
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
      openViewer((ov, setMedia) => {
        const m = mediaNode(kind, url, name);
        setMedia(m);
        ov.append(m, el('div', 'cap', name));
        const acts = el('div', 'vacts');
        if (extra) for (const b of extra) acts.append(b);
        const dl = el('a', 'mini', t('gallery.download'));
        dl.href = url; dl.download = name;
        const close = el('button', 'mini', t('gallery.closeViewer'));
        // closeViewerNow() et non closer() : la variable interne reste ainsi
        // cohérente (le prochain closeViewerNow, y compris à l'unmount, ne
        // rappelle pas un closer d'overlay déjà retiré du DOM).
        close.onclick = () => closeViewerNow();
        acts.append(dl, close);
        ov.append(acts);
      });
    }

    async function viewUpackBytes(u8, packName, saveAs) {
      if (!U) { ctx.ui.log('gallery: lib .upack indisponible', 'warn'); return; }
      let parsed;
      try {
        parsed = await U.extractUpack(u8);
      } catch (err) {
        ctx.ui.log(`gallery: .upack invalide (${err.message})`, 'warn');
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
        openViewer((ov, setMedia) => {
          const m = mediaNode(innerKind, url, h.name);
          setMedia(m);
          ov.append(m, el('div', 'cap', h.name), el('div', 'info', info));
          const acts = el('div', 'vacts');
          if (save) acts.append(save);
          const dl = el('a', 'mini', t('gallery.download'));
          dl.href = url; dl.download = h.name;
          const close = el('button', 'mini', t('gallery.closeViewer'));
          close.onclick = () => closeViewerNow();
          acts.append(dl, close);
          ov.append(acts);
        });
      } else {
        openViewer((ov) => {
          ov.append(el('div', 'cap', h.name), el('div', 'info', info));
          const acts = el('div', 'vacts');
          if (saveAs) {
            const b = el('button', 'mini', t('gallery.extract'));
            b.onclick = async () => { await saveAs(h.name, parsed.bytes); };
            acts.append(b);
          }
          const close = el('button', 'mini', t('gallery.closeViewer'));
          close.onclick = () => closeViewerNow();
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
          if (f.size > SHARED_MAX_BYTES) { ctx.ui.log(`gallery: .upack trop gros (${f.name})`, 'warn'); continue; }
          try {
            const u8 = new Uint8Array(await f.arrayBuffer());
            await viewUpackBytes(u8, f.name, null);
          } catch (err) { ctx.ui.log(`gallery: lecture impossible (${err.message})`, 'warn'); }
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

    /** Pool de vignettes : THUMB_CONCURRENCY lectures simultanées maximum.
     *  Avant, chaque vignette déclenchait sa lecture complète en même temps
     *  (200 entrées × jusqu'à 64 Mo) — on sature la RAM pour des miniatures. */
    function makeThumbPool(limit) {
      const queue = [];
      let active = 0;
      const pump = () => {
        while (active < limit && queue.length) {
          const job = queue.shift();
          active++;
          Promise.resolve()
            .then(job.run)
            .catch(() => {})
            .then(() => { active--; pump(); });
        }
      };
      return (run) => { queue.push({ run }); pump(); };
    }

    const importFromShared = async (name) => {
      // Le plafond data: (64 Mo) est vérifié via stat AVANT la lecture :
      // l'ancien contrôle post-lecture laissait entrer 200 Mo en RAM pour
      // échouer ensuite sur le refus du noyau.
      const st = await ctx.fs.statShared(name).catch(() => null);
      if (st && st.size > DATA_MAX_BYTES) {
        try { ctx.ui.toast(t('gallery.tooBig', { max: human(DATA_MAX_BYTES) })); } catch { /* noop */ }
        ctx.ui.log(`gallery: import refusé, ${name} dépasse ${human(DATA_MAX_BYTES)} (plafond data:gallery)`, 'warn');
        return;
      }
      let data;
      try { data = await readSharedWhole(name); }
      catch (err) { ctx.ui.log(`gallery: lecture impossible (${err.message})`, 'warn'); return; }
      if (data.length > DATA_MAX_BYTES) {
        try { ctx.ui.toast(t('gallery.tooBig', { max: human(DATA_MAX_BYTES) })); } catch { /* noop */ }
        return;
      }
      const existsFn = async (n) => { try { return await ctx.fs.exists(n); } catch { return false; } };
      const dest = await uniqueName(existsFn, name);
      if (!dest) { ctx.ui.log('gallery: trop de doublons', 'warn'); return; }
      try {
        await ctx.fs.writeBinary(dest, data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
        try { ctx.ui.toast(t('gallery.imported', { name: dest })); } catch { /* noop */ }
        ctx.ui.log(`gallery: importé (${dest})`);
        await renderMine();
      } catch (err) {
        // Échec visible : l'utilisateur ne doit pas croire l'import réussi.
        ctx.ui.log(`gallery: import impossible (${err.message})`, 'error');
        try { ctx.ui.toast(t('gallery.importFailed', { error: err.message })); } catch { /* noop */ }
      }
    };

    async function viewShared(name) {
      if (isUpack(name)) {
        const st = await ctx.fs.statShared(name).catch(() => null);
        if (st && st.size > SHARED_MAX_BYTES) {
          try { ctx.ui.toast(t('gallery.tooBig', { max: human(SHARED_MAX_BYTES) })); } catch { /* noop */ }
          return;
        }
        const u8 = await readSharedWhole(name).catch((err) => { ctx.ui.log(`gallery: lecture impossible (${err.message})`, 'warn'); return null; });
        if (!u8) return;
        if (u8.length > SHARED_MAX_BYTES) {
          try { ctx.ui.toast(t('gallery.tooBig', { max: human(SHARED_MAX_BYTES) })); } catch { /* noop */ }
          return;
        }
        await viewUpackBytes(u8, name, async (inner, bytes) => {
          if (bytes.byteLength > DATA_MAX_BYTES) {
            try { ctx.ui.toast(t('gallery.tooBig', { max: human(DATA_MAX_BYTES) })); } catch { /* noop */ }
            ctx.ui.log(`gallery: extraction refusée, ${inner} dépasse le plafond data:`, 'warn');
            return;
          }
          const existsFn = async (n) => { try { return await ctx.fs.exists(n); } catch { return false; } };
          const dest = await uniqueName(existsFn, inner);
          if (!dest) return;
          try {
            await ctx.fs.writeBinary(dest, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
            try { ctx.ui.toast(t('gallery.extracted', { name: dest })); } catch { /* noop */ }
            await renderMine();
          } catch (err) { ctx.ui.log(`gallery: extraction impossible (${err.message})`, 'error'); }
        });
        return;
      }
      const kind = kindOf(name);
      if (!kind) return;
      const st = await ctx.fs.statShared(name).catch(() => null);
      if (st && st.size > SHARED_MAX_BYTES) {
        try { ctx.ui.toast(t('gallery.tooBig', { max: human(SHARED_MAX_BYTES) })); } catch { /* noop */ }
        return;
      }
      const u8 = await readSharedWhole(name).catch((err) => { ctx.ui.log(`gallery: lecture impossible (${err.message})`, 'warn'); return null; });
      if (!u8) return;
      if (u8.length > SHARED_MAX_BYTES) {
        try { ctx.ui.toast(t('gallery.tooBig', { max: human(SHARED_MAX_BYTES) })); } catch { /* noop */ }
        return;
      }
      const url = track(URL.createObjectURL(new Blob([u8])));
      viewBlob(kind, url, name, null);
    }

    const sharedThumbPool = makeThumbPool(THUMB_CONCURRENCY);
    async function renderShared() {
      releaseThumbs();
      sharedGrid.innerHTML = '';
      sharedRows.innerHTML = '';
      let entries = [];
      try {
        entries = (await ctx.fs.listShared('')).filter((e) => e.kind === 'file' && isMedia(e.name)).slice(0, MAX_LIST);
      } catch (err) {
        ctx.ui.log(`gallery: Partage/ inaccessible (${err.message})`, 'warn');
        sharedEmpty.style.display = 'block';
        return;
      }
      sharedEmpty.style.display = entries.length ? 'none' : 'block';
      for (const e of entries) {
        if (kindOf(e.name) === 'image') {
          const cell = el('button', 'thumb');
          cell.onclick = () => { void viewShared(e.name); };
          const im = el('img'); im.alt = e.name;
          // stat() d'abord : au-delà de 8 Mo, inutile de lire le fichier.
          sharedThumbPool(async () => {
            const st = await ctx.fs.statShared(e.name).catch(() => null);
            if (st && st.size > THUMB_MAX_BYTES) { im.remove(); return; }
            const u8 = await readSharedWhole(e.name);
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

    const mineThumbPool = makeThumbPool(THUMB_CONCURRENCY);
    async function renderMine() {
      releaseThumbs();
      mineGrid.innerHTML = '';
      mineRows.innerHTML = '';
      let entries = [];
      try {
        entries = (await ctx.fs.list('')).filter((e) => e.kind === 'file' && isMedia(e.name)).slice(0, MAX_LIST);
      } catch (err) {
        // data:gallery/ n'existe pas encore sur une clé neuve : c'est
        // « aucun média importé », pas une panne. Le journaliser en
        // "lecture impossible" était un faux signal à chaque ouverture.
        if (!err || err.name !== 'NotFoundError') {
          ctx.ui.log(`gallery: listage impossible (${err.message})`, 'error');
          return;
        }
        entries = [];
      }
      mineEmpty.style.display = entries.length ? 'none' : 'block';
      for (const e of entries) {
        const view = async () => { await viewMine(e.name); };
        if (kindOf(e.name) === 'image') {
          const cell = el('button', 'thumb');
          cell.onclick = () => { void view(); };
          const im = el('img'); im.alt = e.name;
          mineThumbPool(async () => {
            const st = await ctx.fs.stat(e.name).catch(() => null);
            if (st && st.size > THUMB_MAX_BYTES) { im.remove(); return; }
            const u8 = new Uint8Array(await ctx.fs.readBinary(e.name));
            if (u8.length > THUMB_MAX_BYTES) { im.remove(); return; }
            im.src = track(URL.createObjectURL(new Blob([u8])));
          }).catch(() => { try { im.remove(); } catch { /* noop */ } });
          cell.append(im, el('div', 'cap', e.name));
          mineGrid.append(cell);
        }
        const acts = [];
        // Un .upack est DÉJÀ un conteneur : le ré-emballer produisait
        // photo.jpg.upack.upack (un fichier que la galerie ne savorait pas
        // relire comme média). On n'expose l'export que pour les médias bruts.
        if (!isUpack(e.name)) {
          const exp = el('button', 'mini', t('gallery.exportUpack'));
          exp.onclick = async () => { await exportUpack(e.name); };
          acts.push(exp);
        }
        const del = el('button', 'mini del', t('gallery.delete'));
        del.onclick = async () => {
          if (del.textContent !== t('gallery.sure')) { del.textContent = t('gallery.sure'); return; }
          try {
            await ctx.fs.remove(e.name);
            try { ctx.ui.toast(t('gallery.deleted', { name: e.name })); } catch { /* noop */ }
            await renderMine();
          } catch (err) { ctx.ui.log(`gallery: suppression impossible (${err.message})`, 'error'); }
        };
        acts.push(del);
        addRow(mineRows, e.name, kindOf(e.name) || '.upack', view, acts);
      }
    }

    async function viewMine(name) {
      const kind0 = kindOf(name);
      // readBinary sur data: est DÉJÀ plafonné à 64 Mo par le noyau : inutile
      // de re-tester 256 Mo ici (l'import ne pouvait d'ailleurs pas dépasser
      // cette limite, tout export/shared en revanche).
      let buf;
      try {
        buf = await ctx.fs.readBinary(name);
      } catch (err) { ctx.ui.log(`gallery: lecture impossible (${err.message})`, 'warn'); return; }
      const u8 = new Uint8Array(buf);
      if (isUpack(name)) {
        await viewUpackBytes(u8, name, null);
        return;
      }
      const kind = kind0;
      if (!kind) return;
      viewBlob(kind, track(URL.createObjectURL(new Blob([u8]))), name, null);
    }

    async function exportUpack(name) {
      if (!U) { ctx.ui.log('gallery: lib .upack indisponible', 'warn'); return; }
      if (isUpack(name)) { ctx.ui.log(`gallery: ${name} est déjà un .upack`, 'warn'); return; }
      const st = await ctx.fs.stat(name).catch(() => null);
      if (st && st.size > UPACK_BUILD_MAX) {
        try { ctx.ui.toast(t('gallery.upackTooBig')); } catch { /* noop */ }
        ctx.ui.log('gallery: export .upack refusé (>64 Mo en RAM)', 'warn');
        return;
      }
      let buf;
      try {
        buf = await ctx.fs.readBinary(name);
      } catch (err) { ctx.ui.log(`gallery: lecture impossible (${err.message})`, 'warn'); return; }
      const u8 = new Uint8Array(buf);
      if (u8.length > UPACK_BUILD_MAX) {
        try { ctx.ui.toast(t('gallery.upackTooBig')); } catch { /* noop */ }
        ctx.ui.log('gallery: export .upack refusé (>64 Mo en RAM)', 'warn');
        return;
      }
      let packed;
      try {
        // mime: '' -> le conteneur sortait en application/octet-stream même
        // pour un JPEG. kindOf connaît l'extension.
        packed = await U.buildUpack({ name, mime: mimeOf(name), bytes: u8, chunk: UPACK_CHUNK });
      } catch (err) {
        ctx.ui.log(`gallery: emballage impossible (${err.message})`, 'error');
        return;
      }
      // Jamais d'écrasement dans Partage/ : suffixe si le nom est pris.
      const existsFn = async (n) => { try { return await ctx.fs.existsShared(n); } catch { return false; } };
      const dest = await uniqueName(existsFn, `${name}.upack`);
      if (!dest) { ctx.ui.log('gallery: trop de doublons', 'warn'); return; }
      try {
        // pas de .slice(0) : packed.bytes.buffer est déjà exclusif, la copie
        // coûtait 64 Mo de RAM pour rien.
        await ctx.fs.writeShared(dest, packed.bytes.buffer);
        try { ctx.ui.toast(t('gallery.exportedUpack', { name: dest })); } catch { /* noop */ }
        ctx.ui.log(`gallery: exporté vers Partage/ (${dest})`);
      } catch (err) {
        ctx.ui.log(`gallery: export impossible (${err.message})`, 'error');
        try { ctx.ui.toast(t('gallery.exportFailed', { error: err.message })); } catch { /* noop */ }
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
      releaseThumbs();
    };
    galleryCleanup = galleryCleanupFn;
  },
  async unmount() { if (galleryCleanup) { try { galleryCleanup(); } catch { /* noop */ } galleryCleanup = null; } },
};
return USBosApp;
