/* InVettura — app client */
'use strict';

const BASE = (window.INVETTURA_API || '').replace(/\/$/, '');
const API = {
  gtfs: BASE + '/api/gtfs',
  vehicles: BASE + '/api/rt/vehicles',
  trips: BASE + '/api/rt/trips',
  alerts: BASE + '/api/rt/alerts',
};
const RT_INTERVAL = 20000;
const QS = new URLSearchParams(location.search);
const PICK = QS.get('pick') === '1';
const EMBED = QS.get('embed') === '1' || PICK;
if (EMBED && !PICK) document.documentElement.classList.add('embed');
// theme: follows RDE's setting (rde_theme) when present
function applyTheme() {
  let t = 'auto'; try { t = localStorage.getItem('rde_theme') || localStorage.getItem('iv.theme') || 'auto'; } catch (e) {}
  if (t === 'auto') document.documentElement.removeAttribute('data-theme'); else document.documentElement.dataset.theme = t;
}
applyTheme();
window.addEventListener('storage', e => { if (e.key === 'rde_theme') applyTheme(); });
const DATA_VERSION = 3; // bump when the cached data structure changes

/* ---------------- Protobuf (GTFS-Realtime) ---------------- */
class PB {
  constructor(buf, start = 0, end = buf.length) { this.b = buf; this.p = start; this.e = end; }
  more() { return this.p < this.e; }
  varint() {
    let r = 0, m = 1, x;
    do { x = this.b[this.p++]; r += (x & 0x7f) * m; m *= 128; } while (x & 0x80);
    return r;
  }
  svarint32() { const v = this.varint(); return v >= 9223372036854775808 ? v - 18446744073709551616 : v > 0x7fffffff ? v - 0x100000000 : v; } // int32 (negatives arrive as 64-bit)
  key() { const k = this.varint(); return [Math.floor(k / 8), k & 7]; }
  sub() { const len = this.varint(); const s = new PB(this.b, this.p, this.p + len); this.p += len; return s; }
  str() { const len = this.varint(); const s = PB.td.decode(this.b.subarray(this.p, this.p + len)); this.p += len; return s; }
  float() { const v = new DataView(this.b.buffer, this.b.byteOffset + this.p, 4).getFloat32(0, true); this.p += 4; return v; }
  double() { const v = new DataView(this.b.buffer, this.b.byteOffset + this.p, 8).getFloat64(0, true); this.p += 8; return v; }
  skip(t) {
    if (t === 0) this.varint();
    else if (t === 1) this.p += 8;
    else if (t === 2) { const n = this.varint(); this.p += n; }
    else if (t === 5) this.p += 4;
    else throw new Error('wire type ' + t);
  }
}
PB.td = new TextDecoder();

function pbTrip(s) {
  const t = {};
  while (s.more()) {
    const [f, w] = s.key();
    if (f === 1 && w === 2) t.trip_id = s.str();
    else if (f === 5 && w === 2) t.route_id = s.str();
    else if (f === 6 && w === 0) t.direction_id = s.varint();
    else if (f === 4 && w === 0) t.sr = s.varint();
    else s.skip(w);
  }
  return t;
}
function pbVehDesc(s) {
  const v = {};
  while (s.more()) {
    const [f, w] = s.key();
    if (f === 1 && w === 2) v.id = s.str();
    else if (f === 2 && w === 2) v.label = s.str();
    else if (f === 3 && w === 2) v.plate = s.str();
    else s.skip(w);
  }
  return v;
}
function pbEvent(s) {
  const e = {};
  while (s.more()) {
    const [f, w] = s.key();
    if (f === 1 && w === 0) e.delay = s.svarint32();
    else if (f === 2 && w === 0) e.time = s.varint();
    else s.skip(w);
  }
  return e;
}
function pbStu(s) {
  const u = {};
  while (s.more()) {
    const [f, w] = s.key();
    if (f === 1 && w === 0) u.seq = s.varint();
    else if (f === 2 && w === 2) u.arr = pbEvent(s.sub());
    else if (f === 3 && w === 2) u.dep = pbEvent(s.sub());
    else if (f === 4 && w === 2) u.stop_id = s.str();
    else if (f === 5 && w === 0) u.sr = s.varint();
    else s.skip(w);
  }
  return u;
}
function pbTripUpdate(s) {
  const t = { stu: [] };
  while (s.more()) {
    const [f, w] = s.key();
    if (f === 1 && w === 2) t.trip = pbTrip(s.sub());
    else if (f === 2 && w === 2) t.stu.push(pbStu(s.sub()));
    else if (f === 3 && w === 2) t.vehicle = pbVehDesc(s.sub());
    else if (f === 4 && w === 0) t.ts = s.varint();
    else s.skip(w);
  }
  return t;
}
function pbPosition(s) {
  const p = {};
  while (s.more()) {
    const [f, w] = s.key();
    if (f === 1 && w === 5) p.lat = s.float();
    else if (f === 2 && w === 5) p.lon = s.float();
    else if (f === 3 && w === 5) p.bearing = s.float();
    else if (f === 5 && w === 5) p.speed = s.float();
    else s.skip(w);
  }
  return p;
}
function pbVehicle(s) {
  const v = {};
  while (s.more()) {
    const [f, w] = s.key();
    if (f === 1 && w === 2) v.trip = pbTrip(s.sub());
    else if (f === 2 && w === 2) v.pos = pbPosition(s.sub());
    else if (f === 3 && w === 0) v.seq = s.varint();
    else if (f === 4 && w === 0) v.status = s.varint();
    else if (f === 5 && w === 0) v.ts = s.varint();
    else if (f === 7 && w === 2) v.stop_id = s.str();
    else if (f === 8 && w === 2) v.vehicle = pbVehDesc(s.sub());
    else if (f === 9 && w === 0) v.occ = s.varint();
    else s.skip(w);
  }
  return v;
}
function pbTranslated(s) {
  let best = '', it = '';
  while (s.more()) {
    const [f, w] = s.key();
    if (f === 1 && w === 2) {
      const t = s.sub(); let text = '', lang = '';
      while (t.more()) { const [g, x] = t.key(); if (g === 1 && x === 2) text = t.str(); else if (g === 2 && x === 2) lang = t.str(); else t.skip(x); }
      if (!best) best = text;
      if (lang.toLowerCase().startsWith('it')) it = text;
    } else s.skip(w);
  }
  return it || best;
}
function pbAlert(s) {
  const a = { routes: [], stops: [], periods: [] };
  while (s.more()) {
    const [f, w] = s.key();
    if (f === 1 && w === 2) {
      const p = s.sub(); const per = {};
      while (p.more()) { const [g, x] = p.key(); if (g === 1 && x === 0) per.start = p.varint(); else if (g === 2 && x === 0) per.end = p.varint(); else p.skip(x); }
      a.periods.push(per);
    } else if (f === 5 && w === 2) {
      const e = s.sub();
      while (e.more()) {
        const [g, x] = e.key();
        if (g === 2 && x === 2) a.routes.push(e.str());
        else if (g === 5 && x === 2) a.stops.push(e.str());
        else if (g === 4 && x === 2) { const tr = pbTrip(e.sub()); if (tr.route_id) a.routes.push(tr.route_id); }
        else e.skip(x);
      }
    } else if (f === 10 && w === 2) a.header = pbTranslated(s.sub());
    else if (f === 11 && w === 2) a.desc = pbTranslated(s.sub());
    else s.skip(w);
  }
  return a;
}
function parseFeed(u8) {
  const s = new PB(u8);
  const out = { ts: 0, tu: [], vp: [], al: [] };
  while (s.more()) {
    const [f, w] = s.key();
    if (f === 1 && w === 2) {
      const h = s.sub();
      while (h.more()) { const [g, x] = h.key(); if (g === 3 && x === 0) out.ts = h.varint(); else h.skip(x); }
    } else if (f === 2 && w === 2) {
      const e = s.sub(); let id = '';
      while (e.more()) {
        const [g, x] = e.key();
        if (g === 1 && x === 2) id = e.str();
        else if (g === 3 && x === 2) out.tu.push(pbTripUpdate(e.sub()));
        else if (g === 4 && x === 2) { const v = pbVehicle(e.sub()); v.eid = id; out.vp.push(v); }
        else if (g === 5 && x === 2) out.al.push(pbAlert(e.sub()));
        else e.skip(x);
      }
    } else s.skip(w);
  }
  return out;
}

/* ---------------- ZIP via HTTP Range ---------------- */
async function rangeGet(url, from, to) {
  const r = await fetch(url, { headers: { Range: `bytes=${from}-${to}` } });
  if (!r.ok && r.status !== 206) throw new Error('HTTP ' + r.status);
  return { status: r.status, headers: r.headers, buf: new Uint8Array(await r.arrayBuffer()) };
}
async function inflateRaw(u8) {
  const stream = new Blob([u8]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
const u16 = (b, o) => b[o] | (b[o + 1] << 8);
const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16)) + b[o + 3] * 16777216;

