/*
 * USBos app: coffre — gestionnaire d'identifiants.
 * Le chiffrement (AES-GCM via WebCrypto, clé dérivée PBKDF2 d'une passphrase
 * saisie dans l'app) est entièrement géré ici : le kernel ne connaît jamais
 * la passphrase ni les données en clair. Le fichier binaire est stocké via
 * ctx.fs.writeBinary — illisible sans la passphrase.
 */
const VAULT_FILE = 'coffre.bin';
const SALT_FILE = 'coffre.salt';

const STYLE = `
.coffre-app{width:100%;flex:1;min-height:0}
.coffre-app h2{font-size:17px;margin-bottom:2px}
.coffre-app .hint{color:var(--muted);font-size:12px;margin-bottom:14px}
.coffre-app .notice{background:var(--panel);border:1px solid var(--warn);border-radius:12px;padding:14px;font-size:13px;color:var(--warn);margin-bottom:14px}
.coffre-app .unlockform{display:flex;gap:8px;background:var(--panel);border:1px solid var(--border);border-radius:12px;padding:14px;margin-bottom:14px}
.coffre-app .unlockform input{flex:1;background:var(--bg);border:1px solid var(--border);border-radius:8px;color:var(--text);padding:9px 11px;font:inherit;outline:none}
.coffre-app .saved{color:var(--ok);font-size:12px}
.coffre-app form.entry{display:flex;flex-direction:column;gap:8px;background:var(--panel);border:1px solid var(--border);border-radius:12px;padding:12px;margin-bottom:14px}
.coffre-app form.entry input,.coffre-app form.entry textarea{background:var(--bg);border:1px solid var(--border);border-radius:8px;color:var(--text);padding:9px 11px;font:inherit;outline:none}
.coffre-app form.entry textarea{min-height:64px;resize:vertical}
.coffre-app .row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.coffre-app .save{background:linear-gradient(135deg,var(--accent),var(--accent2));border:none;border-radius:8px;color:#fff;font-weight:600;padding:8px 14px}
.coffre-app .save:hover{filter:brightness(1.1)}
.coffre-app .mini{background:var(--panel2);border:1px solid var(--border);border-radius:7px;color:var(--text);font-size:12px;padding:5px 10px}
.coffre-app .mini:hover{border-color:var(--accent)}
.coffre-app .mini.del:hover{border-color:var(--err);color:var(--err)}
.coffre-app .list{display:flex;flex-direction:column;gap:8px}
.coffre-app .ent{background:var(--panel);border:1px solid var(--border);border-radius:10px;padding:12px 14px}
.coffre-app .ent .t{display:flex;justify-content:space-between;gap:10px;align-items:center;margin-bottom:6px}
.coffre-app .kv{display:flex;gap:10px;align-items:center;font-size:13px;margin:3px 0;flex-wrap:wrap}
.coffre-app .kv .k{color:var(--muted);min-width:70px}
.coffre-app .kv .v{font-family:'JetBrains Mono',ui-monospace,monospace;word-break:break-all}
.coffre-app .empty{color:var(--muted);font-size:12.5px;text-align:center;padding:22px 0}
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

async function deriveKey(passphrase, saltBytes) {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey('raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: saltBytes, iterations: 210000, hash: 'SHA-256' },
    keyMaterial, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
  );
}

async function encryptJSON(key, obj) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new TextEncoder().encode(JSON.stringify(obj));
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data);
  const out = new Uint8Array(iv.length + cipher.byteLength);
  out.set(iv, 0); out.set(new Uint8Array(cipher), iv.length);
  return out.buffer;
}

async function decryptJSON(key, buffer) {
  const bytes = new Uint8Array(buffer);
  const iv = bytes.slice(0, 12);
  const cipher = bytes.slice(12);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, cipher);
  return JSON.parse(new TextDecoder().decode(plain));
}

const USBosApp = {
  id: 'coffre',
  async mount(ctx, stage) {
    stage.append(el('style', null, STYLE));
    const t = ctx.i18n.t;
    const tp = ctx.i18n.tp;
    const locale = ctx.i18n.locale;
    const self = this;
    try { self._coffreCleanup = null; } catch { /* noop */ }
    const wrap = el('div', 'coffre-app');
    wrap.append(el('h2', null, t('coffre.title')), el('p', 'hint', t('coffre.hint')));
    stage.append(wrap);

    let salt;
    if (await ctx.fs.exists(SALT_FILE)) {
      salt = new Uint8Array(await ctx.fs.readBinary(SALT_FILE));
      if (salt.length < 16) {
        salt = crypto.getRandomValues(new Uint8Array(16));
        await ctx.fs.writeBinary(SALT_FILE, salt.buffer);
      }
    } else {
      salt = crypto.getRandomValues(new Uint8Array(16));
      await ctx.fs.writeBinary(SALT_FILE, salt.buffer);
    }

    const unlockBox = el('div');
    wrap.append(unlockBox);
    // Note : les données du coffre sont chiffrées DEUX fois (couche noyau
    // AES-GCM via la passphrase maître + couche coffre via sa propre
    // passphrase). Le noyau voit le blob doublement chiffré, jamais le clair.

    async function renderUnlock() {
      unlockBox.innerHTML = '';
      // Recalculé à chaque affichage (pas capturé au mount) : sinon, après
      // création puis verrouillage dans la même session, l'écran proposerait
      // "Créer" et accepterait n'importe quelle passphrase sur un coffre
      // existant — avec risque d'écrasement des données.
      const hasVaultNow = await ctx.fs.exists(VAULT_FILE);
      const form = el('div', 'unlockform');
      const pass = el('input'); pass.type = 'password';
      pass.autocomplete = 'current-password';
      pass.placeholder = hasVaultNow ? t('coffre.passExisting') : t('coffre.passNew');
      const btn = el('button', 'save', hasVaultNow ? t('coffre.unlock') : t('coffre.create'));
      const notice = el('div', 'notice'); notice.hidden = true;
      btn.onclick = async () => {
        notice.hidden = true; notice.textContent = '';
        if (!pass.value) return;
        btn.disabled = true;
        try {
          const key = await deriveKey(pass.value, salt);
          pass.value = '';
          let entries = [];
          if (hasVaultNow) {
            const buf = await ctx.fs.readBinary(VAULT_FILE);
            entries = await decryptJSON(key, buf);
            if (!Array.isArray(entries)) throw new Error('corrompu');
          }
          unlockBox.innerHTML = '';
          renderVault(key, entries);
        } catch (err) {
          ctx.ui.log(`coffre: échec de déverrouillage (${err.message})`, 'e');
          notice.textContent = t('coffre.badPass');
          notice.hidden = false;
        } finally {
          btn.disabled = false;
        }
      };
      pass.addEventListener('keydown', (e) => { if (e.key === 'Enter') btn.click(); });
      form.append(pass, btn);
      unlockBox.append(form, notice);
    }

    function renderVault(key, entries) {
      let editingId = null;
      let locked = false;
      const saved = el('div', 'saved');
      const list = el('div', 'list');
      const delTimers = new Set();
      const showTimers = new Set();

      async function persist() {
        try {
          const buf = await encryptJSON(key, entries);
          if (buf.byteLength > 25 * 1024 * 1024) {
            const _msg = t('coffre.tooBig');
            saved.textContent = _msg;
            try { ctx.ui.toast(_msg); } catch { /* noop */ }
            ctx.ui.log('coffre: quota 25 Mo dépassé, persist refusé');
            return;
          }
          await ctx.fs.writeBinary(VAULT_FILE, buf);
          saved.textContent = tp('coffre.savedAt', entries.length, { time: new Date().toLocaleTimeString(locale) });
          ctx.ui.log('coffre: coffre.bin réécrit (chiffré)');
        } catch (err) {
          saved.textContent = t('coffre.saveFailed', { error: err.message });
          ctx.ui.log('coffre: échec persist (' + err.message + ')');
        }
      }

      async function lock() {
        if (locked) return;
        locked = true;
        try { for (const tm of delTimers) clearTimeout(tm); } catch { /* noop */ }
        try { delTimers.clear(); } catch { /* noop */ }
        try { for (const tm of showTimers) clearTimeout(tm); } catch { /* noop */ }
        try { showTimers.clear(); } catch { /* noop */ }
        try { if (onDoc) document.removeEventListener('keydown', onDoc); } catch { /* noop */ }
        try { entries.length = 0; } catch { entries = []; }
        try { key = null; } catch { /* noop */ }
        editingId = null;
        try { nameIn.value = ''; loginIn.value = ''; pwdIn.value = ''; noteIn.value = ''; } catch { /* noop */ }
        wrap.querySelectorAll('form.entry, .list, .saved, .search, .lock-btn').forEach((n) => n.remove());
        try { await renderUnlock(); }
        catch (err) { ctx.ui.log('coffre: verrouillage incomplet (' + err.message + ')'); }
      }
      const lockBtn = el('button', 'mini lock-btn', t('coffre.lock'));
      lockBtn.onclick = lock;
      wrap.append(lockBtn);

      const searchIn = el('input', 'search'); searchIn.placeholder = t('coffre.searchPh'); searchIn.setAttribute('aria-label', t('coffre.searchAria'));
      searchIn.addEventListener('input', renderList);
      searchIn.addEventListener('keydown', (e) => { if (e.key === 'Escape') { searchIn.value = ''; renderList(); } });

      const nameIn = el('input'); nameIn.placeholder = t('coffre.namePh');
      const loginIn = el('input'); loginIn.placeholder = t('coffre.loginPh');
      const pwdIn = el('input'); pwdIn.type = 'password'; pwdIn.placeholder = t('coffre.pwdPh');
      const noteIn = el('textarea'); noteIn.placeholder = t('coffre.notePh');
      const saveBtn = el('button', 'save', t('coffre.add')); saveBtn.type = 'button';
      const onDoc = (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
          e.preventDefault();
          if (!locked) saveBtn.click();
          return;
        }
        if (e.key === '/' && !/^(INPUT|TEXTAREA)$/.test(document.activeElement && document.activeElement.tagName || '')) {
          e.preventDefault(); searchIn.focus();
        }
      };
      document.addEventListener('keydown', onDoc);
      try {
        self._coffreCleanup = async () => {
          try { for (const tm of delTimers) clearTimeout(tm); } catch { /* noop */ }
          try { delTimers.clear(); } catch { /* noop */ }
          try { for (const tm of showTimers) clearTimeout(tm); } catch { /* noop */ }
          try { showTimers.clear(); } catch { /* noop */ }
          try { document.removeEventListener('keydown', onDoc); } catch { /* noop */ }
          try { await lock(); } catch { /* noop */ }
          try { self._coffreCleanup = null; } catch { /* noop */ }
        };
      } catch { /* noop */ }
      const helpLine = el('p', 'hint', t('coffre.helpLine'));
      wrap.append(searchIn, helpLine);

      function renderList() {
        list.innerHTML = '';
        // Recherche sur nom + identifiant UNIQUEMENT (jamais mot de passe ni note).
        const q = searchIn.value.trim().toLowerCase();
        const shown = q
          ? entries.filter((e) => `${e.name || ''}\n${e.login || ''}`.toLowerCase().includes(q))
          : entries;
        if (entries.length === 0) { list.append(el('div', 'empty', t('coffre.empty'))); return; }
        if (shown.length === 0) { list.append(el('div', 'empty', t('coffre.noResult'))); return; }
        for (const e of shown) {
          const card = el('div', 'ent');
          const head = el('div', 't');
          head.append(el('b', null, e.name || t('coffre.noname')));
          const ops = el('div', 'row');
          const edit = el('button', 'mini', t('coffre.edit'));
          edit.onclick = () => {
            editingId = e.id; nameIn.value = e.name; loginIn.value = e.login;
            pwdIn.value = e.password; noteIn.value = e.note || '';
            saveBtn.textContent = t('coffre.saveEdit');
          };
          const del = el('button', 'mini del', t('coffre.delete'));
          let armDel = null;
          del.onclick = async () => {
          if (armDel) {
            clearTimeout(armDel); delTimers.delete(armDel); armDel = null;
            entries = entries.filter((x) => x.id !== e.id); await persist(); renderList();
            ctx.ui.toast(t('coffre.deleted'));
            return;
          }
            del.textContent = t('coffre.sure');
            armDel = setTimeout(() => { delTimers.delete(armDel); armDel = null; del.textContent = t('coffre.delete'); }, 4000);
            delTimers.add(armDel);
          };
          ops.append(edit, del);
          head.append(ops);
          card.append(head);
          const kvLogin = el('div', 'kv');
          kvLogin.append(el('span', 'k', t('coffre.loginLabel')), el('span', 'v', e.login || '—'));
          const kvPwd = el('div', 'kv');
          const pwdVal = el('span', 'v', '••••••••');
          const showBtn = el('button', 'mini', '👁');
          showBtn.title = t('coffre.showTitle');
          let showTimer = null;
          showBtn.onclick = () => {
            if (pwdVal.textContent !== '••••••••') {
              pwdVal.textContent = '••••••••'; showBtn.textContent = '👁';
              if (showTimer) { clearTimeout(showTimer); showTimers.delete(showTimer); showTimer = null; }
              return;
            }
            pwdVal.textContent = e.password || '—'; showBtn.textContent = '🙈';
            if (showTimer) { clearTimeout(showTimer); showTimers.delete(showTimer); }
            showTimer = setTimeout(() => { pwdVal.textContent = '••••••••'; showBtn.textContent = '👁'; showTimers.delete(showTimer); showTimer = null; }, 30000);
            showTimers.add(showTimer);
          };
          const copyBtn = el('button', 'mini', t('toolbox.copy'));
          copyBtn.onclick = async () => {
            const v = e.password || '';
            try {
              if (navigator.clipboard && window.isSecureContext !== false) {
                await navigator.clipboard.writeText(v);
              } else {
                const ta = document.createElement('textarea');
                ta.value = v; document.body.append(ta); ta.select();
                document.execCommand('copy'); ta.remove();
              }
              copyBtn.textContent = t('toolbox.copied'); setTimeout(() => { copyBtn.textContent = t('toolbox.copy'); }, 1200);
            } catch { copyBtn.textContent = t('toolbox.copyFailed'); }
          };
          kvPwd.append(el('span', 'k', t('coffre.pwdLabel')), pwdVal, showBtn, copyBtn);
          card.append(kvLogin, kvPwd);
          if (e.note) card.append(el('div', 'hint', e.note));
          list.append(card);
        }
      }

      saveBtn.onclick = async () => {
        if (locked) return;
        const name = nameIn.value.trim().slice(0, 200);
        if (!name) return;
        if (editingId != null) {
          const e = entries.find((x) => x.id === editingId);
          if (e) Object.assign(e, { name, login: loginIn.value.slice(0, 500), password: pwdIn.value.slice(0, 1000), note: noteIn.value.slice(0, 2000) });
          editingId = null; saveBtn.textContent = t('coffre.add');
        } else {
          entries.push({ id: newId(), name, login: loginIn.value.slice(0, 500), password: pwdIn.value.slice(0, 1000), note: noteIn.value.slice(0, 2000) });
        }
        nameIn.value = ''; loginIn.value = ''; pwdIn.value = ''; noteIn.value = '';
        await persist(); renderList();
      };

      const form = el('form', 'entry');
      form.onsubmit = (e) => { e.preventDefault(); saveBtn.click(); };
      form.append(nameIn, loginIn, pwdIn, noteIn, saveBtn);
      wrap.append(form, list, saved);
      renderList();
    }

    renderUnlock();
  },
  async unmount() { if (this && this._coffreCleanup) { try { await this._coffreCleanup(); } catch { /* noop */ } this._coffreCleanup = null; } },
}
return USBosApp;
