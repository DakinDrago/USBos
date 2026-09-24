/* USBos app template — TODO: rename id, wire your state, delete this comment.
 * Rules recap (see ../contract.md): classic script, top-level `return`
 * at the end; CSS variables only; no prompt()/confirm(); clean up in
 * unmount(); data: is yours, shared: is public plaintext.
 */
const STATE_FILE = 'state.json';

const STYLE = `
.my-app{width:100%;flex:1;min-height:0;display:flex;flex-direction:column;gap:10px}
.my-app h2{font-size:17px}
.my-app .hint{color:var(--muted);font-size:12px}
.my-app .toolbar{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.my-app .search{flex:1;min-width:140px}
.my-app input,.my-app textarea{background:var(--bg);border:1px solid var(--border);border-radius:8px;color:var(--text);padding:9px 11px;font:inherit;outline:none;width:100%}
.my-app input:focus,.my-app textarea:focus{border-color:var(--accent)}
.my-app .list{display:flex;flex-direction:column;gap:8px}
.my-app .card{background:var(--panel);border:1px solid var(--border);border-radius:10px;padding:10px 12px;display:flex;gap:10px;align-items:center}
.my-app .card .t{font-weight:600;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.my-app .mini{background:var(--panel2);border:1px solid var(--border);border-radius:7px;color:var(--text);font-size:12px;padding:5px 10px}
.my-app .mini:hover{border-color:var(--accent)}
.my-app .mini.del:hover{border-color:var(--err);color:var(--err)}
.my-app .save{background:linear-gradient(135deg,var(--accent),var(--accent2));border:none;border-radius:8px;color:#fff;font-weight:600;padding:8px 14px}
.my-app .saved{color:var(--ok);font-size:12px}
.my-app .empty{color:var(--muted);font-size:12.5px;text-align:center;padding:22px 0}
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
  id: 'my-app', // TODO: must equal manifest id + folder name

  async mount(ctx, stage) {
    stage.append(Object.assign(document.createElement('style'), { textContent: STYLE }));
    // i18n (obligatoire avant de publier) : remplacez chaque chaîne visible
    // par ctx.i18n.t('<votre-id>.<clé>') (+ FR/EN dans USBos/system/lang/*.json).
    // Voir ../contract.md (`ctx.i18n`) et `python tools/validate-lang.py`.

    let items = [];
    try {
      const loaded = await ctx.fs.readJSON(STATE_FILE);
      if (Array.isArray(loaded)) items = loaded;
    } catch { /* first run: start empty */ }

    const saved = el('div', 'saved');
    const titleIn = el('input'); titleIn.placeholder = 'New item…'; titleIn.setAttribute('aria-label', 'New item');
    const addBtn = el('button', 'save', 'Add'); addBtn.type = 'button';
    const searchIn = el('input', 'search'); searchIn.placeholder = 'Search… ( / )'; searchIn.setAttribute('aria-label', 'Search items');
    const list = el('div', 'list');

    async function persist() {
      try {
        await ctx.fs.writeJSON(STATE_FILE, items);
        saved.textContent = 'Saved ' + new Date().toLocaleTimeString();
      } catch (err) {
        saved.textContent = 'Save failed: ' + err.message;
        ctx.ui.log(`my-app: persist failed (${err.message})`, 'e');
      }
    }

    function renderList() {
      list.innerHTML = '';
      const q = searchIn.value.trim().toLowerCase();
      const shown = q
        ? items.filter((it) => `${it.title || ''}`.toLowerCase().includes(q))
        : items;
      if (items.length === 0) {
        const box = el('div', 'empty');
        box.append(el('div', null, 'Nothing here yet.'));
        const cta = el('button', 'save', '+ Create my first item'); cta.type = 'button';
        cta.onclick = () => titleIn.focus();
        box.append(cta);
        list.append(box);
        return;
      }
      if (!shown.length) { list.append(el('div', 'empty', 'No results.')); return; }
      for (const it of shown) {
        const card = el('div', 'card');
        card.append(el('span', 't', it.title || '(untitled)'));
        const del = el('button', 'mini del', 'Delete');
        let armed = null;
        del.onclick = async () => {
          if (armed) {
            clearTimeout(armed); armed = null;
            items = items.filter((x) => x.id !== it.id);
            await persist(); renderList();
            ctx.ui.toast('Deleted.');
            return;
          }
          del.textContent = 'Sure?';
          armed = setTimeout(() => { armed = null; del.textContent = 'Delete'; }, 4000);
        };
        card.append(del);
        list.append(card);
      }
    }

    addBtn.onclick = async () => {
      const title = titleIn.value.trim().slice(0, 200);
      if (!title) return;
      items.unshift({ id: newId(), title, created: Date.now() });
      titleIn.value = '';
      await persist(); renderList();
    };

    searchIn.addEventListener('input', renderList);
    searchIn.addEventListener('keydown', (e) => { if (e.key === 'Escape') { searchIn.value = ''; renderList(); } });
    document.addEventListener('keydown', (e) => {
      if (e.key === '/' && !/^(INPUT|TEXTAREA)$/.test((document.activeElement && document.activeElement.tagName) || '')) {
        e.preventDefault(); searchIn.focus();
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); addBtn.click(); }
    });

    const toolbar = el('div', 'toolbar');
    toolbar.append(titleIn, addBtn);
    const wrap = el('div', 'my-app');
    wrap.append(
      el('h2', null, 'My App'), // TODO: rename
      el('p', 'hint', 'TODO: one-line usage hint.'),
      toolbar, searchIn, saved, list
    );
    stage.append(wrap);
    renderList();
  },

  async unmount() { /* nothing global: iframe-scoped listeners die with it */ },
};
return USBosApp;
