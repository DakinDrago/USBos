/* USBos app: notes — porté depuis le module original, adapté au contrat v2 (ctx.fs, mount/unmount). */
const STATE_FILE = 'notes.json';

const STYLE = `
.notes-app{width:100%;flex:1;min-height:0}
.notes-app h2{font-size:17px;margin-bottom:2px}
.notes-app .hint{color:var(--muted);font-size:12px;margin-bottom:14px}
.notes-app form{display:flex;flex-direction:column;gap:8px;background:var(--panel);border:1px solid var(--border);border-radius:12px;padding:12px;margin-bottom:16px}
.notes-app form input,.notes-app form textarea{background:var(--bg);border:1px solid var(--border);border-radius:8px;color:var(--text);padding:9px 11px;font:inherit;outline:none}
.notes-app form input:focus,.notes-app form textarea:focus{border-color:var(--accent)}
.notes-app form textarea{min-height:110px;resize:vertical;font-family:'JetBrains Mono',ui-monospace,monospace;font-size:13px}
.notes-app form .row{display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap}
.notes-app .row{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:12px}
.notes-app form .count{color:var(--muted);font-size:11.5px}
.notes-app .saved{color:var(--ok);font-size:12px}
.notes-app .list{display:flex;flex-direction:column;gap:8px}
.notes-app .note{background:var(--panel);border:1px solid var(--border);border-radius:10px;padding:10px 12px;display:flex;justify-content:space-between;gap:10px;align-items:center}
.notes-app .note .t{font-weight:600;font-size:13.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:60%}
.notes-app .note .p{color:var(--muted);font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}
.notes-app .note .ops{display:flex;gap:6px}
.notes-app .mini{background:var(--panel2);border:1px solid var(--border);border-radius:7px;color:var(--text);font-size:12px;padding:4px 9px}
.notes-app .mini:hover{border-color:var(--accent)}
.notes-app .mini.del:hover{border-color:var(--err);color:var(--err)}
.notes-app .save{background:linear-gradient(135deg,var(--accent),var(--accent2));border:none;border-radius:8px;color:#fff;font-weight:600;padding:8px 14px}
.notes-app .save:hover{filter:brightness(1.1)}
.notes-app .empty{color:var(--muted);font-size:12.5px;text-align:center;padding:22px 0}
.notes-app .empty-cta{display:flex;flex-direction:column;gap:10px;align-items:center;padding:18px 0}
.notes-app .empty-cta .save{align-self:center}
`;

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function newId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
  const hx = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${hx.slice(0, 8)}-${hx.slice(8, 12)}-${hx.slice(12, 16)}-${hx.slice(16, 20)}-${hx.slice(20)}`;
}

const USBosApp = {
  id: 'notes',
  async mount(ctx, stage) {
    stage.append(Object.assign(document.createElement('style'), { textContent: STYLE }));
    const t = ctx.i18n.t;
    const tp = ctx.i18n.tp;
    const locale = ctx.i18n.locale;

    let notes = [];
    try { notes = await ctx.fs.readJSON(STATE_FILE); } catch { /* fichier absent au premier lancement */ }
    if (!Array.isArray(notes)) notes = [];
    let editingId = null;
    let draftDirty = false;
    let draftTimer = null;
    const delTimers = new Set();

    const saved = el('div', 'saved');
    const titleIn = el('input'); titleIn.placeholder = t('notes.titlePh');
    const bodyIn = el('textarea'); bodyIn.placeholder = t('notes.bodyPh');
    const saveBtn = el('button', 'save', t('notes.save')); saveBtn.type = 'button';
    const count = el('span', 'count', tp('notes.countChars', 0));
    const list = el('div', 'list');

    async function persist() {
      try {
        await ctx.fs.writeJSON(STATE_FILE, notes);
        saved.textContent = t('notes.savedAt', { time: new Date().toLocaleTimeString(locale) });
        ctx.ui.log(`notes: ${notes.length} note(s) écrites`);
      } catch (err) {
        saved.textContent = t('notes.saveFailed', { error: err.message });
        ctx.ui.log(`notes: échec persist (${err.message})`);
      }
    }

    function renderList() {
      list.innerHTML = '';
      const q = searchIn.value.trim().toLowerCase();
      const shown = q
        ? notes.filter((n) => `${n.title || ''}\n${n.body || ''}`.toLowerCase().includes(q))
        : notes;
      if (q) list.append(el('div', 'count', t('notes.results', { n: shown.length, q: searchIn.value.trim().slice(0, 60) })));
      if (notes.length === 0) {
        const empty = el('div', 'empty', t('notes.empty'));
        const cta = el('button', 'save', t('notes.emptyCta')); cta.type = 'button';
        cta.onclick = () => { titleIn.focus(); };
        const box = el('div', 'empty-cta');
        box.append(empty, cta);
        list.append(box);
        return;
      }
      if (shown.length === 0) { list.append(el('div', 'empty', t('notes.noResult'))); return; }
      for (const n of shown) {
        const card = el('div', 'note');
        card.append(el('span', 't', n.title || t('notes.untitled')));
        card.append(el('span', 'p', (n.body || '').replace(/\n/g, ' ') || '…'));
        const ops = el('div', 'ops');
        const edit = el('button', 'mini', t('notes.open'));
        edit.onclick = () => {
          editingId = n.id; titleIn.value = n.title; bodyIn.value = n.body;
          saveBtn.textContent = t('notes.update'); bodyIn.focus();
          draftDirty = false; clearTimeout(draftTimer);
        };
        const del = el('button', 'mini del', t('notes.delete'));
        let armDel = null;
        del.onclick = async () => {
          if (armDel) {
            clearTimeout(armDel); delTimers.delete(armDel); armDel = null; del.textContent = t('notes.delete');
            notes = notes.filter((x) => x.id !== n.id);
            if (editingId === n.id) { editingId = null; saveBtn.textContent = t('notes.save'); draftDirty = false; }
            await persist(); renderList();
            ctx.ui.toast(t('notes.deleted'));
            return;
          }
          del.textContent = t('notes.sure');
          armDel = setTimeout(() => { delTimers.delete(armDel); armDel = null; del.textContent = t('notes.delete'); }, 4000);
          delTimers.add(armDel);
        };
        ops.append(edit, del);
        card.append(ops);
        list.append(card);
      }
    }

    saveBtn.onclick = async () => {
      const title = titleIn.value.trim().slice(0, 200);
      const body = bodyIn.value.trim().slice(0, 100000);
      if (!title && !body) return;
      if (editingId != null) {
        const n = notes.find((x) => x.id === editingId);
        if (n) { n.title = title; n.body = body; }
        editingId = null; saveBtn.textContent = t('notes.save');
      } else {
        notes.unshift({ id: newId(), title, body, created: Date.now() });
      }
      titleIn.value = ''; bodyIn.value = '';
      draftDirty = false; clearTimeout(draftTimer);
      await persist(); renderList();
    };

    const markDraftDirty = () => {
      clearTimeout(draftTimer);
      draftTimer = setTimeout(() => { draftDirty = true; }, 500);
    };
    titleIn.addEventListener('input', markDraftDirty);
    bodyIn.addEventListener('input', () => { count.textContent = tp('notes.countChars', bodyIn.value.length); markDraftDirty(); });

    const form = el('form');
    form.onsubmit = (e) => { e.preventDefault(); saveBtn.click(); };
    const row = el('div', 'row');
    row.append(count, saved, saveBtn);
    form.append(titleIn, bodyIn, row);

    const searchIn = el('input'); searchIn.placeholder = t('notes.searchPh'); searchIn.setAttribute('aria-label', t('notes.searchAria'));
    searchIn.addEventListener('input', renderList);
    searchIn.addEventListener('keydown', (e) => { if (e.key === 'Escape') { searchIn.value = ''; renderList(); } });
    const onDoc = (e) => {
      if (e.key === '/' && !/^(INPUT|TEXTAREA)$/.test(document.activeElement && document.activeElement.tagName || '')) {
        e.preventDefault(); searchIn.focus();
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault(); saveBtn.click();
      }
    };
    document.addEventListener('keydown', onDoc);

    function todayStamp() {
      const t = new Date();
      const p = (n) => String(n).padStart(2, '0');
      return `${t.getFullYear()}${p(t.getMonth() + 1)}${p(t.getDate())}`;
    }
    async function exportShared(kind) {
      try {
        if (!notes.length) { saved.textContent = t('notes.nothingToExport'); return; }
        const name = `notes-${todayStamp()}.${kind}`;
        const content = kind === 'json'
          ? JSON.stringify(notes, null, 2)
          : notes.map((n) => `# ${n.title || t('notes.untitled')}\n\n${n.body || ''}`).join('\n\n---\n\n');
        if (new TextEncoder().encode(content).length > 2 * 1024 * 1024) {
          saved.textContent = t('notes.exportFailed', { error: String(locale || '').toLowerCase().startsWith('en') ? '2 MB max' : '2 Mo max' });
          ctx.ui.log('notes: export refusé (>2 Mo)');
          return;
        }
        await ctx.fs.writeSharedText(name, content);
        saved.textContent = t('notes.exportedTo', { name });
        ctx.ui.log(`notes: export ${name}`);
        ctx.ui.toast(t('notes.exportedToast', { name }));
      } catch (err) {
        saved.textContent = t('notes.exportFailed', { error: err.message });
      }
    }
    const expRow = el('div', 'row');
    const expJson = el('button', 'mini', t('notes.exportJson')); expJson.type = 'button';
    expJson.onclick = () => exportShared('json');
    const expTxt = el('button', 'mini', t('notes.exportTxt')); expTxt.type = 'button';
    expTxt.onclick = () => exportShared('txt');
    const sharedBox = el('div', 'list'); sharedBox.hidden = true;
    const fromSharedBtn = el('button', 'mini', t('notes.fromShared')); fromSharedBtn.type = 'button';
    fromSharedBtn.onclick = async () => {
      sharedBox.innerHTML = '';
      sharedBox.hidden = false;
      let files;
      try {
        files = await ctx.fs.listShared('');
      } catch (err) {
        saved.textContent = t('notes.importFailed', { error: err.message });
        ctx.ui.toast(t('shell.settings.sharedNoAccess'));
        return;
      }
      const jsons = (Array.isArray(files) ? files : [])
        .filter((f) => f && f.kind === 'file' && String(f.name || '').toLowerCase().endsWith('.json'))
        .slice(0, 20);
      if (jsons.length === 0) { sharedBox.append(el('div', 'empty', t('notes.sharedNone'))); return; }
      for (const f of jsons) {
        const row = el('div', 'note');
        row.append(el('span', 't', String(f.name || '').slice(0, 200)));
        const imp = el('button', 'mini', t('notes.importBtn')); imp.type = 'button';
        imp.onclick = async () => {
          try {
            const text = await ctx.fs.readSharedText(f.name);
            let arr;
            try {
              arr = JSON.parse(text);
            } catch (err) {
              saved.textContent = t('notes.importFailed', { error: err.message });
              ctx.ui.toast(t('notes.importFailed', { error: err.message }));
              return;
            }
            if (!Array.isArray(arr)) {
              saved.textContent = t('notes.importFailed', { error: String(f.name || '') });
              ctx.ui.toast(t('notes.importFailed', { error: String(f.name || '') }));
              return;
            }
            const ids = new Set(notes.map((n) => n.id));
            const clean = [];
            for (const it of arr.slice(0, 5000)) {
              if (!it || typeof it !== 'object') continue;
              let id = String(it.id || newId());
              if (ids.has(id)) id = newId();
              ids.add(id);
              clean.push({
                id,
                title: String(it.title || '').slice(0, 200),
                body: String(it.body || '').slice(0, 100000),
                created: Number(it.created) || Date.now(),
              });
            }
            if (clean.length === 0) {
              saved.textContent = t('notes.importFailed', { error: String(f.name || '') });
              ctx.ui.toast(t('notes.importFailed', { error: String(f.name || '') }));
              return;
            }
            notes.unshift(...clean);
            await persist(); renderList();
            saved.textContent = t('notes.imported', { name: String(f.name || ''), n: clean.length });
            ctx.ui.toast(t('notes.imported', { name: String(f.name || ''), n: clean.length }));
            ctx.ui.log(`notes: import ${f.name} (${clean.length})`);
          } catch (err) {
            saved.textContent = t('notes.importFailed', { error: err.message });
            ctx.ui.toast(t('notes.importFailed', { error: err.message }));
          }
        };
        row.append(imp);
        sharedBox.append(row);
      }
    };
    expRow.append(expJson, expTxt, fromSharedBtn);
    const helpLine = el('p', 'hint', t('notes.helpLine'));

    const wrap = el('div', 'notes-app');
    wrap.append(
      el('h2', null, t('notes.title')),
      el('p', 'hint', t('notes.hint')),
      form, searchIn, expRow, helpLine, sharedBox, list
    );
    stage.append(wrap);
    renderList();
    try {
      this._notesCleanup = async () => {
        clearTimeout(draftTimer);
        document.removeEventListener('keydown', onDoc);
        for (const tm of delTimers) clearTimeout(tm);
        delTimers.clear();
        if (draftDirty && editingId != null) {
          try {
            const n = notes.find((x) => x.id === editingId);
            if (n) {
              n.title = titleIn.value.trim().slice(0, 200);
              n.body = bodyIn.value.trim().slice(0, 100000);
              await persist();
            }
          } catch { /* best-effort */ }
          draftDirty = false;
        }
      };
    } catch { /* noop */ }
  },
  async unmount() { if (this && this._notesCleanup) { try { await this._notesCleanup(); } catch { /* noop */ } this._notesCleanup = null; } },
}
return USBosApp;
