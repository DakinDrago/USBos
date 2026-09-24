/* USBos app: agenda — vrai calendrier (vues Mois/Semaine/Jour) avec
 * import/export iCalendar (.ics, RFC 5545), compatible Google/Outlook/Apple.
 * Fuseau horaire détecté automatiquement (Intl), conversions via UTC.
 * Schéma data v2 : { version: 2, events: [...] }. Les données v1 (semaine
 * type + échéances) sont migrées automatiquement au premier chargement.
 */
const STATE_FILE = 'agenda.json';
const MAX_EVENTS = 5000;
const MAX_IMPORT_BYTES = 2 * 1024 * 1024;

const STYLE = `
.agenda-app{width:100%;flex:1;min-height:0;display:flex;flex-direction:column;overflow-x:auto;padding:2px}
.agenda-app h2{font-size:17px;margin-bottom:2px}
.agenda-app .hint{color:var(--muted);font-size:12px;margin-bottom:14px}
.agenda-app .tabs{display:flex;gap:6px;margin-bottom:12px;flex-wrap:wrap;align-items:center}
.agenda-app .tab{background:var(--panel2);border:1px solid var(--border);border-radius:8px;color:var(--muted);font-size:13px;padding:7px 13px}
.agenda-app .tab.active{background:linear-gradient(135deg,var(--accent),var(--accent2));border:none;color:#fff;font-weight:600}
.agenda-app .navrow{display:flex;gap:8px;align-items:center;margin-bottom:12px;flex-wrap:wrap}
.agenda-app .navrow .cur{font-weight:600;font-size:14px;min-width:180px}
.agenda-app .tz{color:var(--muted);font-size:11.5px;margin-left:auto}
.agenda-app .cal{display:grid;grid-template-columns:repeat(7,1fr);gap:4px;flex:1;min-height:0;grid-auto-rows:1fr;align-content:stretch;min-width:600px}
.agenda-app .dow{color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.6px;text-align:center;padding:4px 0}
.agenda-app .cell{background:var(--panel);border:1px solid var(--border);border-radius:9px;min-height:64px;padding:5px 6px;cursor:pointer;overflow:hidden}
.agenda-app .cell:hover{border-color:var(--accent)}
.agenda-app .cell.out{opacity:.38}
.agenda-app .cell.today{border-color:var(--accent);box-shadow:0 0 0 1px var(--accent) inset}
.agenda-app .cell .num{font-size:12px;color:var(--muted);font-weight:600}
.agenda-app .cell.today .num{color:var(--accent)}
.agenda-app .pill{font-size:11px;background:var(--panel2);border-radius:5px;padding:1px 5px;margin-top:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.agenda-app .pill .t{color:var(--accent);font-family:'JetBrains Mono',ui-monospace,monospace}
.agenda-app .pill.done{opacity:.5;text-decoration:line-through}
.agenda-app .more{font-size:10.5px;color:var(--muted);margin-top:2px}
.agenda-app .week{display:grid;grid-template-columns:repeat(7,1fr);gap:6px;flex:1;min-height:0;min-width:600px}
.agenda-app .wday{background:var(--panel);border:1px solid var(--border);border-radius:10px;padding:8px;min-height:120px;cursor:pointer}
.agenda-app .wday:hover{border-color:var(--accent)}
.agenda-app .wday.today{border-color:var(--accent)}
.agenda-app .wday h4{font-size:12px;color:var(--muted);margin-bottom:6px}
.agenda-app .wday h4 b{color:var(--text);font-size:15px;margin-right:4px}
.agenda-app .item{display:flex;gap:8px;align-items:center;padding:8px 10px;border-bottom:1px solid var(--border);font-size:13px;background:var(--panel);border:1px solid var(--border);border-radius:10px;margin-bottom:6px;flex-wrap:wrap}
.agenda-app .item .tm{color:var(--accent);font-family:'JetBrains Mono',ui-monospace,monospace;min-width:96px}
.agenda-app .item .tt{font-weight:600}
.agenda-app .item .loc{color:var(--muted);font-size:12px}
.agenda-app .item .ds{color:var(--muted);font-size:12px;flex-basis:100%;white-space:pre-wrap}
.agenda-app .item.done{opacity:.55}
.agenda-app .item.done .tt{text-decoration:line-through}
.agenda-app form.ev{display:flex;flex-direction:column;gap:8px;background:var(--panel);border:1px solid var(--border);border-radius:12px;padding:12px;margin:12px 0}
.agenda-app form.ev input[type=text],.agenda-app form.ev input[type=date],.agenda-app form.ev input[type=time],.agenda-app form.ev textarea{background:var(--bg);border:1px solid var(--border);border-radius:7px;color:var(--text);padding:7px 10px;font:inherit;outline:none;width:100%}
.agenda-app form.ev input:focus,.agenda-app form.ev textarea:focus{border-color:var(--accent)}
.agenda-app form.ev textarea{min-height:56px;resize:vertical}
.agenda-app form.ev .row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.agenda-app form.ev .row label{display:flex;align-items:center;gap:6px;font-size:12.5px;color:var(--text)}
.agenda-app form.ev .grow{flex:1;min-width:140px}
.agenda-app .mini{background:var(--panel2);border:1px solid var(--border);border-radius:7px;color:var(--text);font-size:12px;padding:5px 10px}
.agenda-app .mini:hover{border-color:var(--accent)}
.agenda-app .mini.del:hover{border-color:var(--err);color:var(--err)}
.agenda-app .save{background:linear-gradient(135deg,var(--accent),var(--accent2));border:none;border-radius:8px;color:#fff;font-weight:600;padding:7px 12px}
.agenda-app .save:hover{filter:brightness(1.1)}
.agenda-app .empty{color:var(--muted);font-size:12.5px;padding:10px 0}
.agenda-app .chk{accent-color:var(--accent);width:16px;height:16px;flex-shrink:0}
.agenda-app .saved{color:var(--ok);font-size:12px;margin-top:6px}
.agenda-app .io{display:flex;gap:8px;align-items:center;flex-wrap:wrap;background:var(--panel);border:1px solid var(--border);border-radius:12px;padding:12px;margin-top:14px}
.agenda-app .io .msg{font-size:12px;color:var(--muted);flex-basis:100%}
.agenda-app .io .msg.ok{color:var(--ok)}
.agenda-app .io .msg.err{color:var(--err)}
.agenda-app .confirmbox{background:var(--panel);border:1px solid var(--warn);border-radius:12px;padding:12px;margin-top:10px;font-size:13px;display:flex;gap:8px;align-items:center;flex-wrap:wrap}
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

function pad2(n) { return String(n).padStart(2, '0'); }
function toISODate(y, m, d) { return `${y}-${pad2(m)}-${pad2(d)}`; }
function todayISO() {
  const t = new Date();
  return toISODate(t.getFullYear(), t.getMonth() + 1, t.getDate());
}
function parseISODate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || '');
  if (!m) return null;
  const dt = new Date(+m[1], +m[2] - 1, +m[3]);
  if (dt.getFullYear() !== +m[1] || dt.getMonth() !== +m[2] - 1 || dt.getDate() !== +m[3]) return null;
  return dt;
}
function addDaysISO(iso, n) {
  const dt = parseISODate(iso) || new Date();
  dt.setDate(dt.getDate() + n);
  return toISODate(dt.getFullYear(), dt.getMonth() + 1, dt.getDate());
}
function addMonthsISO(iso, n) {
  const dt = parseISODate(iso) || new Date();
  const day = dt.getDate();
  dt.setDate(1);
  dt.setMonth(dt.getMonth() + n);
  dt.setDate(Math.min(day, new Date(dt.getFullYear(), dt.getMonth() + 1, 0).getDate()));
  return toISODate(dt.getFullYear(), dt.getMonth() + 1, dt.getDate());
}
function mondayOf(iso) {
  const dt = parseISODate(iso) || new Date();
  const dow = (dt.getDay() + 6) % 7; // 0 = lundi
  dt.setDate(dt.getDate() - dow);
  return toISODate(dt.getFullYear(), dt.getMonth() + 1, dt.getDate());
}
function capFirst(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }
/** Noms de jours/mois via Intl (remplace les tableaux FR JOURS/MOIS). */
function fmtDateLong(locale, iso) {
  const dt = parseISODate(iso);
  if (!dt) return iso;
  try {
    return capFirst(dt.toLocaleDateString(locale, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }));
  } catch { return iso; }
}
function fmtMonthYear(locale, iso) {
  const dt = parseISODate(iso) || new Date();
  try {
    return capFirst(dt.toLocaleDateString(locale, { month: 'long', year: 'numeric' }));
  } catch { return iso; }
}
/** Nom court du jour de semaine i (0 = lundi — le 2024-01-01 était un lundi). */
function dowShort(locale, i) {
  try {
    return new Date(2024, 0, 1 + i).toLocaleDateString(locale, { weekday: 'short' });
  } catch { return ''; }
}
function isValidTime(s) { return /^([01]\d|2[0-3]):[0-5]\d$/.test(s || ''); }

// ---------------------------------------------------------------------------
// Fuseau horaire : détection automatique, conversions heure locale <-> UTC.
// Les événements sont stockés en heure locale (date + HH:MM) ; l'export ICS
// convertit vers UTC (suffixe Z), l'import reconvertit vers le fuseau local.
// ---------------------------------------------------------------------------
function detectTZ() {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (tz) return tz;
  } catch { /* noop */ }
  return 'Europe/Paris';
}

// Offset du fuseau `tz` à l'instant `date` (minutes, est -> +60 en hiver Paris).
function tzOffsetMinutes(tz, date) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const parts = {};
  for (const p of dtf.formatToParts(date)) parts[p.type] = p.value;
  const asUTC = Date.UTC(+parts.year, +parts.month - 1, +parts.day, (+parts.hour) % 24, +parts.minute, +parts.second);
  return Math.round((asUTC - date.getTime()) / 60000);
}

// Heure locale (date ISO + HH:MM dans `tz`) -> Date (instant UTC). Itère 2x
// pour tomber juste même sur une transition DST.
function wallToUTC(isoDate, hm, tz) {
  const d = parseISODate(isoDate);
  const [H, M] = hm.split(':').map(Number);
  const base = Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), H, M, 0);
  const once = base - tzOffsetMinutes(tz, new Date(base)) * 60000;
  return new Date(base - tzOffsetMinutes(tz, new Date(once)) * 60000);
}

// Instant UTC -> { iso, hm } en heure locale du fuseau `tz`.
function utcToWall(date, tz) {
  const off = tzOffsetMinutes(tz, date);
  const w = new Date(date.getTime() + off * 60000);
  return {
    iso: toISODate(w.getUTCFullYear(), w.getUTCMonth() + 1, w.getUTCDate()),
    hm: `${pad2(w.getUTCHours())}:${pad2(w.getUTCMinutes())}`,
  };
}

function toICSStamp(date) {
  return `${date.getUTCFullYear()}${pad2(date.getUTCMonth() + 1)}${pad2(date.getUTCDate())}T${pad2(date.getUTCHours())}${pad2(date.getUTCMinutes())}${pad2(date.getUTCSeconds())}Z`;
}

// ---------------------------------------------------------------------------
// iCalendar (RFC 5545) — fonctions pures.
// ---------------------------------------------------------------------------
function icsEscape(s) {
  return String(s ?? '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r\n|\r|\n/g, '\\n');
}
function icsUnescape(s) {
  return String(s ?? '').replace(/\\N/g, '\n').replace(/\\n/g, '\n').replace(/\\;/g, ';').replace(/\\,/g, ',').replace(/\\\\/g, '\\');
}

// Pliage à 75 octets (continuation = CRLF + espace), sans couper un caractère.
function icsFold(line) {
  const enc = new TextEncoder();
  const bytes = enc.encode(line);
  const first = 75, cont = 74;
  if (bytes.length <= first) return line;
  const chars = [...line];
  let out = '', cur = '', curLen = 0, limit = first;
  for (const ch of chars) {
    const bl = enc.encode(ch).length;
    if (curLen + bl > limit) { out += cur + '\r\n '; cur = ''; curLen = 0; limit = cont; }
    cur += ch; curLen += bl;
  }
  return out + cur;
}

function icsExport(events, tz, t) {
  const L = ['BEGIN:VCALENDAR', 'PRODID:-//USBos//Agenda//FR-EN', 'VERSION:2.0', 'CALSCALE:GREGORIAN'];
  const sorted = [...events].sort((a, b) => (a.date || '').localeCompare(b.date || '') || (a.start || '99').localeCompare(b.start || '99'));
  const stamp = toICSStamp(new Date());
  for (const e of sorted) {
    const uid = (e.uid || `${e.id}@usbos`).replace(/[\r\n\s]+/g, '');
    L.push('BEGIN:VEVENT');
    L.push(`UID:${uid}`);
    L.push(`DTSTAMP:${stamp}`);
    if (e.allDay || !isValidTime(e.start)) {
      L.push(`DTSTART;VALUE=DATE:${e.date.replace(/-/g, '')}`);
      L.push(`DTEND;VALUE=DATE:${addDaysISO(e.date, 1).replace(/-/g, '')}`);
    } else {
      const s = wallToUTC(e.date, e.start, tz);
      L.push(`DTSTART:${toICSStamp(s)}`);
      const end = isValidTime(e.end) && e.end > e.start ? e.end : null;
      const eDt = end ? wallToUTC(e.date, end, tz) : new Date(s.getTime() + 3600000);
      L.push(`DTEND:${toICSStamp(eDt)}`);
    }
    L.push(`SUMMARY:${icsEscape(e.title || t('agenda.untitled'))}`);
    if (e.desc) L.push(`DESCRIPTION:${icsEscape(e.desc)}`);
    if (e.loc) L.push(`LOCATION:${icsEscape(e.loc)}`);
    if (e.done) L.push('X-USBOS-DONE:1');
    L.push('END:VEVENT');
  }
  L.push('END:VCALENDAR');
  return L.map(icsFold).join('\r\n') + '\r\n';
}

function icsParseDateTime(value, params, tz) {
  const v = String(value || '').trim();
  if (/^\d{8}$/.test(v)) {
    return { iso: `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}`, hm: '', allDay: true };
  }
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z)?$/.exec(v);
  if (!m) return null;
  const hm = `${m[4]}:${m[5]}`;
  const isoGuess = `${m[1]}-${m[2]}-${m[3]}`;
  if (!parseISODate(isoGuess)) return null;
  if (m[7] === 'Z') {
    const w = utcToWall(new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0))), tz);
    return { iso: w.iso, hm: w.hm, allDay: false };
  }
  const tzid = /TZID=([^;:]+)/i.exec(params || '');
  if (tzid && !/^(UTC|Etc\/UTC|GMT)$/i.test(tzid[1].trim())) {
    // Fuseau inconnu/distant : on garde l'heure affichée telle quelle
    // (documenté), sauf si c'est notre propre fuseau.
    if (tzid[1].trim() === tz) return { iso: isoGuess, hm, allDay: false };
    return { iso: isoGuess, hm, allDay: false, foreignTz: tzid[1].trim() };
  }
  return { iso: isoGuess, hm, allDay: false };
}

function icsImport(text, tz, t) {
  const raw = String(text || '').replace(/\r\n|\r/g, '\n').split('\n');
  // Dépliage : une ligne commençant par espace/tab prolonge la précédente.
  const lines = [];
  for (const ln of raw) {
    if (/^[ \t]/.test(ln) && lines.length) lines[lines.length - 1] += ln.slice(1);
    else lines.push(ln);
  }
  const events = [];
  let cur = null, simplified = 0, skipped = 0;
  const push = () => {
    if (!cur) return;
    // STATUS:CANCELLED : événement annulé -> ignoré (ni importé ni marqué fait).
    if (cur.cancelled) { skipped++; cur = null; return; }
    if (!cur.start) { skipped++; cur = null; return; } // VEVENT sans DTSTART
    events.push({
      id: newId(), uid: (cur.uid || `${newId()}@usbos`).slice(0, 255),
      title: (cur.title || t('agenda.untitled')).slice(0, 200),
      date: cur.start.iso, start: cur.start.allDay ? '' : cur.start.hm,
      end: cur.end && !cur.end.allDay ? cur.end.hm : '',
      allDay: cur.start.allDay, desc: (cur.desc || '').slice(0, 2000),
      loc: (cur.loc || '').slice(0, 200), done: !!cur.done,
      foreignTz: cur.start.foreignTz || '',
    });
    if (cur.rrule) simplified++;
    cur = null;
  };
  for (const ln of lines) {
    const idx = ln.indexOf(':');
    if (idx < 0) continue;
    const head = ln.slice(0, idx), val = ln.slice(idx + 1);
    const semi = head.indexOf(';');
    const prop = (semi < 0 ? head : head.slice(0, semi)).toUpperCase();
    const params = semi < 0 ? '' : head.slice(semi + 1);
    if (prop === 'BEGIN' && val.toUpperCase() === 'VEVENT') { cur = {}; continue; }
    if (prop === 'END' && val.toUpperCase() === 'VEVENT') { push(); continue; }
    if (!cur) continue;
    if (prop === 'UID') cur.uid = val.trim();
    else if (prop === 'SUMMARY') cur.title = icsUnescape(val);
    else if (prop === 'DESCRIPTION') cur.desc = icsUnescape(val);
    else if (prop === 'LOCATION') cur.loc = icsUnescape(val);
    else if (prop === 'DTSTART') cur.start = icsParseDateTime(val, params, tz);
    else if (prop === 'DTEND' || prop === 'DUE') cur.end = icsParseDateTime(val, params, tz);
    else if (prop === 'RRULE') cur.rrule = val;
    else if (prop === 'X-USBOS-DONE') cur.done = val.trim() === '1';
    // Pas d'expansion RRULE complète : importé en occurrence unique (cf. confirmRrule).
    else if (prop === 'STATUS' && /cancelled/i.test(val)) cur.cancelled = true;
  }
  return { events: events.slice(0, MAX_EVENTS), skipped, simplified };
}

// ---------------------------------------------------------------------------
// Migration v1 (semaine type + échéances) -> v2 (événements datés).
// ---------------------------------------------------------------------------
function migrateV1(data, t) {
  const events = [];
  const weekStart = mondayOf(todayISO()); // semaine courante à venir
  const dayKeys = ['lun', 'mar', 'mer', 'jeu', 'ven', 'sam', 'dim'];
  if (data.days && typeof data.days === 'object') {
    dayKeys.forEach((k, i) => {
      const items = Array.isArray(data.days[k]) ? data.days[k] : [];
      for (const it of items) {
        if (!it || typeof it !== 'object') continue;
        const start = isValidTime((it.time || '').trim()) ? it.time.trim() : '';
        events.push({
          id: newId(), uid: `${newId()}@usbos`,
          title: String(it.title || it.text || t('agenda.untitled')).slice(0, 200),
          date: addDaysISO(weekStart, i), start, end: '', allDay: !start,
          desc: t('agenda.migratedWeek'), loc: '', done: false,
        });
      }
    });
  }
  for (const d of Array.isArray(data.deadlines) ? data.deadlines : []) {
    if (!d || typeof d !== 'object') continue;
    if (!parseISODate(d.date || '')) continue;
    events.push({
      id: newId(), uid: `${newId()}@usbos`,
      title: String(d.title || t('agenda.untitled')).slice(0, 200),
      date: d.date, start: '', end: '', allDay: true,
      desc: '', loc: '', done: !!d.done,
    });
  }
  return { version: 2, events: events.slice(0, MAX_EVENTS) };
}

function sanitizeEvent(e, t) {
  if (!e || typeof e !== 'object') return null;
  if (!parseISODate(e.date || '')) return null;
  const start = isValidTime(e.start) ? e.start : '';
  let end = isValidTime(e.end) ? e.end : '';
  if (end && (!start || end <= start)) end = '';
  return {
    id: String(e.id || newId()).slice(0, 128),
    uid: String(e.uid || `${e.id || newId()}@usbos`).slice(0, 255),
    title: String(e.title || (t ? t('agenda.untitled') : '(sans titre)')).slice(0, 200),
    date: e.date, start, end, allDay: !start || !!e.allDay,
    desc: String(e.desc || '').slice(0, 2000),
    loc: String(e.loc || '').slice(0, 200),
    done: !!e.done,
  };
}

const USBosApp = {
  id: 'agenda',
  async mount(ctx, stage) {
    stage.append(el('style', null, STYLE));
    const t = ctx.i18n.t;
    const tp = ctx.i18n.tp;
    const locale = ctx.i18n.locale;
    const TZ = detectTZ();

    let data;
    try { data = await ctx.fs.readJSON(STATE_FILE); } catch { /* premier lancement */ }
    if (!data || typeof data !== 'object') data = { version: 2, events: [] };
    if (data.version !== 2 || !Array.isArray(data.events)) {
      const migrated = migrateV1(data, t);
      data = migrated;
      try { await ctx.fs.writeJSON(STATE_FILE, data); } catch { /* persisté au prochain save */ }
      ctx.ui.log(`agenda: migration v1 -> v2 (${data.events.length} événement(s))`);
    }
    const _rawLen = Array.isArray(data.events) ? data.events.length : 0;
    let events = (data.events || []).map((e) => sanitizeEvent(e, t)).filter(Boolean).slice(0, MAX_EVENTS);
    if (_rawLen > MAX_EVENTS) ctx.ui.log(`agenda: liste tronquée à ${MAX_EVENTS} événements (quota)`);

    let view = 'month'; // month | week | day
    let cursor = todayISO();
    let editingId = null; // null = création, undefined = formulaire fermé
    let formOpen = false;
    let saveCurrent = null; // bouton save du formulaire visible (Ctrl+S)
    let onDoc = null;
    const delTimers = new Set();
    const blobUrls = new Set();

    const saved = el('div', 'saved');
    async function persist() {
      try {
        await ctx.fs.writeJSON(STATE_FILE, { version: 2, events });
        saved.textContent = t('agenda.savedAt', { time: new Date().toLocaleTimeString(locale) });
        ctx.ui.log(`agenda: ${events.length} événement(s) écrits`);
      } catch (err) {
        saved.textContent = t('agenda.saveFailed', { error: err.message });
        ctx.ui.log('agenda: échec persist (' + err.message + ')');
      }
    }

    const byDate = () => {
      const m = new Map();
      for (const e of events) {
        if (!m.has(e.date)) m.set(e.date, []);
        m.get(e.date).push(e);
      }
      for (const list of m.values()) list.sort((a, b) => (a.allDay ? '' : a.start).localeCompare(b.allDay ? '' : b.start));
      return m;
    };
    const fmtWhen = (e) => (e.allDay ? t('agenda.dayAll') : e.start + (e.end ? '–' + e.end : ''));

    const wrap = el('div', 'agenda-app');
    wrap.append(
      el('h2', null, t('agenda.title')),
      el('p', 'hint', t('agenda.hint')),
    );
    const tabs = el('div', 'tabs');
    const navRow = el('div', 'navrow');
    const searchIn = el('input'); searchIn.placeholder = t('agenda.searchPh'); searchIn.setAttribute('aria-label', t('agenda.searchAria'));
    searchIn.addEventListener('input', () => { renderAll(); });
    searchIn.addEventListener('keydown', (e) => { if (e.key === 'Escape') { searchIn.value = ''; renderAll(); } });
    // Handler clavier unique (fusion des deux anciens) : Ctrl+S + focus recherche via "/".
    onDoc = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        if (saveCurrent) saveCurrent.click();
        return;
      }
      if (e.key === '/' && !/^(INPUT|TEXTAREA)$/.test(document.activeElement && document.activeElement.tagName || '')) {
        e.preventDefault(); searchIn.focus();
      }
    };
    document.addEventListener('keydown', onDoc);
    const body = el('div');
    wrap.append(tabs, navRow, searchIn, body);

    function renderSearch(q) {
      body.innerHTML = '';
      const hits = events
        .filter((e) => `${e.title || ''}\n${e.loc || ''}\n${e.desc || ''}`.toLowerCase().includes(q))
        .sort((a, b) => (a.date || '').localeCompare(b.date || '') || (a.allDay ? '' : a.start || '99').localeCompare(b.allDay ? '' : b.start || '99'))
        .slice(0, 100);
      body.append(el('div', 'count', t('agenda.results', { n: hits.length })));
      if (!hits.length) { body.append(el('div', 'empty', t('agenda.noResult'))); return; }
      for (const e of hits) {
        const row = el('div', 'item' + (e.done ? ' done' : ''));
        row.append(el('span', 'tm', e.date.slice(5).replace('-', '/') + ' ' + fmtWhen(e)));
        row.append(el('span', 'tt', e.title));
        if (e.loc) row.append(el('span', 'loc', '@ ' + e.loc));
        const go = el('button', 'mini', t('agenda.viewDay'));
        go.type = 'button';
        go.onclick = () => { cursor = e.date; view = 'day'; searchIn.value = ''; renderAll(); };
        row.append(go);
        body.append(row);
      }
    }

    function renderTabs() {
      tabs.innerHTML = '';
      for (const [k, label] of [['month', t('agenda.tabMonth')], ['week', t('agenda.tabWeek')], ['day', t('agenda.tabDay')]]) {
        const b = el('button', 'tab' + (view === k ? ' active' : ''), label);
        b.type = 'button';
        b.onclick = () => { view = k; formOpen = false; editingId = undefined; renderAll(); };
        tabs.append(b);
      }
    }

    function renderNav() {
      navRow.innerHTML = '';
      const prev = el('button', 'mini', '◀'); prev.type = 'button';
      const next = el('button', 'mini', '▶'); next.type = 'button';
      const today = el('button', 'mini', t('agenda.today')); today.type = 'button';
      const step = view === 'month' ? 1 : view === 'week' ? 7 : 1;
      prev.onclick = () => { cursor = view === 'month' ? addMonthsISO(cursor, -1) : addDaysISO(cursor, -step); renderAll(); };
      next.onclick = () => { cursor = view === 'month' ? addMonthsISO(cursor, 1) : addDaysISO(cursor, step); renderAll(); };
      today.onclick = () => { cursor = todayISO(); renderAll(); };
      const label = view === 'month' ? fmtMonthYear(locale, cursor)
        : view === 'week' ? t('agenda.weekOf', { date: fmtDateLong(locale, mondayOf(cursor)) }) : fmtDateLong(locale, cursor);
      navRow.append(prev, today, next, el('span', 'cur', label), el('span', 'tz', t('agenda.tzLabel', { tz: TZ })));
    }

    function eventPill(e) {
      const p = el('div', 'pill' + (e.done ? ' done' : ''));
      if (!e.allDay) p.append(el('span', 't', e.start + ' '));
      p.append(el('span', null, e.title));
      p.title = `${fmtWhen(e)} — ${e.title}${e.loc ? ' @ ' + e.loc : ''}`;
      return p;
    }

    function renderMonth() {
      body.innerHTML = '';
      const map = byDate();
      const dt = parseISODate(cursor) || new Date();
      const first = new Date(dt.getFullYear(), dt.getMonth(), 1);
      const offset = (first.getDay() + 6) % 7;
      const startCell = new Date(first);
      startCell.setDate(1 - offset);
      const grid = el('div', 'cal');
      for (let i = 0; i < 7; i++) grid.append(el('div', 'dow', dowShort(locale, i)));
      const today = todayISO();
      for (let i = 0; i < 42; i++) {
        const d = new Date(startCell);
        d.setDate(startCell.getDate() + i);
        const iso = toISODate(d.getFullYear(), d.getMonth() + 1, d.getDate());
        const cell = el('div', 'cell' + (d.getMonth() !== dt.getMonth() ? ' out' : '') + (iso === today ? ' today' : ''));
        cell.append(el('div', 'num', String(d.getDate())));
        const list = map.get(iso) || [];
        list.slice(0, 3).forEach((e) => cell.append(eventPill(e)));
        if (list.length > 3) cell.append(el('div', 'more', tp('agenda.moreOthers', list.length - 3)));
        cell.onclick = () => { cursor = iso; view = 'day'; renderAll(); };
        grid.append(cell);
      }
      body.append(grid);
    }

    function renderWeek() {
      body.innerHTML = '';
      const map = byDate();
      const mon = mondayOf(cursor);
      const today = todayISO();
      const grid = el('div', 'week');
      for (let i = 0; i < 7; i++) {
        const iso = addDaysISO(mon, i);
        const dt = parseISODate(iso);
        const col = el('div', 'wday' + (iso === today ? ' today' : ''));
        col.append(el('h4', null, `${dowShort(locale, i)} ${dt.getDate()}/${dt.getMonth() + 1}`));
        const list = map.get(iso) || [];
        if (list.length === 0) col.append(el('div', 'empty', '—'));
        list.slice(0, 5).forEach((e) => col.append(eventPill(e)));
        if (list.length > 5) col.append(el('div', 'more', tp('agenda.moreOthers', list.length - 5)));
        col.onclick = () => { cursor = iso; view = 'day'; renderAll(); };
        grid.append(col);
      }
      body.append(grid);
    }

    function renderDay() {
      body.innerHTML = '';
      const list = (byDate().get(cursor) || []);
      if (list.length === 0) {
        body.append(el('div', 'empty', t('agenda.emptyDay')));
        const add = el('button', 'mini', t('agenda.addEvent')); add.type = 'button';
        add.onclick = () => { formOpen = true; editingId = null; renderAll(); };
        body.append(add);
      }
      for (const e of list) {
        const row = el('div', 'item' + (e.done ? ' done' : ''));
        const chk = el('input'); chk.type = 'checkbox'; chk.className = 'chk'; chk.checked = !!e.done;
        chk.onchange = async () => { e.done = chk.checked; await persist(); renderAll(); };
        row.append(chk, el('span', 'tm', fmtWhen(e)));
        const main = el('span', 'tt', e.title);
        row.append(main);
        if (e.loc) row.append(el('span', 'loc', '@ ' + e.loc));
        if (e.foreignTz) row.append(el('span', 'loc', t('agenda.foreignTz', { tz: e.foreignTz })));
        if (e.desc) row.append(el('div', 'ds', e.desc));
        const edit = el('button', 'mini', t('agenda.edit'));
        edit.type = 'button';
        edit.onclick = () => { editingId = e.id; formOpen = true; renderAll(); };
        const del = el('button', 'mini del', t('agenda.delete'));
        del.type = 'button';
        let armDel = null;
        del.onclick = async () => {
          if (armDel) {
            clearTimeout(armDel); delTimers.delete(armDel); armDel = null;
            events = events.filter((x) => x.id !== e.id); await persist(); renderAll();
            ctx.ui.toast(t('agenda.deleted'));
            return;
          }
          del.textContent = t('agenda.sure');
          armDel = setTimeout(() => { delTimers.delete(armDel); armDel = null; del.textContent = t('agenda.delete'); }, 4000);
          delTimers.add(armDel);
        };
        row.append(edit, del);
        body.append(row);
      }
      renderForm();
    }

    // --- formulaire création/édition ---
    const titleIn = el('input'); titleIn.type = 'text'; titleIn.placeholder = t('agenda.titlePh');
    const dateIn = el('input'); dateIn.type = 'date';
    const allDayIn = el('input'); allDayIn.type = 'checkbox';
    const startIn = el('input'); startIn.type = 'time';
    const endIn = el('input'); endIn.type = 'time';
    const locIn = el('input'); locIn.type = 'text'; locIn.placeholder = t('agenda.locPh');
    const descIn = el('textarea'); descIn.placeholder = t('agenda.descPh');
    function renderForm() {
      const f = el('form', 'ev');
      const head = el('div', 'row');
      const toggleBtn = el('button', 'mini', formOpen ? t('agenda.close') : t('agenda.newEvent'));
      toggleBtn.type = 'button';
      toggleBtn.onclick = () => { formOpen = !formOpen; editingId = null; renderAll(); };
      head.append(toggleBtn);
      if (editingId) head.append(el('span', 'hint', t('agenda.editing')));
      f.append(head);
      if (!formOpen && !editingId) { body.append(f); return; }
      if (editingId) {
        const e = events.find((x) => x.id === editingId);
        if (e) {
          titleIn.value = e.title; dateIn.value = e.date; allDayIn.checked = e.allDay;
          startIn.value = e.start || ''; endIn.value = e.end || '';
          locIn.value = e.loc || ''; descIn.value = e.desc || '';
        }
      } else {
        titleIn.value = ''; dateIn.value = cursor; allDayIn.checked = false;
        startIn.value = ''; endIn.value = ''; locIn.value = ''; descIn.value = '';
      }
      const syncTime = () => { startIn.disabled = allDayIn.checked; endIn.disabled = allDayIn.checked; };
      allDayIn.onchange = syncTime; syncTime();
      titleIn.className = 'grow';
      const r1 = el('div', 'row'); r1.append(titleIn);
      const r2 = el('div', 'row'); r2.append(dateIn, startIn, endIn);
      const r3 = el('div', 'row');
      const adLbl = el('label', null, ''); adLbl.append(allDayIn, document.createTextNode(t('agenda.allDay')));
      r3.append(adLbl);
      const r4 = el('div', 'row'); r4.append(locIn);
      const save = el('button', 'save', editingId ? t('agenda.update') : t('agenda.add')); save.type = 'button';
      saveCurrent = save;
      const cancel = el('button', 'mini', t('agenda.cancel')); cancel.type = 'button';
      cancel.onclick = () => { formOpen = false; editingId = undefined; renderAll(); };
      save.onclick = async () => {
        const title = titleIn.value.trim().slice(0, 200);
        if (!title || !parseISODate(dateIn.value)) return;
        const allDay = allDayIn.checked || !isValidTime(startIn.value);
        let end = isValidTime(endIn.value) ? endIn.value : '';
        if (end && (!isValidTime(startIn.value) || end <= startIn.value)) end = '';
        if (events.length >= MAX_EVENTS && !editingId) { ctx.ui.log(`agenda: quota ${MAX_EVENTS} événements atteint, création refusée`); return; }
        if (editingId) {
          const e = events.find((x) => x.id === editingId);
          if (e) Object.assign(e, {
            title, date: dateIn.value, allDay,
            start: allDay ? '' : startIn.value, end: allDay ? '' : end,
            loc: locIn.value.trim().slice(0, 200), desc: descIn.value.slice(0, 2000),
          });
          editingId = undefined; formOpen = false;
        } else {
          events.push({
            id: newId(), uid: `${newId()}@usbos`, title, date: dateIn.value, allDay,
            start: allDay ? '' : startIn.value, end: allDay ? '' : end,
            loc: locIn.value.trim().slice(0, 200), desc: descIn.value.slice(0, 2000), done: false,
          });
          cursor = dateIn.value;
          formOpen = false;
        }
        await persist(); renderAll();
      };
      f.onsubmit = (ev) => { ev.preventDefault(); save.click(); };
      const r5 = el('div', 'row'); r5.append(save, cancel);
      f.append(r1, r2, r3, r4, descIn, r5);
      body.append(f);
    }

    // --- import / export ---
    const ioMsg = el('div', 'msg');
    const io = el('div', 'io');
    const expBtn = el('button', 'save', t('agenda.expIcs')); expBtn.type = 'button';
    expBtn.onclick = () => {      try {
        const text = icsExport(events, TZ, t);
        const blob = new Blob([text], { type: 'text/calendar;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        blobUrls.add(url);
        const a = document.createElement('a');
        a.href = url; a.download = `agenda-${todayISO()}.ics`; a.textContent = '';
        io.append(a); a.click(); a.remove();
        setTimeout(() => { try { URL.revokeObjectURL(url); } catch { /* noop */ } blobUrls.delete(url); }, 5000);
        ioMsg.className = 'msg ok';
        ioMsg.textContent = t('agenda.exportedN', { n: events.length, tz: TZ });
        ctx.ui.log(`agenda: export ics (${events.length} événements)`);
      } catch (err) {
        ioMsg.className = 'msg err';
        ioMsg.textContent = t('agenda.exportFailed', { error: err.message });
      }
    };
    const expSharedBtn = el('button', 'mini', t('agenda.expShared')); expSharedBtn.type = 'button';
    expSharedBtn.title = t('agenda.expSharedTitle');
    expSharedBtn.onclick = async () => {
      try {
        const name = `agenda-${todayISO()}.ics`;
        const text = icsExport(events, TZ, t);
        if (new TextEncoder().encode(text).length > 2 * 1024 * 1024) {
          ioMsg.className = 'msg err';
          ioMsg.textContent = t('agenda.exportFailed', { error: String(locale || '').toLowerCase().startsWith('en') ? '2 MB max' : '2 Mo max' });
          ctx.ui.log('agenda: export Partage refusé (>2 Mo)');
          return;
        }
        await ctx.fs.writeSharedText(name, text);
        ioMsg.className = 'msg ok';
        ioMsg.textContent = t('agenda.exportedTo', { name });
        ctx.ui.log(`agenda: export Partage/${name}`);
        ctx.ui.toast(t('agenda.exportedToast', { name }));
      } catch (err) {
        ioMsg.className = 'msg err';
        ioMsg.textContent = t('agenda.exportFailed', { error: err.message });
      }
    };
    const fileIn = el('input'); fileIn.type = 'file'; fileIn.accept = '.ics,.ical,text/calendar'; fileIn.hidden = true;
    const impBtn = el('button', 'mini', t('agenda.impIcs')); impBtn.type = 'button';
    impBtn.onclick = () => fileIn.click();
    const confirmBox = el('div', 'confirmbox'); confirmBox.hidden = true;
    let pendingImport = null;
    function proposeImport(res) {
      try {
        const _foreign = res.events.filter((e) => e.foreignTz).length;
        if (_foreign) ctx.ui.log(`agenda: ${_foreign} event(s) with remote TZID, source time kept`);
      } catch { /* noop */ }
      const known = new Set(events.map((e) => e.uid));
      const fresh = res.events.filter((e) => !known.has(e.uid));
      const dups = res.events.length - fresh.length;
      if (fresh.length === 0) {
        ioMsg.className = 'msg';
        ioMsg.textContent = t('agenda.nothingToImport', { dups, skipped: res.skipped });
        return;
      }
      pendingImport = fresh;
      confirmBox.innerHTML = '';
      confirmBox.hidden = false;
      confirmBox.append(el('span', null,
        t('agenda.confirmImport', { n: fresh.length }) +
        (dups ? t('agenda.confirmDups', { dups }) : '') +
        (res.simplified ? t('agenda.confirmRrule', { n: res.simplified }) : '') +
        (res.skipped ? t('agenda.confirmSkipped', { n: res.skipped }) : '')));
      const ok = el('button', 'save', t('agenda.import')); ok.type = 'button';
      ok.onclick = async () => {
        const _combined = events.length + pendingImport.length;
        events = [...events, ...pendingImport].slice(0, MAX_EVENTS);
        if (_combined > MAX_EVENTS) ctx.ui.log(`agenda: import truncated to ${MAX_EVENTS} events (quota)`);
        pendingImport = null; confirmBox.hidden = true; confirmBox.innerHTML = '';
        await persist(); renderAll();
        ioMsg.className = 'msg ok';
        ioMsg.textContent = t('agenda.importDone');
        ctx.ui.toast(t('agenda.importToast'));
      };
      const no = el('button', 'mini', t('agenda.cancel')); no.type = 'button';
      no.onclick = () => { pendingImport = null; confirmBox.hidden = true; confirmBox.innerHTML = ''; };
      confirmBox.append(ok, no);
    }
    function importIcsText(text) {
      let res;
      try {
        res = icsImport(text, TZ, t);
      } catch (err) {
        ioMsg.className = 'msg err';
        ioMsg.textContent = t('agenda.invalidIcs', { error: err.message });
        ctx.ui.toast(t('agenda.importFailed', { error: err.message }));
        return;
      }
      proposeImport(res);
    }
    fileIn.onchange = async () => {
      const f = fileIn.files[0];
      fileIn.value = '';
      if (!f) return;
      if (f.size > MAX_IMPORT_BYTES) {
        ioMsg.className = 'msg err';
        ioMsg.textContent = t('agenda.tooBig');
        return;
      }
      let text;
      try {
        text = await f.text();
      } catch (err) {
        ioMsg.className = 'msg err';
        ioMsg.textContent = t('agenda.readFailed', { error: err.message });
        ctx.ui.toast(t('agenda.importFailed', { error: err.message }));
        return;
      }
      importIcsText(text);
    };
    const sharedBox = el('div'); sharedBox.hidden = true;
    const fromSharedBtn = el('button', 'mini', t('agenda.fromShared')); fromSharedBtn.type = 'button';
    fromSharedBtn.onclick = async () => {
      sharedBox.innerHTML = '';
      sharedBox.hidden = false;
      let files;
      try {
        files = await ctx.fs.listShared('');
      } catch (err) {
        ioMsg.className = 'msg err';
        ioMsg.textContent = t('shell.settings.sharedNoAccess');
        ctx.ui.toast(t('shell.settings.sharedNoAccess'));
        return;
      }
      const icsFiles = (Array.isArray(files) ? files : [])
        .filter((e) => e && e.kind === 'file' && String(e.name || '').toLowerCase().endsWith('.ics'))
        .slice(0, 20);
      if (icsFiles.length === 0) { sharedBox.append(el('div', 'empty', t('agenda.sharedNone'))); return; }
      for (const f of icsFiles) {
        const row = el('div', 'item');
        row.append(el('span', 'tt', String(f.name || '').slice(0, 200)));
        const imp = el('button', 'mini', t('agenda.import')); imp.type = 'button';
        imp.onclick = async () => {
          try {
            const text = await ctx.fs.readSharedText(f.name);
            importIcsText(text);
            ctx.ui.log(`agenda: import shared ${f.name}`);
          } catch (err) {
            ioMsg.className = 'msg err';
            ioMsg.textContent = t('agenda.importFailed', { error: err.message });
            ctx.ui.toast(t('agenda.importFailed', { error: err.message }));
          }
        };
        row.append(imp);
        sharedBox.append(row);
      }
    };
    io.append(expBtn, expSharedBtn, impBtn, fromSharedBtn, fileIn, ioMsg);

    function renderAll() {
      saveCurrent = null;
      renderTabs(); renderNav();
      const q = searchIn.value.trim().toLowerCase();
      if (q) { renderSearch(q); return; }
      if (view === 'month') renderMonth();
      else if (view === 'week') renderWeek();
      else renderDay();
      if (view !== 'day') renderFormInline();
    }
    function renderFormInline() {
      // Formulaire de création rapide sous les vues Mois/Semaine.
      const f = el('form', 'ev');
      const toggleBtn = el('button', 'mini', formOpen ? t('agenda.close') : t('agenda.newEvent'));
      toggleBtn.type = 'button';
      toggleBtn.onclick = () => { formOpen = !formOpen; editingId = null; renderAll(); };
      const head = el('div', 'row'); head.append(toggleBtn);
      f.append(head);
      if (formOpen) {
        titleIn.value = ''; dateIn.value = cursor; allDayIn.checked = false;
        startIn.value = ''; endIn.value = ''; locIn.value = ''; descIn.value = '';
        const syncTime = () => { startIn.disabled = allDayIn.checked; endIn.disabled = allDayIn.checked; };
        allDayIn.onchange = syncTime; syncTime();
        titleIn.className = 'grow';
        const r1 = el('div', 'row'); r1.append(titleIn);
        const r2 = el('div', 'row'); r2.append(dateIn, startIn, endIn);
        const r3 = el('div', 'row');
        const adLbl = el('label', null, ''); adLbl.append(allDayIn, document.createTextNode(t('agenda.allDay')));
        r3.append(adLbl);
        const r4 = el('div', 'row'); r4.append(locIn);
        const save = el('button', 'save', t('agenda.add')); save.type = 'button';
        saveCurrent = save;
        save.onclick = async () => {
          const title = titleIn.value.trim().slice(0, 200);
          if (!title || !parseISODate(dateIn.value) || events.length >= MAX_EVENTS) { if (events.length >= MAX_EVENTS) ctx.ui.log(`agenda: quota ${MAX_EVENTS} événements atteint, création refusée`); return; }
          const allDay = allDayIn.checked || !isValidTime(startIn.value);
          let end = isValidTime(endIn.value) ? endIn.value : '';
          if (end && (!isValidTime(startIn.value) || end <= startIn.value)) end = '';
          events.push({
            id: newId(), uid: `${newId()}@usbos`, title, date: dateIn.value, allDay,
            start: allDay ? '' : startIn.value, end: allDay ? '' : end,
            loc: locIn.value.trim().slice(0, 200), desc: descIn.value.slice(0, 2000), done: false,
          });
          cursor = dateIn.value; formOpen = false;
          await persist(); renderAll();
        };
        f.onsubmit = (ev) => { ev.preventDefault(); save.click(); };
        const r5 = el('div', 'row'); r5.append(save);
        f.append(r1, r2, r3, r4, descIn, r5);
      }
      body.append(f);
    }

    const helpLine = el('div', 'hint', t('agenda.helpLine'));
    wrap.append(helpLine, io, sharedBox, confirmBox, saved);
    stage.append(wrap);
    renderAll();
    try {
      this._agendaCleanup = () => {
        if (onDoc) document.removeEventListener('keydown', onDoc);
        for (const tm of delTimers) clearTimeout(tm);
        delTimers.clear();
        for (const u of blobUrls) { try { URL.revokeObjectURL(u); } catch { /* noop */ } }
        blobUrls.clear();
        saveCurrent = null;
      };
    } catch { /* noop */ }
  },
  async unmount() { if (this && this._agendaCleanup) { try { this._agendaCleanup(); } catch { /* noop */ } this._agendaCleanup = null; } },
}
return USBosApp;