async function openZip(url) {
  const first = await rangeGet(url, 0, 0);
  let full = null, total;
  if (first.status === 200) { full = first.buf; total = full.length; }
  else {
    const cr = first.headers.get('Content-Range') || '';
    total = parseInt(cr.split('/')[1], 10);
    if (!total) throw new Error('Dimensione file sconosciuta');
  }
  const version = (first.headers.get('ETag') || first.headers.get('Last-Modified') || '') + ':' + total;
  const get = async (a, b) => full ? full.subarray(a, b + 1) : (await rangeGet(url, a, b)).buf;

  const tailLen = Math.min(total, 70000);
  const tail = await get(total - tailLen, total - 1);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) if (u32(tail, i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('ZIP non valido');
  const cdSize = u32(tail, eocd + 12), cdOff = u32(tail, eocd + 16);
  const cd = await get(cdOff, cdOff + cdSize - 1);
  const entries = {};
  for (let p = 0; p + 46 <= cd.length && u32(cd, p) === 0x02014b50;) {
    const method = u16(cd, p + 10), csize = u32(cd, p + 20), nlen = u16(cd, p + 28), xlen = u16(cd, p + 30), clen = u16(cd, p + 32), off = u32(cd, p + 42);
    const name = PB.td.decode(cd.subarray(p + 46, p + 46 + nlen)).split('/').pop();
    entries[name] = { method, csize, off };
    p += 46 + nlen + xlen + clen;
  }
  return {
    version, entries,
    async text(name) {
      const e = entries[name]; if (!e) return null;
      const end = Math.min(total - 1, e.off + 30 + 1024 + 1024 + e.csize);
      const b = await get(e.off, end);
      const start = 30 + u16(b, 26) + u16(b, 28);
      const data = b.subarray(start, start + e.csize);
      const raw = e.method === 0 ? data : await inflateRaw(data);
      return PB.td.decode(raw).replace(/^\uFEFF/, '');
    },
  };
}

/* ---------------- CSV ---------------- */
function splitLine(l) {
  if (l.indexOf('"') < 0) return l.split(',');
  const out = []; let cur = '', q = false;
  for (let i = 0; i < l.length; i++) {
    const c = l[i];
    if (q) { if (c === '"') { if (l[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true; else if (c === ',') { out.push(cur); cur = ''; } else cur += c;
  }
  out.push(cur); return out;
}
function eachRow(text, cols, fn) {
  let i = text.indexOf('\n');
  const head = splitLine(text.slice(0, i).replace(/\r$/, '')).map(h => h.trim());
  const idx = cols.map(c => head.indexOf(c));
  let p = i + 1;
  while (p < text.length) {
    let n = text.indexOf('\n', p); if (n < 0) n = text.length;
    const line = text.slice(p, n).replace(/\r$/, '');
    p = n + 1;
    if (!line) continue;
    const f = splitLine(line);
    fn(idx.map(k => (k >= 0 ? (f[k] || '').trim() : '')));
  }
}

/* ---------------- IndexedDB (tiny) ---------------- */
const idb = {
  db: null,
  open() {
    if (this.db) return Promise.resolve(this.db);
    return new Promise((res, rej) => {
      const r = indexedDB.open('invettura', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('kv');
      r.onsuccess = () => res(this.db = r.result);
      r.onerror = () => rej(r.error);
    });
  },
  async get(k) { const db = await this.open(); return new Promise((res, rej) => { const r = db.transaction('kv').objectStore('kv').get(k); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); },
  async set(k, v) { const db = await this.open(); return new Promise((res, rej) => { const t = db.transaction('kv', 'readwrite'); t.objectStore('kv').put(v, k); t.oncomplete = res; t.onerror = () => rej(t.error); }); },
};

/* ---------------- State ---------------- */
const S = {
  stops: [],          // {id, code, name, lat, lon, n (normalized name)}
  stopById: new Map(),
  routes: new Map(),  // route_id -> {short, color, text, type}
  trips: new Map(),   // trip_id -> [route_id, headsign]
  vehicles: [], vehTs: 0,
  tu: null, tuTs: 0, byStop: new Map(), byTrip: new Map(),
  alerts: [], alTs: 0,
  me: null,
  view: 'attese', stop: null,
  fav: JSON.parse(localStorage.getItem('iv.fav') || '[]'),
  gtfsVersion: '', gtfsDate: '',
};
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const norm = s => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9 ]/g, ' ');
const now = () => Date.now() / 1000;

function dist(a, b, c, d) {
  const R = 6371000, r = Math.PI / 180;
  const x = (d - b) * r * Math.cos((a + c) / 2 * r), y = (c - a) * r;
  return Math.sqrt(x * x + y * y) * R;
}
function fmtDist(m) { return m < 1000 ? Math.round(m / 10) * 10 + ' m' : (m / 1000).toFixed(1).replace('.', ',') + ' km'; }
function hashColor(s) { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0; return `hsl(${Math.abs(h) % 360} 55% 42%)`; }
function routeInfo(rid) {
  const r = S.routes.get(rid);
  const short = r?.short || rid || '?';
  const bg = r?.color ? '#' + r.color : hashColor(short);
  const fg = r?.text ? '#' + r.text : '#fff';
  return { short, bg, fg, type: r?.type };
}
function badge(rid) { const r = routeInfo(rid); return `<span class="badge" style="background:${r.bg};color:${r.fg}">${esc(r.short)}</span>`; }
function headsign(tripId) { return S.trips.get(tripId)?.[1] || ''; }
function routeOfTrip(t) { return t?.route_id || S.trips.get(t?.trip_id)?.[0] || ''; }

function setStatus(kind, txt) { $('#dot').className = 'dot ' + kind; $('#stxt').textContent = txt; }
function loading(pct, txt) { $('#lbar').style.width = pct + '%'; $('#ltxt').textContent = txt; }

/* ---------------- Static data ---------------- */
async function loadStatic(force = false) {
  const cached = force ? null : await idb.get('gtfs').catch(() => null);
  if (cached && cached.v === DATA_VERSION) {
    applyStatic(cached);
    $('#loading').classList.add('hide');
    checkStaticUpdate(cached.version);
    return;
  }
  $('#loading').classList.remove('hide');
  try {
    const data = await downloadStatic();
    applyStatic(data);
    await idb.set('gtfs', data).catch(() => {});
  } catch (e) {
    console.error(e);
    loading(100, 'Impossibile scaricare i dati della rete: ' + e.message + '. Riprova più tardi.');
    throw e;
  }
  $('#loading').classList.add('hide');
}
async function checkStaticUpdate(version) {
  try {
    const r = await fetch(API.gtfs, { headers: { Range: 'bytes=0-0' } });
    const total = (r.headers.get('Content-Range') || '').split('/')[1] || r.headers.get('Content-Length');
    const v = (r.headers.get('ETag') || r.headers.get('Last-Modified') || '') + ':' + total;
    if (total && v !== version) {
      const data = await downloadStatic(true);
      applyStatic(data);
      await idb.set('gtfs', data).catch(() => {});
    }
  } catch (e) { /* offline: keep cache */ }
}
async function downloadStatic(silent = false) {
  const L = silent ? () => {} : loading;
  L(5, 'Apro l\u2019archivio della rete…');
  const zip = await openZip(API.gtfs);
  L(20, 'Scarico le fermate…');
  const stopsTxt = await zip.text('stops.txt');
  if (!stopsTxt) throw new Error('stops.txt mancante');
  const stops = [];
  eachRow(stopsTxt, ['stop_id', 'stop_code', 'stop_name', 'stop_lat', 'stop_lon', 'location_type'], ([id, code, name, lat, lon, lt]) => {
    if (lt && lt !== '0') return;
    stops.push([id, code, name, +lat, +lon]);
  });
  L(40, 'Scarico le linee…');
  const routes = [];
  const routesTxt = await zip.text('routes.txt');
  if (routesTxt) eachRow(routesTxt, ['route_id', 'route_short_name', 'route_long_name', 'route_color', 'route_text_color', 'route_type'], ([id, s, l, c, t, ty]) => routes.push([id, s || l, c, t, ty, s ? l : '']));
  L(60, 'Scarico le corse (può volerci un minuto)…');
  const trips = [];
  const tripsTxt = await zip.text('trips.txt');
  L(90, 'Preparo i dati…');
  if (tripsTxt) eachRow(tripsTxt, ['trip_id', 'route_id', 'trip_headsign'], r => trips.push(r));
  let date = '';
  const info = await zip.text('feed_info.txt').catch(() => null);
  if (info) eachRow(info, ['feed_start_date', 'feed_end_date'], ([a, b]) => { date = a && b ? `${a.slice(6)}/${a.slice(4, 6)}/${a.slice(0, 4)} – ${b.slice(6)}/${b.slice(4, 6)}/${b.slice(0, 4)}` : ''; });
  L(100, 'Pronto');
  return { v: DATA_VERSION, version: zip.version, date, saved: Date.now(), stops, routes, trips };
}
function applyStatic(d) {
  S.stops = d.stops.map(([id, code, name, lat, lon]) => ({ id, code, name, lat, lon, n: norm(name) }));
  S.stopById = new Map(S.stops.map(s => [s.id, s]));
  S.routes = new Map(d.routes.map(([id, short, color, text, type, long]) => [id, { short, color, text, type, long }]));
  S.trips = new Map(d.trips.map(([t, r, h]) => [t, [r, h]]));
  S.gtfsVersion = d.version; S.gtfsDate = d.date;
  $('#gtfsinfo').textContent = `${S.stops.length.toLocaleString('it')} fermate · ${S.routes.size} linee` + (d.date ? ` · validità ${d.date}` : '') + ` · scaricati il ${new Date(d.saved).toLocaleDateString('it')}`;
  renderHome();
}

/* ---------------- Realtime ---------------- */
async function fetchFeed(url) {
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return parseFeed(new Uint8Array(await r.arrayBuffer()));
}
async function refreshTrips(force) {
  if (!force && now() - S.tuTs < RT_INTERVAL / 1000 - 2) return;
  const f = await fetchFeed(API.trips);
  S.tuTs = now();
  const byStop = new Map(), byTrip = new Map();
  const seen = new Set();
  for (const t of f.tu) {
    if (t.trip?.sr === 3) continue; // CANCELED
    byTrip.set(t.trip?.trip_id, t);
    for (const u of t.stu) {
      if (u.sr === 1) continue; // SKIPPED
      const time = u.arr?.time || u.dep?.time;
      if (!time || !u.stop_id) continue;
      const k = (t.trip?.trip_id || t.vehicle?.id) + '|' + u.stop_id + '|' + Math.round(time / 120);
      if (seen.has(k)) continue; seen.add(k);
      let a = byStop.get(u.stop_id); if (!a) byStop.set(u.stop_id, a = []);
      a.push({ time, trip: t.trip, veh: t.vehicle });
    }
  }
  S.byStop = byStop; S.byTrip = byTrip; S.feedTs = f.ts;
}
async function refreshVehicles(force) {
  if (!force && now() - S.vehTs < RT_INTERVAL / 1000 - 2) return;
  const f = await fetchFeed(API.vehicles);
  S.vehTs = now();
  S.vehicles = f.vp.filter(v => v.pos && v.pos.lat).map(v => ({
    id: v.vehicle?.id || v.eid, label: v.vehicle?.label || v.vehicle?.id || v.eid,
    lat: v.pos.lat, lon: v.pos.lon, bearing: v.pos.bearing, speed: v.pos.speed,
    trip: v.trip, rid: routeOfTrip(v.trip), ts: v.ts || f.ts, stop_id: v.stop_id, status: v.status, occ: v.occ,
  }));
}
async function refreshAlerts() {
  if (now() - S.alTs < 300) return;
  try {
    const f = await fetchFeed(API.alerts); S.alTs = now();
    const t = now();
    S.alerts = f.al.filter(a => !a.periods.length || a.periods.some(p => (!p.start || p.start <= t) && (!p.end || p.end >= t)));
  } catch (e) { S.alTs = now() - 240; }
}
async function tick(force = false) {
  try {
    if (S.view === 'attese' && S.stop) { await Promise.all([refreshTrips(force), refreshAlerts()]); renderStop(); }
    else if (S.view === 'mappa') { await refreshVehicles(force); renderMap(); }
    else if (S.view === 'linee' && (S.line || S.myLines.length)) { await Promise.all([refreshTrips(force), refreshVehicles(force)]); if (S.line) renderLine(); else renderLinesHome(); }
    else if (S.view === 'vettura' && S.vq) { await Promise.all([refreshVehicles(force), refreshTrips(force)]); renderVehicle(); }
    const ts = Math.max(S.tuTs, S.vehTs);
    if (ts) setStatus('live', 'live · ' + new Date(ts * 1000).toLocaleTimeString('it', { hour: '2-digit', minute: '2-digit', second: '2-digit' }));
  } catch (e) {
    console.error(e);
    setStatus('err', navigator.onLine ? 'riprovo…' : 'offline');
    if (!S.retry) S.retry = setTimeout(() => { S.retry = null; tick(true); }, 5000);
  }
}

/* ---------------- Views: Attese ---------------- */
function stopCard(s, d) {
  const fav = S.fav.includes(s.id);
  return `<div class="card" data-stop="${esc(s.id)}">
    <div class="grow"><div class="t">${esc(s.name)}</div><div class="s">Fermata ${esc(s.code || s.id)}</div></div>
    ${d != null ? `<span class="dist">${fmtDist(d)}</span>` : ''}
    <button class="star ${fav ? 'on' : ''}" data-fav="${esc(s.id)}" aria-label="Preferita">${fav ? '★' : '☆'}</button>
  </div>`;
}
function renderHome() {
  const q = $('#q').value.trim();
  const el = $('#results');
  if (!S.stops.length) { el.innerHTML = ''; return; }
  if (q) {
    const nq = norm(q).trim(), words = nq.split(/\s+/).filter(Boolean);
    const exact = S.stops.filter(s => s.code === q || s.id === q);
    const byName = S.stops.filter(s => !exact.includes(s) && words.every(w => s.n.includes(w)));
    if (S.me) byName.sort((a, b) => dist(S.me[0], S.me[1], a.lat, a.lon) - dist(S.me[0], S.me[1], b.lat, b.lon));
    const list = [...exact, ...byName].slice(0, 40);
    el.innerHTML = `<h2>Risultati</h2>` + (list.length ? `<div class="list">${list.map(s => stopCard(s, S.me ? dist(S.me[0], S.me[1], s.lat, s.lon) : null)).join('')}</div>` : `<div class="empty">Nessuna fermata trovata per “${esc(q)}”.</div>`);
    return;
  }
  let html = '';
  const favs = S.fav.map(id => S.stopById.get(id)).filter(Boolean);
  if (favs.length) html += `<h2>Preferite</h2><div class="list">${favs.map(s => stopCard(s, S.me ? dist(S.me[0], S.me[1], s.lat, s.lon) : null)).join('')}</div>`;
  if (S.me) {
    const near = S.stops.map(s => [s, dist(S.me[0], S.me[1], s.lat, s.lon)]).filter(x => x[1] < 1000).sort((a, b) => a[1] - b[1]).slice(0, 15);
    html += `<h2>Vicino a te</h2>` + (near.length ? `<div class="list">${near.map(([s, d]) => stopCard(s, d)).join('')}</div>` : `<div class="empty">Nessuna fermata entro 1 km.</div>`);
  } else {
    html += `<div class="empty">Tocca 📍 per vedere le fermate vicine, oppure cerca una fermata per nome o numero.</div>`;
  }
  el.innerHTML = html;
}
function locate() {
  if (!navigator.geolocation) return;
  $('#gps').textContent = '…';
  navigator.geolocation.getCurrentPosition(p => {
    S.me = [p.coords.latitude, p.coords.longitude];
    $('#gps').textContent = '📍';
    renderHome(); if (S.map) showMe();
  }, () => { $('#gps').textContent = '📍'; $('#results').insertAdjacentHTML('afterbegin', `<div class="alert">Posizione non disponibile: controlla i permessi di localizzazione.</div>`); }, { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 });
}
function openStop(id) {
  S.stop = S.stopById.get(id); if (!S.stop) return;
  $('#attese-home').hidden = true; $('#attese-stop').hidden = false;
  history.pushState({ stop: id }, '', '#fermata-' + encodeURIComponent(id));
  renderStop(); tick(true); loadStopSched(id);
}
function closeStop() { S.stop = null; $('#attese-home').hidden = false; $('#attese-stop').hidden = true; renderHome(); }
function renderStop() {
  const s = S.stop; if (!s) return;
  const t = now();
  const liveArr = (S.byStop.get(s.id) || []).filter(a => a.time > t - 60 && a.time < t + 120 * 60);
  const liveTrips = new Set(liveArr.map(a => a.trip?.trip_id));
  const sched = stopSched(s.id).filter(a => !liveTrips.has(a.tid) && !S.byTrip.has(a.tid));
  const arr = liveArr.concat(sched).sort((a, b) => a.time - b.time).slice(0, 30);
  const rids = new Set(arr.map(a => routeOfTrip(a.trip)));
  const alerts = S.alerts.filter(a => a.stops.includes(s.id) || a.routes.some(r => rids.has(r))).slice(0, 8);
  const fav = S.fav.includes(s.id);
  let html = `<button class="back" id="back">‹ Fermate</button>
    <div class="stophead" style="display:flex;align-items:flex-start;gap:8px"><div style="flex:1"><div class="n">${esc(s.name)}</div><div class="c">Fermata ${esc(s.code || s.id)}${S.me ? ' · ' + fmtDist(dist(S.me[0], S.me[1], s.lat, s.lon)) : ''}</div></div>
    <button class="star ${fav ? 'on' : ''}" data-fav="${esc(s.id)}" style="font-size:26px">${fav ? '★' : '☆'}</button></div>`;
  if (alerts.length) html += `<details class="alert"><summary><b style="display:inline">⚠ ${alerts.length === 1 ? '1 avviso' : alerts.length + ' avvisi'} su questa fermata o linee</b></summary>` +
    alerts.map(a => `<div style="margin-top:8px"><b>${esc(a.header || 'Avviso')}</b>${esc((a.desc || '').slice(0, 400))}</div>`).join('') + `</details>`;
  if (!S.tuTs && !arr.length) html += `<div class="empty">Carico i tempi di attesa…</div>`;
  else if (!arr.length) html += `<div class="empty">Nessun passaggio previsto nelle prossime due ore.</div>`;
  else html += `<div class="list">` + arr.map(a => {
    if (a.sched) {
      const m = Math.round((a.time - t) / 60);
      return `<div class="arr sch" data-line="${esc(a.short)}" style="cursor:pointer">${badgeShort(a.short)}
      <div class="grow" style="flex:1;min-width:0"><div class="t" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">→ ${esc(a.head)}</div>
      <div class="s" style="font-size:12px;color:var(--muted)">🕒 programmato · ${hhmm(a.time)}</div></div>
      <div class="min">${m <= 0 ? 'ora' : m}${m > 0 ? '<small>min</small>' : ''}</div></div>`;
    }
    const rid = routeOfTrip(a.trip), m = Math.round((a.time - t) / 60);
    const hs = headsign(a.trip?.trip_id);
    const vid = a.veh?.label || a.veh?.id;
    const clock = new Date(a.time * 1000).toLocaleTimeString('it', { hour: '2-digit', minute: '2-digit' });
    return `<div class="arr" ${vid ? `data-veh="${esc(vid)}" style="cursor:pointer"` : ''}>${badge(rid)}
      <div class="grow" style="flex:1;min-width:0"><div class="t" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(hs ? '→ ' + hs : 'Linea ' + routeInfo(rid).short)}</div>
      <div class="s" style="font-size:12px;color:var(--muted)"><span class="rt">● live</span>${vid ? ' · vettura ' + esc(vid) : ''} · ${clock}</div></div>
      <div class="min ${m <= 1 ? 'now' : ''}">${m <= 0 ? 'ora' : m}${m > 0 ? '<small>min</small>' : ''}</div></div>`;
  }).join('') + `</div>`;
  html += `<p class="note">● live = previsione in tempo reale, si aggiorna ogni 20 secondi (tocca per vedere la vettura sulla mappa). 🕒 programmato = orario ufficiale per le corse senza dati in tempo reale (tocca per la linea).</p>`;
  $('#attese-stop').innerHTML = html;
}

/* ---------------- Views: Mappa ---------------- */
const markers = new Map();
function initMap() {
  if (S.map) return;
  S.map = L.map('map', { zoomControl: false, preferCanvas: true }).setView(S.me || [41.9028, 12.4964], S.me ? 15 : 13);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  }).addTo(S.map);
  L.control.zoom({ position: 'bottomright' }).addTo(S.map);
  S.map.on('moveend', renderMap);
  if (S.me) showMe();
}
function showMe() {
  if (!S.me || !S.map) return;
  if (S.meMarker) S.meMarker.setLatLng(S.me);
  else S.meMarker = L.marker(S.me, { icon: L.divIcon({ className: '', html: '<div class="me"></div>', iconSize: [16, 16] }), zIndexOffset: 1000 }).addTo(S.map);
}
function lineFilter() { return $('#lineFilter').value.split(/[\s,;]+/).map(s => s.trim().toUpperCase()).filter(Boolean); }
function vehPopup(v) {
  const r = routeInfo(v.rid), hs = headsign(v.trip?.trip_id);
  const age = Math.max(0, Math.round(now() - v.ts));
  const st = v.stop_id && S.stopById.get(v.stop_id);
  return `<b>Linea ${esc(r.short)}</b>${hs ? ' → ' + esc(hs) : ''}<br>Vettura <b>${esc(v.label)}</b><br>` +
    (st ? `${v.status === 1 ? 'Ferma a' : 'Verso'}: ${esc(st.name)}<br>` : '') +
    (v.speed != null ? `Velocità: ${Math.round(v.speed * 3.6)} km/h<br>` : '') +
    `<span style="color:var(--muted)">aggiornato ${age < 60 ? age + ' s' : Math.round(age / 60) + ' min'} fa</span>` +
    (PICK ? `<br><button class="btn" data-pick="${esc(v.label)}" style="margin-top:8px;padding:8px 12px">✓ Usa nella scheda</button>` : '');
}
function renderMap() {
  if (!S.map) return;
  const filt = lineFilter();
  const b = S.map.getBounds().pad(0.3);
  let list = S.vehicles;
  if (filt.length) list = list.filter(v => filt.includes(routeInfo(v.rid).short.toUpperCase()));
  const visible = list.filter(v => b.contains([v.lat, v.lon]));
  if (filt.length && list.length && !visible.length && S.fitFilter !== filt.join()) {
    S.fitFilter = filt.join();
    S.map.fitBounds(L.latLngBounds(list.map(v => [v.lat, v.lon])).pad(0.2), { maxZoom: 15 });
    return; // moveend will re-render
  }
  const zoomed = S.map.getZoom() >= 14 || filt.length;
  const show = visible.slice(0, 800);
  const keep = new Set();
  for (const v of show) {
    keep.add(v.id);
    const r = routeInfo(v.rid);
    const hl = S.hl && v.label === S.hl;
    const stl = now() - v.ts > 300 ? ' stale' : '';
    const html = zoomed || hl
      ? `<div class="vm${stl} ${hl ? 'hl' : ''}" style="background:${r.bg};color:${r.fg}">${esc(r.short)}</div>`
      : `<div class="vm${stl}" style="background:${r.bg};width:10px;height:10px;padding:0;border-radius:50%;border-width:1px"></div>`;
    let m = markers.get(v.id);
    if (!m) {
      m = L.marker([v.lat, v.lon], { icon: L.divIcon({ className: '', html, iconSize: null }) }).addTo(S.map);
      m.bindPopup('');
      m.on('popupopen', () => m.setPopupContent(vehPopup(m.v)));
      markers.set(v.id, m);
    } else {
      m.setLatLng([v.lat, v.lon]);
      if (m.html !== html) m.setIcon(L.divIcon({ className: '', html, iconSize: null }));
    }
    m.v = v; m.html = html;
    if (m.isPopupOpen()) m.setPopupContent(vehPopup(v));
  }
  for (const [id, m] of markers) if (!keep.has(id)) { S.map.removeLayer(m); markers.delete(id); }
  $('#mapinfo').textContent = S.vehTs ? `${list.length.toLocaleString('it')} mezzi${filt.length ? ' (filtrati)' : ''} · ${show.length} in vista` : 'Carico i mezzi…';
}
function focusVehicle(label) {
  S.hl = label;
  switchView('mappa');
  refreshVehicles(false).then(() => {
    const v = S.vehicles.find(x => x.label === label);
    if (!v) return;
    S.map.setView([v.lat, v.lon], 16);
    renderMap();
    const m = markers.get(v.id); if (m) m.openPopup();
  }).catch(() => {});
}

/* ---------------- Views: Vettura ---------------- */
function findVehicles(q) {
  const nz = x => String(x ?? '').toUpperCase().replace(/^0+(?=.)/, '');
  q = nz(q.trim()); if (!q) return [];
  const ex = S.vehicles.filter(v => nz(v.label) === q);
  if (ex.length) return ex;
  return S.vehicles.filter(v => nz(v.label).includes(q)).slice(0, 10);
}
function renderVehicle() {
  const el = $('#vres'); const q = S.vq;
  if (!q) { el.innerHTML = ''; return; }
  if (!S.vehTs) { el.innerHTML = `<div class="empty">Carico i mezzi…</div>`; return; }
  const found = findVehicles(q);
  if (!found.length) { el.innerHTML = `<div class="empty">La vettura “${esc(q)}” non risulta in servizio in questo momento.</div>`; return; }
  const t = now();
  el.innerHTML = found.map(v => {
    const r = routeInfo(v.rid), hs = headsign(v.trip?.trip_id);
    const st = v.stop_id && S.stopById.get(v.stop_id);
    const tu = S.byTrip.get(v.trip?.trip_id);
    const next = tu ? tu.stu.filter(u => { const x = u.arr?.time || u.dep?.time; return x > t - 30 && x < t + 3 * 3600 && u.stop_id; }).slice(0, 6) : [];
    const age = Math.max(0, Math.round(t - v.ts));
    return `<div class="veh" style="margin-bottom:10px">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">${badge(v.rid)}<div style="flex:1"><div class="t" style="font-weight:700">Vettura ${esc(v.label)}</div><div class="s" style="color:var(--muted);font-size:13px">${hs ? '→ ' + esc(hs) : 'Linea ' + esc(r.short)}</div></div></div>
      ${st ? `<div class="row"><span>${v.status === 1 ? 'Ferma a' : 'Prossima fermata'}</span><span>${esc(st.name)}</span></div>` : ''}
      ${v.speed != null ? `<div class="row"><span>Velocità</span><span>${Math.round(v.speed * 3.6)} km/h</span></div>` : ''}
      <div class="row"><span>Posizione aggiornata</span><span>${age < 60 ? age + ' s' : Math.round(age / 60) + ' min'} fa</span></div>
      ${next.length ? `<div style="margin-top:10px;font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em">Prossime fermate</div>` + next.map(u => {
        const s2 = S.stopById.get(u.stop_id); const tm = u.arr?.time || u.dep?.time;
        return `<div class="row"><span>${esc(s2?.name || u.stop_id)}</span><span>${new Date(tm * 1000).toLocaleTimeString('it', { hour: '2-digit', minute: '2-digit' })}</span></div>`;
      }).join('') : ''}
      ${PICK ? `<button class="btn" data-pick="${esc(v.label)}" style="width:100%;padding:12px;margin-top:10px">✓ Usa nella scheda</button>` : ''}
      <button class="btn ${PICK ? 'ghost' : ''}" data-map="${esc(v.label)}" style="width:100%;padding:12px;margin-top:8px">Mostra sulla mappa</button>
    </div>`;
  }).join('');
}

/* ---------------- Dati programmati (preparati ogni notte da GitHub) ---------------- */
const DATA = (window.INVETTURA_DATA || 'data').replace(/\/$/, '');
const dayKey = d => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
const SD = { index: null, cal: null, stops: null, idx: null, calV: null, stopsV: null, lines: new Map(), lineV: new Map(), byShort: new Map() };
async function getJSON(p) { const r = await fetch(`${DATA}/${p}?v=${dayKey(new Date())}`); if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); }
function sdOnce(k, p, after) {
  if (!SD[k]) SD[k] = getJSON(p).then(j => { SD.fail = false; after(j); return j; }).catch(e => { SD[k] = null; SD.fail = true; throw e; });
  return SD[k];
}
const sdIndex = () => sdOnce('index', 'index.json', j => { SD.idx = j; SD.byShort = new Map(j.lines.map(l => [l.s.toUpperCase(), l])); });
const sdCal = () => sdOnce('cal', 'cal.json', j => { SD.calV = j; });
const sdStops = () => sdOnce('stops', 'stops.json', j => { SD.stopsV = j; });
async function sdLine(short) {
  await sdIndex();
  const e = SD.byShort.get(String(short).toUpperCase()); if (!e) return null;
  if (!SD.lines.has(e.k)) SD.lines.set(e.k, getJSON('l/' + e.k + '.json').then(j => {
    j.tripDir = new Map(); j.tripPat = new Map();
    j.dirs.forEach((d, di) => { for (const list of Object.values(d.svc)) for (const [, p, tid] of list) { j.tripDir.set(tid, di); j.tripPat.set(tid, p); } });
    SD.lineV.set(e.k, j); return j;
  }).catch(() => { SD.lines.delete(e.k); return null; }));
  return SD.lines.get(e.k);
}
const lineData = short => { const e = SD.byShort.get(String(short).toUpperCase()); return e ? SD.lineV.get(e.k) || null : null; };
const midnight = (d, add = 0) => { const x = new Date(d); x.setHours(0, 0, 0, 0); x.setDate(x.getDate() + add); return x; };
// partenze programmate di una direzione per il giorno 'day' (0 = oggi): [{t (epoch s), pat, tid}]
function departures(L, di, day = 0) {
  if (!L || !SD.calV) return [];
  const out = [], d = L.dirs[di];
  for (const back of [0, 1]) { // corse del giorno prima oltre mezzanotte
    const m = midnight(new Date(), day - back), sids = SD.calV[dayKey(m)] || [];
    const base = m.getTime() / 1000;
    for (const sid of sids) for (const [min, pat, tid] of (d.svc[sid] || [])) {
      if (back && min < 1440) continue;
      const t = base + min * 60;
      if (!back || t >= midnight(new Date(), day).getTime() / 1000) out.push({ t, pat, tid, back });
    }
  }
  // la stessa corsa può comparire nel servizio di ieri (oltre le 24) e in quello di oggi: una sola volta
  const seen = new Set();
  return out.sort((a, b) => a.t - b.t).filter(d => { const k = d.t + '|' + d.pat; if (seen.has(k)) return false; seen.add(k); return true; });
}
const hhmm = t => new Date(t * 1000).toLocaleTimeString('it', { hour: '2-digit', minute: '2-digit' });
function badgeShort(short) {
  const rid = routesByShort(short)[0]; if (rid) return badge(rid);
  const e = SD.byShort.get(String(short).toUpperCase());
  const bg = e?.c ? '#' + e.c : hashColor(short), fg = e?.tc ? '#' + e.tc : '#fff';
  return `<span class="badge" style="background:${bg};color:${fg}">${esc(short)}</span>`;
}
// passaggi programmati a una fermata nelle prossime 2 ore (corse senza dati in tempo reale)
async function loadStopSched(stopId) {
  try { await Promise.all([sdStops(), sdCal(), sdIndex()]); } catch (e) { return; }
  const shorts = SD.stopsV[stopId] || [];
  await Promise.all(shorts.map(sdLine));
  if (S.stop && S.stop.id === stopId) renderStop();
}
function stopSched(stopId) {
  if (!SD.stopsV || !SD.calV) return [];
  const t = now(), out = [];
  for (const short of SD.stopsV[stopId] || []) {
    const L = lineData(short); if (!L) continue;
    L.dirs.forEach((d, di) => {
      const posIn = d.pats.map(p => { const i = p.st.indexOf(stopId); return i >= 0 && i < p.st.length - 1 && p.off[i] != null ? p.off[i] : null; });
      if (posIn.every(x => x == null)) return;
      for (const dep of departures(L, di, 0)) {
        const off = posIn[dep.pat]; if (off == null) continue;
        const at = dep.t + off * 60;
        if (at < t - 60 || at > t + 120 * 60) continue;
        if (out.some(o => o.short === short && o.time === at && o.di === di)) continue;
        out.push({ time: at, short, head: d.h || d.tn, tid: dep.tid, sched: true, di });
      }
    });
  }
  return out;
}

/* ---------------- Views: Linee (capolinea, schema, partenze, monitoraggio) ---------------- */
S.myLines = JSON.parse(localStorage.getItem('iv.lines') || '[]');
S.line = null; S.lineDir = 0; S.lineTab = null; S.lineDay = 0;
const okDelay = d => d != null && Math.abs(d) < 7200 ? d : null;
function routesByShort(short) { const u = String(short).toUpperCase(); return [...S.routes].filter(([, r]) => (r.short || '').toUpperCase() === u).map(([id]) => id); }
function fmtDelay(d) {
  if (d == null) return '';
  const m = Math.round(d / 60);
  if (m === 0) return 'in orario';
  return (m > 0 ? '+' : '−') + Math.abs(m) + '′';
}
function delayCls(d) { if (d == null) return ''; const m = Math.round(d / 60); return m >= 3 ? 'late' : m <= -2 ? 'early' : ''; }
function dirCount(short) { const L = lineData(short); return L ? L.dirs.length : 2; }
function dirOfTrip(L, tu) {
  if (L) {
    const di = L.tripDir.get(tu.trip?.trip_id); if (di != null) return di;
    const k = L.dirs.findIndex(d => d.dir !== '' && +d.dir === (tu.trip?.direction_id ?? 0)); if (k >= 0) return k;
  }
  return tu.trip?.direction_id ?? 0;
}

// Modello di una linea in una direzione: fermate (dal percorso programmato se disponibile) + vetture in tempo reale
function buildLine(short, dir) {
  const L = lineData(short);
  const rids = new Set(routesByShort(short));
  const t = now();
  const trips = [];
  for (const [, tu] of S.byTrip) {
    if (!rids.has(routeOfTrip(tu.trip))) continue;
    if (dirOfTrip(L, tu) !== dir) continue;
    trips.push(tu);
  }
  let stops, fromStatic = false;
  const D = L?.dirs[dir];
  if (D) {
    fromStatic = true;
    stops = D.pats[0].st.map((id, i) => ({ seq: i + 1, id, name: S.stopById.get(id)?.name || id, off: D.pats[0].off[i] }));
  } else {
    const bySeq = new Map();
    for (const tu of trips) for (const u of tu.stu) {
      if (u.seq == null || !u.stop_id) continue;
      let m = bySeq.get(u.seq); if (!m) bySeq.set(u.seq, m = new Map());
      m.set(u.stop_id, (m.get(u.stop_id) || 0) + 1);
    }
    const seqs = [...bySeq.keys()].sort((a, b) => a - b), seen = new Set();
    stops = [];
    for (const q of seqs) {
      const sid = [...bySeq.get(q)].sort((a, b) => b[1] - a[1])[0][0];
      if (seen.has(sid)) continue; seen.add(sid);
      stops.push({ seq: q, id: sid, name: S.stopById.get(sid)?.name || sid });
    }
  }
  const idx = new Map(stops.map((s, i) => [s.id, i]));
  const hc = new Map(); for (const tu of trips) { const h = headsign(tu.trip?.trip_id); if (h) hc.set(h, (hc.get(h) || 0) + 1); }
  const head = D?.h || [...hc].sort((a, b) => b[1] - a[1])[0]?.[0] || '';
  const vByTrip = new Map(S.vehicles.map(v => [v.trip?.trip_id, v]));
  const vehs = [], offRoute = [];
  for (const tu of trips) {
    const v = vByTrip.get(tu.trip?.trip_id);
    const next = tu.stu.find(u => (u.arr?.time || u.dep?.time) > t - 60) || tu.stu[0];
    if (!next) continue;
    const sid = v?.stop_id && idx.has(v.stop_id) ? v.stop_id : idx.has(next.stop_id) ? next.stop_id : (tu.stu.find(u => idx.has(u.stop_id))?.stop_id);
    const item = {
      label: v?.label || tu.vehicle?.label || tu.vehicle?.id || '—', tu, v, at: v ? v.status === 1 : false,
      delay: okDelay(next.arr?.delay ?? next.dep?.delay), stale: v ? t - v.ts > 300 : true,
      eta: new Map(tu.stu.map(u => [u.stop_id, u.arr?.time || u.dep?.time])),
    };
    if (!sid) { item.stop = v?.stop_id || next.stop_id; item.pos = -1; offRoute.push(item); continue; }
    item.pos = idx.get(sid); item.stop = sid; vehs.push(item);
  }
  vehs.sort((a, b) => b.pos - a.pos || (a.eta.get(a.stop) || 0) - (b.eta.get(b.stop) || 0));
  for (let i = 1; i < vehs.length; i++) {
    const A = vehs[i - 1], B = vehs[i];
    const ta = A.eta.get(A.stop), tb = B.eta.get(A.stop);
    B.gap = ta && tb && tb > ta ? (tb - ta) / 60 : null;
  }
  const gaps = vehs.map(v => v.gap).filter(g => g != null).sort((a, b) => a - b);
  const med = gaps.length ? gaps[Math.floor(gaps.length / 2)] : null;
  for (const v of vehs) { v.bunch = v.gap != null && v.gap < 3; v.hole = v.gap != null && med != null && v.gap > Math.max(2 * med, 20); }
  const all = vehs.concat(offRoute);
  return { short, dir, D, L, stops, vehs, offRoute, all, head, med, rids: [...rids], fromStatic, gapsMissing: !fromStatic && stops.length && stops[0].seq > 1 };
}
function lineSummary(short) {
  const all = [];
  for (let d = 0; d < dirCount(short); d++) all.push(...buildLine(short, d).all);
  const ds = all.map(v => v.delay).filter(x => x != null);
  return { n: all.length, avg: ds.length ? ds.reduce((a, b) => a + b, 0) / ds.length : null,
    bunch: all.filter(v => v.bunch).length, hole: all.filter(v => v.hole).length, stale: all.filter(v => v.stale).length };
}
function flags(v) {
  return (v.bunch ? '<span class="flag q">accodata</span>' : '') + (v.hole ? '<span class="flag h">buco davanti</span>' : '') + (v.stale ? '<span class="flag s">no segnale</span>' : '');
}
function lineTitle(short) {
  const e = SD.byShort.get(String(short).toUpperCase());
  if (e && e.d.length) return e.d.length > 1 ? `${e.d[0].fn} ↔ ${e.d[0].tn}` : `${e.d[0].fn} → ${e.d[0].tn}`;
  const rid = routesByShort(short)[0];
  return S.routes.get(rid)?.long || 'Linea ' + short;
}
function lineCard(short) {
  const sm = S.byTrip.size ? lineSummary(short) : null;
  const on = S.myLines.includes(short);
  const det = sm ? (sm.n ? `${sm.n} ${sm.n === 1 ? 'vettura' : 'vetture'} in servizio` + (sm.avg != null ? ` · ritardo medio ${fmtDelay(sm.avg)}` : '') : 'nessuna vettura in tempo reale') : 'carico…';
  const warn = sm ? (sm.bunch ? `<span class="flag q">${sm.bunch} accodate</span>` : '') + (sm.hole ? `<span class="flag h">${sm.hole} buchi</span>` : '') + (sm.stale ? `<span class="flag s">${sm.stale} senza segnale</span>` : '') : '';
  return `<div class="card" data-line="${esc(short)}">${badgeShort(short)}<div class="grow"><div class="t">${esc(lineTitle(short))}</div><div class="s">${det}</div>${warn ? `<div style="margin-top:4px">${warn}</div>` : ''}</div>
    <button class="star ${on ? 'on' : ''}" data-myline="${esc(short)}">${on ? '★' : '☆'}</button></div>`;
}
function notifyBox() {
  const perm = 'Notification' in window ? Notification.permission : 'unsupported';
  const note = !S.notify ? 'Ti avviso quando sulle linee qui sotto ci sono vetture accodate o un buco di servizio.'
    : perm === 'granted' ? 'Attivi: controllo ogni minuto mentre l\u2019app \u00e8 aperta, anche se sei in un\u2019altra sezione.'
    : perm === 'denied' ? 'Attivi solo dentro l\u2019app: le notifiche del telefono sono bloccate nelle impostazioni.'
    : 'Attivi dentro l\u2019app (messaggio in basso). Per le notifiche del telefono installa l\u2019app sulla schermata Home.';
  return `<div class="nbox ${S.notify ? 'on' : ''}"><button class="btn ${S.notify ? '' : 'ghost'}" id="notifyBtn">${S.notify ? '\ud83d\udd14 Avvisi attivi' : '\ud83d\udd15 Attiva avvisi'}</button><span>${note}</span></div>`;
}
function renderLinesHome() {
  if (!SD.idx) sdIndex().then(() => { if (S.view === 'linee' && !S.line) renderLinesHome(); }).catch(() => {});
  const q = $('#lq').value.trim().toUpperCase();
  const el = $('#lres');
  if (q) {
    const shorts = SD.idx ? SD.idx.lines.map(l => l.s) : [...new Set([...S.routes.values()].map(r => r.short).filter(Boolean))];
    const hits = shorts.filter(s => s.toUpperCase() === q).concat(shorts.filter(s => s.toUpperCase() !== q && s.toUpperCase().startsWith(q))).slice(0, 30);
    el.innerHTML = hits.length ? `<h2>Linee</h2><div class="list">${hits.slice(0, 8).map(lineCard).join('')}</div>` +
      (hits.length > 8 ? `<div class="chips" style="margin-top:10px">${hits.slice(8).map(s => `<span data-line="${esc(s)}">${badgeShort(s)}</span>`).join('')}</div>` : '')
      : `<div class="empty">Nessuna linea “${esc(q)}”.</div>`;
    return;
  }
  if (S.myLines.length && !S.byTrip.size && !S.lineLoading) { S.lineLoading = true; Promise.all([refreshTrips(true), refreshVehicles(true)]).then(renderLinesHome).catch(() => {}).finally(() => { S.lineLoading = false; }); }
  el.innerHTML = S.myLines.length
    ? `<h2>Le mie linee · monitoraggio</h2>${notifyBox()}<div class="list">${S.myLines.map(lineCard).join('')}</div><p class="note">Accodata: meno di 3 minuti dalla vettura davanti. Buco: distacco oltre il doppio del normale (almeno 20 minuti). Dati aggiornati ogni 20 secondi.</p>`
    : `<div class="empty">Cerca una linea per vedere capolinea, fermate, partenze e vetture in servizio.<br>Con la ☆ la aggiungi a <b>Le mie linee</b> per monitorarle tutte insieme.</div>`;
}
async function openLine(short) {
  S.line = short; S.lineDir = 0; S.lineTab = null; S.lineDay = 0; S.lineDirChosen = false;
  $('#linee-home').hidden = true; $('#linee-line').hidden = false;
  history.pushState({ line: short }, '', '#linea-' + encodeURIComponent(short));
  renderLine(); tick(true);
  try { await Promise.all([sdLine(short), sdCal()]); } catch (e) {}
  if (S.line !== short) return;
  // parte dalla direzione con vetture in tempo reale
  const n = dirCount(short), live = [...Array(n)].map((_, d) => buildLine(short, d).all.length);
  if (!live[0] && live.some(x => x)) S.lineDir = live.findIndex(x => x);
  renderLine();
}
function closeLine() { S.line = null; $('#linee-home').hidden = false; $('#linee-line').hidden = true; renderLinesHome(); }
function renderLine() {
  if (!S.line) return;
  const el = $('#linee-line'), short = S.line;
  const n = dirCount(short);
  const ms = [...Array(n)].map((_, d) => buildLine(short, d));
  if (S.lineDir >= n) S.lineDir = 0;
  // finché non scegli tu, parte dalla direzione con vetture in tempo reale
  if (!S.lineDirChosen && !ms[S.lineDir].all.length) { const k = ms.findIndex(x => x.all.length); if (k >= 0) S.lineDir = k; }
  const m = ms[S.lineDir], L = m.L, t = now();
  const on = S.myLines.includes(short);
  const live = m.all.length > 0;
  const tab = S.lineTab || (live || !L ? 'schema' : 'partenze');
  const nextDep = di => { const d = L ? departures(L, di, 0).find(x => x.t >= t - 30) : null; return d ? hhmm(d.t) : null; };
  const dirCard = (x, i) => {
    const D = x.D, nd = nextDep(i);
    const names = D ? `<small>Da</small><b>${esc(D.fn)}</b><small>verso</small><b>${esc(D.tn)}</b>`
      : `<small>Dir.</small><b>${i + 1}</b><small>verso</small><b>${esc(x.head || 'destinazione non nota')}</b>`;
    return `<button class="dirc ${i === S.lineDir ? 'on' : ''}" data-dir="${i}">
      <span class="dk">${i === S.lineDir ? '◉' : '○'}</span>
      <span class="dt">${names}</span>
      <span class="dm">${x.all.length ? `<span class="lv">● ${x.all.length} live</span>` : '<span class="nl">no live</span>'}${nd ? `<span>prossima ${nd}</span>` : ''}</span></button>`;
  };
  const ds = m.vehs.map(v => v.delay).filter(x => x != null);
  const avg = ds.length ? ds.reduce((a, b) => a + b, 0) / ds.length : null;
  let html = `<button class="back" id="lback">‹ Linee</button>
    <div style="display:flex;align-items:center;gap:10px;margin:8px 0 2px">${badgeShort(short)}<div style="flex:1;font-weight:800;font-size:18px">Linea ${esc(short)}</div>
    <button class="star ${on ? 'on' : ''}" data-myline="${esc(short)}" style="font-size:24px">${on ? '★' : '☆'}</button></div>
    <h2>${n > 1 ? 'Scegli il capolinea di partenza' : 'Percorso'}</h2>${!L && SD.fail ? '<p class="note" style="margin:0 4px 8px">Nomi dei capolinea e orari arriveranno col primo aggiornamento notturno dei dati.</p>' : ''}
    <div class="dirs">${ms.map(dirCard).join('')}</div>`;
  if (!live && S.tuTs) html += `<div class="alert" style="margin-top:10px">🕒 <b style="display:inline">Nessun dato in tempo reale</b> per questa direzione: ${L ? 'mostro gli orari programmati.' : 'orari programmati non ancora disponibili.'}</div>`;
  if (live) html += `<div class="sum"><div><b>${m.all.length}</b><span>vetture</span></div><div><b class="${delayCls(avg)}">${avg != null ? fmtDelay(avg) : '—'}</b><span>ritardo medio</span></div><div><b>${m.med != null ? Math.round(m.med) + '′' : '—'}</b><span>distacco tipico</span></div></div>`;
  html += `<div class="seg"><button data-ltab="schema" class="${tab === 'schema' ? 'on' : ''}">Fermate</button><button data-ltab="partenze" class="${tab === 'partenze' ? 'on' : ''}">Partenze</button><button data-ltab="vetture" class="${tab === 'vetture' ? 'on' : ''}">Vetture</button><button data-ltab="mappa">Mappa</button></div>`;

  if (tab === 'schema') {
    if (!m.stops.length) html += `<div class="empty">${S.tuTs ? 'Fermate non disponibili per questa direzione.' : 'Carico i dati…'}</div>`;
    else {
      const at = new Map(); for (const v of m.vehs) { const k = v.pos + (v.at ? '' : '-'); if (!at.has(k)) at.set(k, []); at.get(k).push(v); }
      const chip = (v, app) => `<span class="vchip ${app ? 'app' : ''}" data-veh="${esc(v.label)}" title="${app ? 'in arrivo' : 'in fermata'}">🚌 ${esc(v.label)} <span class="dl ${delayCls(v.delay)}">${fmtDelay(v.delay)}</span>${v.bunch ? ' ⚠' : ''}${v.stale ? ' ⦸' : ''}</span>`;
      // senza vetture live: prossimo passaggio programmato a ogni fermata
      const deps = !live && L ? departures(L, S.lineDir, 0).filter(d => d.pat === 0) : [];
      const nextAt = off => { if (off == null) return null; const d = deps.find(x => x.t + off * 60 >= t); return d ? d.t + off * 60 : null; };
      html += `<div class="schema" style="--rc:${routeInfo(m.rids[0] || short).bg}">`;
      if (m.gapsMissing) html += `<div class="gap">Prime fermate non disponibili: nessuna vettura le deve ancora servire.</div>`;
      if (m.offRoute.length) html += `<div class="gap" style="font-style:normal">Su percorso variato: ${m.offRoute.map(v => chip(v, true)).join(' ')}</div>`;
      let prev = null;
      m.stops.forEach((s, i) => {
        if (!m.fromStatic && prev != null && s.seq - prev > 1) html += `<div class="gap">…</div>`;
        prev = s.seq;
        const vs = [...(at.get(i + '-') || []).map(v => chip(v, true)), ...(at.get(String(i)) || []).map(v => chip(v, false))];
        const na = deps.length ? nextAt(s.off) : null;
        const cap = i === 0 ? '<span class="cap">capolinea</span>' : i === m.stops.length - 1 ? '<span class="cap">arrivo</span>' : '';
        html += `<div class="sst"><div class="rail"><i></i></div><div class="body" data-stop="${esc(s.id)}"><div class="nm">${esc(s.name)}${cap}</div>${na ? `<div class="pg">🕒 prossimo passaggio ${hhmm(na)}</div>` : ''}${vs.length ? `<div class="vv">${vs.join('')}</div>` : ''}</div></div>`;
      });
      html += `</div><p class="note">🚌 bordo pieno = in fermata · tratteggiato = in arrivo · ⚠ accodata · ⦸ senza segnale da oltre 5 minuti${deps.length ? ' · 🕒 orario programmato' : ''}.</p>`;
    }
  } else if (tab === 'partenze') {
    if (!L) html += `<div class="empty">${SD.idx ? 'Orari programmati non disponibili per questa linea.' : SD.fail ? 'Orari programmati non ancora pronti: il primo aggiornamento notturno su GitHub non è ancora stato eseguito.' : 'Carico gli orari…'}</div>`;
    else {
      const deps = departures(L, S.lineDir, S.lineDay);
      const liveBy = new Map(m.all.map(v => [v.tu.trip?.trip_id, v]));
      html += `<div class="seg" style="margin-top:0"><button data-lday="0" class="${S.lineDay === 0 ? 'on' : ''}">Oggi</button><button data-lday="1" class="${S.lineDay === 1 ? 'on' : ''}">Domani</button></div>`;
      if (!deps.length) html += `<div class="empty">Nessuna partenza programmata ${S.lineDay ? 'domani' : 'oggi'} da ${esc(m.D?.fn || 'questo capolinea')}.</div>`;
      else {
        const up = S.lineDay ? [] : deps.filter(d => d.t >= t - 60).slice(0, 4);
        if (up.length) html += `<div class="list" style="margin-bottom:12px">` + up.map(d => {
          const v = liveBy.get(d.tid), mi = Math.round((d.t - t) / 60);
          return `<div class="arr"${v ? ` data-veh="${esc(v.label)}" style="cursor:pointer"` : ''}><div class="min" style="text-align:left;min-width:70px">${hhmm(d.t)}</div>
            <div class="grow" style="flex:1"><div class="t">${mi <= 0 ? 'in partenza' : 'tra ' + (mi >= 60 ? Math.floor(mi / 60) + ' h ' + (mi % 60) + ' min' : mi + ' min')}</div><div class="s" style="font-size:12px;color:var(--muted)">${v ? `<span class="rt">● live</span> · vettura ${esc(v.label)} ${fmtDelay(v.delay)}` : '🕒 programmata'}${d.pat ? ' · percorso variato' : ''}</div></div></div>`;
        }).join('') + `</div>`;
        const day0 = midnight(new Date(), S.lineDay).getTime() / 1000;
        const byH = new Map(); for (const d of deps) { const h = Math.floor((d.t - day0) / 3600); if (!byH.has(h)) byH.set(h, []); byH.get(h).push(d); }
        const nextT = deps.find(d => d.t >= t)?.t;
        html += `<div class="tt">` + [...byH].map(([h, list]) => `<div class="tr"><div class="th" ${h >= 24 ? 'title="dopo mezzanotte"' : ''}>${String(h % 24).padStart(2, '0')}${h >= 24 ? '<sup>+1</sup>' : ''}</div><div class="tm">${list.map(d => {
          const mm = String(new Date(d.t * 1000).getMinutes()).padStart(2, '0');
          const cls = !S.lineDay && d.t < t - 60 ? 'past' : d.t === nextT && !S.lineDay ? 'nx' : '';
          return `<span class="${cls}${liveBy.has(d.tid) ? ' lv' : ''}${d.pat ? ' var' : ''}" title="${hhmm(d.t)}">${mm}</span>`;
        }).join('')}</div></div>`).join('') + `</div>
        <p class="note">Partenze da <b>${esc(m.D.fn)}</b> verso ${esc(m.D.tn)} · ${deps.length} corse. Evidenziata la prossima; sottolineata = con vettura in tempo reale; corsivo = percorso variato; +1 = dopo mezzanotte. Orari programmati dall’archivio ufficiale (Roma Servizi per la Mobilità).</p>`;
      }
    }
  } else {
    if (!m.all.length) html += `<div class="empty">Nessuna vettura in tempo reale in questa direzione.</div>`;
    else html += `<table class="mon"><tr><th>Vettura</th><th>Posizione</th><th>Ritardo</th><th>Distacco</th></tr>` +
      m.vehs.concat(m.offRoute).map(v => `<tr data-veh="${esc(v.label)}"><td class="n">${esc(v.label)}</td><td>${v.at ? '' : '<span style="color:var(--muted)">verso </span>'}${esc(S.stopById.get(v.stop)?.name || v.stop)}${flags(v) ? '<br>' + flags(v) : ''}</td>
        <td class="${delayCls(v.delay)}">${fmtDelay(v.delay) || '—'}</td><td>${v.gap != null ? Math.round(v.gap) + '′' : '—'}</td></tr>`).join('') + `</table>
      <p class="note">Ordine: dalla vettura più avanti sul percorso. Distacco = minuti dalla vettura che precede, stimati dalle previsioni di passaggio.</p>`;
  }
  el.innerHTML = html;
}
function toggleMyLine(short) {
  S.myLines = S.myLines.includes(short) ? S.myLines.filter(x => x !== short) : [...S.myLines, short];
  localStorage.setItem('iv.lines', JSON.stringify(S.myLines));
  if (S.line) renderLine(); else renderLinesHome();
}


/* ---------------- Avvisi sulle mie linee (accodamenti e buchi) ---------------- */
S.notify = (() => { try { return localStorage.getItem('iv.notify') === '1'; } catch (e) { return false; } })();
S.alertSeen = new Map(); S.alertLine = new Map();
function ivToast(text) {
  let t = document.getElementById('ivtoast');
  if (!t) { t = document.createElement('div'); t.id = 'ivtoast'; t.className = 'ivtoast'; document.body.appendChild(t); }
  t.textContent = text; t.classList.add('on'); clearTimeout(ivToast.h); ivToast.h = setTimeout(() => t.classList.remove('on'), 8000);
}
async function sendAlert(line, text) {
  if (window.parent !== window) window.parent.postMessage({ type: 'invettura-alert', line, text }, location.origin);
  else ivToast(text);
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const opt = { body: text, tag: 'iv-' + line, renotify: true, icon: (window.INVETTURA_API ? '../' : '/') + 'icon-192.png' };
  try {
    const reg = navigator.serviceWorker && await navigator.serviceWorker.getRegistration();
    if (reg) await reg.showNotification('InVettura \u00b7 Linea ' + line, opt); else new Notification('InVettura \u00b7 Linea ' + line, opt);
  } catch (e) { try { new Notification('InVettura \u00b7 Linea ' + line, opt); } catch (e2) {} }
}
async function monitorLines() {
  if (!S.notify || !S.myLines.length || document.hidden) return;
  try { await Promise.all([refreshTrips(false), refreshVehicles(false), ...S.myLines.map(l => sdLine(l).catch(() => null)), sdCal().catch(() => null)]); } catch (e) { return; }
  const t = now();
  for (const [k, ts] of S.alertSeen) if (t - ts > 1800) S.alertSeen.delete(k);
  for (const short of S.myLines) {
    const parts = [];
    for (let d = 0; d < dirCount(short); d++) {
      const m = buildLine(short, d), fresh = [];
      m.vehs.forEach((v, i) => {
        if (v.bunch) { const a = m.vehs[i - 1]; const k = `${short}|${d}|q|${a?.label}|${v.label}`; if (!S.alertSeen.has(k)) { fresh.push(`${a?.label} e ${v.label} accodate (${Math.round(v.gap)}\u2032)`); } S.alertSeen.set(k, t); }
        if (v.hole) { const k = `${short}|${d}|h|${v.label}`; if (!S.alertSeen.has(k)) { fresh.push(`buco di ${Math.round(v.gap)}\u2032 prima della ${v.label}`); } S.alertSeen.set(k, t); }
      });
      if (fresh.length) parts.push(`\u2192 ${m.D?.tn || m.head || 'dir. ' + (d + 1)}: ` + fresh.join(', '));
    }
    if (!parts.length) continue;
    if (t - (S.alertLine.get(short) || 0) < 600) continue; // al massimo un avviso ogni 10 minuti per linea
    S.alertLine.set(short, t);
    sendAlert(short, `Linea ${short} ${parts.join(' \u00b7 ')}`);
  }
}
async function toggleNotify() {
  S.notify = !S.notify;
  try { localStorage.setItem('iv.notify', S.notify ? '1' : '0'); } catch (e) {}
  if (S.notify && 'Notification' in window && Notification.permission === 'default') { try { await Notification.requestPermission(); } catch (e) {} }
  if (S.notify) { S.alertSeen.clear(); monitorLines(); }
  renderLinesHome();
}
setInterval(monitorLines, 60000);
setTimeout(monitorLines, 8000);

/* ---------------- Tabelle di marcia (PDF "Stampa Turni Macchina" da GAPI) ---------------- */
// Dal nome file: TM + tipo + linea + '-' + AAMMGG (+ suffisso)
function infoNomeTabella(name) {
  const m = String(name).match(/TM([A-Z])(.+?)-(\d{6})/i);
  if (!m) return null;
  const d = m[3];
  return { tipo: m[1].toUpperCase(), linea: m[2], dal: `20${d.slice(0, 2)}-${d.slice(2, 4)}-${d.slice(4, 6)}` };
}
// Legge un PDF e restituisce le tabelle: [{n, t:[minuti 0-1439 di tutti gli orari della tabella]}]
async function leggiTabellaPdf(buf, name) {
  const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(buf) }).promise;
  const tabs = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const tc = await page.getTextContent();
    const txt = tc.items.map(it => it.str).join(' ');
    const n = (txt.match(/Tab\.?\s*N\s*°\s*(\d+)/i) || [])[1];
    if (!n) continue;
    // orari dopo la riga di separazione (le righe d'intestazione hanno presenza/consegna, turni guida...)
    const corpo = txt.split(/¯{5,}/).slice(1).join(' ') || txt;
    const t = [...corpo.matchAll(/\b([0-2]\d):([0-5]\d)\b/g)].map(m => (+m[1] * 60 + +m[2]) % 1440);
    const prev = tabs.find(x => x.n === +n);
    if (prev) prev.t.push(...t); else tabs.push({ n: +n, t });
  }
  const info = infoNomeTabella(name) || {};
  return { file: name, ...info, tabs };
}
// Abbina i turni macchina della linea (giorno 'day' rispetto a oggi) alle tabelle importate.
// Restituisce Map(prefisso turno -> {n, file, prog: Map(tid -> n. corsa)})
function abbinaTabelle(L, day, tabelle) {
  const turni = new Map();
  // solo le corse del servizio di quel giorno (non i pezzi di turno di ieri oltre la mezzanotte)
  L.dirs.forEach((D, di) => { for (const d of departures(L, di, day)) { if (d.back) continue; const k = d.tid.split('-')[0]; if (!turni.has(k)) turni.set(k, []); turni.get(k).push(d); } });
  const out = new Map();
  if (!tabelle || !tabelle.length) return out;
  for (const [k, deps] of turni) {
    deps.sort((a, b) => a.t - b.t);
    const mins = deps.map(d => { const x = new Date(d.t * 1000); return x.getHours() * 60 + x.getMinutes(); });
    let best = null;
    for (const T of tabelle) for (const tab of T.tabs) {
      const set = new Set(tab.t); const hit = mins.filter(m => set.has(m)).length / mins.length;
      if (!best || hit > best.hit) best = { hit, n: tab.n, file: T.file };
    }
    if (best && best.hit >= 0.8) out.set(k, { n: best.n, file: best.file, hit: best.hit, prog: new Map(deps.map((d, i) => [d.tid, i + 1])) });
  }
  return out;
}

