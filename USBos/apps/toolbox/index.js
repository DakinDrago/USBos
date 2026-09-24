/* USBos app: toolbox — porté depuis le module original, adapté au contrat v2. */
const PREFS_FILE = 'toolbox.json';

const STYLE = `
.toolbox-app{width:100%;flex:1;min-height:0}
.toolbox-app h2{font-size:17px;margin-bottom:2px}
.toolbox-app .hint{color:var(--muted);font-size:12px;margin-bottom:14px}
.toolbox-app .tabs{display:flex;gap:6px;margin-bottom:14px;flex-wrap:wrap}
.toolbox-app .tab{background:var(--panel2);border:1px solid var(--border);border-radius:8px;color:var(--muted);font-size:13px;padding:7px 13px}
.toolbox-app .tab.active{background:linear-gradient(135deg,var(--accent),var(--accent2));border:none;color:#fff;font-weight:600}
.toolbox-app .panel{background:var(--panel);border:1px solid var(--border);border-radius:12px;padding:14px;display:flex;flex-direction:column;gap:10px}
.toolbox-app label{font-size:12.5px;color:var(--muted)}
.toolbox-app input[type=text],.toolbox-app input[type=number],.toolbox-app textarea,.toolbox-app input[type=range]{background:var(--bg);border:1px solid var(--border);border-radius:8px;color:var(--text);padding:9px 11px;font:inherit;outline:none;width:100%}
.toolbox-app input:focus,.toolbox-app textarea:focus{border-color:var(--accent)}
.toolbox-app textarea{min-height:90px;resize:vertical;font-family:'JetBrains Mono',ui-monospace,monospace;font-size:13px}
.toolbox-app .row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.toolbox-app .row label{display:flex;align-items:center;gap:6px;font-size:12.5px;color:var(--text)}
.toolbox-app input[type=checkbox]{accent-color:var(--accent)}
.toolbox-app .out{background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:10px 12px;font-family:'JetBrains Mono',ui-monospace,monospace;font-size:13px;word-break:break-all;min-height:40px}
.toolbox-app .act{background:linear-gradient(135deg,var(--accent),var(--accent2));border:none;border-radius:8px;color:#fff;font-weight:600;padding:8px 14px}
.toolbox-app .act:hover{filter:brightness(1.1)}
.toolbox-app .mini{background:var(--panel2);border:1px solid var(--border);border-radius:7px;color:var(--text);font-size:12px;padding:5px 10px}
.toolbox-app .mini:hover{border-color:var(--accent)}
`;

function el(tag, props, ...children) {
  const n = document.createElement(tag);
  if (typeof props === 'string') n.className = props;
  else if (props) for (const [k, v] of Object.entries(props)) { if (k === 'class') n.className = v; else if (v != null) n.setAttribute(k, v); }
  for (const c of children.flat()) { if (c == null) continue; n.append(c.nodeType ? c : document.createTextNode(c)); }
  return n;
}

