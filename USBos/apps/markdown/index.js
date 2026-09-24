/* USBos app: markdown — porté depuis le module original, adapté au contrat v2. */
const STATE_FILE = 'markdown.json';

const STYLE = `
.md-app{display:flex;gap:14px;align-items:stretch;flex:1;min-height:0;width:100%}
.md-app .docs{width:230px;flex-shrink:0;display:flex;flex-direction:column;gap:6px;min-height:0}
.md-app .docslist{display:flex;flex-direction:column;gap:6px;overflow-y:auto;min-height:0}
.md-app .docslist{display:flex;flex-direction:column;gap:6px;overflow-y:auto;min-height:0}
.md-app .doc{background:var(--panel);border:1px solid var(--border);border-radius:9px;padding:8px 11px;font-size:13px;cursor:pointer;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.md-app .doc.active{border-color:var(--accent);background:rgba(79,140,255,.08)}
.md-app .doc .when{font-size:11px;color:var(--muted)}
.md-app .ed{flex:1;display:flex;flex-direction:column;gap:8px;min-width:0}
.md-app .edhead{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.md-app textarea{background:var(--bg);border:1px solid var(--border);border-radius:9px;color:var(--text);font-family:'JetBrains Mono',ui-monospace,monospace;font-size:13px;padding:10px 12px;min-height:46vh;resize:vertical;outline:none;width:100%}
.md-app textarea:focus{border-color:var(--accent)}
.md-app .preview{background:var(--bg);border:1px solid var(--border);border-radius:9px;padding:12px 16px;min-height:46vh;font-size:13.5px;line-height:1.6;overflow-wrap:break-word}
.md-app .preview h1,.md-app .preview h2,.md-app .preview h3{margin:0.8em 0 0.3em;line-height:1.2}
.md-app .preview code{background:var(--panel2);border-radius:5px;padding:1px 5px;font-family:'JetBrains Mono',ui-monospace,monospace;font-size:12px}
.md-app .preview pre{background:var(--panel2);border-radius:8px;padding:10px;overflow-x:auto}
.md-app .preview pre code{background:none;padding:0}
.md-app .preview ul,.md-app .preview ol{padding-left:22px;margin:0.4em 0}
.md-app .preview blockquote{border-left:3px solid var(--accent);margin:0.5em 0;padding:2px 12px;color:var(--muted)}
.md-app .preview hr{border:none;border-top:1px solid var(--border);margin:1em 0}
.md-app .preview a{color:var(--accent)}
.md-app .mini{background:var(--panel2);border:1px solid var(--border);border-radius:7px;color:var(--text);font-size:12px;padding:5px 10px}
.md-app .mini:hover{border-color:var(--accent)}
.md-app .mini.del:hover{border-color:var(--err);color:var(--err)}
.md-app .save{background:linear-gradient(135deg,var(--accent),var(--accent2));border:none;border-radius:8px;color:#fff;font-weight:600;padding:7px 12px}
.md-app .save:hover{filter:brightness(1.1)}
.md-app .saved{color:var(--ok);font-size:12px;margin-left:auto}
.md-app .empty{color:var(--muted);font-size:13px;text-align:center;padding:40px 0;flex:1}
.md-app input{background:var(--bg);border:1px solid var(--border);border-radius:7px;color:var(--text);padding:6px 10px;font:inherit;outline:none}
.md-app .hint{color:var(--muted);font-size:12px}
.md-app .sharedbox{display:flex;flex-direction:column;gap:6px}
`;