const PDFJS = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/';
async function caricaPdfJs() {
  if (window.pdfjsLib) return;
  await new Promise((res, rej) => { const s = document.createElement('script'); s.src = PDFJS + 'pdf.min.js'; s.onload = res; s.onerror = () => rej(new Error('impossibile caricare il lettore PDF')); document.head.appendChild(s); });
  pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS + 'pdf.worker.min.js';
}
// archivio sul dispositivo: { LINEA: [ {file, tipo, linea, dal, tabs:[{n,t}]} ] }
async function tabelleSalvate() { return (await idb.get('tabelle').catch(() => null)) || {}; }
async function importaTabelle(files, onProgress) {
  let arch = await tabelleSalvate();
  const fatti = [], errori = [];
  // file unico già pronto (tabelle-per-RDE.json): sostituisce tutto l'archivio
  for (const f of files.filter(f => /\.json$/i.test(f.name))) {
    try {
      const j = JSON.parse(await f.text());
      if (!j || !Array.isArray(j.tabelle)) throw new Error('non è il file delle tabelle');
      arch = {};
      for (const T of j.tabelle) {
        if (!T || !T.linea || !Array.isArray(T.tabs) || !T.tabs.length) continue;
        const k = String(T.linea).toUpperCase();
        (arch[k] = arch[k] || []).push(T); fatti.push(T);
      }
    } catch (e) { errori.push(f.name + ': ' + e.message); }
  }
  const pdfs = files.filter(f => !/\.json$/i.test(f.name));
  if (pdfs.length) await caricaPdfJs();
  let i = 0;
  for (const f of pdfs) {
    i++; onProgress && onProgress(i, pdfs.length, f.name);
    try {
      const T = await leggiTabellaPdf(await f.arrayBuffer(), f.name);
      if (!T.linea || !T.tabs.length) throw new Error('non sembra una tabella di marcia');
      const k = T.linea.toUpperCase();
      arch[k] = (arch[k] || []).filter(x => x.file !== T.file).concat([T]);
      fatti.push(T);
    } catch (e) { errori.push(f.name + ': ' + e.message); }
  }
  await idb.set('tabelle', arch);
  return { fatti, errori, arch };
}
async function boxTabelle() {
  const el = $('#ptab'); if (!el) return;
  const arch = await tabelleSalvate(), linee = Object.keys(arch), n = linee.reduce((a, k) => a + arch[k].length, 0);
  el.innerHTML = `<div class="nbox ${n ? 'on' : ''}" style="margin:12px 0"><label class="btn ${n ? 'ghost' : ''}" style="padding:10px 12px;cursor:pointer">📂 Importa tabelle di marcia<input type="file" id="ptabIn" accept="application/pdf,.pdf,application/json,.json" multiple hidden></label>
    <span>${n ? `${n} tabelle di ${linee.length} linee sul dispositivo. Servono per scrivere il turno (es. 90/2°). Per aggiornarle reimporta <b>tabelle-per-RDE.json</b> dalla cartella OneDrive.` : 'Dalla cartella OneDrive «Tabelle di marcia» scegli il file <b>tabelle-per-RDE.json</b> (contiene tutte le tabelle). In alternativa puoi selezionare i singoli PDF. Restano solo su questo dispositivo.'}</span></div><div id="ptabMsg"></div>`;
  $('#ptabIn').addEventListener('change', async e => {
    const files = [...e.target.files]; if (!files.length) return;
    const msg = $('#ptabMsg');
    try {
      const r = await importaTabelle(files, (i, tot, name) => { msg.innerHTML = `<div class="note">Leggo ${i}/${tot}: ${esc(name)}…</div>`; });
      msg.innerHTML = `<div class="note">Importate ${r.fatti.length} tabelle${r.errori.length ? `; non lette: ${r.errori.map(esc).join(', ')}` : ''}.</div>`;
      boxTabelle();
    } catch (err) { msg.innerHTML = `<div class="alert"><b>Importazione non riuscita</b>${esc(err.message)}</div>`; }
  });
}