function b64Enc(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
function b64Dec(b64) {
  const bin = atob(b64.trim());
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}
function randInt(max) {
  const limit = Math.floor(256 / max) * max;
  const buf = new Uint8Array(1);
  let x;
  do { crypto.getRandomValues(buf); x = buf[0]; } while (x >= limit);
  return x % max;
}
function genPassword(len, opts) {
  const pools = [];
  if (opts.lower) pools.push('abcdefghijklmnopqrstuvwxyz');
  if (opts.upper) pools.push('ABCDEFGHIJKLMNOPQRSTUVWXYZ');
  if (opts.digits) pools.push('0123456789');
  if (opts.symbols) pools.push('!@#$%^&*()-_=+[]{};:,.?/');
  if (pools.length === 0) return '';
  const chars = pools.join('');
  const out = pools.map((p) => p[randInt(p.length)]);
  while (out.length < len) out.push(chars[randInt(chars.length)]);
  for (let i = out.length - 1; i > 0; i--) { const j = randInt(i + 1); [out[i], out[j]] = [out[j], out[i]]; }
  return out.join('');
}
function humanSize(n, locale) {
  const isEn = String(locale || '').toLowerCase().startsWith('en');
  const units = isEn ? ['B', 'KB', 'MB', 'GB', 'TB'] : ['o', 'Ko', 'Mo', 'Go', 'To'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return n.toFixed(i ? (n < 10 ? 2 : 1) : 0) + ' ' + units[i];
}
function copyBtn(getValue, t) {
  const b = el('button', 'mini', t('toolbox.copy'));
  b.onclick = async () => {
    const v = getValue();
    try {
      if (navigator.clipboard && window.isSecureContext !== false) {
        await navigator.clipboard.writeText(v);
      } else {
        // Repli sans Clipboard API (contexte non sécurisé) : sélection manuelle.
        const ta = document.createElement('textarea');
        ta.value = v; document.body.append(ta); ta.select();
        document.execCommand('copy'); ta.remove();
      }
      b.textContent = t('toolbox.copied'); setTimeout(() => { b.textContent = t('toolbox.copy'); }, 1200);
    } catch { b.textContent = t('toolbox.copyFailed'); }
  };
  return b;
}

const USBosApp = {
  id: 'toolbox',
  async mount(ctx, stage) {
    stage.append(el('style', null, STYLE));
    const t = ctx.i18n.t;
    const locale = ctx.i18n.locale;

    let prefs = { len: 16, lower: true, upper: true, digits: true, symbols: true };
    try { prefs = Object.assign(prefs, await ctx.fs.readJSON(PREFS_FILE)); } catch { /* premier lancement */ }

    const panels = new Map();
    const tabs = el('div', 'tabs');
    const body = el('div');

    function show(id) {
      tabs.innerHTML = '';
      for (const [k, label] of [['pwd', t('toolbox.tabPwd')], ['sha', t('toolbox.tabSha')], ['b64', t('toolbox.tabB64')], ['conv', t('toolbox.tabConv')]]) {
        const b = el('button', 'tab' + (k === id ? ' active' : ''), label);
        b.onclick = () => show(k);
        tabs.append(b);
      }
      body.innerHTML = '';
      body.append(panels.get(id));
    }

    async function persist() { try { await ctx.fs.writeJSON(PREFS_FILE, prefs); } catch (err) { ctx.ui.log('toolbox: prefs non sauvegardées (' + err.message + ')'); } }

    const lenLabel = el('label', null, t('toolbox.lenLabel', { n: prefs.len }));
    const lenIn = el('input'); lenIn.type = 'number'; lenIn.min = 6; lenIn.max = 64; lenIn.value = prefs.len;
    const lenRange = el('input'); lenRange.type = 'range'; lenRange.min = 6; lenRange.max = 64; lenRange.value = prefs.len;
    const applyLen = (v, save) => {
      v = Math.min(64, Math.max(6, parseInt(v, 10) || 16));
      lenIn.value = v; lenRange.value = v; prefs.len = v; lenLabel.textContent = t('toolbox.lenLabel', { n: v });
      if (save) persist();
    };
    lenIn.onchange = () => applyLen(lenIn.value, true);
    lenRange.oninput = () => applyLen(lenRange.value, false);
    lenRange.onchange = () => applyLen(lenRange.value, true);

    const opts = ['lower', 'upper', 'digits', 'symbols'].map((k) => {
      const cb = el('input'); cb.type = 'checkbox'; cb.checked = prefs[k];
      cb.onchange = () => { prefs[k] = cb.checked; persist(); };
      const lbl = el('label', null, cb, document.createTextNode(k === 'lower' ? t('toolbox.optLower') : k === 'upper' ? t('toolbox.optUpper') : k === 'digits' ? t('toolbox.optDigits') : t('toolbox.optSymbols')));
      return lbl;
    });

    const pwdOut = el('div', 'out');
    const genBtn = el('button', 'act', t('toolbox.gen'));
    genBtn.onclick = () => {
      const o = {}; for (const k of ['lower', 'upper', 'digits', 'symbols']) o[k] = prefs[k];
      pwdOut.textContent = genPassword(prefs.len, o);
    };

    const shaIn = el('textarea'); shaIn.placeholder = t('toolbox.shaPh');
    const shaOut = el('div', 'out', '—');
    const shaBtn = el('button', 'act', t('toolbox.shaBtn'));
    shaBtn.onclick = async () => {
      shaBtn.disabled = true;
      try {
        const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(shaIn.value));
        shaOut.textContent = Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
      } finally { shaBtn.disabled = false; }
    };

    const b64In = el('textarea'); b64In.placeholder = t('toolbox.b64Ph');
    const b64Out = el('div', 'out', '—');
    const b64EncBtn = el('button', 'act', t('toolbox.enc'));
    b64EncBtn.onclick = () => { try { b64Out.textContent = b64Enc(b64In.value); } catch { b64Out.textContent = t('toolbox.b64Error'); } };
    const b64DecBtn = el('button', 'mini', t('toolbox.dec'));
    b64DecBtn.onclick = () => {
      try { b64Out.textContent = b64Dec(b64In.value); } catch { b64Out.textContent = t('toolbox.b64Invalid'); }
    };

    const convBytesIn = el('input'); convBytesIn.type = 'number'; convBytesIn.placeholder = t('toolbox.bytesPh');
    const convBytesOut = el('div', 'out', '—');
    convBytesIn.oninput = () => { const v = parseFloat(convBytesIn.value); convBytesOut.textContent = (isNaN(v) || v < 0) ? '—' : t('toolbox.bytesOut', { v, h: humanSize(v, locale) }); };

    const convHexIn = el('input'); convHexIn.placeholder = t('toolbox.hexPh');
    const convHexOut = el('div', 'out', '—');
    convHexIn.oninput = () => {
      const v = convHexIn.value.trim();
      if (!v) { convHexOut.textContent = '—'; return; }
      if (/^0x[0-9a-f]+$/i.test(v)) convHexOut.textContent = v + ' = ' + parseInt(v.slice(2), 16);
      else if (/^\d+$/.test(v)) convHexOut.textContent = v + ' = 0x' + parseInt(v, 10).toString(16);
      else if (/^[0-9a-f]+$/i.test(v)) convHexOut.textContent = '0x' + v + ' = ' + parseInt(v, 16);
      else convHexOut.textContent = t('toolbox.hexInvalid');
    };

    const convTsIn = el('input'); convTsIn.placeholder = t('toolbox.tsPh');
    const convTsOut = el('div', 'out', '—');
    convTsIn.oninput = () => {
      const v = convTsIn.value.trim();
      if (!v) { convTsOut.textContent = '—'; return; }
      const digits = v.replace(/[^0-9]/g, '');
      const n = parseFloat(v);
      if (isNaN(n)) { convTsOut.textContent = t('toolbox.tsInvalidNum'); return; }
      // Heuristique sur le nombre de chiffres (pas sur la magnitude) :
      // ≤10 chiffres = secondes, 11-13 = millisecondes, au-delà = micro/nanosecondes.
      let ms;
      if (digits.length <= 10) ms = n * 1000;
      else if (digits.length <= 13) ms = n;
      else if (digits.length <= 16) ms = n / 1000;
      else ms = n / 1000000;
      const d = new Date(ms);
      convTsOut.textContent = isNaN(d.getTime()) ? t('toolbox.tsInvalidDate') : d.toLocaleString(locale);
    };

    panels.set('pwd', el('div', 'panel', lenLabel, lenRange, el('div', { class: 'row' }, lenIn, ...opts),
      el('div', { class: 'row' }, genBtn, pwdOut, copyBtn(() => pwdOut.textContent, t)),
      el('label', null, t('toolbox.genNote'))));
    panels.set('sha', el('div', 'panel', el('label', null, t('toolbox.shaLabel')), shaIn,
      el('div', { class: 'row' }, shaBtn, copyBtn(() => shaOut.textContent, t)), shaOut));
    panels.set('b64', el('div', 'panel', el('label', null, t('toolbox.b64Label')), b64In,
      el('div', { class: 'row' }, b64EncBtn, b64DecBtn), b64Out,
      el('label', null, t('toolbox.b64Hint'))));
    panels.set('conv', el('div', 'panel', el('label', null, t('toolbox.bytesLabel')), convBytesIn, convBytesOut,
      el('label', null, t('toolbox.hexLabel')), convHexIn, convHexOut,
      el('label', null, t('toolbox.tsLabel')), convTsIn, convTsOut));

    const wrap = el('div', 'toolbox-app');
    wrap.append(el('h2', null, t('toolbox.title')), el('p', 'hint', t('toolbox.hint')), tabs, body);
    stage.append(wrap);
    show('pwd');
  },
  async unmount() {},
}
return USBosApp;
