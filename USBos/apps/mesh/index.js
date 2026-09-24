/*
 * USBos app: mesh — "un LocalSend/Discord entre clés USBos".
 * Connexion directe pair-à-pair (WebRTC via PeerJS, signalisation publique
 * gratuite du projet PeerJS). Pas de scan QR : on partage un code court
 * (l'identifiant de la clé) à la voix/texte, comme un pseudo LocalSend.
 * La lib PeerJS est chargée depuis apps/mesh/vendor/ (asset statique de
 * l'app, jamais depuis le kernel).
 */
const CONFIG_FILE = 'mesh.json';

const STYLE = `
.mesh-app{width:100%;flex:1;min-height:0;display:flex;flex-direction:column;gap:14px}
.mesh-app h2{font-size:17px;margin-bottom:2px}
.mesh-app .hint{color:var(--muted);font-size:12px}
.mesh-app .idcard{background:var(--panel);border:1px solid var(--border);border-radius:12px;padding:14px;display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.mesh-app .idcard .code{font-family:'JetBrains Mono',ui-monospace,monospace;font-size:15px;background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:8px 12px;letter-spacing:1px}
.mesh-app .status{display:flex;align-items:center;gap:6px;font-size:12.5px;color:var(--muted);margin-left:auto}
.mesh-app .dot{width:8px;height:8px;border-radius:50%;background:var(--muted)}
.mesh-app .dot.on{background:var(--ok);box-shadow:0 0 6px var(--ok)}
.mesh-app .dot.err{background:var(--err)}
.mesh-app .connectrow{display:flex;gap:8px}
.mesh-app .connectrow input{flex:1;background:var(--bg);border:1px solid var(--border);border-radius:8px;color:var(--text);padding:9px 11px;font:inherit;outline:none;font-family:'JetBrains Mono',ui-monospace,monospace}
.mesh-app .peers{display:flex;flex-direction:column;gap:6px}
.mesh-app .peer{background:var(--panel);border:1px solid var(--border);border-radius:10px;padding:9px 12px;display:flex;justify-content:space-between;align-items:center;gap:10px}
.mesh-app .peer .n{font-weight:600;font-size:13px;font-family:'JetBrains Mono',ui-monospace,monospace}
.mesh-app .chat{background:var(--bg);border:1px solid var(--border);border-radius:10px;padding:10px 12px;flex:1;min-height:200px;overflow-y:auto;display:flex;flex-direction:column;gap:6px;font-size:13px}
.mesh-app .msg{max-width:75%;padding:6px 10px;border-radius:8px;background:var(--panel2)}
.mesh-app .msg.me{align-self:flex-end;background:linear-gradient(135deg,var(--accent),var(--accent2));color:#fff}
.mesh-app .msg .meta{font-size:10.5px;opacity:.7;margin-bottom:2px}
.mesh-app .msg.file{display:flex;align-items:center;gap:8px}
.mesh-app .sendrow{display:flex;gap:8px}
.mesh-app .sendrow input[type=text]{flex:1;background:var(--bg);border:1px solid var(--border);border-radius:8px;color:var(--text);padding:9px 11px;font:inherit;outline:none}
.mesh-app .btn{background:linear-gradient(135deg,var(--accent),var(--accent2));border:none;border-radius:8px;color:#fff;font-weight:600;padding:8px 14px}
.mesh-app .btn:hover{filter:brightness(1.1)}
.mesh-app .mini{background:var(--panel2);border:1px solid var(--border);border-radius:7px;color:var(--text);font-size:12px;padding:6px 11px}
.mesh-app .mini:hover{border-color:var(--accent)}
.mesh-app .dropzone{border:1.5px dashed var(--border);border-radius:10px;padding:14px;text-align:center;color:var(--muted);font-size:12.5px}
.mesh-app .dropzone.drag{border-color:var(--accent);color:var(--accent)}
.mesh-app .empty{color:var(--muted);font-size:12.5px;text-align:center;padding:14px 0}
`;

function el(tag, cls, text) { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }

