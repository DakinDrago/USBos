/*
 * USBos app: mesh — "un LocalSend/Discord entre clés USBos".
 * Connexion directe pair-à-pair (WebRTC via PeerJS, signalisation publique
 * gratuite du projet PeerJS). Pas de scan QR : on partage un code court
 * (l'identifiant de la clé) à la voix/texte, comme un pseudo LocalSend.
 * La lib PeerJS est chargée depuis apps/mesh/vendor/ (asset statique de
 * l'app, jamais depuis le kernel).
 *
 * Salons de groupe (maillage complet) : un salon a un code GRP-123456 + un
 * nom. Chaque membre se connecte à tous les autres ; les listes de membres
 * sont échangées dans les poignées de main (hello/welcome) et les manquants
 * sont proposés en connexion 1-clic. Chaque connexion entrante reste
 * acceptée manuellement (avec le contexte du salon). Les messages/fichiers
 * sont taggés {group} ou diffusés à tous. Compat mixte : un pair en 1.2.0
 * reçoit les champs inconnus sans les afficher (repli 1:1).
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
.mesh-app .connectrow select{background:var(--bg);border:1px solid var(--border);border-radius:8px;color:var(--text);padding:9px 11px;font:inherit;outline:none;max-width:220px}
.mesh-app .peers{display:flex;flex-direction:column;gap:6px}
.mesh-app .peer{background:var(--panel);border:1px solid var(--border);border-radius:10px;padding:9px 12px;display:flex;justify-content:space-between;align-items:center;gap:10px}
.mesh-app .peer .n{font-weight:600;font-size:13px;font-family:'JetBrains Mono',ui-monospace,monospace}
.mesh-app .peer .acts{display:flex;gap:6px;align-items:center;flex-wrap:wrap}
.mesh-app .peer select{background:var(--bg);border:1px solid var(--border);border-radius:7px;color:var(--text);font-size:12px;padding:6px 8px;outline:none;max-width:180px}
.mesh-app .chat{background:var(--bg);border:1px solid var(--border);border-radius:10px;padding:10px 12px;flex:1;min-height:200px;overflow-y:auto;display:flex;flex-direction:column;gap:6px;font-size:13px}
.mesh-app .msg{max-width:75%;padding:6px 10px;border-radius:8px;background:var(--panel2)}
.mesh-app .msg.me{align-self:flex-end;background:linear-gradient(135deg,var(--accent),var(--accent2));color:#fff}
.mesh-app .msg .meta{font-size:10.5px;opacity:.7;margin-bottom:2px}
.mesh-app .msg.file{display:flex;align-items:center;gap:8px}
.mesh-app .sendrow{display:flex;gap:8px}
.mesh-app .sendrow input[type=text]{flex:1;background:var(--bg);border:1px solid var(--border);border-radius:8px;color:var(--text);padding:9px 11px;font:inherit;outline:none}
.mesh-app .sendrow select{background:var(--bg);border:1px solid var(--border);border-radius:8px;color:var(--text);padding:9px 11px;font:inherit;outline:none;max-width:200px}
.mesh-app .btn{background:linear-gradient(135deg,var(--accent),var(--accent2));border:none;border-radius:8px;color:#fff;font-weight:600;padding:8px 14px}
.mesh-app .btn:hover{filter:brightness(1.1)}
.mesh-app .mini{background:var(--panel2);border:1px solid var(--border);border-radius:7px;color:var(--text);font-size:12px;padding:6px 11px}
.mesh-app .mini:hover{border-color:var(--accent)}
.mesh-app .mini.del{background:rgba(248,81,73,.1);border:1px solid var(--err);color:var(--err)}
.mesh-app .mini.del:hover{background:rgba(248,81,73,.2)}
.mesh-app .msg{overflow-wrap:anywhere}
.mesh-app .peer .n{overflow-wrap:anywhere}
.mesh-app input[type=file]{color:var(--muted);font-size:12px;max-width:100%}
.mesh-app input[type=file]::file-selector-button{font:inherit;cursor:pointer;background:var(--panel2);border:1px solid var(--border);border-radius:7px;color:var(--text);padding:6px 11px;margin-right:8px}
.mesh-app input[type=file]::file-selector-button:hover{border-color:var(--accent)}
.mesh-app .dropzone{border:1.5px dashed var(--border);border-radius:10px;padding:14px;text-align:center;color:var(--muted);font-size:12.5px}
.mesh-app .dropzone.drag{border-color:var(--accent);color:var(--accent)}
.mesh-app .empty{color:var(--muted);font-size:12.5px;text-align:center;padding:14px 0}
.mesh-app .groupcard{background:var(--panel);border:1px solid var(--border);border-radius:12px;padding:14px;display:flex;flex-direction:column;gap:10px}
.mesh-app .groupcard h3{font-size:14px}
.mesh-app .grow{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.mesh-app .grow input{flex:1;min-width:140px;background:var(--bg);border:1px solid var(--border);border-radius:8px;color:var(--text);padding:9px 11px;font:inherit;outline:none}
.mesh-app .gitem{background:var(--bg);border:1px solid var(--border);border-radius:10px;padding:9px 12px;display:flex;flex-direction:column;gap:8px}
.mesh-app .gitem .gtop{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.mesh-app .gitem .gname{font-weight:600;font-size:13px}
.mesh-app .gitem .gcode{font-family:'JetBrains Mono',ui-monospace,monospace;font-size:12px;background:var(--panel2);border:1px solid var(--border);border-radius:7px;padding:4px 8px;letter-spacing:1px}
.mesh-app .gitem .gcount{font-size:12px;color:var(--muted)}
.mesh-app .gitem .gacts{display:flex;gap:6px;flex-wrap:wrap}
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

function shortGroup() {
  // Code de salon GRP-123456 (~20 bits). Comme les IDs pairs : une adresse à
  // communiquer, pas un secret — l'entrée reste validée manuellement.
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return `GRP-${100000 + (buf[0] % 900000)}`;
}

// Taille max d'envoi direct (DataChannel) : au-delà, on refuse plutôt que
// de faire exploser la RAM des deux pairs (pas de chunking pour l'instant).
// Seuil effectif recommandé 8 Mo (message Partage/), refus dur 25 Mo absolu.
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const WARN_FILE_BYTES = 8 * 1024 * 1024;
// Transferts morcelés (.upack-style, transit brut) : l'émetteur lit par
// tranches à la demande, le receveur accuse chaque morceau (1 en vol).
// RAM bornée des deux côtés -> plafond haut mais fini.
const PIECE_BYTES = 256 * 1024;
const MAX_PACK_BYTES = 256 * 1024 * 1024;
const MAX_PIECES = 4096;
const ACK_TIMEOUT_MS = 10000;
const MAX_ACK_RETRIES = 9; // couvre la fenêtre d'acceptation manuelle (60 s)
const TRANSFER_TIMEOUT_MS = 120000;
const MAX_CHAT_MSGS = 50;
const MAX_EARLY_QUEUE = 20;
const MAX_ADVERT_MEMBERS = 50;
const TARGET_RE = /^[A-Z]{3}-\d{6}$/;
const GROUP_RE = /^GRP-\d{6}$/;
let meshCleanup = null;

function newId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
  const hx = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${hx.slice(0, 8)}-${hx.slice(8, 12)}-${hx.slice(12, 16)}-${hx.slice(16, 20)}-${hx.slice(20)}`;
}

async function sha256Hex(u8) {
  const d = await crypto.subtle.digest('SHA-256', u8);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
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

    let cfg = {};
    try { cfg = await ctx.fs.readJSON(CONFIG_FILE); } catch { /* premier lancement */ }
    if (!cfg.myId) cfg.myId = shortId();
    if (ctx.keyId && cfg.keyId !== ctx.keyId) cfg.keyId = ctx.keyId; // identité de clé (socle auth/appairage futur)
    if (!cfg.knownKeys || typeof cfg.knownKeys !== 'object') cfg.knownKeys = {}; // carnet futur : keyId -> {alias, trusted}
    if (!cfg.groups || typeof cfg.groups !== 'object' || Array.isArray(cfg.groups)) cfg.groups = {}; // salons rejoints : code -> {name}
    async function saveCfg() { try { await ctx.fs.writeJSON(CONFIG_FILE, cfg); } catch { /* best effort */ } }
    await saveCfg();

    const wrap = el('div', 'mesh-app');
    const status = el('div', 'status'); status.append(el('span', 'dot'), el('span', null, t('mesh.statusOffline')));
    const idCard = el('div', 'idcard');
    idCard.append(el('span', null, t('mesh.myKey')), el('span', 'code', cfg.myId), status);
    if (cfg.keyId) idCard.append(el('span', 'hint', t('mesh.keyIdLabel', { id: cfg.keyId })));

    const connectIn = el('input'); connectIn.placeholder = t('mesh.joinPh');
    const groupSel = el('select'); groupSel.setAttribute('aria-label', t('mesh.groupJoinScope'));
    const connectBtn = el('button', 'btn', t('mesh.connect'));
    const connectRow = el('div', 'connectrow'); connectRow.append(connectIn, groupSel, connectBtn);

    // Carte salons de groupe.
    const groupCard = el('div', 'groupcard');
    groupCard.append(el('h3', null, t('mesh.groupTitle')), el('p', 'hint', t('mesh.groupHint')));
    const gNameIn = el('input'); gNameIn.placeholder = t('mesh.groupNamePh');
    gNameIn.setAttribute('aria-label', t('mesh.groupNamePh'));
    const gCreateBtn = el('button', 'btn', t('mesh.groupCreate'));
    const gCreateRow = el('div', 'grow'); gCreateRow.append(gNameIn, gCreateBtn);
    const gList = el('div', 'peers');
    groupCard.append(gCreateRow, gList);

    const invitesBox = el('div', 'peers');
    const transfersBox = el('div', 'peers');
    const peersBox = el('div', 'peers');
    const chat = el('div', 'chat');
    const clearChatBtn = el('button', 'mini', t('mesh.clearChat'));
    clearChatBtn.onclick = () => {
      for (const u of blobUrls) { try { URL.revokeObjectURL(u); } catch { /* noop */ } }
      blobUrls.clear();
      chat.innerHTML = '';
    };
    const msgIn = el('input'); msgIn.type = 'text'; msgIn.placeholder = t('mesh.msgPh'); msgIn.disabled = true;
    const scopeSel = el('select'); scopeSel.setAttribute('aria-label', t('mesh.scopeLabel')); scopeSel.disabled = true;
    const sendBtn = el('button', 'btn', t('mesh.send')); sendBtn.disabled = true;
    const sendRow = el('div', 'sendrow'); sendRow.append(msgIn, scopeSel, sendBtn, clearChatBtn);
    const drop = el('div', 'dropzone', t('mesh.dropHint'));
    const filePick = el('input'); filePick.type = 'file';
    filePick.onchange = async () => { const f = filePick.files[0]; if (f) await sendFile(f); filePick.value = ''; };

    wrap.append(
      el('h2', null, t('mesh.title')),
      el('p', 'hint', t('mesh.hint')),
      idCard, connectRow, groupCard, invitesBox, transfersBox, peersBox, chat, sendRow, drop, filePick,
      el('p', 'hint', t('mesh.helpLine'))
    );
    stage.append(wrap);

    let peer = null;
    let peerDead = false;
    const conns = new Map(); // peerId -> DataConnection
    const dialing = new Set(); // peerId avec connexion sortante en cours
    const blobUrls = new Set();
    const peerGroups = new Map(); // peerId -> { groupCode: {name, members:[...]} } (annoncé)
    const groupMembers = new Map(); // groupCode -> Map peerCode -> true (membres connus, hors soi)
    const earlyQueue = new Map(); // peerId -> [payload] reçus avant acceptation
    const invites = new Map(); // `${group}:${from}` -> {group, name, from}
    const peerCaps = new Map(); // peerId -> true si transferts morcelés supportés
    const sendTransfers = new Map(); // id -> {name,size,mime,n,piece,hashes,group,file,peers:Map,row}
    const recvTransfers = new Map(); // id -> {name,size,mime,n,piece,hashes,group,from,parts,received,timer,row}
    const doneAcks = new Map(); // id -> {peer} : transferts reçus (renvoie packDone 60 s)

    function setStatus(text, cls) {
      status.querySelector('span:first-child').className = 'dot' + (cls ? ' ' + cls : '');
      status.querySelector('span:last-child').textContent = text;
    }

    function myGroupCodes() { return Object.keys(cfg.groups || {}); }

    function groupName(code) {
      const g = (cfg.groups || {})[code];
      return (g && g.name) || code;
    }

    function membersOf(code) {
      // Membres connus d'un salon (hors soi), limités aux pairs connectés
      // pour les actions : un membre déconnecté n'est pas joignable.
      const m = groupMembers.get(code);
      return m ? [...m.keys()] : [];
    }

    function missingMembers(code) {
      return membersOf(code).filter((id) => id !== cfg.myId && !conns.has(id) && !pendingIncoming.has(id) && !dialing.has(id));
    }

    function advertise() {
      // Ce que j'annonce : mes salons + membres connus (borné).
      const out = {};
      for (const code of myGroupCodes()) {
        out[code] = { name: groupName(code), members: [cfg.myId, ...membersOf(code)].slice(0, MAX_ADVERT_MEMBERS) };
      }
      return out;
    }

    function addMember(code, peerId) {
      if (!cfg.groups[code] || peerId === cfg.myId) return false;
      let m = groupMembers.get(code);
      if (!m) { m = new Map(); groupMembers.set(code, m); }
      if (m.has(peerId)) return false;
      m.set(peerId, true);
      return true;
    }

    function removePeerEverywhere(peerId, render) {
      conns.delete(peerId);
      dialing.delete(peerId);
      peerGroups.delete(peerId);
      earlyQueue.delete(peerId);
      for (const m of groupMembers.values()) m.delete(peerId);
      if (render !== false) { renderPeers(); renderGroups(); updateSendEnabled(); }
    }

    function renderScope() {
      const prev = scopeSel.value;
      scopeSel.innerHTML = '';
      const all = document.createElement('option');
      all.value = 'all'; all.textContent = t('mesh.scopeAll');
      scopeSel.append(all);
      for (const code of myGroupCodes()) {
        const o = document.createElement('option');
        o.value = code; o.textContent = groupName(code);
        scopeSel.append(o);
      }
      scopeSel.value = (prev === 'all' || cfg.groups[prev]) ? prev : 'all';
      scopeSel.disabled = conns.size === 0;
    }

    function renderGroupSel() {
      const prev = groupSel.value;
      groupSel.innerHTML = '';
      const none = document.createElement('option');
      none.value = ''; none.textContent = t('mesh.groupNone');
      groupSel.append(none);
      for (const code of myGroupCodes()) {
        const o = document.createElement('option');
        o.value = code; o.textContent = `${groupName(code)} (${code})`;
        groupSel.append(o);
      }
      groupSel.value = cfg.groups[prev] ? prev : '';
    }

    function renderPeers() {
      peersBox.innerHTML = '';
      if (conns.size === 0) { peersBox.append(el('div', 'empty', t('mesh.noPeers'))); return; }
      for (const id of conns.keys()) {
        const row = el('div', 'peer');
        row.append(el('span', 'n', id));
        const acts = el('div', 'acts');
        const inv = el('button', 'mini', t('mesh.inviteBtn'));
        inv.onclick = () => {
          // Remplace le bouton par un choix de salon à proposer.
          acts.innerHTML = '';
          const sel = document.createElement('select');
          for (const code of myGroupCodes()) {
            const o = document.createElement('option');
            o.value = code; o.textContent = groupName(code);
            sel.append(o);
          }
          if (!myGroupCodes().length) { renderPeers(); return; }
          const go = el('button', 'mini', t('mesh.inviteSend'));
          go.onclick = () => {
            try { conns.get(id).send({ type: 'invite', group: sel.value, name: groupName(sel.value), from: cfg.myId }); } catch (err) { ctx.ui.log(`mesh: invitation échouée (${err.message})`); }
            try { ctx.ui.toast(t('mesh.inviteSent', { peer: id })); } catch { /* noop */ }
            renderPeers();
          };
          acts.append(sel, go);
        };
        const disc = el('button', 'mini', t('mesh.disconnect'));
        disc.onclick = () => { try { conns.get(id).close(); } catch { /* noop */ } removePeerEverywhere(id); };
        acts.append(inv, disc);
        row.append(acts);
        peersBox.append(row);
      }
    }

    function renderGroups() {
      gList.innerHTML = '';
      const codes = myGroupCodes();
      if (!codes.length) { gList.append(el('div', 'empty', t('mesh.groupEmpty'))); }
      for (const code of codes) {
        const item = el('div', 'gitem');
        const top = el('div', 'gtop');
        const copy = el('button', 'mini', t('mesh.copyCode'));
        copy.onclick = async () => {
          try { await navigator.clipboard.writeText(code); ctx.ui.toast(t('mesh.codeCopied')); }
          catch { ctx.ui.toast(code); }
        };
        top.append(el('span', 'gname', groupName(code)), el('span', 'gcode', code), copy);
        const connected = membersOf(code).filter((id) => conns.has(id));
        const missing = missingMembers(code);
        item.append(top, el('div', 'gcount', t('mesh.groupMembersN', { n: connected.length + 1 })));
        const acts = el('div', 'gacts');
        if (missing.length) {
          const link = el('button', 'mini', t('mesh.groupConnectMissing', { n: missing.length }));
          link.onclick = () => { for (const m of missingMembers(code)) void dialPeer(m, code); };
          acts.append(link);
        } else {
          acts.append(el('span', 'gcount', t('mesh.groupAllLinked')));
        }
        const quit = el('button', 'mini del', t('mesh.groupQuit'));
        quit.onclick = async () => { await quitGroup(code); };
        acts.append(quit);
        item.append(acts);
        gList.append(item);
      }
      renderGroupSel();
      renderScope();
    }

    function renderInvites() {
      invitesBox.innerHTML = '';
      for (const [key, inv] of invites) {
        const row = el('div', 'peer');
        row.append(el('span', 'n', t('mesh.inviteAsk', { from: inv.from, name: inv.name, code: inv.group })));
        const acts = el('div', 'acts');
        const join = el('button', 'mini', t('mesh.inviteJoin'));
        join.onclick = async () => {
          invites.delete(key);
          cfg.groups[inv.group] = { name: String(inv.name || inv.group).slice(0, 40) };
          await saveCfg();
          // S'annoncer à tous pour recevoir les listes de membres.
          const hello = { type: 'hello', me: cfg.myId, groups: advertise(), wantJoin: null, packV: 1 };
          for (const conn of conns.values()) { try { conn.send(hello); } catch { /* noop */ } }
          try { ctx.ui.toast(t('mesh.inviteAccepted', { name: groupName(inv.group) })); } catch { /* noop */ }
          ctx.ui.log(`mesh: salon rejoint (${inv.group})`);
          renderInvites(); renderGroups();
        };
        const no = el('button', 'mini del', t('mesh.refuse'));
        no.onclick = () => { invites.delete(key); renderInvites(); };
        acts.append(join, no);
        row.append(acts);
        invitesBox.append(row);
      }
    }

    // ---- Transferts morcelés (gros fichiers, RAM bornée) ----
    function makeProgressRow(label, onCancel) {
      const row = el('div', 'peer');
      row.append(el('span', 'n', label));
      const acts = el('div', 'acts');
      const pct = el('span', 'n', '0 %');
      acts.append(pct);
      if (onCancel) {
        const c = el('button', 'mini del', t('mesh.packCancelBtn'));
        c.onclick = onCancel;
        acts.append(c);
      }
      row.append(acts);
      transfersBox.append(row);
      return {
        set(frac) { pct.textContent = `${Math.round(Math.max(0, Math.min(1, frac)) * 100)} %`; },
        done() { try { row.remove(); } catch { /* noop */ } },
      };
    }

    function updateSendRow(tr) {
      let min = 1;
      for (const st of tr.peers.values()) min = Math.min(min, st.next / tr.n);
      tr.row.set(tr.peers.size ? min : 1);
    }

    function clearPeerTimer(st) { if (st.timer) { clearTimeout(st.timer); st.timer = null; } }

    async function slicePiece(file, i, piece) {
      const buf = await file.slice(i * piece, Math.min((i + 1) * piece, file.size)).arrayBuffer();
      return new Uint8Array(buf);
    }

    async function startPackTransfer(file, targets, group) {
      const piece = PIECE_BYTES;
      const n = Math.ceil(file.size / piece);
      if (!Number.isInteger(n) || n < 1 || n > MAX_PIECES) {
        ctx.ui.log(`mesh: découpage impossible (${file.size} o)`);
        try { ctx.ui.toast(t('mesh.packTooBig')); } catch { /* noop */ }
        return;
      }
      const name = String(file.name || 'file').slice(0, 255);
      const mime = String(file.type || '').slice(0, 128);
      // Hash par morceau en lecture séquentielle (pic RAM = 1 morceau).
      const hashes = [];
      for (let i = 0; i < n; i++) {
        try {
          hashes.push(await sha256Hex(await slicePiece(file, i, piece)));
        } catch (err) {
          ctx.ui.log(`mesh: lecture fichier impossible (${err.message})`);
          return;
        }
      }
      const id = newId();
      const row = makeProgressRow(t('mesh.packSending', { name }), () => abortSendTransfer(id, true));
      const peers = new Map();
      for (const { conn } of targets) peers.set(conn.peer, { conn, next: 0, timer: null, retries: 0 });
      sendTransfers.set(id, { id, name, size: file.size, mime, n, piece, hashes, group, file, peers, row });
      updateSendRow(sendTransfers.get(id));
      ctx.ui.log(`mesh: envoi morcelé ${name} (${n} morceaux)`);
      for (const peerId of peers.keys()) sendPackStart(id, peerId);
    }

    function sendPackStart(id, peerId) {
      const tr = sendTransfers.get(id);
      const st = tr && tr.peers.get(peerId);
      if (!tr || !st) return;
      clearPeerTimer(st);
      try {
        st.conn.send({ type: 'packStart', id, name: tr.name, size: tr.size, mime: tr.mime, n: tr.n, piece: tr.piece, hashes: tr.hashes, group: tr.group, from: cfg.myId, packV: 1 });
      } catch (err) { dropSendPeer(id, peerId, err.message); return; }
      st.timer = setTimeout(() => {
        // Sans accusé (pair pas encore accepté ?) : on réémet jusqu'à
        // couvrir la fenêtre d'acceptation manuelle, puis abandon.
        if (st.retries >= MAX_ACK_RETRIES) { dropSendPeer(id, peerId, 'timeout'); return; }
        st.retries++;
        sendPackStart(id, peerId);
      }, ACK_TIMEOUT_MS);
    }

    async function sendPiece(id, peerId, i) {
      const tr = sendTransfers.get(id);
      const st = tr && tr.peers.get(peerId);
      if (!tr || !st) return;
      clearPeerTimer(st);
      st.next = i;
      updateSendRow(tr);
      let bytes;
      try {
        bytes = await slicePiece(tr.file, i, tr.piece);
      } catch (err) { dropSendPeer(id, peerId, err.message); return; }
      if (!sendTransfers.get(id) || !tr.peers.get(peerId)) return; // annulé pendant lecture
      try {
        st.conn.send({ type: 'packPiece', id, i, data: bytes.buffer });
      } catch (err) { dropSendPeer(id, peerId, err.message); return; }
      st.timer = setTimeout(() => {
        if (st.retries >= 3) { dropSendPeer(id, peerId, 'timeout'); return; }
        st.retries++;
        sendPiece(id, peerId, i); // réémission (relecture tranche)
      }, ACK_TIMEOUT_MS);
    }

    function onPackAck(conn, p) {
      const tr = sendTransfers.get(String(p.id));
      const st = tr && tr.peers.get(conn.peer);
      if (!tr || !st) return;
      const next = p.next;
      if (!Number.isInteger(next) || next < 0 || next > tr.n) { dropSendPeer(tr.id, conn.peer, 'ack'); return; }
      clearPeerTimer(st);
      st.retries = 0;
      if (next >= tr.n) { dropSendPeer(tr.id, conn.peer, 'ack'); return; }
      void sendPiece(tr.id, conn.peer, next);
    }

    function dropSendPeer(id, peerId, reason) {
      const tr = sendTransfers.get(id);
      const st = tr && tr.peers.get(peerId);
      if (!tr || !st) return;
      clearPeerTimer(st);
      tr.peers.delete(peerId);
      const conn = conns.get(peerId);
      if (conn) { try { conn.send({ type: 'packCancel', id }); } catch { /* noop */ } }
      ctx.ui.log(`mesh: envoi abandonné vers ${peerId} (${reason})`);
      updateSendRow(tr);
      if (tr.peers.size === 0) {
        tr.row.done();
        sendTransfers.delete(id);
        try { ctx.ui.toast(t('mesh.packFailed', { name: tr.name, error: String(reason || '?').slice(0, 80) })); } catch { /* noop */ }
      }
    }

    function abortSendTransfer(id, notify) {
      const tr = sendTransfers.get(id);
      if (!tr) return;
      for (const [peerId, st] of tr.peers) {
        clearPeerTimer(st);
        const conn = conns.get(peerId);
        if (conn) { try { conn.send({ type: 'packCancel', id }); } catch { /* noop */ } }
      }
      tr.peers.clear();
      tr.row.done();
      sendTransfers.delete(id);
      if (notify) {
        try { ctx.ui.toast(t('mesh.packCancelled', { name: tr.name })); } catch { /* noop */ }
        ctx.ui.log(`mesh: envoi annulé (${tr.name})`);
      }
    }

    function armRecvTimer(st) {
      if (st.timer) clearTimeout(st.timer);
      st.timer = setTimeout(() => {
        recvTransfers.delete(st.id);
        st.row.done();
        ctx.ui.log(`mesh: transfert ${st.name} abandonné (inactif)`);
        try { ctx.ui.toast(t('mesh.packCancelled', { name: st.name })); } catch { /* noop */ }
      }, TRANSFER_TIMEOUT_MS);
    }

    function ackRecv(st) {
      const conn = conns.get(st.from);
      if (conn) { try { conn.send({ type: 'packAck', id: st.id, next: st.received }); } catch { /* noop */ } }
    }

    function ensureRecv(meta) {
      // Valide l'annonce puis crée (ou retrouve) l'état de réception.
      if (!Number.isInteger(meta.n) || meta.n < 1 || meta.n > MAX_PIECES) return null;
      if (!Number.isInteger(meta.size) || meta.size <= 0 || meta.size > MAX_PACK_BYTES) return null;
      if (!Number.isInteger(meta.piece) || meta.piece <= 0 || meta.piece > PIECE_BYTES) return null;
      if (!Array.isArray(meta.hashes) || meta.hashes.length !== meta.n) return null;
      const g = meta.group != null ? String(meta.group) : null;
      if (g && !cfg.groups[g]) return null; // pas notre salon
      const existing = recvTransfers.get(meta.id);
      if (existing) return { st: existing, created: false };
      const row = makeProgressRow(t('mesh.packReceiving', { name: String(meta.name).slice(0, 60) }), () => abortRecv(meta.id, true));
      const st = {
        id: meta.id, name: String(meta.name || 'file').slice(0, 255),
        size: meta.size, mime: String(meta.mime || '').slice(0, 128),
        n: meta.n, piece: meta.piece, hashes: meta.hashes, group: g, from: meta.from,
        parts: new Array(meta.n).fill(null), received: 0, timer: null, row,
      };
      recvTransfers.set(meta.id, st);
      armRecvTimer(st);
      return { st, created: true };
    }

    function recvStart(conn, p) {
      const r = ensureRecv({
        id: String(p.id), name: p.name, size: p.size, mime: p.mime, n: p.n,
        piece: p.piece, hashes: p.hashes,
        group: p.group != null ? String(p.group) : null, from: conn.peer,
      });
      if (!r) return;
      ackRecv(r.st); // accuse la position courante (répare aussi les accusés perdus)
    }

    async function toBytes(data) {
      if (data instanceof ArrayBuffer) return new Uint8Array(data);
      if (typeof Blob !== 'undefined' && data instanceof Blob) return new Uint8Array(await data.arrayBuffer());
      if (data && data.buffer instanceof ArrayBuffer) return new Uint8Array(data.buffer, data.byteOffset || 0, data.byteLength);
      throw new Error('binary');
    }

    function recvPiece(conn, p) {
      const st = recvTransfers.get(String(p.id));
      if (!st || conn.peer !== st.from) {
        // Transfert terminé côté receveur mais accusé final perdu :
        // on renvoie packDone plutôt que de laisser l'émetteur réémettre.
        const done = doneAcks.get(String(p.id));
        if (done && conn.peer === done.peer) {
          try { conn.send({ type: 'packDone', id: String(p.id) }); } catch { /* noop */ }
        }
        return;
      }
      const i = p.i;
      if (!Number.isInteger(i) || i < 0 || i >= st.n) return;
      if (st.parts[i]) { ackRecv(st); return; } // duplicata : ré-accuser
      if (i !== st.received) return; // hors séquence : l'émetteur réémet sur timeout
      toBytes(p.data).then(async (u8) => {
        if (!recvTransfers.get(st.id)) return; // annulé entre-temps
        if (u8.length > st.piece + 16 || await sha256Hex(u8) !== String(st.hashes[i]).toLowerCase()) {
          ctx.ui.log(`mesh: morceau ${i} corrompu (${st.name}) — attente réémission`);
          return; // pas d'accusé : l'émetteur réémet sur timeout
        }
        st.parts[i] = u8;
        st.received++;
        armRecvTimer(st);
        st.row.set(st.received / st.n);
        if (st.received >= st.n) completeRecv(st);
        else ackRecv(st);
      }).catch((err) => ctx.ui.log(`mesh: morceau illisible (${err.message})`));
    }

    function completeRecv(st) {
      recvTransfers.delete(st.id);
      if (st.timer) clearTimeout(st.timer);
      st.row.done();
      const blob = new Blob(st.parts, { type: st.mime || 'application/octet-stream' });
      const url = URL.createObjectURL(blob);
      blobUrls.add(url);
      const conn = conns.get(st.from);
      if (conn) { try { conn.send({ type: 'packDone', id: st.id }); } catch { /* noop */ } }
      doneAcks.set(st.id, { peer: st.from });
      setTimeout(() => doneAcks.delete(st.id), 60000);
      if (doneAcks.size > 20) { const k = doneAcks.keys().next().value; doneAcks.delete(k); }
      appendFileMsg(st.name, st.size, false, st.from, url, st.group);
      ctx.ui.log(`mesh: reçu ${st.name} (${st.n} morceaux)`);
    }

    function abortRecv(id, notify) {
      const st = recvTransfers.get(String(id));
      if (!st) return;
      recvTransfers.delete(st.id);
      if (st.timer) clearTimeout(st.timer);
      st.row.done();
      const conn = conns.get(st.from);
      if (conn) { try { conn.send({ type: 'packCancel', id: st.id }); } catch { /* noop */ } }
      if (notify) {
        try { ctx.ui.toast(t('mesh.packCancelled', { name: st.name })); } catch { /* noop */ }
        ctx.ui.log(`mesh: réception annulée (${st.name})`);
      }
    }

    async function quitGroup(code) {      const name = groupName(code);
      const bye = { type: 'bye', group: code, from: cfg.myId };
      for (const id of membersOf(code)) {
        const conn = conns.get(id);
        if (conn) { try { conn.send(bye); } catch { /* noop */ } }
      }
      delete cfg.groups[code];
      groupMembers.delete(code);
      await saveCfg();
      try { ctx.ui.toast(t('mesh.groupLeft', { name })); } catch { /* noop */ }
      ctx.ui.log(`mesh: salon quitté (${code})`);
      renderGroups();
    }

    function updateSendEnabled() {
      const on = conns.size > 0;
      msgIn.disabled = !on; sendBtn.disabled = !on; scopeSel.disabled = !on;
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

    function appendMsg(text, mine, fromId, groupCode) {
      const m = el('div', 'msg' + (mine ? ' me' : ''));
      let meta;
      if (groupCode) {
        const who = mine ? t('mesh.me') : fromId;
        meta = el('div', 'meta', t('mesh.msgGroupMeta', { group: groupName(groupCode), who }));
      } else {
        meta = el('div', 'meta', mine ? t('mesh.me') : fromId);
      }
      const body = el('div', null, text);
      m.append(meta, body);
      chat.append(m);
      trimChat();
      chat.scrollTop = chat.scrollHeight;
    }

    function appendFileMsg(name, size, mine, fromId, blobUrl, groupCode) {
      const m = el('div', 'msg file' + (mine ? ' me' : ''));
      const who0 = mine ? t('mesh.meArrow') : t('mesh.peerArrowMe', { from: fromId });
      const who = groupCode ? t('mesh.msgGroupMeta', { group: groupName(groupCode), who: who0 }) : who0;
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

    function pendingContext(peerId) {
      // Contexte salon si le hello est déjà arrivé (file pré-acceptation).
      const q = earlyQueue.get(peerId) || [];
      for (const p of q) {
        if (p && p.type === 'hello' && p.wantJoin && cfg.groups[p.wantJoin]) {
          return t('mesh.incomingGroupAsk', { peer: peerId, name: groupName(p.wantJoin), code: p.wantJoin });
        }
        if (p && p.type === 'hello' && p.wantJoin) return `${t('mesh.incomingAsk', { peer: peerId })} · ${p.wantJoin}`;
      }
      return t('mesh.incomingAsk', { peer: peerId });
    }

    function renderPending() {
      pendingBox.innerHTML = '';
      for (const [peerId, entry] of pendingIncoming) {
        const conn = entry.conn;
        const row = el('div', 'peer');
        row.append(el('span', 'n', pendingContext(peerId)));
        const accept = el('button', 'mini', t('mesh.accept'));
        accept.onclick = () => { clearTimeout(entry.timer); pendingIncoming.delete(peerId); acceptConn(conn); renderPending(); };
        const refuse = el('button', 'mini del', t('mesh.refuse'));
        refuse.onclick = () => { clearTimeout(entry.timer); pendingIncoming.delete(peerId); earlyQueue.delete(peerId); try { conn.close(); } catch { /* noop */ } renderPending(); };
        const btns = el('div'); btns.append(accept, refuse);
        row.append(btns);
        pendingBox.append(row);
      }
    }

    function mergeMembers(fromPeer, groupsObj) {
      if (!groupsObj || typeof groupsObj !== 'object') return;
      for (const [code, info] of Object.entries(groupsObj)) {
        if (!cfg.groups[code]) continue; // salon non partagé : on ignore
        const list = info && Array.isArray(info.members) ? info.members : [];
        for (const m of list.slice(0, MAX_ADVERT_MEMBERS)) {
          if (typeof m === 'string' && m !== cfg.myId && m !== fromPeer) addMember(code, m);
        }
      }
      renderGroups();
    }

    function handlePayload(conn, payload) {
      if (!payload || typeof payload !== 'object') return;
      if (payload.type === 'hello') {
        const groupsObj = payload.groups && typeof payload.groups === 'object' ? payload.groups : {};
        peerGroups.set(conn.peer, groupsObj);
        peerCaps.set(conn.peer, payload.packV === 1);
        mergeMembers(conn.peer, groupsObj);
        // Répondre pour que l'appelant découvre aussi nos salons/membres.
        try { conn.send({ type: 'welcome', me: cfg.myId, groups: advertise(), packV: 1 }); } catch { /* noop */ }
        const want = payload.wantJoin;
        if (typeof want === 'string' && want && cfg.groups[want]) {
          if (addMember(want, conn.peer)) {
            renderGroups();
            try { ctx.ui.toast(t('mesh.memberJoined', { peer: conn.peer, group: groupName(want) })); } catch { /* noop */ }
          }
          ctx.ui.log(`mesh: ${conn.peer} a rejoint ${want}`);
        } else if (typeof want === 'string' && want) {
          ctx.ui.log(`mesh: ${conn.peer} cherche le salon ${want.slice(0, 32)} (inconnu ici)`);
          try { ctx.ui.toast(t('mesh.groupUnknownAsk', { peer: conn.peer, code: want.slice(0, 32) })); } catch { /* noop */ }
        }
        return;
      }
      if (payload.type === 'welcome') {
        const groupsObj = payload.groups && typeof payload.groups === 'object' ? payload.groups : {};
        peerGroups.set(conn.peer, groupsObj);
        peerCaps.set(conn.peer, payload.packV === 1);
        mergeMembers(conn.peer, groupsObj);
        return;
      }
      if (payload.type === 'invite') {
        const code = String(payload.group || '');
        if (!GROUP_RE.test(code)) return;
        if (cfg.groups[code]) return; // déjà membre
        invites.set(`${code}:${conn.peer}`, { group: code, name: String(payload.name || code).slice(0, 40), from: conn.peer });
        renderInvites();
        try { ctx.ui.toast(t('mesh.inviteAsk', { from: conn.peer, name: String(payload.name || code).slice(0, 40), code })); } catch { /* noop */ }
        ctx.ui.log(`mesh: invitation au salon ${code} par ${conn.peer}`);
        return;
      }
      if (payload.type === 'joined') {
        const code = String(payload.group || '');
        if (cfg.groups[code] && addMember(code, conn.peer)) {
          renderGroups();
          try { ctx.ui.toast(t('mesh.memberJoined', { peer: conn.peer, group: groupName(code) })); } catch { /* noop */ }
        }
        return;
      }
      if (payload.type === 'bye') {
        const code = String(payload.group || '');
        const m = groupMembers.get(code);
        if (m && m.delete(conn.peer)) {
          renderGroups();
          ctx.ui.log(`mesh: ${conn.peer} a quitté ${code}`);
        }
        return;
      }
      if (payload.type === 'packStart') { recvStart(conn, payload); return; }
      if (payload.type === 'packPiece') { recvPiece(conn, payload); return; }
      if (payload.type === 'packAck') {
        if (sendTransfers.size) onPackAck(conn, payload);
        return;
      }
      if (payload.type === 'packDone') {
        const tr = sendTransfers.get(String(payload.id));
        if (tr && tr.peers.has(conn.peer)) {
          const st = tr.peers.get(conn.peer);
          clearPeerTimer(st);
          tr.peers.delete(conn.peer);
          updateSendRow(tr);
          if (tr.peers.size === 0) {
            tr.row.done();
            sendTransfers.delete(tr.id);
            appendFileMsg(tr.name, tr.size, true, null, null, tr.group);
            ctx.ui.log(`mesh: envoi terminé (${tr.name})`);
          }
        }
        return;
      }
      if (payload.type === 'packCancel') {
        const id = String(payload.id);
        if (sendTransfers.has(id)) { abortSendTransfer(id, false); ctx.ui.log(`mesh: transfert annulé par ${conn.peer}`); return; }
        if (recvTransfers.has(id)) { abortRecv(id, false); return; }
        return;
      }
      // Garde anti-causerie croisée : un message taggé d'un salon qu'on
      // n'a pas est ignoré (pas d'affichage, pas de relais).
      const g = payload.group != null ? String(payload.group) : null;
      if (g && !cfg.groups[g]) return;
      if (payload.type === 'text') appendMsg(String(payload.text).slice(0, 4000), false, conn.peer, g);
      else if (payload.type === 'file') {
        const size = payload.size || 0;
        if (size > MAX_FILE_BYTES) { ctx.ui.log(`mesh: fichier refusé (${size} octets > 25 Mo)`); return; }
        const mime = String(payload.mime || 'application/octet-stream').slice(0, 128);
        const blob = new Blob([payload.data], { type: mime });
        const url = URL.createObjectURL(blob);
        blobUrls.add(url);
        appendFileMsg(String(payload.name).slice(0, 255), size, false, conn.peer, url, g);
      }
    }

    function acceptConn(conn) {
      conn.on('data', (payload) => handlePayload(conn, payload));
      conn.on('close', () => { removePeerEverywhere(conn.peer); });
      conns.set(conn.peer, conn);
      dialing.delete(conn.peer);
      // Rejoue ce qui est arrivé avant l'acceptation (hello précoce…).
      const queued = earlyQueue.get(conn.peer) || [];
      earlyQueue.delete(conn.peer);
      renderPeers(); updateSendEnabled();
      for (const p of queued) { try { handlePayload(conn, p); } catch { /* noop */ } }
      ctx.ui.log(`mesh: connexion acceptée (${conn.peer})`);
    }

    function wireConn(conn, wantJoin) {
      // Connexion SORTANTE (nous avons initié) : acceptée automatiquement.
      dialing.add(conn.peer);
      conn.on('open', () => {
        acceptConn(conn);
        try { conn.send({ type: 'hello', me: cfg.myId, groups: advertise(), wantJoin: wantJoin || null, packV: 1 }); } catch { /* noop */ }
      });
      conn.on('close', () => {
        dialing.delete(conn.peer);
        if (conns.get(conn.peer) === conn) removePeerEverywhere(conn.peer);
      });
      conn.on('error', (e) => {
        dialing.delete(conn.peer);
        ctx.ui.log(`mesh: erreur connexion (${e.message || e})`, 'e');
      });
    }

    function wireIncoming(conn) {
      // Connexion ENTRANTE : rien n'est accepté tant que l'utilisateur n'a
      // pas cliqué "Accepter". Expiration automatique après 60 s. Cap 5 demandes.
      // Les payloads pré-acceptation sont mis en file (contexte + hello),
      // rejoués à l'acceptation, jetés au refus.
      conn.on('open', () => {
        if (conns.has(conn.peer)) { try { conn.close(); } catch { /* noop */ } return; }
        if (!pendingIncoming.has(conn.peer) && pendingIncoming.size >= 5) {
          try { conn.close(); } catch { /* noop */ }
          ctx.ui.log('mesh: trop de demandes entrantes, refusée');
          return;
        }
        const old = pendingIncoming.get(conn.peer);
        if (old) { clearTimeout(old.timer); try { old.conn.close(); } catch { /* noop */ } }
        const timer = setTimeout(() => {
          pendingIncoming.delete(conn.peer);
          earlyQueue.delete(conn.peer);
          try { conn.close(); } catch { /* noop */ }
          renderPending();
          ctx.ui.log(`mesh: demande de ${conn.peer} expirée (60 s)`);
        }, PENDING_TIMEOUT_MS);
        pendingIncoming.set(conn.peer, { conn, timer });
        conn.on('data', (payload) => {
          if (conns.has(conn.peer)) { handlePayload(conn, payload); return; }
          if (!payload || typeof payload !== 'object') return;
          let q = earlyQueue.get(conn.peer);
          if (!q) { q = []; earlyQueue.set(conn.peer, q); }
          if (q.length < MAX_EARLY_QUEUE) q.push(payload);
          renderPending(); // le contexte salon peut apparaître
        });
        conn.on('close', () => {
          const e = pendingIncoming.get(conn.peer);
          if (e) { clearTimeout(e.timer); pendingIncoming.delete(conn.peer); renderPending(); }
          earlyQueue.delete(conn.peer);
          if (conns.get(conn.peer) === conn) removePeerEverywhere(conn.peer);
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

    async function dialPeer(target, wantJoin) {
      target = String(target || '').trim().toUpperCase();
      if (!TARGET_RE.test(target)) {
        ctx.ui.log(`mesh: code invalide (${target.slice(0, 32)}) — format AAA-123456`);
        try { ctx.ui.toast(t('mesh.badCode')); } catch { /* noop */ }
        return false;
      }
      if (target === cfg.myId) {
        try { ctx.ui.toast(t('mesh.selfDial')); } catch { /* noop */ }
        return false;
      }
      if (conns.has(target)) {
        try { ctx.ui.toast(t('mesh.alreadyLinked', { peer: target })); } catch { /* noop */ }
        return false;
      }
      if (dialing.has(target) || pendingIncoming.has(target)) return false;
      if (wantJoin && !GROUP_RE.test(wantJoin)) wantJoin = null;
      try {
        const p = await ensurePeer();
        const conn = p.connect(target.replace(/[^a-zA-Z0-9-]/g, ''), { reliable: true });
        wireConn(conn, wantJoin);
        return true;
      } catch (err) {
        dialing.delete(target);
        ctx.ui.log(`mesh: connexion échouée (${err.message || err})`, 'e');
        return false;
      }
    }

    connectBtn.onclick = async () => {
      const target = connectIn.value.trim();
      if (!target) return;
      if (/^GRP-/i.test(target)) {
        // Un code salon ne se compose pas : il faut passer par un membre.
        try { ctx.ui.toast(t('mesh.groupJoinViaMember')); } catch { /* noop */ }
        ctx.ui.log(`mesh: salon ${target.slice(0, 32)} — compose le code d'un membre + choisis le salon`);
        return;
      }
      const wantJoin = groupSel.value || null;
      if (await dialPeer(target, wantJoin)) connectIn.value = '';
    };

    gCreateBtn.onclick = async () => {
      const name = gNameIn.value.trim().slice(0, 40);
      if (!name) {
        try { ctx.ui.toast(t('mesh.groupNeedName')); } catch { /* noop */ }
        return;
      }
      let code = shortGroup();
      for (let i = 0; i < 5 && cfg.groups[code]; i++) code = shortGroup();
      cfg.groups[code] = { name };
      await saveCfg();
      gNameIn.value = '';
      try { ctx.ui.toast(t('mesh.groupCreated', { name, code })); } catch { /* noop */ }
      ctx.ui.log(`mesh: salon créé (${code})`);
      renderGroups();
    };

    function scopeTargets() {
      const scope = scopeSel.value;
      if (!scope || scope === 'all') return [...conns.values()];
      // Tagué salon : uniquement les pairs membres (pas de fuite 1:1).
      const out = [];
      for (const id of membersOf(scope)) {
        const conn = conns.get(id);
        if (conn) out.push({ conn, group: scope });
      }
      return out;
    }

    sendBtn.onclick = () => {
      const text = msgIn.value.trim().slice(0, 4000);
      if (!text || conns.size === 0) return;
      const scope = scopeSel.value;
      const group = scope && scope !== 'all' ? scope : null;
      const targets = scopeTargets().map((e) => (e.conn ? e : { conn: e, group: null }));
      if (!targets.length) {
        try { ctx.ui.toast(t('mesh.noTargets')); } catch { /* noop */ }
        return;
      }
      for (const { conn } of targets) {
        try { conn.send({ type: 'text', text, group, from: cfg.myId }); } catch (err) { ctx.ui.log(`mesh: envoi échoué (${err.message})`); }
      }
      appendMsg(text, true, null, group);
      msgIn.value = '';
    };
    msgIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') sendBtn.click(); });

    async function sendFile(file) {
      if (conns.size === 0) return;
      if (file.size > MAX_PACK_BYTES) {
        ctx.ui.log(`mesh: fichier trop volumineux (${(file.size / 1048576).toFixed(1)} Mo > 256 Mo) — utilisez Partage/`);
        try { ctx.ui.toast(t('mesh.packTooBig')); } catch { /* noop */ }
        return;
      }
      const scope = scopeSel.value;
      const group = scope && scope !== 'all' ? scope : null;
      const targets = scopeTargets().map((e) => (e.conn ? e : { conn: e, group: null }));
      if (!targets.length) {
        try { ctx.ui.toast(t('mesh.noTargets')); } catch { /* noop */ }
        return;
      }
      if (file.size > WARN_FILE_BYTES) {
        // Chemin morcelé (RAM bornée) : pairs à jour uniquement.
        const modern = targets.filter(({ conn }) => peerCaps.get(conn.peer));
        const legacy = targets.filter(({ conn }) => !peerCaps.get(conn.peer));
        if (legacy.length) {
          ctx.ui.log(`mesh: ${legacy.length} pair(s) en ancienne version (fichiers >8 Mo impossibles)`);
          try { ctx.ui.toast(t('mesh.packLegacy', { peer: legacy[0].conn.peer })); } catch { /* noop */ }
        }
        if (!modern.length) return;
        await startPackTransfer(file, modern, group);
        return;
      }
      // Chemin direct historique (≤8 Mo, compatible 1.2.0).
      if (file.size > MAX_FILE_BYTES) {
        ctx.ui.log(`mesh: fichier trop volumineux (${(file.size / 1048576).toFixed(1)} Mo > 25 Mo) — envoi refusé`);
        try { ctx.ui.toast(t('mesh.fileTooBig')); } catch { /* noop */ }
        return;
      }
      let buf;
      try {
        buf = await file.arrayBuffer();
      } catch (err) {
        ctx.ui.log(`mesh: lecture fichier impossible (${err.message})`);
        return;
      }
      for (const { conn } of targets) {
        try {
          conn.send({ type: 'file', name: String(file.name || 'file').slice(0, 255), size: file.size, mime: String(file.type || '').slice(0, 128), data: buf, group, from: cfg.myId });
        } catch (err) {
          ctx.ui.log(`mesh: envoi fichier échoué (${err.message})`);
        }
      }
      appendFileMsg(file.name, file.size, true, null, null, group);
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
    renderPeers(); renderGroups(); renderPending(); renderInvites(); updateSendEnabled();

    meshCleanup = () => {
      for (const entry of pendingIncoming.values()) { clearTimeout(entry.timer); try { entry.conn.close(); } catch { /* noop */ } }
      pendingIncoming.clear();
      earlyQueue.clear();
      invites.clear();
      for (const [id, tr] of sendTransfers) {
        for (const st of tr.peers.values()) clearPeerTimer(st);
        try { tr.row.done(); } catch { /* noop */ }
      }
      sendTransfers.clear();
      for (const st of recvTransfers.values()) {
        if (st.timer) clearTimeout(st.timer);
        try { st.row.done(); } catch { /* noop */ }
      }
      recvTransfers.clear();
      doneAcks.clear();
      dialing.clear();
      peerGroups.clear();
      groupMembers.clear();
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