/* ---------------- Corse perse / limitate (dallo storico di 48 ore del ponte) ---------------- */
const PERSE = QS.get('perse') === '1';
async function fetchStorico(from, to) {
  const out = { since: null, snaps: [] };
  for (let a = from; a < to; a += 8 * 3600) {        // il ponte accetta finestre di max 8 ore
    const r = await fetch(`${BASE}/api/storico?from=${Math.floor(a)}&to=${Math.floor(Math.min(to, a + 8 * 3600))}`, { cache: 'no-store' });
    const j = await r.json().catch(() => ({ error: 'risposta non valida' }));
    if (!r.ok || j.error) throw new Error(j.error || 'HTTP ' + r.status);
    out.since = j.since; out.snaps.push(...j.snaps);
  }
  return out;
}
// dateStr 'YYYY-MM-DD', hh:mm locali -> epoch s
const epochOf = (dateStr, hm) => { const [y, mo, d] = dateStr.split('-').map(Number); const [h, mi] = hm.split(':').map(Number); return new Date(y, mo - 1, d, h, mi).getTime() / 1000; };
async function calcolaPerse(lines, dateStr, dalle, alle) {
  let from = epochOf(dateStr, dalle), to = epochOf(dateStr, alle); if (to <= from) to += 86400;
  const t = now();
  if (from > t) { from -= 86400; to -= 86400; } // turno di notte: l'inizio era ieri sera
  if (from < t - 48 * 3600) throw new Error('Lo storico copre solo le ultime 48 ore.');
  await Promise.all([sdCal(), sdIndex()]);
  const st = await fetchStorico(from - 3600, Math.min(t, to + 3 * 3600));
  if (!st.snaps.length) throw new Error('Nessuna registrazione in questa fascia: il ponte non stava registrando.');
  // aggrega lo storico per corsa
  const agg = new Map(), seenRoute = new Map();
  for (const [ts, rows] of st.snaps) for (const [trip, veh, seq, stop, vts] of rows) {
    let a = agg.get(trip); if (!a) agg.set(trip, a = { veh, first: ts, last: ts, firstSeq: seq || 0, firstStop: stop, minSeq: seq || 99, maxSeq: seq || 0, lastStop: stop, move: null, stops: new Set() });
    if (stop) a.stops.add(stop);
    a.last = ts; a.veh = veh || a.veh; if (seq) { a.minSeq = Math.min(a.minSeq, seq); if (seq > a.maxSeq) { a.maxSeq = seq; a.lastStop = stop; } }
    if (!a.move && seq >= 2) a.move = { ts, seq };
  }
  // corse di ogni vettura in ordine di tempo (serve a capire se e' arrivata al capolinea tra due registrazioni)
  const nz = x => String(x ?? '').toUpperCase().replace(/^0+(?=.)/, ''), perVeh = new Map();
  for (const a of agg.values()) { const k = nz(a.veh); if (!perVeh.has(k)) perVeh.set(k, []); perVeh.get(k).push(a); }
  for (const l of perVeh.values()) l.sort((x, y) => x.first - y.first);
  const dopo = a => { const l = perVeh.get(nz(a.veh)) || []; return l.find(b => b !== a && b.first > a.last) || null; };
  const dayOff = Math.round((midnight(new Date(from * 1000)).getTime() - midnight(new Date()).getTime()) / 86400000);
  const res = [];
  for (const short of lines) {
    const L = await sdLine(short); if (!L) { res.push({ short, err: 'linea non trovata' }); continue; }
    // turni macchina dalle tabelle di marcia importate (90/1, 90/2...)
    const arch = await tabelleSalvate();
    const abb = abbinaTabelle(L, dayOff, arch[String(short).toUpperCase()] || []);
    if (!S.tabMap) S.tabMap = new Map();
    S.tabMap.set(String(short).toUpperCase(), new Map([...abb].map(([k, v]) => [k, v.n])));
    const nTurni = new Set(); L.dirs.forEach((D, di) => { for (const d of departures(L, di, dayOff)) if (!d.back) nTurni.add(d.tid.split('-')[0]); });
    let gpsLine = false;
    const dirs = L.dirs.map((D, di) => {
      // vetture di questa direzione che trasmettevano nella fascia (per capire se il GPS funzionava)
      const dirTrips = new Set(); for (const list of Object.values(D.svc)) for (const [, , tid] of list) dirTrips.add(tid);
      const tx = new Set(); for (const [ts, rows] of st.snaps) if (ts >= from - 600 && ts <= to + 600) for (const r of rows) if (dirTrips.has(r[0])) tx.add(ts);
      const gpsOk = tx.size >= 3; if (gpsOk) gpsLine = true;
      // partenze nella fascia; la stessa partenza puo' stare in due servizi (oltre le 24): tengo quella registrata
      const byKey = new Map();
      for (const day of [dayOff, dayOff + 1]) for (const d of departures(L, di, day)) {
        if (d.t < from || d.t > to) continue;
        const k = d.t + '|' + d.pat, old = byKey.get(k);
        if (!old || (!agg.has(old.tid) && agg.has(d.tid))) byKey.set(k, d);
      }
      const deps = [...byKey.values()].sort((a, b) => a.t - b.t);
      const items = deps.map(d => {
        const P = D.pats[d.pat] || D.pats[0];
        const endT = d.t + (P.off[P.off.length - 1] || 0) * 60;
        const a = agg.get(d.tid);
        if (d.t > t) return { d, s: 'futura' };
        // partita prima che il ponte iniziasse a registrare: non possiamo saperlo
        if (!a && st.since && d.t < st.since + 120) return { d, s: 'incerta' };
        if (!a) return { d, s: gpsOk ? 'persa' : 'incerta' };
        let late = null;
        // il feed indica la fermata VERSO cui va: la prima volta che la vediamo diretta alla fermata N, ha lasciato la N-1
        if (a.move) { const o = P.off[Math.max(0, Math.min(a.move.seq, P.off.length) - 2)]; if (o != null) { const dl = (a.move.ts - (d.t + o * 60)) / 60; if (dl > 5) late = Math.round(dl); } }
        // limitata = non ha raggiunto il capolinea, anche per una sola fermata.
        // Arrivata se e' stata vista all'ultima fermata o diretta verso di essa (il feed indica la prossima fermata):
        // cosi' una vettura che arriva e sparisce tra due registrazioni non risulta limitata per errore.
        const ended = t > endT + 15 * 60, n = P.st.length, capo = P.st[n - 1];
        // oppure: era quasi arrivata (ultime 5 fermate) e poco dopo la stessa vettura compare sulla corsa successiva
        // ferma proprio a quel capolinea (il GPS ha cambiato corsa tra una registrazione e l'altra, ogni 3 minuti)
        const b = dopo(a);
        const ripartita = !!b && b.firstStop === capo && n - a.maxSeq <= 5 && b.first - a.last <= 12 * 60;
        const arrivata = a.maxSeq >= n || a.stops.has(capo) || ripartita;
        if (ended && !arrivata) return { d, s: 'limitata', veh: a.veh };
        return { d, s: late ? 'ritardo' : 'partita', veh: a.veh, late };
      });
      return { D, items, gpsOk };
    });
    for (const d of dirs) for (const x of d.items) { const v = abb.get(x.d.tid.split('-')[0]); if (v) { x.tab = v.n; x.corsa = v.prog.get(x.d.tid); } }
    res.push({ short, gpsOk: gpsLine, dirs, tabOk: abb.size, tabTot: nTurni.size, tabImp: (arch[String(short).toUpperCase()] || []).length });
  }
  return { res, since: st.since };
}
// turno macchina (90/7) di una corsa: dalle tabelle di marcia importate (S.tabMap: linea -> Map(prefisso turno -> n. tabella))
function tabOf(short, tid) { const m = S.tabMap && S.tabMap.get(String(short).toUpperCase()); return m ? m.get(String(tid).split('-')[0]) || null : null; }
// testo come nel fonogramma: "90/7° perde n. 2 corse e n. 1 limitata" (senza orari ne' capolinea)
function testoPerse(r) {
  const righe = []; let nP = 0, nL = 0;
  const frase = (chi, p, l) => {
    const corse = p ? `perde n. ${p} ${p === 1 ? 'corsa' : 'corse'}` : '';
    const lim = l ? `n. ${l} ${l === 1 ? 'limitata' : 'limitate'}` : '';
    return `${chi} ${corse && lim ? corse + ' e ' + lim : corse || 'effettua ' + lim}`;
  };
  for (const l of r.res) {
    if (!l.dirs) continue;
    const g = new Map(); // turno (o linea, se le tabelle non ci sono) -> [perse, limitate]
    for (const d of l.dirs) for (const x of d.items) {
      if (x.s !== 'persa' && x.s !== 'limitata') continue;
      const tab = tabOf(l.short, x.d.tid), k = tab ? `${l.short}/${tab}°` : l.short;
      const c = g.get(k) || [0, 0, tab || 0]; if (x.s === 'persa') c[0]++; else c[1]++; g.set(k, c);
    }
    for (const [k, [p, li]] of [...g].sort((a, b) => a[1][2] - b[1][2])) { righe.push(frase(k, p, li)); nP += p; nL += li; }
  }
  return { s: righe.length ? righe.join('\n') : 'Nessuna corsa persa o limitata.', nP, nL };
}
async function renderPerse() {
  const el = $('#v-perse');
  const linee = ($('#pl').value || '').split(/[\s,;]+/).map(x => x.trim()).filter(Boolean);
  const box = $('#pres');
  if (!linee.length) { box.innerHTML = `<div class="empty">Scrivi almeno una linea.</div>`; return; }
  box.innerHTML = `<div class="empty">Confronto partenze programmate e corse registrate…</div>`;
  let r;
  try { await (S.staticP || Promise.resolve()).catch(() => {}); r = await calcolaPerse(linee, $('#pd').value, $('#pa').value, $('#pb').value); }
  catch (e) { box.innerHTML = `<div class="alert"><b>Non posso calcolare</b>${esc(e.message)}</div>`; return; }
  S.perseRes = r;
  let html = '';
  for (const l of r.res) {
    if (l.err) { html += `<div class="alert">${esc(l.short)}: ${esc(l.err)}</div>`; continue; }
    const all = l.dirs.flatMap(d => d.items).filter(x => x.s !== 'futura');
    const c = k => all.filter(x => x.s === k).length;
    html += `<h2 style="display:flex;align-items:center;gap:8px">${badgeShort(l.short)} Linea ${esc(l.short)}</h2>`;
    html += l.tabImp ? `<p class="note" style="margin:0 4px 8px">Tabelle di marcia: ${l.tabOk} turni su ${l.tabTot} riconosciuti${l.tabOk < l.tabTot ? ' (importa la tabella del tipo di giorno giusto per gli altri)' : ''}.</p>`
      : `<p class="note" style="margin:0 4px 8px">Nessuna tabella di marcia della ${esc(l.short)} sul dispositivo: il testo indica il totale della linea invece del turno.</p>`;
    for (const d of l.dirs) if (!d.gpsOk && d.items.length) html += `<div class="alert"><b>Dati GPS assenti da ${esc(d.D.fn)}</b>Nessuna vettura di questa direzione ha trasmesso nella fascia: le sue corse sono segnate come incerte, non come perse.</div>`;
    html += `<div class="sum"><div><b>${all.length}</b><span>programmate${c('incerta') ? ` (${c('incerta')} incerte)` : ''}</span></div><div><b style="color:var(--ok)">${c('partita') + c('ritardo')}</b><span>partite</span></div><div><b style="color:var(--late)">${c('persa')}</b><span>perse</span></div><div><b style="color:var(--warn)">${c('limitata')}</b><span>limitate</span></div></div>`;
    for (const d of l.dirs) {
      if (!d.items.length) continue;
      html += `<div class="pdir">Da <b>${esc(d.D.fn)}</b> verso ${esc(d.D.tn)}</div><div class="pch">` + d.items.map(x => {
        const tt = hhmm(x.d.t) + (x.tab ? ` \u00b7 ${esc(l.short)}/${x.tab}\u00b0${x.corsa ? ' ' + x.corsa + '\u00aa' : ''}` : '');
        if (x.s === 'partita') return `<span class="ok" title="partita">${tt} · ${esc(x.veh || '?')}</span>`;
        if (x.s === 'ritardo') return `<span class="lt" title="partita in ritardo">${tt} · ${esc(x.veh || '?')} +${x.late}′</span>`;
        if (x.s === 'persa') return `<span class="ko" title="non partita">${tt}</span>`;
        if (x.s === 'limitata') return `<span class="li" title="limitata: non ha raggiunto il capolinea">${tt} · ${esc(x.veh || '?')} · limitata</span>`;
        if (x.s === 'incerta') return `<span class="un" title="dato incerto">${tt} · ?</span>`;
        return `<span class="fu" title="non ancora partita">${tt}</span>`;
      }).join('') + `</div>`;
    }
  }
  const T = testoPerse(r);
  html += `<div class="ptxt" style="white-space:pre-line">${esc(T.s)}</div>
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px">${window.parent !== window ? `<button class="btn" id="pUse" style="padding:12px">Usa nella scheda</button>` : ''}<button class="btn ghost" id="pCopy" style="padding:12px">Copia testo</button></div>
    <p class="note">Verde partita · rosso barrato non partita · arancio limitata (non ha raggiunto il capolinea) · giallo partita con oltre 5′ di ritardo · grigio dato incerto (GPS assente o corsa precedente all\u2019inizio dello storico). Il risultato vale quanto i dati trasmessi dalle vetture: verifica sempre prima del fonogramma. Storico disponibile dal ${r.since ? new Date(r.since * 1000).toLocaleString('it', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—'}.</p>`;
  box.innerHTML = html;
}
function initPerse() {
  const pad = x => String(x).padStart(2, '0'), d = new Date();
  $('#pd').value = QS.get('data') || `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  $('#pa').value = QS.get('dalle') || `${pad(Math.max(0, d.getHours() - 1))}:00`;
  $('#pb').value = QS.get('alle') || `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  $('#pl').value = QS.get('linee') || '';
  $('#pgo').addEventListener('click', renderPerse);
  boxTabelle();
  document.addEventListener('click', e => {
    if (e.target.id === 'pUse' && S.perseRes) { const T = testoPerse(S.perseRes); window.parent.postMessage({ type: 'invettura-perse', testo: T.s, perse: T.nP, limitate: T.nL }, location.origin); }
    if (e.target.id === 'pCopy' && S.perseRes) { navigator.clipboard?.writeText(testoPerse(S.perseRes).s).then(() => { e.target.textContent = 'Copiato'; }).catch(() => {}); }
  });
  document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.id === 'v-perse'));
  document.querySelector('nav').style.display = 'none';
  $('#pickClose').hidden = false; $('#status').style.display = 'none'; $('#pickClose').style.marginLeft = 'auto'; $('.logo').style.fontSize = '19px'; $('.logo span').innerHTML = 'Corse <b>perse</b>';
  $('#pickClose').addEventListener('click', () => window.parent.postMessage({ type: 'invettura-close' }, location.origin));
  if ($('#pl').value) sdIndex().then(renderPerse).catch(renderPerse);
}
/* ---------------- Scelta vettura per la scheda evento (RDE) ---------------- */
function pickData(label) {
  const v = S.vehicles.find(x => x.label === label);
  const tu = v ? S.byTrip.get(v.trip?.trip_id) : null;
  const r = v ? routeInfo(v.rid) : null;
  const sid = v?.stop_id || tu?.stu?.[0]?.stop_id;
  const st = sid && S.stopById.get(sid);
  return {
    type: 'invettura-pick', vettura: String(label).replace(/^0+(?=.)/, ''), vetturaFeed: label,
    linea: r?.short || '', direzione: v ? headsign(v.trip?.trip_id) : '',
    fermata: st ? st.name : '', fermataCodice: st ? (st.code || st.id) : '', fermataStato: v?.status === 1 ? 'ferma a' : 'verso',
    lat: v?.lat, lon: v?.lon, ora: new Date().toTimeString().slice(0, 5),
  };
}
function sendPick(label) {
  const d = pickData(label);
  if (window.parent !== window) window.parent.postMessage(d, location.origin);
}
function showVehicle(label) { S.vq = label; $('#vq').value = label.replace(/^0+(?=.)/, ''); switchView('vettura'); tick(true); }

