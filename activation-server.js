/*
 * Zayron Activation Server — Phase 1 (dependency-free, like the pairing relay).
 *
 * WHAT IT DOES
 *  - App calls POST /api/check {mac, app, ver} on launch → server says allow / block (+ expiry).
 *  - Admin panel (web) to: toggle paid/free per app, kill-switch, trial days, contact text,
 *    manage resellers + credits, and activate / block / extend / delete device MACs.
 *  - Credit rule: 1 credit = 1 year, 2 credits = lifetime.
 *  - Everything stored in one JSON file (data.json). No database to install. Move to SQLite later.
 *
 * DEPLOY (does not touch your other apps): see the comment block at the very bottom.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.ZAYRON_ACT_PORT || 3800;
const DATA = process.env.ZAYRON_ACT_DATA || path.join(__dirname, 'data.json');

// ---------- storage ----------
function load() {
  try { return JSON.parse(fs.readFileSync(DATA, 'utf8')); } catch (e) { return null; }
}
function save(d) {
  const tmp = DATA + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(d, null, 2));
  fs.renameSync(tmp, DATA);
}
let db = load();
if (!db) {
  db = {
    admin_key: process.env.ZAYRON_ADMIN_KEY || crypto.randomBytes(6).toString('hex'),
    config: {
      paid: { windows: false, android: false, ios: false },   // false = FREE (nobody is blocked)
      kill: { windows: false, android: false, ios: false },   // true = block that app entirely
      trial_days: 0,                                          // >0 = auto free trial for new devices
      contact: 'WhatsApp +92 314 1892712  ·  zayron.tv'
    },
    resellers: {},   // id -> { name, key, credits, parent, enabled, created }
    devices: {},     // MAC -> { app, plan, expires, activated_by, created, status, note }
    seen: {},        // MAC -> { app, ver, first, last, count }  (live usage tracking)
    ledger: []       // { ts, type, reseller, amount, mac, note }
  };
  save(db);
  console.log('First run. ADMIN KEY = ' + db.admin_key + '  (change it in the panel; keep it secret)');
}
if (!db.seen) db.seen = {};   // migrate older data files

// ---------- usage tracking (debounced saves so heavy traffic never thrashes the disk) ----------
let __dirty = false;
function markDirty() { __dirty = true; }
setInterval(function () { if (__dirty) { __dirty = false; try { save(db); } catch (e) {} } }, 15000).unref();
function recordSeen(mac, app, ver) {
  if (!mac) return;
  if (mac.replace(/[^0-9A-F]/g, '').length < 6) return;   // ignore junk / web fallbacks
  const s = db.seen[mac] || { first: now(), count: 0 };
  s.app = app || s.app || 'unknown';
  if (ver) s.ver = String(ver).slice(0, 20);
  s.last = now();
  s.count = (s.count || 0) + 1;
  db.seen[mac] = s;
  markDirty();
}
function computeStats() {
  const t = now(), MIN = 60 * 1000, H = 3600 * 1000, D = 24 * H;
  const S = { total: 0, online: 0, today: 0, week: 0, month: 0,
    byApp: { windows: 0, android: 0, ios: 0, other: 0 }, recent: [] };
  const macs = Object.keys(db.seen || {});
  S.total = macs.length;
  const arr = [];
  for (const m of macs) {
    const s = db.seen[m], age = t - (s.last || 0);
    if (age <= 7 * MIN) S.online++;
    if (age <= D) S.today++;
    if (age <= 7 * D) S.week++;
    if (age <= 30 * D) S.month++;
    const a = (s.app === 'windows' || s.app === 'android' || s.app === 'ios') ? s.app : 'other';
    S.byApp[a]++;
    arr.push({ mac: m, app: s.app, ver: s.ver || '', last: s.last, count: s.count || 0 });
  }
  arr.sort((a, b) => (b.last || 0) - (a.last || 0));
  S.recent = arr.slice(0, 20);
  return S;
}

// ---------- helpers ----------
const now = () => Date.now();
const YEAR = 365 * 24 * 3600 * 1000;
function normMac(m) { return String(m || '').toUpperCase().replace(/[^0-9A-F:]/g, '').trim(); }
function json(res, code, obj) { res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }); res.end(JSON.stringify(obj)); }
function readBody(req) { return new Promise(r => { let b = ''; req.on('data', c => { b += c; if (b.length > 100000) req.destroy(); }); req.on('end', () => r(b)); }); }

// sessions: token -> expiry
const sessions = {};
function newSession() { const t = crypto.randomBytes(16).toString('hex'); sessions[t] = now() + 8 * 3600 * 1000; return t; }
function validSession(t) { return t && sessions[t] && sessions[t] > now(); }
function cookie(req, name) { const c = (req.headers.cookie || '').split(';').map(s => s.trim()); for (const p of c) if (p.indexOf(name + '=') === 0) return p.slice(name.length + 1); return ''; }

// ---------- device / activation logic ----------
function planExpiry(plan, fromTs) {
  if (plan === 'lifetime') return null;                 // null = never expires
  const base = fromTs && fromTs > now() ? fromTs : now();
  return base + YEAR;                                   // 1 year
}
function deviceActive(dev) {
  if (!dev || dev.status === 'blocked') return false;
  if (dev.plan === 'lifetime' || dev.expires == null) return true;
  return dev.expires > now();
}
function creditsFor(plan) { return plan === 'lifetime' ? 2 : 1; }

// activate/extend a MAC. by = reseller id or 'admin'. returns {ok,error}
function activate(mac, app, plan, by, note) {
  mac = normMac(mac);
  if (!mac) return { ok: false, error: 'bad mac' };
  const cost = creditsFor(plan);
  if (by !== 'admin') {
    const r = db.resellers[by];
    if (!r || !r.enabled) return { ok: false, error: 'reseller disabled' };
    if ((r.credits || 0) < cost) return { ok: false, error: 'not enough credits' };
    r.credits -= cost;
  }
  const cur = db.devices[mac];
  const fromTs = cur && cur.plan !== 'lifetime' && cur.expires ? cur.expires : now();
  db.devices[mac] = {
    app: app || (cur && cur.app) || 'any',
    plan: plan,
    expires: planExpiry(plan, fromTs),
    activated_by: by,
    created: (cur && cur.created) || now(),
    status: 'active',
    note: note || (cur && cur.note) || ''
  };
  db.ledger.push({ ts: now(), type: 'activate', reseller: by, amount: (by === 'admin' ? 0 : -cost), mac, note: plan });
  save(db);
  return { ok: true };
}

// ---------- server ----------
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const p = u.pathname.replace(/\/+$/, '') || '/';

  // ===== APP-FACING: activation check =====
  if (p.endsWith('/api/check') && req.method === 'POST') {
    let body = {}; try { body = JSON.parse(await readBody(req) || '{}'); } catch (e) {}
    const app = (body.app || 'windows').toLowerCase();
    const mac = normMac(body.mac);
    const c = db.config;
    recordSeen(mac, app, body.ver);   // live usage: remember this device checked in
    if (c.kill[app]) return json(res, 200, { active: false, kill: true, message: 'This app is temporarily unavailable. ' + c.contact });
    if (!c.paid[app]) return json(res, 200, { active: true, free: true });        // FREE mode → always allow
    let dev = db.devices[mac];
    if (deviceActive(dev)) return json(res, 200, { active: true, plan: dev.plan, expires: dev.expires });
    // trial for brand-new devices
    if (!dev && c.trial_days > 0) {
      db.devices[mac] = { app, plan: 'trial', expires: now() + c.trial_days * 24 * 3600 * 1000, activated_by: 'trial', created: now(), status: 'active', note: 'auto-trial' };
      save(db);
      return json(res, 200, { active: true, plan: 'trial', expires: db.devices[mac].expires });
    }
    if (dev && dev.plan === 'trial' && deviceActive(dev)) return json(res, 200, { active: true, plan: 'trial', expires: dev.expires });
    return json(res, 200, { active: false, mac, message: 'This device is not activated. Send this MAC to your provider: ' + mac + '  —  ' + c.contact });
  }

  // ===== ADMIN AUTH =====
  if (p.endsWith('/admin/login') && req.method === 'POST') {
    let body = {}; try { body = JSON.parse(await readBody(req) || '{}'); } catch (e) {}
    if (body.key && body.key === db.admin_key) { const t = newSession(); res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': 'zadm=' + t + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=28800' }); return res.end('{"ok":true}'); }
    return json(res, 200, { ok: false, error: 'wrong key' });
  }
  const authed = validSession(cookie(req, 'zadm'));

  // ===== ADMIN ACTIONS (JSON, must be authed) =====
  if (p.indexOf('/admin/act') >= 0 && req.method === 'POST') {
    if (!authed) return json(res, 401, { error: 'login' });
    let b = {}; try { b = JSON.parse(await readBody(req) || '{}'); } catch (e) {}
    const a = b.action;
    try {
      if (a === 'state') return json(res, 200, { config: db.config, resellers: db.resellers, devices: db.devices, ledger: db.ledger.slice(-100).reverse(), stats: computeStats() });
      if (a === 'setConfig') { db.config = Object.assign(db.config, b.config || {}); save(db); return json(res, 200, { ok: true }); }
      if (a === 'setAdminKey') { if (b.key && b.key.length >= 6) { db.admin_key = b.key; save(db); return json(res, 200, { ok: true }); } return json(res, 200, { ok: false, error: 'key too short' }); }
      if (a === 'activate') return json(res, 200, activate(b.mac, b.app, b.plan, b.by || 'admin', b.note));
      if (a === 'block') { const d = db.devices[normMac(b.mac)]; if (d) { d.status = 'blocked'; save(db); } return json(res, 200, { ok: !!d }); }
      if (a === 'unblock') { const d = db.devices[normMac(b.mac)]; if (d) { d.status = 'active'; save(db); } return json(res, 200, { ok: !!d }); }
      if (a === 'delete') { delete db.devices[normMac(b.mac)]; save(db); return json(res, 200, { ok: true }); }
      if (a === 'reseller') { const id = b.id || crypto.randomBytes(4).toString('hex'); db.resellers[id] = Object.assign({ name: b.name || id, key: crypto.randomBytes(8).toString('hex'), credits: 0, parent: b.parent || null, enabled: true, created: now() }, db.resellers[id] || {}); if (b.name) db.resellers[id].name = b.name; save(db); return json(res, 200, { ok: true, id }); }
      if (a === 'credits') { const r = db.resellers[b.id]; if (r) { r.credits = (r.credits || 0) + (parseInt(b.amount) || 0); db.ledger.push({ ts: now(), type: 'credit', reseller: b.id, amount: parseInt(b.amount) || 0, note: 'admin issue' }); save(db); } return json(res, 200, { ok: !!r }); }
      if (a === 'toggleReseller') { const r = db.resellers[b.id]; if (r) { r.enabled = !r.enabled; save(db); } return json(res, 200, { ok: !!r }); }
      return json(res, 200, { error: 'unknown action' });
    } catch (e) { return json(res, 200, { error: String(e) }); }
  }

  // ===== ADMIN PANEL (HTML) =====
  if (p.endsWith('/admin') || p.endsWith('/admin/')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(PANEL);
  }
  if (p.endsWith('/health')) { res.writeHead(200); return res.end('ok'); }
  res.writeHead(404); res.end('not found');
});

// ---------- admin panel HTML (single page, light Hot-Player-style dashboard) ----------
const PANEL = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Zayron — Activation Admin</title><style>
:root{
  --navy:#0e2a4f; --navy2:#123a6b; --cyan:#1fa6e8; --cb:#25b6ff; --cyd:#0e7fc0;
  --bg:#eef3f9; --card:#ffffff; --line:#e4ebf3; --text:#14263f; --muted:#6f8098;
  --green:#12a150; --greenbg:#e7f7ee; --red:#e5546e; --redbg:#fdecef; --amber:#c9860a; --amberbg:#fdf3e0;
}
*{box-sizing:border-box;font-family:'Segoe UI',Roboto,-apple-system,Arial,sans-serif}
html,body{margin:0;height:100%}
body{background:var(--bg);color:var(--text)}
svg{fill:none;stroke:currentColor;stroke-width:1.9;stroke-linecap:round;stroke-linejoin:round}

/* ---- login ---- */
.loginwrap{min-height:100vh;display:flex;align-items:center;justify-content:center;
  background:radial-gradient(80% 60% at 50% 0,rgba(31,166,232,.18),transparent 60%),var(--bg)}