function el(tag, cls, text) { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function newId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
  const hx = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${hx.slice(0, 8)}-${hx.slice(8, 12)}-${hx.slice(12, 16)}-${hx.slice(16, 20)}-${hx.slice(20)}`;
}

function relTime(t, locale, ts, now) {
  const d = Math.max(0, (now || Date.now()) - ts);
  const m = Math.floor(d / 60000);
  if (m < 1) return t('markdown.relNow');
  if (m < 60) return t('markdown.relMin', { n: m });
  const h = Math.floor(m / 60);
  if (h < 24) return t('markdown.relHour', { n: h });
  const j = Math.floor(h / 24);
  if (j < 7) return t('markdown.relDay', { n: j });
  return new Date(ts).toLocaleDateString(locale, { day: 'numeric', month: 'numeric', year: 'numeric' });
}

function mdRender(src) {
  let html = escapeHtml(src);
  const blocks = [];
  // Placeholder avec entropie aléatoire : impossible à collisionner avec le contenu.
  const nonce = Array.from(crypto.getRandomValues(new Uint8Array(8))).map((b) => b.toString(16).padStart(2, '0')).join('');
  const token = (i) => `\u0000MD-${nonce}-${i}\u0000`;
  html = html.replace(/```([\s\S]*?)```/g, (_, c) => { blocks.push('<pre><code>' + c + '</code></pre>'); return token(blocks.length - 1); });
  html = html.split('\n').map((line) => {
    if (line.indexOf('\u0000MD-' + nonce) !== -1) return line;
    line = line.replace(/`([^`]+)`/g, '<code>$1</code>');
    line = line.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    line = line.replace(/\*(.+?)\*/g, '<em>$1</em>');
    line = line.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, label, url) => {
      const cleanUrl = url.replace(/&amp;/g, '&');
      if (!/^(https?:|mailto:|#|\/)/i.test(cleanUrl)) return m;
      return '<a href="' + url + '" target="_blank" rel="noopener">' + label + '</a>';
    });
    return line;
  }).join('\n');
  html = html.replace(/^###### (.*)$/gm, '<h6>$1</h6>').replace(/^##### (.*)$/gm, '<h5>$1</h5>')
             .replace(/^#### (.*)$/gm, '<h4>$1</h4>').replace(/^### (.*)$/gm, '<h3>$1</h3>')
             .replace(/^## (.*)$/gm, '<h2>$1</h2>').replace(/^# (.*)$/gm, '<h1>$1</h1>');
  html = html.replace(/^\s*- (.+)$/gm, '<li>$1</li>');
  html = html.replace(/^\s*\d+\. (.+)$/gm, '<li>$1</li>');
  html = html.replace(/((?:<li>.*<\/li>\n?)+)/g, '<ul>$1</ul>');
  html = html.replace(/^\s*&gt; (.*)$/gm, '<blockquote>$1</blockquote>');
  html = html.replace(/^-{3,}$/gm, '<hr>');
  html = html.replace(new RegExp('\u0000MD-' + nonce + '-(\\d+)\u0000', 'g'), (_, i) => blocks[+i]);
  html = html.split(/\n{2,}/).map((block) => (/^\s*<(ul|ol|blockquote|pre|h[1-6]|hr)/.test(block) ? block : '<p>' + block.replace(/\n/g, '<br>') + '</p>')).join('\n');
  return html;
}

const USBosApp = {
  id: 'markdown',
  async mount(ctx, stage) {
    stage.append(el('style', null, STYLE));
    const t = ctx.i18n.t;
    const locale = ctx.i18n.locale;

    let data;
    try { data = await ctx.fs.readJSON(STATE_FILE); } catch { /* premier lancement */ }
    if (!data || !Array.isArray(data.docs)) data = { docs: [] };
    let current = null;
    let preview = false;

    const saved = el('span', 'saved');
    const docsPane = el('div', 'docs');
    const searchIn = el('input'); searchIn.placeholder = t('markdown.searchPh'); searchIn.setAttribute('aria-label', t('markdown.searchAria'));
    const docsList = el('div', 'docslist');
    docsPane.append(searchIn, docsList);
    const titleIn = el('input'); titleIn.placeholder = t('markdown.titlePh');
    const editor = el('textarea'); editor.placeholder = t('markdown.editorPh');
    const previewEl = el('div', 'preview');
    const newBtn = el('button', 'mini', t('markdown.new'));
    const saveBtn = el('button', 'save', t('markdown.save'));
    const prevBtn = el('button', 'mini', t('markdown.preview'));
    const delBtn = el('button', 'mini del', t('markdown.delete'));
    const expBtn = el('button', 'mini', t('markdown.exportMd'));
    expBtn.onclick = async () => {
      if (!current) return;
      const d = data.docs.find((x) => x.id === current);
      if (!d) return;
      const safe = (d.name || t('markdown.defaultName')).replace(/[<>:"|?*\\/]+/g, '-').slice(0, 100) || t('markdown.defaultName');
      try {
        const _expBytes = new TextEncoder().encode(d.content || '').length;
        if (_expBytes > 2 * 1024 * 1024) {
          saved.textContent = t('markdown.exportFailed', { error: String(locale || '').toLowerCase().startsWith('en') ? '2 MB max' : '2 Mo max' });
          ctx.ui.log('markdown: export refusé (>2 Mo)');
          return;
        }
        await ctx.fs.writeSharedText(`${safe}.md`, d.content || '');
        saved.textContent = t('markdown.exportedTo', { name: `${safe}.md` });
        ctx.ui.log(`markdown: export ${safe}.md`);
        ctx.ui.toast(t('markdown.exportedToast', { name: `${safe}.md` }));
      } catch (err) {
        saved.textContent = t('markdown.exportFailed', { error: err.message });
      }
    };

    async function persist() {
      try {
        const _bytes = new TextEncoder().encode(JSON.stringify(data)).length;
        if (_bytes > 2 * 1024 * 1024) {
          saved.textContent = t('markdown.saveFailed', { error: String(locale || '').toLowerCase().startsWith('en') ? '2 MB max' : '2 Mo max' });
          ctx.ui.log('markdown: quota 2 Mo dépassé, persist refusé');
          return;
        }
        await ctx.fs.writeJSON(STATE_FILE, data);
        saved.textContent = t('markdown.savedAt', { time: new Date().toLocaleTimeString(locale) });
        ctx.ui.log(`markdown: ${data.docs.length} doc(s) écrits`);
      } catch (err) {
        saved.textContent = t('markdown.saveFailed', { error: err.message });
        ctx.ui.log(`markdown: échec persist (${err.message})`);
      }
    }

    function renderList() {
      docsList.innerHTML = '';
      const q = searchIn.value.trim().toLowerCase();
      const shown = q
        ? data.docs.filter((d) => `${d.name || ''}\n${d.content || ''}`.toLowerCase().includes(q))
        : data.docs;
      if (q && shown.length === 0) docsList.append(el('div', 'empty', t('markdown.noResult')));
      if (data.docs.length === 0) {
        docsList.append(el('div', 'empty', t('markdown.empty')));
        docsList.append(el('button', 'mini', t('markdown.firstDoc')));
        docsList.lastChild.onclick = () => newBtn.click();
      }
      for (const d of shown) {
        const b = el('div', 'doc' + (d.id === current ? ' active' : ''));
        b.append(el('div', null, d.name || t('markdown.noname')));
        if (d.updated) b.append(el('div', 'when', relTime(t, locale, d.updated)));
        b.onclick = () => select(d.id);
        docsList.append(b);
      }
    }

    function select(id) {
      const d = data.docs.find((x) => x.id === id);
      if (!d) return;
      current = id; titleIn.value = d.name; editor.value = d.content;
      previewEl.innerHTML = mdRender(d.content);
      renderList();
    }

    function renderEditor() {
      if (preview) { editor.hidden = true; previewEl.hidden = false; previewEl.innerHTML = mdRender(editor.value); }
      else { editor.hidden = false; previewEl.hidden = true; }
    }

    // Création inline (pas de prompt() natif : bloquant et soumis à allow-modals).
    const nameRow = el('div', 'edhead');
    const nameIn = el('input'); nameIn.placeholder = t('markdown.createPh'); nameIn.hidden = true;
    const nameOk = el('button', 'save', t('markdown.create')); nameOk.hidden = true;
    const nameCancel = el('button', 'mini', t('markdown.cancel')); nameCancel.hidden = true;
    nameRow.append(nameIn, nameOk, nameCancel);
    nameCancel.onclick = () => { nameIn.hidden = true; nameOk.hidden = true; nameCancel.hidden = true; newBtn.hidden = false; };

    newBtn.onclick = () => {
      nameIn.value = t('markdown.defaultName') + '-' + (data.docs.length + 1);
      nameIn.hidden = false; nameOk.hidden = false; nameCancel.hidden = false; newBtn.hidden = true;
      nameIn.focus(); nameIn.select();
    };
    nameOk.onclick = async () => {
      const name = (nameIn.value.trim() || t('markdown.defaultTitle')).slice(0, 200);
      data.docs.unshift({ id: newId(), name, content: '# ' + name + '\n', updated: Date.now() });
      nameIn.hidden = true; nameOk.hidden = true; nameCancel.hidden = true; newBtn.hidden = false;
      await persist();
      select(data.docs[0].id);
    };
    nameIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') nameOk.click(); if (e.key === 'Escape') nameCancel.click(); });
    saveBtn.onclick = async () => {
      if (!current) return;
      const d = data.docs.find((x) => x.id === current);
      if (d) { d.name = titleIn.value.trim().slice(0, 200) || d.name; d.content = editor.value.slice(0, 500000); d.updated = Date.now(); }
      await persist(); renderList();
    };
    prevBtn.onclick = () => { preview = !preview; prevBtn.textContent = preview ? t('markdown.edit') : t('markdown.preview'); renderEditor(); };
    // Suppression en deux temps (pas de confirm() natif).
    let armDelete = false;
    let armTimer = null;
    let previewTimer = null;
    delBtn.onclick = async () => {
      if (!current) return;
      if (!armDelete) {
        armDelete = true;
        delBtn.textContent = t('markdown.confirmDelete');
        armTimer = setTimeout(() => { armDelete = false; delBtn.textContent = t('markdown.delete'); }, 4000);
        return;
      }
      clearTimeout(armTimer); armDelete = false; delBtn.textContent = t('markdown.delete');
      data.docs = data.docs.filter((x) => x.id !== current);
      current = null; titleIn.value = ''; editor.value = '';
      await persist(); renderList(); renderEditor();
      ctx.ui.toast(t('markdown.deleted'));
    };
    editor.addEventListener('input', () => {
      if (!preview) return;
      clearTimeout(previewTimer);
      previewTimer = setTimeout(() => {
        if (preview) previewEl.innerHTML = mdRender(editor.value.slice(0, 500000));
      }, 150);
    });
    searchIn.addEventListener('input', renderList);
    searchIn.addEventListener('keydown', (e) => { if (e.key === 'Escape') { searchIn.value = ''; renderList(); } });
    const onDoc = (e) => {
      if (e.key === '/' && !/^(INPUT|TEXTAREA)$/.test(document.activeElement && document.activeElement.tagName || '')) {
        e.preventDefault(); searchIn.focus();
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        if (!nameOk.hidden) nameOk.click(); else saveBtn.click();
      }
    };
    document.addEventListener('keydown', onDoc);
    try { this._mdCleanup = () => { clearTimeout(armTimer); clearTimeout(previewTimer); document.removeEventListener('keydown', onDoc); }; } catch { /* noop */ }

    const edhead = el('div', 'edhead');
    const sharedBox = el('div', 'sharedbox'); sharedBox.hidden = true;
    const fromSharedBtn = el('button', 'mini', t('markdown.fromShared'));
    fromSharedBtn.onclick = async () => {
      sharedBox.innerHTML = '';
      sharedBox.hidden = false;
      let files;
      try {
        files = await ctx.fs.listShared('');
      } catch (err) {
        saved.textContent = t('markdown.importFailed', { error: err.message });
        ctx.ui.toast(t('shell.settings.sharedNoAccess'));
        return;
      }
      const mds = (Array.isArray(files) ? files : [])
        .filter((f) => f && f.kind === 'file' && String(f.name || '').toLowerCase().endsWith('.md'))
        .slice(0, 20);
      if (mds.length === 0) { sharedBox.append(el('div', 'empty', t('markdown.sharedNone'))); return; }
      for (const f of mds) {
        const row = el('div', 'edhead');
        row.append(el('div', null, String(f.name || '').slice(0, 200)));
        const imp = el('button', 'mini', t('markdown.importBtn'));
        imp.onclick = async () => {
          try {
            const text = await ctx.fs.readSharedText(f.name);
            const base = String(f.name || '').replace(/\.md$/i, '').slice(0, 200) || t('markdown.defaultTitle');
            data.docs.unshift({ id: newId(), name: base, content: String(text || '').slice(0, 500000), updated: Date.now() });
            await persist();
            select(data.docs[0].id);
            saved.textContent = t('markdown.imported', { name: String(f.name || '') });
            ctx.ui.toast(t('markdown.imported', { name: String(f.name || '') }));
            ctx.ui.log(`markdown: import ${f.name}`);
            sharedBox.hidden = true; sharedBox.innerHTML = '';
          } catch (err) {
            saved.textContent = t('markdown.importFailed', { error: err.message });
            ctx.ui.toast(t('markdown.importFailed', { error: err.message }));
          }
        };
        row.append(imp);
        sharedBox.append(row);
      }
    };
    edhead.append(newBtn, titleIn, saveBtn, prevBtn, expBtn, fromSharedBtn, delBtn, saved);
    const helpLine = el('div', 'hint', t('markdown.helpLine'));
    const ed = el('div', 'ed');
    ed.append(edhead, helpLine, sharedBox, nameRow, editor, previewEl);

    const wrap = el('div', 'md-app');
    wrap.append(docsPane, ed);
    stage.append(wrap);

    if (data.docs.length > 0) select(data.docs[0].id);
    renderList();
    renderEditor();
  },
  async unmount() { if (this && this._mdCleanup) { try { this._mdCleanup(); } catch { /* noop */ } this._mdCleanup = null; } },
}
return USBosApp;