function shortId() {
  // Code lisible à voix haute. Deux tirages indépendants (mot + nombre) via
  // crypto.getRandomValues : ~10 x 900 000 ≈ 9M combinaisons (~23 bits).
  // L'ID est une adresse, pas un secret : la vraie protection contre les
  // connexions indésirables est l'acceptation manuelle côté destinataire.
  const words = ['ROC', 'LAC', 'MTL', 'BOA', 'IVY', 'FEU', 'ODE', 'ZEN', 'ARC', 'NIL'];
  const buf = new Uint32Array(2);
  crypto.getRandomValues(buf);
  const w = words[buf[0] % words.length];
  const n = 100000 + (buf[1] % 900000);
  return `${w}-${n}`;
}

// Taille max d'envoi direct (DataChannel) : au-delà, on refuse plutôt que
// de faire exploser la RAM des deux pairs (pas de chunking pour l'instant).
// Seuil effectif recommandé 8 Mo (message Partage/), refus dur 25 Mo absolu.
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const WARN_FILE_BYTES = 8 * 1024 * 1024;
const MAX_CHAT_MSGS = 50;
const TARGET_RE = /^[A-Z]{3}-\d{6}$/;
let meshCleanup = null;

function newId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
  const hx = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${hx.slice(0, 8)}-${hx.slice(8, 12)}-${hx.slice(12, 16)}-${hx.slice(16, 20)}-${hx.slice(20)}`;
}

async function loadPeerJS(ctx) {
  if (window.Peer) return;
  const code = await ctx.fs.readAppAsset('vendor/peerjs.min.js');
  const script = document.createElement('script');
  script.textContent = code;
  document.head.append(script);
  if (!window.Peer) throw new Error(ctx.i18n.t('mesh.peerInit'));
}

const USBosApp = {
  id: 'mesh',
  async mount(ctx, stage) {
    stage.append(el('style', null, STYLE));
    const t = ctx.i18n.t;
    const locale = ctx.i18n.locale;
    const isEn = String(locale || '').toLowerCase().startsWith('en');

    let cfg = {};
    try { cfg = await ctx.fs.readJSON(CONFIG_FILE); } catch { /* premier lancement */ }
    if (!cfg.myId) cfg.myId = shortId();
    if (ctx.keyId && cfg.keyId !== ctx.keyId) cfg.keyId = ctx.keyId; // identité de clé (socle auth/appairage futur)
    if (!cfg.knownKeys || typeof cfg.knownKeys !== 'object') cfg.knownKeys = {}; // carnet futur : keyId -> {alias, trusted}
    await ctx.fs.writeJSON(CONFIG_FILE, cfg);

    const wrap = el('div', 'mesh-app');
    const status = el('div', 'status'); status.append(el('span', 'dot'), el('span', null, t('mesh.statusOffline')));
    const idCard = el('div', 'idcard');
    idCard.append(el('span', null, t('mesh.myKey')), el('span', 'code', cfg.myId), status);
    if (cfg.keyId) idCard.append(el('span', 'hint', t('mesh.keyIdLabel', { id: cfg.keyId })));

    const connectIn = el('input'); connectIn.placeholder = t('mesh.joinPh');
    const connectBtn = el('button', 'btn', t('mesh.connect'));
    const connectRow = el('div', 'connectrow'); connectRow.append(connectIn, connectBtn);

    const peersBox = el('div', 'peers');
    const chat = el('div', 'chat');
    const clearChatBtn = el('button', 'mini', isEn ? 'Clear chat' : 'Vider chat');
    clearChatBtn.onclick = () => {
      for (const u of blobUrls) { try { URL.revokeObjectURL(u); } catch { /* noop */ } }
      blobUrls.clear();
      chat.innerHTML = '';
    };
    const msgIn = el('input'); msgIn.type = 'text'; msgIn.placeholder = t('mesh.msgPh'); msgIn.disabled = true;
    const sendBtn = el('button', 'btn', t('mesh.send')); sendBtn.disabled = true;
    const sendRow = el('div', 'sendrow'); sendRow.append(msgIn, sendBtn, clearChatBtn);
    const drop = el('div', 'dropzone', t('mesh.dropHint'));
    const filePick = el('input'); filePick.type = 'file';
    filePick.onchange = async () => { const f = filePick.files[0]; if (f) await sendFile(f); filePick.value = ''; };

    wrap.append(
      el('h2', null, t('mesh.title')),
      el('p', 'hint', t('mesh.hint')),
      idCard, connectRow, peersBox, chat, sendRow, drop, filePick,
      el('p', 'hint', t('mesh.helpLine'))
    );
    stage.append(wrap);

    let peer = null;
    let peerDead = false;
    const conns = new Map(); // peerId -> DataConnection
    const blobUrls = new Set();

    function setStatus(text, cls) {
      status.querySelector('span:first-child').className = 'dot' + (cls ? ' ' + cls : '');
      status.querySelector('span:last-child').textContent = text;
    }

    function renderPeers() {
      peersBox.innerHTML = '';
      if (conns.size === 0) { peersBox.append(el('div', 'empty', t('mesh.noPeers'))); return; }
      for (const id of conns.keys()) {
        const row = el('div', 'peer');
        row.append(el('span', 'n', id));
        const disc = el('button', 'mini', t('mesh.disconnect'));
        disc.onclick = () => { conns.get(id).close(); conns.delete(id); renderPeers(); updateSendEnabled(); };
        row.append(disc);
        peersBox.append(row);
      }
    }

    function updateSendEnabled() {
      const on = conns.size > 0;
      msgIn.disabled = !on; sendBtn.disabled = !on;
    }

    function trimChat() {
      while (chat.children.length > MAX_CHAT_MSGS) {
        const old = chat.firstChild;
        try {
          const a = old && old.querySelector ? old.querySelector('a[href^="blob:"]') : null;
          if (a) { try { URL.revokeObjectURL(a.href); } catch { /* noop */ } blobUrls.delete(a.href); }
        } catch { /* noop */ }
        try { old.remove(); } catch { chat.removeChild(chat.firstChild); }
      }
    }

    function appendMsg(text, mine, fromId) {
      const m = el('div', 'msg' + (mine ? ' me' : ''));
      const meta = el('div', 'meta', mine ? t('mesh.me') : fromId);
      const body = el('div', null, text);
      m.append(meta, body);
      chat.append(m);
      trimChat();
      chat.scrollTop = chat.scrollHeight;
    }

    function appendFileMsg(name, size, mine, fromId, blobUrl) {
      const m = el('div', 'msg file' + (mine ? ' me' : ''));
      const who = mine ? t('mesh.meArrow') : t('mesh.peerArrowMe', { from: fromId });
      const meta = el('div', 'meta', t('mesh.fileMeta', { who, name, size: (size / 1024).toFixed(1), unit: t('mesh.unitKo') }));
      m.append(meta);
      if (blobUrl) {
        const a = document.createElement('a');
        a.href = blobUrl; a.download = name; a.textContent = t('mesh.download'); a.className = 'mini';
        a.onclick = () => { setTimeout(() => { try { URL.revokeObjectURL(blobUrl); } catch { /* noop */ } blobUrls.delete(blobUrl); }, 5000); };
        m.append(a);
      }
      chat.append(m);
      trimChat();
      chat.scrollTop = chat.scrollHeight;
    }

    const pendingIncoming = new Map(); // peerId -> { conn, timer }
    const PENDING_TIMEOUT_MS = 60000;
    const pendingBox = el('div', 'peers');
    wrap.insertBefore(pendingBox, chat);

    function renderPending() {
      pendingBox.innerHTML = '';
      for (const [peerId, entry] of pendingIncoming) {
        const conn = entry.conn;
        const row = el('div', 'peer');
        row.append(el('span', 'n', t('mesh.incomingAsk', { peer: peerId })));
        const accept = el('button', 'mini', t('mesh.accept'));
        accept.onclick = () => { clearTimeout(entry.timer); pendingIncoming.delete(peerId); acceptConn(conn); renderPending(); };
        const refuse = el('button', 'mini del', t('mesh.refuse'));
        refuse.onclick = () => { clearTimeout(entry.timer); pendingIncoming.delete(peerId); try { conn.close(); } catch { /* noop */ } renderPending(); };
        const btns = el('div'); btns.append(accept, refuse);
        row.append(btns);
        pendingBox.append(row);
      }
    }

    function handlePayload(conn, payload) {
      if (payload && payload.type === 'text') appendMsg(String(payload.text).slice(0, 4000), false, conn.peer);
      else if (payload && payload.type === 'file') {
        const size = payload.size || 0;
        if (size > MAX_FILE_BYTES) { ctx.ui.log(`mesh: fichier refusé (${size} octets > 25 Mo)`); return; }
        const mime = String(payload.mime || 'application/octet-stream').slice(0, 128);
        const blob = new Blob([payload.data], { type: mime });
        const url = URL.createObjectURL(blob);
        blobUrls.add(url);
        appendFileMsg(String(payload.name).slice(0, 255), size, false, conn.peer, url);
      }
    }

    function acceptConn(conn) {
      conn.on('data', (payload) => handlePayload(conn, payload));
      conn.on('close', () => { conns.delete(conn.peer); renderPeers(); updateSendEnabled(); });
      conns.set(conn.peer, conn); renderPeers(); updateSendEnabled();
      ctx.ui.log(`mesh: connexion acceptée (${conn.peer})`);
    }

    function wireConn(conn) {
      // Connexion SORTANTE (nous avons initié) : acceptée automatiquement.
      conn.on('open', () => acceptConn(conn));
      conn.on('error', (e) => ctx.ui.log(`mesh: erreur connexion (${e.message || e})`, 'e'));
    }

    function wireIncoming(conn) {
      // Connexion ENTRANTE : rien n'est accepté tant que l'utilisateur n'a
      // pas cliqué "Accepter". Expiration automatique après 60 s. Cap 5 demandes.
      conn.on('open', () => {
        if (!pendingIncoming.has(conn.peer) && pendingIncoming.size >= 5) {
          try { conn.close(); } catch { /* noop */ }
          ctx.ui.log('mesh: trop de demandes entrantes, refusée');
          return;
        }
        const old = pendingIncoming.get(conn.peer);
        if (old) { clearTimeout(old.timer); try { old.conn.close(); } catch { /* noop */ } }
        const timer = setTimeout(() => {
          pendingIncoming.delete(conn.peer);
          try { conn.close(); } catch { /* noop */ }
          renderPending();
          ctx.ui.log(`mesh: demande de ${conn.peer} expirée (60 s)`);
        }, PENDING_TIMEOUT_MS);
        pendingIncoming.set(conn.peer, { conn, timer });
        // Attache le handler tôt pour ne perdre aucun message post-accept.
        conn.on('data', (payload) => { if (conns.has(conn.peer)) handlePayload(conn, payload); });
        conn.on('close', () => {
          const e = pendingIncoming.get(conn.peer);
          if (e) { clearTimeout(e.timer); pendingIncoming.delete(conn.peer); renderPending(); }
          if (conns.get(conn.peer) === conn) { conns.delete(conn.peer); renderPeers(); updateSendEnabled(); }
        });
        renderPending();
        ctx.ui.log(`mesh: demande de connexion de ${conn.peer}`);
      });
    }

    async function ensurePeer(retry) {
      retry = retry || 0;
      if (peer && !peerDead && !peer.destroyed) return peer;
      if (peer) { try { peer.destroy(); } catch { /* noop */ } peer = null; }
      peerDead = false;
      setStatus(t('mesh.statusConnecting'));
      await loadPeerJS(ctx);
      try {
        return await new Promise((resolve, reject) => {
          const p = new window.Peer(String(cfg.myId).replace(/[^a-zA-Z0-9-]/g, ''));
          peer = p;
          p.on('open', () => { setStatus(t('mesh.statusOnline', { id: cfg.myId }), 'on'); resolve(p); });
          p.on('connection', (conn) => wireIncoming(conn));
          p.on('error', (e) => {
            setStatus(t('mesh.statusError', { error: e.type || e.message }), 'err');
            if (!p.open) { peerDead = true; }
            reject(e);
          });
        });
      } catch (e) {
        // Collision d'ID (unavailable-id) : régénère un code court, persiste, retry backoff max 3.
        if (e && e.type === 'unavailable-id' && retry < 3) {
          try { peer = null; } catch { /* noop */ }
          cfg.myId = shortId();
          try { await ctx.fs.writeJSON(CONFIG_FILE, cfg); } catch { /* noop */ }
          try { idCard.querySelector('.code').textContent = cfg.myId; } catch { /* noop */ }
          ctx.ui.log(`mesh: id collision, nouvel id ${cfg.myId} (retry ${retry + 1}/3)`);
          await new Promise((r) => setTimeout(r, 500 * (retry + 1)));
          return ensurePeer(retry + 1);
        }
        throw e;
      }
    }

    connectBtn.onclick = async () => {
      const target = connectIn.value.trim().toUpperCase();
      if (!target) return;
      if (!TARGET_RE.test(target)) {
        ctx.ui.log(`mesh: code invalide (${target.slice(0, 32)}) — format AAA-123456`);
        try { ctx.ui.toast(t('mesh.badCode')); } catch { /* noop */ }
        return;
      }
      try {
        const p = await ensurePeer();
        const conn = p.connect(target.replace(/[^a-zA-Z0-9-]/g, ''), { reliable: true });
        wireConn(conn);
        connectIn.value = '';
      } catch (err) {
        ctx.ui.log(`mesh: connexion échouée (${err.message || err})`, 'e');
      }
    };

    sendBtn.onclick = () => {
      const text = msgIn.value.trim().slice(0, 4000);
      if (!text || conns.size === 0) return;
      for (const conn of conns.values()) {
        try { conn.send({ type: 'text', text }); } catch (err) { ctx.ui.log(`mesh: envoi échoué (${err.message})`); }
      }
      appendMsg(text, true);
      msgIn.value = '';
    };
    msgIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') sendBtn.click(); });

    async function sendFile(file) {
      if (conns.size === 0) return;
      if (file.size > MAX_FILE_BYTES) {
        ctx.ui.log(`mesh: fichier trop volumineux (${(file.size / 1048576).toFixed(1)} Mo > 25 Mo) — envoi refusé`);
        try { ctx.ui.toast(t('mesh.fileTooBig')); } catch { /* noop */ }
        return;
      }
      // Garde RAM sans chunking : seuil effectif 8 Mo avec conseil Partage/.
      if (file.size > WARN_FILE_BYTES) {
        ctx.ui.log(`mesh: fichier >8 Mo (${(file.size / 1048576).toFixed(1)} Mo) — utilisez Partage/`);
        try { ctx.ui.toast(t('mesh.fileBigShared')); } catch { /* noop */ }
        return;
      }
      let buf;
      try {
        buf = await file.arrayBuffer();
      } catch (err) {
        ctx.ui.log(`mesh: lecture fichier impossible (${err.message})`);
        return;
      }
      for (const conn of conns.values()) {
        try {
          conn.send({ type: 'file', name: String(file.name || 'file').slice(0, 255), size: file.size, mime: String(file.type || '').slice(0, 128), data: buf });
        } catch (err) {
          ctx.ui.log(`mesh: envoi fichier échoué (${err.message})`);
        }
      }
      appendFileMsg(file.name, file.size, true);
    }

    drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('drag'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('drag'));
    drop.addEventListener('drop', async (e) => {
      e.preventDefault(); drop.classList.remove('drag');
      const file = e.dataTransfer.files[0];
      if (file) await sendFile(file);
    });

    // Connexion "passive" ouverte dès l'entrée dans l'app pour être joignable.
    ensurePeer().catch(() => { /* affiché via setStatus */ });

    meshCleanup = () => {
      for (const entry of pendingIncoming.values()) { clearTimeout(entry.timer); try { entry.conn.close(); } catch { /* noop */ } }
      pendingIncoming.clear();
      for (const c of conns.values()) { try { c.close(); } catch { /* noop */ } }
      conns.clear();
      for (const u of blobUrls) { try { URL.revokeObjectURL(u); } catch { /* noop */ } }
      blobUrls.clear();
      if (peer) { try { peer.destroy(); } catch { /* noop */ } peer = null; }
    };
  },
  async unmount() { if (meshCleanup) { try { meshCleanup(); } catch { /* noop */ } meshCleanup = null; } },
}
return USBosApp;