/* ---------------- Navigation & events ---------------- */
function switchView(v) {
  S.view = v;
  document.querySelectorAll('.view').forEach(e => e.classList.toggle('active', e.id === 'v-' + v));
  document.querySelectorAll('nav button').forEach(b => b.classList.toggle('active', b.dataset.v === v));
  if (v === 'mappa') { initMap(); setTimeout(() => S.map.invalidateSize(), 50); }
  if (v === 'linee' && !S.line) renderLinesHome();
  tick();
}
function toggleFav(id) {
  S.fav = S.fav.includes(id) ? S.fav.filter(x => x !== id) : [...S.fav, id];
  localStorage.setItem('iv.fav', JSON.stringify(S.fav));
  if (S.stop) renderStop(); else renderHome();
}

document.addEventListener('click', e => {
  const f = e.target.closest('[data-fav]'); if (f) { e.stopPropagation(); toggleFav(f.dataset.fav); return; }
  const ml = e.target.closest('[data-myline]'); if (ml) { e.stopPropagation(); toggleMyLine(ml.dataset.myline); return; }
  const dr = e.target.closest('[data-dir]'); if (dr) { S.lineDir = +dr.dataset.dir; S.lineDirChosen = true; S.lineTab = null; renderLine(); return; }
  const dy = e.target.closest('[data-lday]'); if (dy) { S.lineDay = +dy.dataset.lday; renderLine(); return; }
  const lt = e.target.closest('[data-ltab]'); if (lt) {
    if (lt.dataset.ltab === 'mappa') { $('#lineFilter').value = S.line; S.fitFilter = null; switchView('mappa'); return; }
    S.lineTab = lt.dataset.ltab; renderLine(); return;
  }
  const pk = e.target.closest('[data-pick]'); if (pk) { sendPick(pk.dataset.pick); return; }
  const mp = e.target.closest('[data-map]'); if (mp) { focusVehicle(mp.dataset.map); return; }
  const vh0 = e.target.closest('[data-veh]'); if (vh0) { if (PICK) showVehicle(vh0.dataset.veh); else focusVehicle(vh0.dataset.veh); return; }
  const ln = e.target.closest('[data-line]'); if (ln) { if (S.view !== 'linee') switchView('linee'); openLine(ln.dataset.line); return; }
  const st = e.target.closest('[data-stop]'); if (st) { if (S.view !== 'attese') switchView('attese'); openStop(st.dataset.stop); return; }
  const vh = e.target.closest('[data-veh]'); if (vh) { focusVehicle(vh.dataset.veh); return; }
  const nb = e.target.closest('nav button'); if (nb) { switchView(nb.dataset.v); return; }
  if (e.target.closest('#notifyBtn')) { toggleNotify(); return; }
  if (e.target.id === 'back' || e.target.id === 'lback') history.back();
});
window.addEventListener('popstate', () => { if (S.view === 'linee' && S.line) closeLine(); else if (S.stop) closeStop(); });
$('#lq').addEventListener('input', renderLinesHome);
$('#q').addEventListener('input', renderHome);
$('#gps').addEventListener('click', locate);
let filtT;
$('#lineFilter').addEventListener('input', () => { clearTimeout(filtT); filtT = setTimeout(() => { S.fitFilter = null; renderMap(); }, 400); });
const vsearch = () => { S.vq = $('#vq').value.trim(); renderVehicle(); tick(true); };
$('#vgo').addEventListener('click', vsearch);
$('#vq').addEventListener('keydown', e => { if (e.key === 'Enter') vsearch(); });
$('#reload').addEventListener('click', () => loadStatic(true).catch(() => {}));
let deferredPrompt;
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferredPrompt = e; $('#install').hidden = false; });
$('#install').addEventListener('click', async () => { if (!deferredPrompt) return; deferredPrompt.prompt(); deferredPrompt = null; $('#install').hidden = true; });
document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(true); });