.loginbox{background:var(--card);border:1px solid var(--line);border-radius:18px;padding:34px 30px;width:340px;
  box-shadow:0 24px 60px rgba(20,50,90,.14);text-align:center}
.loginbox .lgo{width:64px;height:64px;margin:0 auto 14px}
.loginbox h2{margin:2px 0 2px;font-size:20px}.loginbox h2 b{color:var(--cyd)}
.loginbox p{margin:0 0 16px;color:var(--muted);font-size:13px}
.loginbox input{width:100%;padding:12px 13px;border-radius:11px;border:1px solid var(--line);background:#f7fafd;font-size:15px;margin-bottom:10px}
.loginbox button{width:100%;padding:12px;border:0;border-radius:11px;background:var(--cyan);color:#fff;font-weight:700;font-size:15px;cursor:pointer}
.loginbox button:hover{background:var(--cyd)}
.err{color:var(--red);font-size:12.5px;margin-top:8px;min-height:16px}

/* ---- shell ---- */
.shell{display:flex;min-height:100vh}
.side{width:230px;flex:none;background:linear-gradient(180deg,var(--navy),#0a2244);color:#dbe8fa;display:flex;flex-direction:column;padding:20px 14px}
.side .brand{display:flex;align-items:center;gap:11px;padding:6px 8px 18px}
.side .brand .lgo{width:40px;height:40px;flex:none}
.side .brand .bt b{display:block;font-size:17px;font-weight:800;letter-spacing:2px;line-height:1;color:#fff}
.side .brand .bt span{font-size:9px;letter-spacing:3px;color:var(--cb);font-weight:700}
.side nav{display:flex;flex-direction:column;gap:3px;margin-top:6px}
.navi{display:flex;align-items:center;gap:12px;padding:11px 13px;border-radius:11px;cursor:pointer;color:#b8cbe6;font-size:14px;font-weight:600;transition:.14s}
.navi svg{width:19px;height:19px}
.navi:hover{background:rgba(255,255,255,.07);color:#fff}
.navi.on{background:linear-gradient(90deg,var(--cyan),var(--cyd));color:#fff;box-shadow:0 8px 20px rgba(31,166,232,.35)}
.side .foot{margin-top:auto;padding:12px 10px 2px;font-size:11px;color:#7d94b6;border-top:1px solid rgba(255,255,255,.08)}
.side .foot b{color:var(--cb)}

.main{flex:1;min-width:0;display:flex;flex-direction:column}
.topbar{display:flex;align-items:center;justify-content:space-between;gap:14px;padding:18px 26px;background:var(--card);border-bottom:1px solid var(--line);position:sticky;top:0;z-index:5}
.topbar #ptitle{font-size:19px;font-weight:800}
.topbar .right{display:flex;align-items:center;gap:12px}
.credits{display:flex;align-items:center;gap:10px;background:linear-gradient(90deg,var(--navy),var(--navy2));color:#fff;
  padding:9px 15px;border-radius:12px;font-size:11px;font-weight:700;letter-spacing:.6px}
.credits b{font-size:18px;color:var(--cb);letter-spacing:0}
.logout{padding:9px 13px;border-radius:10px;border:1px solid var(--line);background:#f7fafd;color:var(--muted);font-weight:700;font-size:13px;cursor:pointer}

.content{padding:22px 26px;overflow:auto}
.view[hidden]{display:none}

/* cards / stats */
.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:16px;margin-bottom:20px}
.stat{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:18px 18px;box-shadow:0 6px 20px rgba(20,50,90,.05)}
.stat .lbl{display:flex;align-items:center;gap:9px;color:var(--muted);font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.5px}
.stat .lbl .ci{width:34px;height:34px;border-radius:10px;display:flex;align-items:center;justify-content:center}
.stat .num{font-size:30px;font-weight:800;margin-top:10px}
.ci.cy{background:rgba(31,166,232,.14);color:var(--cyd)}
.ci.gr{background:var(--greenbg);color:var(--green)}
.ci.am{background:var(--amberbg);color:var(--amber)}
.ci.rd{background:var(--redbg);color:var(--red)}

.card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:20px;margin-bottom:20px;box-shadow:0 6px 20px rgba(20,50,90,.05)}
.card h3{margin:0 0 4px;font-size:16px}
.card .sub{color:var(--muted);font-size:12.5px;margin-bottom:14px}
.row{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
label{font-size:12.5px;color:var(--muted);font-weight:600}
input,select{padding:10px 12px;border-radius:10px;border:1px solid var(--line);background:#f7fafd;color:var(--text);font-size:14px}
input:focus,select:focus{outline:0;border-color:var(--cyan);background:#fff}
button{padding:10px 16px;border-radius:10px;border:0;background:var(--cyan);color:#fff;font-weight:700;cursor:pointer;font-size:14px}
button:hover{background:var(--cyd)}
button.g{background:#eef3f9;border:1px solid var(--line);color:#455872}
button.g:hover{background:#e2e9f2}
button.d{background:var(--red)}button.d:hover{background:#cf3f59}
button.sm{padding:6px 11px;font-size:12.5px;border-radius:8px}

.filters{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:6px}
.chip{padding:8px 14px;border-radius:20px;border:1px solid var(--line);background:#f7fafd;color:var(--muted);font-size:12.5px;font-weight:700;cursor:pointer}
.chip.on{background:var(--navy);color:#fff;border-color:var(--navy)}
.grow{flex:1;min-width:120px}

table{width:100%;border-collapse:collapse;margin-top:12px}
th,td{text-align:left;padding:11px 10px;border-bottom:1px solid var(--line);font-size:13px;vertical-align:middle}
th{color:var(--muted);font-size:10.5px;text-transform:uppercase;letter-spacing:.6px;font-weight:700}
tbody tr:hover{background:#f7fafd}
.mono{font-family:'SF Mono',Consolas,monospace;font-weight:600;letter-spacing:.3px}
.tag{font-size:11px;font-weight:700;padding:3px 10px;border-radius:20px;display:inline-block}
.tag.on{background:var(--greenbg);color:var(--green)}
.tag.off{background:var(--redbg);color:var(--red)}
.tag.soon{background:var(--amberbg);color:var(--amber)}
.tag.life{background:rgba(31,166,232,.14);color:var(--cyd)}
.empty{text-align:center;color:var(--muted);padding:26px;font-size:13.5px}

/* player mode toggles */
.modewrap{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin-top:6px}
.modecard{border:1px solid var(--line);border-radius:14px;padding:16px;background:#f9fbfe}
.modecard h4{margin:0 0 12px;font-size:14px;display:flex;align-items:center;gap:8px}
.modecard .mrow{display:flex;align-items:center;justify-content:space-between;margin:9px 0}
.modecard .mrow span{font-size:12.5px;color:var(--muted);font-weight:600}
.pill{padding:6px 13px;border-radius:20px;font-size:12px;font-weight:700;cursor:pointer;border:0;min-width:78px}
.pill.paid{background:var(--cyan);color:#fff}.pill.free{background:#eef3f9;color:#455872;border:1px solid var(--line)}
.pill.killed{background:var(--red);color:#fff}.pill.live{background:var(--greenbg);color:var(--green)}
.note{font-size:12.5px;color:var(--muted);margin-top:6px}
.ok{color:var(--green);font-weight:700}
.big{font-size:22px;font-weight:800;letter-spacing:1px}
.lookup{background:#f9fbfe;border:1px dashed var(--line);border-radius:14px;padding:18px;margin-top:14px;font-size:14px}
.lookup .k{color:var(--muted);font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.5px}
@media(max-width:820px){.side{width:64px;padding:16px 8px}.side .brand .bt,.side .navi span,.side .foot{display:none}.navi{justify-content:center}.stats{grid-template-columns:repeat(2,1fr)}.modewrap{grid-template-columns:1fr}}
</style></head><body>

<div id="login" class="loginwrap">
  <div class="loginbox">
    <div class="lgo">SVGLOGO</div>
    <h2><b>Zayron</b> Activation</h2>
    <p>Admin sign in</p>
    <input id="key" type="password" placeholder="Admin key" onkeydown="if(event.key==='Enter')login()">
    <button onclick="login()">Sign in</button>
    <div id="lerr" class="err"></div>
  </div>
</div>

<div id="shell" class="shell" style="display:none">
  <aside class="side">
    <div class="brand"><div class="lgo">SVGLOGO</div><div class="bt"><b>ZAYRON</b><span>ADMIN PANEL</span></div></div>
    <nav id="nav">
      <div class="navi on" data-view="dash"><svg viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/></svg><span>Dashboard</span></div>
      <div class="navi" data-view="cust"><svg viewBox="0 0 24 24"><circle cx="9" cy="8" r="3.2"/><path d="M3.5 20c0-3.3 2.7-5 5.5-5s5.5 1.7 5.5 5"/><path d="M17 9.5a2.7 2.7 0 1 0-1-5.2M20.5 20c0-2.6-1.6-4.2-3.5-4.7"/></svg><span>Customers</span></div>
      <div class="navi" data-view="activate"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 8v8M8 12h8"/></svg><span>Activate</span></div>
      <div class="navi" data-view="check"><svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.2-3.2"/></svg><span>Check MAC</span></div>
      <div class="navi" data-view="res"><svg viewBox="0 0 24 24"><rect x="3" y="6" width="18" height="13" rx="2"/><path d="M3 10h18M8 3v3M16 3v3"/></svg><span>Resellers</span></div>
      <div class="navi" data-view="modes"><svg viewBox="0 0 24 24"><rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="8" cy="12" r="2.4"/><path d="M14 10h4M14 14h4"/></svg><span>Player Modes</span></div>
      <div class="navi" data-view="settings"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19.4 13a7.6 7.6 0 0 0 0-2l2-1.5-2-3.4-2.3 1a7.3 7.3 0 0 0-1.7-1L15 3h-4l-.4 2.6a7.3 7.3 0 0 0-1.7 1l-2.3-1-2 3.4 2 1.5a7.6 7.6 0 0 0 0 2l-2 1.5 2 3.4 2.3-1a7.3 7.3 0 0 0 1.7 1l.4 2.6h4l.4-2.6a7.3 7.3 0 0 0 1.7-1l2.3 1 2-3.4z"/></svg><span>Settings</span></div>
    </nav>
    <div class="foot">Signed in as Admin<br><b>zayron.tv</b></div>
  </aside>

  <div class="main">
    <div class="topbar">
      <div id="ptitle">Dashboard</div>
      <div class="right">
        <div class="credits">CREDITS IN CIRCULATION <b id="credtot">0</b></div>
        <button class="logout" onclick="location.reload()">Refresh</button>
      </div>
    </div>
    <div class="content">

      <!-- DASHBOARD -->
      <section id="v-dash" class="view">
        <div class="row" style="justify-content:space-between;align-items:baseline;margin:0 0 12px">
          <h3 style="margin:0;font-size:16px">Live usage <span id="liveDot" style="display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--green);margin-left:5px;vertical-align:middle;box-shadow:0 0 0 4px rgba(18,161,80,.15)"></span></h3>
          <span class="sub" style="margin:0" id="liveUpd">auto-updates every 30s</span>
        </div>
        <div class="stats">
          <div class="stat"><div class="lbl"><span class="ci gr"><svg viewBox="0 0 24 24" style="width:18px;height:18px"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3.5" fill="currentColor" stroke="none"/></svg></span>Online now</div><div class="num" id="u_online">0</div></div>
          <div class="stat"><div class="lbl"><span class="ci cy"><svg viewBox="0 0 24 24" style="width:18px;height:18px"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg></span>Active today</div><div class="num" id="u_today">0</div></div>
          <div class="stat"><div class="lbl"><span class="ci cy"><svg viewBox="0 0 24 24" style="width:18px;height:18px"><rect x="3" y="4" width="18" height="17" rx="2"/><path d="M3 9h18M8 2v4M16 2v4"/></svg></span>This week</div><div class="num" id="u_week">0</div></div>
          <div class="stat"><div class="lbl"><span class="ci am"><svg viewBox="0 0 24 24" style="width:18px;height:18px"><circle cx="9" cy="8" r="3"/><path d="M3.5 19c0-3 2.5-4.5 5.5-4.5s5.5 1.5 5.5 4.5"/><circle cx="17" cy="9" r="2.2"/></svg></span>Total users</div><div class="num" id="u_total">0</div></div>
        </div>
        <div class="card">
          <h3>By app</h3>
          <div class="sub">Which app your users are running (every device ever seen).</div>
          <div id="byapp"></div>
        </div>
        <div class="card">
          <div class="row" style="justify-content:space-between"><h3 style="margin:0">Recently active</h3><span class="sub" style="margin:0">Last 20 check-ins</span></div>
          <table id="recent"></table>
        </div>
        <h3 style="margin:24px 0 2px;font-size:16px">Licensing</h3>
        <div class="sub" style="margin:0 0 12px">Paid activations, expiry and resellers.</div>
        <div class="stats">
          <div class="stat"><div class="lbl"><span class="ci cy"><svg viewBox="0 0 24 24" style="width:18px;height:18px"><rect x="2" y="6" width="20" height="12" rx="2"/><path d="M8 21h8"/></svg></span>Total devices</div><div class="num" id="s_total">0</div></div>
          <div class="stat"><div class="lbl"><span class="ci gr"><svg viewBox="0 0 24 24" style="width:18px;height:18px"><path d="M20 6L9 17l-5-5"/></svg></span>Active</div><div class="num" id="s_active">0</div></div>
          <div class="stat"><div class="lbl"><span class="ci am"><svg viewBox="0 0 24 24" style="width:18px;height:18px"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg></span>Expiring soon</div><div class="num" id="s_soon">0</div></div>
          <div class="stat"><div class="lbl"><span class="ci rd"><svg viewBox="0 0 24 24" style="width:18px;height:18px"><circle cx="12" cy="12" r="9"/><path d="M15 9l-6 6M9 9l6 6"/></svg></span>Expired / blocked</div><div class="num" id="s_dead">0</div></div>
        </div>
        <div class="stats" style="grid-template-columns:repeat(3,1fr)">
          <div class="stat"><div class="lbl"><span class="ci cy"><svg viewBox="0 0 24 24" style="width:18px;height:18px"><circle cx="9" cy="8" r="3"/><path d="M3.5 19c0-3 2.5-4.5 5.5-4.5s5.5 1.5 5.5 4.5"/></svg></span>Resellers</div><div class="num" id="s_res">0</div></div>
          <div class="stat"><div class="lbl"><span class="ci am"><svg viewBox="0 0 24 24" style="width:18px;height:18px"><rect x="3" y="6" width="18" height="13" rx="2"/><path d="M3 10h18"/></svg></span>Credits in circulation</div><div class="num" id="s_cred">0</div></div>
          <div class="stat"><div class="lbl"><span class="ci gr"><svg viewBox="0 0 24 24" style="width:18px;height:18px"><path d="M4 17l5-5 3 3 7-8"/></svg></span>Lifetime devices</div><div class="num" id="s_life">0</div></div>
        </div>
        <div class="card">
          <h3>Recent activity</h3>
          <div class="sub">Latest activations, renewals and credit changes.</div>
          <table id="ledger"></table>
        </div>
      </section>

      <!-- CUSTOMERS -->
      <section id="v-cust" class="view" hidden>
        <div class="card">
          <div class="row" style="justify-content:space-between">
            <div><h3 style="margin:0">Customers / Devices</h3><div class="sub" style="margin:2px 0 0">Every activated MAC, its plan and expiry.</div></div>
            <button onclick="go('activate')">+ New activation</button>
          </div>
          <div class="filters" style="margin-top:14px">
            <div class="chip on" data-f="all">All</div>
            <div class="chip" data-f="active">Active</div>
            <div class="chip" data-f="soon">Expires soon</div>
            <div class="chip" data-f="expired">Expired</div>
            <div class="chip" data-f="blocked">Blocked</div>
            <input id="q" class="grow" placeholder="Search MAC or note…" oninput="render()" style="min-width:180px">
          </div>
          <table id="devs"></table>
        </div>
      </section>

      <!-- ACTIVATE -->
      <section id="v-activate" class="view" hidden>
        <div class="card" style="max-width:640px">
          <h3>Activate a device</h3>
          <div class="sub">1 credit = 1 year · 2 credits = lifetime. As Admin activations are free.</div>
          <div class="row" style="margin-bottom:10px"><label style="width:120px">Device MAC</label><input id="amac" class="grow" placeholder="1A:2B:3C:4D:5E:6F"></div>
          <div class="row" style="margin-bottom:10px"><label style="width:120px">Note (optional)</label><input id="anote" class="grow" placeholder="Customer name / phone"></div>
          <div class="row" style="margin-bottom:10px"><label style="width:120px">App</label>
            <select id="aapp" class="grow"><option value="any">Any app</option><option value="windows">Windows</option><option value="android">Android</option><option value="ios">iOS</option></select></div>
          <div class="row" style="margin-bottom:10px"><label style="width:120px">Plan</label>
            <select id="aplan" class="grow"><option value="1y">1 Year (1 credit)</option><option value="lifetime">Lifetime (2 credits)</option></select></div>
          <div class="row" style="margin-bottom:14px"><label style="width:120px">Activated by</label>
            <select id="aby" class="grow"><option value="admin">As Admin (free)</option></select></div>
          <button onclick="act()">Activate device</button>
          <div id="aerr" class="note"></div>
        </div>
      </section>

      <!-- CHECK MAC -->
      <section id="v-check" class="view" hidden>
        <div class="card" style="max-width:640px">
          <h3>Check a MAC</h3>
          <div class="sub">Look up any device to see its plan, expiry and who sold it.</div>
          <div class="row"><input id="cmac" class="grow" placeholder="Enter device MAC…"><button onclick="checkMac()">Look up</button></div>
          <div id="cres"></div>
        </div>
      </section>

      <!-- RESELLERS -->
      <section id="v-res" class="view" hidden>
        <div class="card">
          <div class="row" style="justify-content:space-between">
            <div><h3 style="margin:0">Resellers &amp; credits</h3><div class="sub" style="margin:2px 0 0">Add resellers, issue credits, enable or disable.</div></div>
          </div>
          <div class="row" style="margin-top:12px"><input id="rname" placeholder="New reseller name" class="grow"><button onclick="addR()">+ Add reseller</button></div>
          <table id="res"></table>
        </div>
      </section>

      <!-- PLAYER MODES -->
      <section id="v-modes" class="view" hidden>
        <div class="card">
          <h3>Player modes</h3>
          <div class="sub">Turn each app Paid or Free, or kill it instantly. Free = nobody is blocked.</div>
          <div class="modewrap" id="modes"></div>
          <div class="row" style="margin-top:18px"><label style="width:150px">Free trial (days, 0 = off)</label><input id="trial" type="number" style="width:100px"></div>
          <div class="row" style="margin-top:10px"><label style="width:150px">Contact text (shown on block)</label><input id="contact" class="grow"></div>
          <div class="row" style="margin-top:14px"><button onclick="saveCfg()">Save settings</button><span id="cfgok" class="ok"></span></div>
        </div>
      </section>

      <!-- SETTINGS -->
      <section id="v-settings" class="view" hidden>
        <div class="card" style="max-width:520px">
          <h3>Change admin key</h3>
          <div class="sub">Use a long, private key. This replaces your current sign-in key immediately.</div>
          <div class="row"><input id="nkey" placeholder="New admin key (min 6 chars)" class="grow"><button class="g" onclick="setKey()">Update key</button></div>
          <div id="kok" class="note"></div>
        </div>
      </section>

    </div>
  </div>
</div>

<script>
var S={},FILTER='all',SOON=14*24*3600*1000;
function post(action,extra){return fetch('admin/act',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(Object.assign({action:action},extra||{}))}).then(function(r){return r.json();});}
function $(id){return document.getElementById(id);}
function esc(s){return String(s==null?'':s).replace(/[&<>"]/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];});}
function login(){
  fetch('admin/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key:$('key').value})})
  .then(function(r){return r.json();})
  .then(function(d){if(d.ok){$('login').style.display='none';$('shell').style.display='flex';load();startAuto();}else $('lerr').textContent='Wrong key — try again';});
}
var __auto=null;
function startAuto(){if(__auto)return;__auto=setInterval(function(){load();},30000);}
function load(){post('state').then(function(d){if(d.error){if(__auto){clearInterval(__auto);__auto=null;}$('login').style.display='';$('shell').style.display='none';return;}S=d;render();});}
function go(view){
  var items=document.querySelectorAll('.navi');for(var i=0;i<items.length;i++)items[i].classList.toggle('on',items[i].getAttribute('data-view')===view);
  var secs=document.querySelectorAll('.view');for(var j=0;j<secs.length;j++)secs[j].hidden=(secs[j].id!=='v-'+view);
  var t={dash:'Dashboard',cust:'Customers / Devices',activate:'Activate a device',check:'Check MAC',res:'Resellers & credits',modes:'Player modes',settings:'Settings'};
  $('ptitle').textContent=t[view]||'Dashboard';
}
document.getElementById('nav').addEventListener('click',function(e){var n=e.target.closest('.navi');if(n)go(n.getAttribute('data-view'));});
document.querySelector('.filters').addEventListener('click',function(e){var c=e.target.closest('.chip');if(!c)return;FILTER=c.getAttribute('data-f');var ch=document.querySelectorAll('.chip');for(var i=0;i<ch.length;i++)ch[i].classList.toggle('on',ch[i]===c);render();});

function expOf(d){return (d.plan==='lifetime'||d.expires==null)?null:d.expires;}
function classify(d){
  if(d.status==='blocked')return 'blocked';
  var e=expOf(d);
  if(e==null)return 'active';
  if(e<=Date.now())return 'expired';
  if(e-Date.now()<=SOON)return 'soon';
  return 'active';
}
function fmt(ts){if(ts==null)return 'Lifetime';var x=new Date(ts);return x.getFullYear()+'-'+String(x.getMonth()+1).padStart(2,'0')+'-'+String(x.getDate()).padStart(2,'0');}
function daysLeft(ts){if(ts==null)return '∞';var d=Math.ceil((ts-Date.now())/86400000);return d+' d';}
function timeAgo(ts){if(!ts)return '—';var s=Math.floor((Date.now()-ts)/1000);if(s<60)return 'just now';var m=Math.floor(s/60);if(m<60)return m+'m ago';var h=Math.floor(m/60);if(h<24)return h+'h ago';var d=Math.floor(h/24);return d+'d ago';}
var APPMETA={windows:{label:'Windows',color:'#1fa6e8'},android:{label:'Android',color:'#12a150'},ios:{label:'iOS',color:'#7a5cff'},other:{label:'Other',color:'#94a3b8'}};
function renderUsage(){
  var u=S.stats||{online:0,today:0,week:0,total:0,byApp:{},recent:[]};
  $('u_online').textContent=u.online||0;$('u_today').textContent=u.today||0;$('u_week').textContent=u.week||0;$('u_total').textContent=u.total||0;
  var dot=$('liveDot');if(dot)dot.style.background=(u.online>0)?'var(--green)':'#c2ccd8';
  // by-app bars
  var ba=u.byApp||{};var keys=['windows','android','ios','other'];var max=1;keys.forEach(function(k){max=Math.max(max,ba[k]||0);});
  var h='';keys.forEach(function(k){var v=ba[k]||0;var meta=APPMETA[k];var pct=Math.round((v/max)*100);
    h+='<div style="display:flex;align-items:center;gap:12px;margin:11px 0"><div style="width:78px;font-size:13px;font-weight:700;color:'+meta.color+'">'+meta.label+'</div>'+
      '<div style="flex:1;background:#eef3f9;border-radius:8px;height:14px;overflow:hidden"><div style="height:100%;width:'+pct+'%;background:'+meta.color+';border-radius:8px;transition:width .4s"></div></div>'+
      '<div style="width:44px;text-align:right;font-weight:800;font-size:14px">'+v+'</div></div>';});
  $('byapp').innerHTML=h;
  // recently active table
  var rec=u.recent||[];var rh='<tr><th>MAC</th><th>App</th><th>Version</th><th>Check-ins</th><th>Last seen</th></tr>';
  if(!rec.length)rh+='<tr><td colspan="5" class="empty">No devices have checked in yet. Install a 3.6.4 build and open it — it will appear here within seconds.</td></tr>';
  rec.forEach(function(x){var meta=APPMETA[(x.app==='windows'||x.app==='android'||x.app==='ios')?x.app:'other'];
    rh+='<tr><td class="mono">'+esc(x.mac)+'</td><td><span style="color:'+meta.color+';font-weight:700">'+meta.label+'</span></td><td>'+esc(x.ver||'—')+'</td><td>'+(x.count||0)+'</td><td>'+timeAgo(x.last)+'</td></tr>';});
  $('recent').innerHTML=rh;
}

function render(){
  renderUsage();
  var c=S.config,devs=S.devices||{},res=S.resellers||{};
  var macs=Object.keys(devs);
  // stats
  var st={total:macs.length,active:0,soon:0,dead:0,life:0};
  macs.forEach(function(m){var cl=classify(devs[m]);if(cl==='active')st.active++;if(cl==='soon'){st.soon++;st.active++;}if(cl==='expired'||cl==='blocked')st.dead++;if(expOf(devs[m])==null&&devs[m].status!=='blocked')st.life++;});
  var credtot=0;Object.keys(res).forEach(function(id){credtot+=(res[id].credits||0);});
  $('s_total').textContent=st.total;$('s_active').textContent=st.active;$('s_soon').textContent=st.soon;$('s_dead').textContent=st.dead;
  $('s_res').textContent=Object.keys(res).length;$('s_cred').textContent=credtot;$('s_life').textContent=st.life;$('credtot').textContent=credtot;

  // ledger
  var lg=(S.ledger||[]).slice(0,12);var lh='<tr><th>When</th><th>Type</th><th>Reseller</th><th>MAC</th><th>Amount</th></tr>';
  if(!lg.length)lh+='<tr><td colspan="5" class="empty">No activity yet.</td></tr>';
  lg.forEach(function(x){var rn=x.reseller==='admin'?'Admin':((res[x.reseller]&&res[x.reseller].name)||x.reseller||'—');
    lh+='<tr><td>'+fmt(x.ts)+'</td><td>'+esc(x.type)+(x.note?' <span class="note">('+esc(x.note)+')</span>':'')+'</td><td>'+esc(rn)+'</td><td class="mono">'+esc(x.mac||'—')+'</td><td>'+(x.amount>0?'+'+x.amount:x.amount||0)+'</td></tr>';});
  $('ledger').innerHTML=lh;

  // player modes
  var apps=['windows','android','ios'];var mh='';
  apps.forEach(function(a){
    mh+='<div class="modecard"><h4>'+a.charAt(0).toUpperCase()+a.slice(1)+'</h4>'+
      '<div class="mrow"><span>Billing</span><button class="pill '+(c.paid[a]?'paid':'free')+'" data-tog="paid" data-app="'+a+'">'+(c.paid[a]?'PAID':'FREE')+'</button></div>'+
      '<div class="mrow"><span>Availability</span><button class="pill '+(c.kill[a]?'killed':'live')+'" data-tog="kill" data-app="'+a+'">'+(c.kill[a]?'KILLED':'LIVE')+'</button></div></div>';
  });
  $('modes').innerHTML=mh;
  $('trial').value=c.trial_days||0;$('contact').value=c.contact||'';

  // activate reseller dropdown
  var aby=$('aby');var cur=aby.value;aby.innerHTML='<option value="admin">As Admin (free)</option>';
  Object.keys(res).forEach(function(id){var r=res[id];aby.innerHTML+='<option value="'+id+'">'+esc(r.name)+' ('+(r.credits||0)+' cr)</option>';});
  aby.value=cur||'admin';

  // devices table
  var q=($('q').value||'').toUpperCase();
  var list=macs.filter(function(m){
    var d=devs[m];var cl=classify(d);
    if(FILTER==='soon'&&cl!=='soon')return false;
    if(FILTER==='active'&&!(cl==='active'||cl==='soon'))return false;
    if(FILTER==='expired'&&cl!=='expired')return false;
    if(FILTER==='blocked'&&cl!=='blocked')return false;
    if(q&&(m.indexOf(q)<0&&String(d.note||'').toUpperCase().indexOf(q)<0))return false;
    return true;
  }).sort(function(a,b){return (expOf(devs[a])||9e15)-(expOf(devs[b])||9e15);});
  var th='<tr><th>MAC</th><th>Note</th><th>App</th><th>Plan</th><th>Expiry</th><th>Left</th><th>By</th><th>Status</th><th></th></tr>';
  var t=th;
  if(!list.length)t+='<tr><td colspan="9" class="empty">No devices match this filter.</td></tr>';
  list.forEach(function(m){var d=devs[m];var cl=classify(d);var e=expOf(d);
    var tag=cl==='active'?'<span class="tag on">Active</span>':cl==='soon'?'<span class="tag soon">Expires soon</span>':cl==='expired'?'<span class="tag off">Expired</span>':'<span class="tag off">Blocked</span>';
    var plan=d.plan==='lifetime'?'<span class="tag life">Lifetime</span>':esc(d.plan);
    var by=d.activated_by==='admin'?'Admin':((res[d.activated_by]&&res[d.activated_by].name)||d.activated_by||'—');
    var actbtn=d.status==='blocked'?'<button class="g sm" data-act="unblock" data-mac="'+m+'">Unblock</button>':'<button class="g sm" data-act="block" data-mac="'+m+'">Block</button>';
    t+='<tr><td class="mono">'+m+'</td><td>'+esc(d.note||'—')+'</td><td>'+esc(d.app)+'</td><td>'+plan+'</td><td>'+fmt(e)+'</td><td>'+(cl==='expired'?'—':daysLeft(e))+'</td><td>'+esc(by)+'</td><td>'+tag+'</td><td style="white-space:nowrap"><button class="sm" data-act="renew" data-mac="'+m+'">Renew</button> '+actbtn+' <button class="d sm" data-act="delete" data-mac="'+m+'">Del</button></td></tr>';});
  $('devs').innerHTML=t;

  // resellers table
  var rh='<tr><th>Name</th><th>Login key</th><th>Credits</th><th>Status</th><th>Adjust credits</th></tr>';
  var rk=Object.keys(res);
  if(!rk.length)rh+='<tr><td colspan="5" class="empty">No resellers yet.</td></tr>';
  rk.forEach(function(id){var x=res[id];
    rh+='<tr><td><b>'+esc(x.name)+'</b></td><td class="mono" style="color:var(--muted)">'+esc(x.key)+'</td><td><b>'+(x.credits||0)+'</b></td>'+
      '<td><button class="'+(x.enabled?'g':'d')+' sm" data-rtog="'+id+'">'+(x.enabled?'Enabled':'Disabled')+'</button></td>'+
      '<td style="white-space:nowrap"><input id="cr_'+id+'" type="number" style="width:80px" placeholder="+/-"> <button class="g sm" data-rcr="'+id+'">Apply</button></td></tr>';});
  $('res').innerHTML=rh;
}

// delegated actions on devices + resellers
document.addEventListener('click',function(e){
  var b=e.target.closest('button');if(!b)return;
  if(b.dataset.tog){var c=S.config;c[b.dataset.tog][b.dataset.app]=!c[b.dataset.tog][b.dataset.app];post('setConfig',{config:c}).then(load);return;}
  if(b.dataset.act){var m=b.dataset.mac,a=b.dataset.act;
    if(a==='delete'){if(!confirm('Delete '+m+' ?'))return;post('delete',{mac:m}).then(load);return;}
    if(a==='renew'){var d=S.devices[m];post('activate',{mac:m,app:d.app,plan:(d.plan==='lifetime'?'lifetime':'1y'),by:'admin',note:d.note}).then(load);return;}
    post(a,{mac:m}).then(load);return;}
  if(b.dataset.rtog){post('toggleReseller',{id:b.dataset.rtog}).then(load);return;}
  if(b.dataset.rcr){var v=$('cr_'+b.dataset.rcr).value;if(v)post('credits',{id:b.dataset.rcr,amount:v}).then(load);return;}
});

function tog(){}
function saveCfg(){var c=S.config;c.trial_days=parseInt($('trial').value)||0;c.contact=$('contact').value;post('setConfig',{config:c}).then(function(){$('cfgok').textContent='Saved ✓';setTimeout(function(){$('cfgok').textContent='';},1800);load();});}
function act(){post('activate',{mac:$('amac').value,app:$('aapp').value,plan:$('aplan').value,by:$('aby').value,note:$('anote').value}).then(function(d){
  if(d.ok){$('aerr').innerHTML='<span class="ok">Activated ✓</span>';$('amac').value='';$('anote').value='';load();}
  else $('aerr').innerHTML='<span style="color:var(--red)">Error: '+esc(d.error||'failed')+'</span>';});}
function checkMac(){var m=($('cmac').value||'').toUpperCase().replace(/[^0-9A-F:]/g,'');var d=S.devices[m];
  if(!m){$('cres').innerHTML='';return;}
  if(!d){$('cres').innerHTML='<div class="lookup"><div class="k">Result</div><div class="big" style="color:var(--red)">Not activated</div><div class="note">This MAC has no record. In Paid mode it would be blocked.</div></div>';return;}
  var cl=classify(d),e=expOf(d);
  var color=cl==='active'?'var(--green)':cl==='soon'?'var(--amber)':'var(--red)';
  $('cres').innerHTML='<div class="lookup"><div class="k">'+esc(m)+'</div><div class="big" style="color:'+color+'">'+cl.toUpperCase()+'</div>'+
    '<div class="note">Plan: <b>'+esc(d.plan)+'</b> · Expiry: <b>'+fmt(e)+'</b> · App: <b>'+esc(d.app)+'</b> · Note: '+esc(d.note||'—')+'</div></div>';}
function addR(){var n=$('rname').value.trim();if(!n)return;post('reseller',{name:n}).then(function(){$('rname').value='';load();});}
function setKey(){var k=$('nkey').value;post('setAdminKey',{key:k}).then(function(d){$('kok').innerHTML=d.ok?'<span class="ok">Key updated ✓ — use it next sign-in.</span>':'<span style="color:var(--red)">'+esc(d.error||'error')+'</span>';if(d.ok)$('nkey').value='';});}
</script>
</body></html>`.replace(/SVGLOGO/g,'<svg viewBox="0 0 64 64" style="width:100%;height:100%"><defs><linearGradient id="zg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#63e2ff"/><stop offset="1" stop-color="#0e7fc0"/></linearGradient></defs><circle cx="32" cy="32" r="28" fill="none" stroke="url(#zg)" stroke-width="5"/><polygon points="26,20 44,20 30,44 46,44 46,50 20,50 34,26 26,26" fill="url(#zg)" stroke="none"/></svg>');

server.listen(PORT, '127.0.0.1', () => console.log('Zayron activation server on 127.0.0.1:' + PORT));

/*
 * DEPLOY (isolated — does not touch your other apps):
 *  1) Put this file at /root/zayron-activation/activation-server.js
 *  2) Run it 24/7 (systemd):
 *       cat > /etc/systemd/system/zayron-activation.service <<'EOF'
 *       [Unit]
 *       Description=Zayron activation server
 *       After=network.target
 *       [Service]
 *       ExecStart=/usr/bin/env node /root/zayron-activation/activation-server.js
 *       Restart=always
 *       Environment=ZAYRON_ACT_PORT=3800
 *       WorkingDirectory=/root/zayron-activation
 *       User=root
 *       [Install]
 *       WantedBy=multi-user.target
 *       EOF
 *       systemctl daemon-reload && systemctl enable --now zayron-activation
 *  3) In your Caddyfile, inside the zayron.tv { } block, add:
 *       handle /act* { reverse_proxy 127.0.0.1:3800 }
 *     then reload caddy.
 *  4) Admin panel: https://zayron.tv/act/admin   (the admin key is printed once in the log:
 *       journalctl -u zayron-activation | grep 'ADMIN KEY' )
 *  App check endpoint: https://zayron.tv/act/api/check
 */