setInterval(() => { if (!document.hidden) tick(); }, RT_INTERVAL);
if ('serviceWorker' in navigator && !window.INVETTURA_API) navigator.serviceWorker.register('/sw.js').catch(() => {});
if (PICK) {
  $('#pickClose').hidden = false; $('#status').style.display = 'none'; $('#pickClose').style.marginLeft = 'auto'; $('.logo').style.fontSize = '19px'; $('.logo span').innerHTML = 'Scegli la <b>vettura</b>';
  $('#pickClose').addEventListener('click', () => window.parent.postMessage({ type: 'invettura-close' }, location.origin));
  const q0 = QS.get('q'); if (q0) { $('#vq').value = q0; S.vq = q0; }
  switchView('vettura');
}

if (PERSE) initPerse();
S.staticP = loadStatic();
S.staticP.then(() => {
  if (navigator.permissions) navigator.permissions.query({ name: 'geolocation' }).then(p => { if (p.state === 'granted') locate(); }).catch(() => {});
  const h = decodeURIComponent(location.hash);
  if (h.startsWith('#fermata-')) { history.replaceState(null, '', location.pathname); openStop(h.slice(9)); }
  else if (h.startsWith('#linea-')) { history.replaceState(null, '', location.pathname); switchView('linee'); openLine(h.slice(7)); }
}).catch(() => {});
