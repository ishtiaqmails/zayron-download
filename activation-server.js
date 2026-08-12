/*
 * Zayron Activation Server — Phase 2 (dependency-free, single JSON file).
 *
 *  - App calls POST /act/api/check {mac, app, ver} on launch → allow / block (+ expiry). Also
 *    records live usage (who checked in, which app, version, last-seen).
 *  - Web panel at /act/admin with USERNAME + PASSWORD login. Two roles:
 *       ADMIN     = you. Full control. Unlimited credits (the "mint").
 *       RESELLER  = a tree of resellers / sub-resellers (any depth). Each sees only its own
 *                   customers + its own sub-tree + its own credit balance.
 *  - Credits: 1 credit = 1 year, 2 credits = lifetime. Credits flow DOWN the tree
 *    (admin → reseller → sub-reseller → …). Full ledger.
 *  - Sessions are saved to disk + a 30-day cookie, so a refresh or restart never logs you out.
 *
 * DEPLOY: see the comment block at the very bottom (unchanged — still /act on Caddy).
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.ZAYRON_ACT_PORT || 3800;
const DATA = process.env.ZAYRON_ACT_DATA || path.join(__dirname, 'data.json');

// ---------- storage ----------
function load() { try { return JSON.parse(fs.readFileSync(DATA, 'utf8')); } catch (e) { return null; } }
function save(d) { const tmp = DATA + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(d, null, 2)); fs.renameSync(tmp, DATA); }

const now = () => Date.now();
const YEAR = 365 * 24 * 3600 * 1000;

// ---------- password hashing (pbkdf2, dependency-free) ----------
function mkPass(pw) { const salt = crypto.randomBytes(16).toString('hex'); const hash = crypto.pbkdf2Sync(String(pw), salt, 60000, 32, 'sha256').toString('hex'); return { salt, hash }; }
function chkPass(pw, rec) { if (!rec || !rec.salt || !rec.hash) return false; const h = crypto.pbkdf2Sync(String(pw), rec.salt, 60000, 32, 'sha256').toString('hex'); try { return crypto.timingSafeEqual(Buffer.from(h), Buffer.from(rec.hash)); } catch (e) { return false; } }

// ---------- db init + migration ----------
let db = load();
if (!db) {
  const firstPass = process.env.ZAYRON_ADMIN_KEY || crypto.randomBytes(6).toString('hex');
  const ap = mkPass(firstPass);
  db = {
    version: 2,
    admin: { username: 'admin', salt: ap.salt, hash: ap.hash },
    config: {
      paid: { windows: false, android: false, ios: false },
      kill: { windows: false, android: false, ios: false },
      trial_days: 0,
      contact: 'WhatsApp +92 314 1892712  ·  zayron.tv',
      downloads: { windows: 'https://zayron.tv/windows', android: 'https://zayron.tv/android' }
    },
    accounts: {},   // id -> { id, username, salt, hash, name, email, credits, parent, enabled, created }
    devices: {},    // MAC -> { app, plan, expires, activated_by, created, status, note }
    seen: {},       // MAC -> { app, ver, first, last, count }
    sessions: {},   // token -> { uid, role, exp }
    ledger: []      // { ts, type, from, to, amount, mac, note }
  };
  save(db);
  console.log('First run. LOGIN  username: admin   password: ' + firstPass + '   (change it in Settings)');
}
// migrate older (Phase-1) data files
if (!db.version) db.version = 2;
if (!db.seen) db.seen = {};
if (!db.sessions) db.sessions = {};
if (!db.accounts) db.accounts = {};
if (!db.admin) { const ap = mkPass(db.admin_key || 'admin'); db.admin = { username: 'admin', salt: ap.salt, hash: ap.hash }; }
if (!db.config.downloads) db.config.downloads = { windows: 'https://zayron.tv/windows', android: 'https://zayron.tv/android' };
if (db.resellers && Object.keys(db.resellers).length && !Object.keys(db.accounts).length) {
  Object.keys(db.resellers).forEach(function (id) {
    const r = db.resellers[id];
    db.accounts[id] = { id: id, username: (r.name || id).toLowerCase().replace(/[^a-z0-9]/g, '') || id, salt: '', hash: '', name: r.name || id, email: '', credits: r.credits || 0, parent: r.parent || null, enabled: r.enabled !== false, created: r.created || now() };
  });
  delete db.resellers; save(db);
}

// ---------- helpers ----------
function normMac(m) { return String(m || '').toUpperCase().replace(/[^0-9A-F:]/g, '').trim(); }
function json(res, code, obj) { res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }); res.end(JSON.stringify(obj)); }
function readBody(req) { return new Promise(r => { let b = ''; req.on('data', c => { b += c; if (b.length > 100000) req.destroy(); }); req.on('end', () => r(b)); }); }
function cookie(req, name) { const c = (req.headers.cookie || '').split(';').map(s => s.trim()); for (const p of c) if (p.indexOf(name + '=') === 0) return p.slice(name.length + 1); return ''; }

// ---------- sessions (persisted) ----------
const SESSION_TTL = 30 * 24 * 3600 * 1000;
function newSession(uid, role) { const t = crypto.randomBytes(24).toString('hex'); db.sessions[t] = { uid: uid, role: role, exp: now() + SESSION_TTL }; save(db); return t; }
function getSession(t) { const s = db.sessions[t]; if (!s) return null; if (s.exp < now()) { delete db.sessions[t]; return null; } return s; }
function dropSession(t) { if (t && db.sessions[t]) { delete db.sessions[t]; save(db); } }
function currentUser(req) { return getSession(cookie(req, 'zadm')); }

// ---------- tree helpers ----------
function isDesc(ancestor, id) { if (ancestor === 'admin') return true; let cur = id, g = 0; while (cur && g++ < 200) { if (cur === ancestor) return true; const a = db.accounts[cur]; cur = a ? a.parent : null; } return false; }
function directChildren(uid) { const key = (uid === 'admin') ? null : uid; return Object.keys(db.accounts).filter(function (id) { return (db.accounts[id].parent || null) === key; }); }
function subtreeIds(uid) { return Object.keys(db.accounts).filter(function (id) { return id !== uid && isDesc(uid, id); }); }
function ownsDevice(uid, mac) { if (uid === 'admin') return true; const d = db.devices[mac]; if (!d) return true; /* new device → any reseller may sell it */ return isDesc(uid, d.activated_by); }
function displayName(uid) { if (uid === 'admin') return 'Admin'; const a = db.accounts[uid]; return a ? (a.name || a.username) : (uid || '—'); }

// ---------- credit helpers (admin = unlimited mint) ----------
function balanceOf(uid) { return uid === 'admin' ? Infinity : ((db.accounts[uid] && db.accounts[uid].credits) || 0); }
function usernameTaken(u) { u = String(u || '').toLowerCase(); if (u === (db.admin.username || 'admin').toLowerCase()) return true; return Object.keys(db.accounts).some(function (id) { return (db.accounts[id].username || '').toLowerCase() === u; }); }

// give `amount` from `fromUid` to a DIRECT child `toId`. amount<0 = reclaim. returns {ok,error}
function transfer(fromUid, toId, amount) {
  amount = parseInt(amount) || 0; if (!amount) return { ok: false, error: 'enter an amount' };
  const to = db.accounts[toId]; if (!to) return { ok: false, error: 'unknown account' };
  const okChild = (fromUid === 'admin') ? (to.parent == null) : (to.parent === fromUid);
  if (!okChild) return { ok: false, error: 'not your direct account' };
  if (amount > 0) {
    if (fromUid !== 'admin' && balanceOf(fromUid) < amount) return { ok: false, error: 'not enough credits' };
    if (fromUid !== 'admin') db.accounts[fromUid].credits -= amount;
    to.credits = (to.credits || 0) + amount;
  } else {
    const take = -amount;
    if ((to.credits || 0) < take) return { ok: false, error: 'account does not have that many credits' };
    to.credits -= take;
    if (fromUid !== 'admin') db.accounts[fromUid].credits = (db.accounts[fromUid].credits || 0) + take;
  }
  db.ledger.push({ ts: now(), type: 'transfer', from: fromUid, to: toId, amount: amount, note: '' });
  save(db); return { ok: true };
}

// ---------- device / activation ----------
function planExpiry(plan, fromTs) { if (plan === 'lifetime') return null; const base = fromTs && fromTs > now() ? fromTs : now(); return base + YEAR; }
function deviceActive(dev) { if (!dev || dev.status === 'blocked') return false; if (dev.plan === 'lifetime' || dev.expires == null) return true; return dev.expires > now(); }
function creditsFor(plan) { return plan === 'lifetime' ? 2 : 1; }

function activate(uid, mac, app, plan, note, isRenew) {
  mac = normMac(mac); if (!mac) return { ok: false, error: 'bad mac' };
  const cur = db.devices[mac];
  if (isRenew && uid !== 'admin' && cur && !isDesc(uid, cur.activated_by)) return { ok: false, error: 'not your device' };
  const cost = creditsFor(plan);
  if (uid !== 'admin') { if (balanceOf(uid) < cost) return { ok: false, error: 'not enough credits' }; db.accounts[uid].credits -= cost; }
  const fromTs = cur && cur.plan !== 'lifetime' && cur.expires ? cur.expires : now();
  db.devices[mac] = {
    app: app || (cur && cur.app) || 'any',
    plan: plan,
    expires: planExpiry(plan, fromTs),
    activated_by: uid,
    created: (cur && cur.created) || now(),
    status: 'active',
    note: (note != null && note !== '') ? note : (cur && cur.note) || ''
  };
  db.ledger.push({ ts: now(), type: isRenew ? 'renew' : 'activate', from: uid, mac: mac, amount: (uid === 'admin' ? 0 : -cost), note: plan });
  save(db); return { ok: true };
}

// ---------- usage tracking (debounced saves) ----------
let __dirty = false;
function markDirty() { __dirty = true; }
setInterval(function () { if (__dirty) { __dirty = false; try { save(db); } catch (e) {} } }, 15000).unref();
function recordSeen(mac, app, ver) {
  if (!mac || mac.replace(/[^0-9A-F]/g, '').length < 6) return;
  const s = db.seen[mac] || { first: now(), count: 0 };
  s.app = app || s.app || 'unknown'; if (ver) s.ver = String(ver).slice(0, 20); s.last = now(); s.count = (s.count || 0) + 1;
  db.seen[mac] = s; markDirty();
}
function computeStats() {
  const t = now(), MIN = 60 * 1000, H = 3600 * 1000, D = 24 * H;
  const S = { total: 0, online: 0, today: 0, week: 0, month: 0, byApp: { windows: 0, android: 0, ios: 0, other: 0 }, recent: [] };
  const macs = Object.keys(db.seen || {}); S.total = macs.length; const arr = [];
  for (const m of macs) { const s = db.seen[m], age = t - (s.last || 0);
    if (age <= 7 * MIN) S.online++; if (age <= D) S.today++; if (age <= 7 * D) S.week++; if (age <= 30 * D) S.month++;
    const a = (s.app === 'windows' || s.app === 'android' || s.app === 'ios') ? s.app : 'other'; S.byApp[a]++;
    arr.push({ mac: m, app: s.app, ver: s.ver || '', last: s.last, count: s.count || 0 }); }
  arr.sort((a, b) => (b.last || 0) - (a.last || 0)); S.recent = arr.slice(0, 20); return S;
}

// ---------- build role-scoped state for the panel ----------
function accountView(id) { const a = db.accounts[id]; return { id: id, username: a.username, name: a.name, email: a.email || '', credits: a.credits || 0, parent: a.parent || null, enabled: a.enabled !== false, created: a.created, hasPass: !!a.hash, children: directChildren(id).length }; }
function stateFor(cu) {
  if (cu.role === 'admin') {
    const accs = {}; Object.keys(db.accounts).forEach(function (id) { accs[id] = accountView(id); });
    return { role: 'admin', me: { username: db.admin.username, credits: null },
      config: db.config, accounts: accs, devices: db.devices, stats: computeStats(),
      ledger: db.ledger.slice(-120).reverse().map(fmtLedger) };
  }
  const uid = cu.uid, ids = subtreeIds(uid); const accs = {}; ids.forEach(function (id) { accs[id] = accountView(id); });
  const devs = {}; Object.keys(db.devices).forEach(function (m) { if (ownsDevice(uid, m) && db.devices[m].activated_by !== 'admin' && isDesc(uid, db.devices[m].activated_by)) devs[m] = db.devices[m]; });
  const me = db.accounts[uid] || {};
  const led = db.ledger.filter(function (e) { return e.from === uid || e.to === uid || (e.mac && devs[e.mac]); }).slice(-120).reverse().map(fmtLedger);
  return { role: 'reseller', me: { id: uid, username: me.username, name: me.name, email: me.email || '', credits: me.credits || 0 },
    config: { contact: db.config.contact, downloads: db.config.downloads }, accounts: accs, devices: devs, ledger: led };
}
function fmtLedger(e) { return { ts: e.ts, type: e.type, from: displayName(e.from), to: e.to ? displayName(e.to) : '', amount: e.amount, mac: e.mac || '', note: e.note || '' }; }

// ---------- server ----------
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const p = u.pathname.replace(/\/+$/, '') || '/';

  // APP: activation check + usage
  if (p.endsWith('/api/check') && req.method === 'POST') {
    let body = {}; try { body = JSON.parse(await readBody(req) || '{}'); } catch (e) {}
    const app = (body.app || 'windows').toLowerCase(); const mac = normMac(body.mac); const c = db.config;
    recordSeen(mac, app, body.ver);
    if (c.kill[app]) return json(res, 200, { active: false, kill: true, message: 'This app is temporarily unavailable. ' + c.contact });
    if (!c.paid[app]) return json(res, 200, { active: true, free: true });
    let dev = db.devices[mac];
    if (deviceActive(dev)) return json(res, 200, { active: true, plan: dev.plan, expires: dev.expires });
    if (!dev && c.trial_days > 0) { db.devices[mac] = { app, plan: 'trial', expires: now() + c.trial_days * 24 * 3600 * 1000, activated_by: 'trial', created: now(), status: 'active', note: 'auto-trial' }; save(db); return json(res, 200, { active: true, plan: 'trial', expires: db.devices[mac].expires }); }
    if (dev && dev.plan === 'trial' && deviceActive(dev)) return json(res, 200, { active: true, plan: 'trial', expires: dev.expires });
    return json(res, 200, { active: false, mac, message: 'This device is not activated. Send this MAC to your provider: ' + mac + '  —  ' + c.contact });
  }

  // AUTH: login
  if (p.endsWith('/admin/login') && req.method === 'POST') {
    let b = {}; try { b = JSON.parse(await readBody(req) || '{}'); } catch (e) {}
    const un = String(b.username || '').trim(), pw = String(b.password || '');
    if (un.toLowerCase() === (db.admin.username || 'admin').toLowerCase() && chkPass(pw, db.admin)) {
      const t = newSession('admin', 'admin'); res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': 'zadm=' + t + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000' }); return res.end('{"ok":true,"role":"admin"}');
    }
    const id = Object.keys(db.accounts).find(function (i) { return (db.accounts[i].username || '').toLowerCase() === un.toLowerCase(); });
    if (id) { const a = db.accounts[id]; if (a.enabled === false) return json(res, 200, { ok: false, error: 'account disabled' }); if (chkPass(pw, a)) { const t = newSession(id, 'reseller'); res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': 'zadm=' + t + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000' }); return res.end('{"ok":true,"role":"reseller"}'); } }
    return json(res, 200, { ok: false, error: 'wrong username or password' });
  }
  if (p.endsWith('/admin/logout') && req.method === 'POST') { dropSession(cookie(req, 'zadm')); res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': 'zadm=; Path=/; HttpOnly; Max-Age=0' }); return res.end('{"ok":true}'); }

  // ADMIN/RESELLER ACTIONS
  if (p.indexOf('/admin/act') >= 0 && req.method === 'POST') {
    const cu = currentUser(req); if (!cu) return json(res, 401, { error: 'login' });
    const uid = cu.uid, role = cu.role;
    let b = {}; try { b = JSON.parse(await readBody(req) || '{}'); } catch (e) {}
    const a = b.action;
    const adminOnly = function () { return role === 'admin'; };
    try {
      if (a === 'state') return json(res, 200, stateFor(cu));

      // config / player modes (admin only)
      if (a === 'setConfig') { if (!adminOnly()) return json(res, 403, { error: 'admins only' }); db.config = Object.assign(db.config, b.config || {}); save(db); return json(res, 200, { ok: true }); }
      if (a === 'setDownloads') { if (!adminOnly()) return json(res, 403, { error: 'admins only' }); db.config.downloads = { windows: (b.windows || '').trim(), android: (b.android || '').trim() }; save(db); return json(res, 200, { ok: true }); }

      // change my own login (admin: username+password; reseller: password)
      if (a === 'changeMyPass') { if (!b.newpass || b.newpass.length < 4) return json(res, 200, { ok: false, error: 'password too short (min 4)' });
        if (role === 'admin') { if (!chkPass(b.oldpass || '', db.admin)) return json(res, 200, { ok: false, error: 'current password is wrong' }); const np = mkPass(b.newpass); db.admin.salt = np.salt; db.admin.hash = np.hash; if (b.username) db.admin.username = String(b.username).trim(); save(db); return json(res, 200, { ok: true }); }
        const me = db.accounts[uid]; if (!chkPass(b.oldpass || '', me)) return json(res, 200, { ok: false, error: 'current password is wrong' }); const np = mkPass(b.newpass); me.salt = np.salt; me.hash = np.hash; save(db); return json(res, 200, { ok: true }); }

      // create a reseller / sub-reseller under me
      if (a === 'createAccount') {
        const un = String(b.username || '').trim(); if (un.length < 3) return json(res, 200, { ok: false, error: 'username too short (min 3)' });
        if (!/^[a-zA-Z0-9_.-]+$/.test(un)) return json(res, 200, { ok: false, error: 'username: letters, numbers, . _ - only' });
        if (usernameTaken(un)) return json(res, 200, { ok: false, error: 'username already taken' });
        if (!b.password || b.password.length < 4) return json(res, 200, { ok: false, error: 'password too short (min 4)' });
        const startCr = parseInt(b.credits) || 0;
        if (startCr > 0 && role !== 'admin' && balanceOf(uid) < startCr) return json(res, 200, { ok: false, error: 'not enough credits for that starting balance' });
        const id = crypto.randomBytes(4).toString('hex'); const pw = mkPass(b.password);
        db.accounts[id] = { id: id, username: un, salt: pw.salt, hash: pw.hash, name: (b.name || un).trim(), email: (b.email || '').trim(), credits: 0, parent: (role === 'admin' ? null : uid), enabled: true, created: now() };
        save(db);
        if (startCr > 0) transfer(uid, id, startCr);
        return json(res, 200, { ok: true, id: id });
      }
      // transfer credits to a direct child
      if (a === 'transfer') { const to = db.accounts[b.id]; if (!to) return json(res, 200, { ok: false, error: 'unknown account' }); const okChild = (role === 'admin') ? (to.parent == null) : (to.parent === uid); if (!okChild) return json(res, 403, { error: 'not your direct account' }); return json(res, 200, transfer(uid, b.id, b.amount)); }
      // reset a descendant's password
      if (a === 'resetPass') { const t = db.accounts[b.id]; if (!t) return json(res, 200, { ok: false, error: 'unknown account' }); if (role !== 'admin' && !isDesc(uid, b.id)) return json(res, 403, { error: 'not in your tree' }); if (!b.password || b.password.length < 4) return json(res, 200, { ok: false, error: 'password too short (min 4)' }); const np = mkPass(b.password); t.salt = np.salt; t.hash = np.hash; save(db); return json(res, 200, { ok: true }); }
      // enable / disable a descendant
      if (a === 'toggleAccount') { const t = db.accounts[b.id]; if (!t) return json(res, 200, { ok: false, error: 'unknown' }); if (role !== 'admin' && !isDesc(uid, b.id)) return json(res, 403, { error: 'not in your tree' }); t.enabled = !(t.enabled !== false); save(db); return json(res, 200, { ok: true, enabled: t.enabled }); }
      // re-assign a sub-reseller to a new parent (admin only)
      if (a === 'reparent') { if (!adminOnly()) return json(res, 403, { error: 'admins only' }); const t = db.accounts[b.id]; if (!t) return json(res, 200, { ok: false, error: 'unknown' }); const np = (b.parent === 'admin' || !b.parent) ? null : b.parent; if (np && !db.accounts[np]) return json(res, 200, { ok: false, error: 'unknown new parent' }); if (np === b.id) return json(res, 200, { ok: false, error: 'cannot parent to itself' }); if (np && isDesc(b.id, np)) return json(res, 200, { ok: false, error: 'cannot move under its own sub-account' }); t.parent = np; save(db); return json(res, 200, { ok: true }); }
      // delete an account (admin only; must have no children)
      if (a === 'deleteAccount') { if (!adminOnly()) return json(res, 403, { error: 'admins only' }); if (directChildren(b.id).length) return json(res, 200, { ok: false, error: 'move or remove its sub-accounts first' }); delete db.accounts[b.id]; save(db); return json(res, 200, { ok: true }); }

      // activate / renew a device
      if (a === 'activate') return json(res, 200, activate(uid, b.mac, b.app, b.plan, b.note, false));
      if (a === 'renew') return json(res, 200, activate(uid, b.mac, b.app, b.plan, b.note, true));
      // block / unblock / delete a device (must own it)
      if (a === 'block' || a === 'unblock' || a === 'delete') { const mac = normMac(b.mac); if (!ownsDevice(uid, mac)) return json(res, 403, { error: 'not your device' });
        if (a === 'delete') { delete db.devices[mac]; save(db); return json(res, 200, { ok: true }); }
        const d = db.devices[mac]; if (d) { d.status = (a === 'block') ? 'blocked' : 'active'; save(db); } return json(res, 200, { ok: !!d }); }
      // MAC lookup (installed? + activation)
      if (a === 'checkMac') { const mac = normMac(b.mac); const s = db.seen[mac] || null; const d = db.devices[mac] || null; let dv = null;
        if (d) { const mine = role === 'admin' || isDesc(uid, d.activated_by); dv = { plan: d.plan, expires: d.expires, status: d.status, active: deviceActive(d), note: mine ? d.note : '', by: (role === 'admin') ? displayName(d.activated_by) : (mine ? displayName(d.activated_by) : 'another reseller'), app: d.app }; }
        return json(res, 200, { ok: true, mac: mac, installed: !!s, seen: s ? { app: s.app, ver: s.ver || '', last: s.last, first: s.first, count: s.count || 0 } : null, device: dv }); }

      return json(res, 200, { error: 'unknown action' });
    } catch (e) { return json(res, 200, { error: String(e) }); }
  }

  if (p.endsWith('/admin') || p.endsWith('/admin/')) { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(PANEL); }
  if (p.endsWith('/health')) { res.writeHead(200); return res.end('ok'); }
  res.writeHead(404); res.end('not found');
});

// ---------- admin/reseller panel (single page, light Hot-Player style, role-aware) ----------
const PANEL = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Zayron — Activation Panel</title><style>
:root{--navy:#0e2a4f;--navy2:#123a6b;--cyan:#1fa6e8;--cb:#25b6ff;--cyd:#0e7fc0;
--bg:#eef3f9;--card:#fff;--line:#e4ebf3;--text:#14263f;--muted:#6f8098;
--green:#12a150;--greenbg:#e7f7ee;--red:#e5546e;--redbg:#fdecef;--amber:#c9860a;--amberbg:#fdf3e0;--violet:#7a5cff;}
*{box-sizing:border-box;font-family:'Segoe UI',Roboto,-apple-system,Arial,sans-serif}
html,body{margin:0;height:100%}body{background:var(--bg);color:var(--text)}
svg{fill:none;stroke:currentColor;stroke-width:1.9;stroke-linecap:round;stroke-linejoin:round}
.loginwrap{min-height:100vh;display:flex;align-items:center;justify-content:center;background:radial-gradient(80% 60% at 50% 0,rgba(31,166,232,.18),transparent 60%),var(--bg)}
.loginbox{background:var(--card);border:1px solid var(--line);border-radius:18px;padding:34px 30px;width:350px;box-shadow:0 24px 60px rgba(20,50,90,.14);text-align:center}
.loginbox .lgo{width:64px;height:64px;margin:0 auto 14px}
.loginbox h2{margin:2px 0;font-size:20px}.loginbox h2 b{color:var(--cyd)}
.loginbox p{margin:0 0 16px;color:var(--muted);font-size:13px}
.loginbox input{width:100%;padding:12px 13px;border-radius:11px;border:1px solid var(--line);background:#f7fafd;font-size:15px;margin-bottom:10px}
.loginbox button{width:100%;padding:12px;border:0;border-radius:11px;background:var(--cyan);color:#fff;font-weight:700;font-size:15px;cursor:pointer}
.loginbox button:hover{background:var(--cyd)}.err{color:var(--red);font-size:12.5px;margin-top:8px;min-height:16px}
.shell{display:flex;min-height:100vh}
.side{width:230px;flex:none;background:linear-gradient(180deg,var(--navy),#0a2244);color:#dbe8fa;display:flex;flex-direction:column;padding:20px 14px}
.side .brand{display:flex;align-items:center;gap:11px;padding:6px 8px 16px}.side .brand .lgo{width:40px;height:40px;flex:none}
.side .brand .bt b{display:block;font-size:17px;font-weight:800;letter-spacing:2px;line-height:1;color:#fff}
.side .brand .bt span{font-size:9px;letter-spacing:3px;color:var(--cb);font-weight:700}
.rolechip{margin:2px 8px 12px;font-size:10px;font-weight:800;letter-spacing:1px;color:#0a2244;background:var(--cb);display:inline-block;padding:3px 9px;border-radius:20px;text-transform:uppercase}
.side nav{display:flex;flex-direction:column;gap:3px}
.navi{display:flex;align-items:center;gap:12px;padding:11px 13px;border-radius:11px;cursor:pointer;color:#b8cbe6;font-size:14px;font-weight:600;transition:.14s}
.navi svg{width:19px;height:19px}.navi:hover{background:rgba(255,255,255,.07);color:#fff}
.navi.on{background:linear-gradient(90deg,var(--cyan),var(--cyd));color:#fff;box-shadow:0 8px 20px rgba(31,166,232,.35)}
.navi[hidden]{display:none}
.side .foot{margin-top:auto;padding-top:12px;border-top:1px solid rgba(255,255,255,.08)}
.side .foot button{width:100%;padding:11px;border:0;border-radius:11px;background:rgba(255,255,255,.08);color:#ffd0d8;font-weight:700;cursor:pointer;font-size:13.5px}
.side .foot button:hover{background:rgba(229,84,110,.25)}
.main{flex:1;min-width:0;display:flex;flex-direction:column}
.topbar{display:flex;align-items:center;justify-content:space-between;gap:14px;padding:16px 26px;background:var(--card);border-bottom:1px solid var(--line);position:sticky;top:0;z-index:5}
.topbar #ptitle{font-size:19px;font-weight:800}.topbar .right{display:flex;align-items:center;gap:12px}
.credits{display:flex;align-items:center;gap:9px;background:linear-gradient(90deg,var(--navy),var(--navy2));color:#fff;padding:9px 15px;border-radius:12px;font-size:11px;font-weight:700;letter-spacing:.6px}
.credits b{font-size:18px;color:var(--cb);letter-spacing:0}
.content{padding:22px 26px;overflow:auto}.view[hidden]{display:none}
.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:16px;margin-bottom:20px}
.stat{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:18px;box-shadow:0 6px 20px rgba(20,50,90,.05)}
.stat .lbl{display:flex;align-items:center;gap:9px;color:var(--muted);font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.5px}
.stat .lbl .ci{width:34px;height:34px;border-radius:10px;display:flex;align-items:center;justify-content:center}
.stat .num{font-size:30px;font-weight:800;margin-top:10px}
.ci.cy{background:rgba(31,166,232,.14);color:var(--cyd)}.ci.gr{background:var(--greenbg);color:var(--green)}.ci.am{background:var(--amberbg);color:var(--amber)}.ci.rd{background:var(--redbg);color:var(--red)}.ci.vi{background:rgba(122,92,255,.12);color:var(--violet)}
.card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:20px;margin-bottom:20px;box-shadow:0 6px 20px rgba(20,50,90,.05)}
.card h3{margin:0 0 4px;font-size:16px}.card .sub{color:var(--muted);font-size:12.5px;margin-bottom:14px}
.row{display:flex;gap:10px;flex-wrap:wrap;align-items:center}label{font-size:12.5px;color:var(--muted);font-weight:600}
input,select{padding:10px 12px;border-radius:10px;border:1px solid var(--line);background:#f7fafd;color:var(--text);font-size:14px}
input:focus,select:focus{outline:0;border-color:var(--cyan);background:#fff}
button{padding:10px 16px;border-radius:10px;border:0;background:var(--cyan);color:#fff;font-weight:700;cursor:pointer;font-size:14px}button:hover{background:var(--cyd)}
button.g{background:#eef3f9;border:1px solid var(--line);color:#455872}button.g:hover{background:#e2e9f2}
button.d{background:var(--red)}button.d:hover{background:#cf3f59}button.sm{padding:6px 11px;font-size:12.5px;border-radius:8px}
.filters{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:6px}
.chip{padding:8px 14px;border-radius:20px;border:1px solid var(--line);background:#f7fafd;color:var(--muted);font-size:12.5px;font-weight:700;cursor:pointer}
.chip.on{background:var(--navy);color:#fff;border-color:var(--navy)}.grow{flex:1;min-width:120px}
table{width:100%;border-collapse:collapse;margin-top:12px}th,td{text-align:left;padding:11px 10px;border-bottom:1px solid var(--line);font-size:13px;vertical-align:middle}
th{color:var(--muted);font-size:10.5px;text-transform:uppercase;letter-spacing:.6px;font-weight:700}tbody tr:hover{background:#f7fafd}
.mono{font-family:'SF Mono',Consolas,monospace;font-weight:600;letter-spacing:.3px}
.tag{font-size:11px;font-weight:700;padding:3px 10px;border-radius:20px;display:inline-block}
.tag.on{background:var(--greenbg);color:var(--green)}.tag.off{background:var(--redbg);color:var(--red)}.tag.soon{background:var(--amberbg);color:var(--amber)}.tag.life{background:rgba(31,166,232,.14);color:var(--cyd)}
.empty{text-align:center;color:var(--muted);padding:26px;font-size:13.5px}.ok{color:var(--green);font-weight:700}.note{font-size:12.5px;color:var(--muted);margin-top:6px}
.lookup{background:#f9fbfe;border:1px dashed var(--line);border-radius:14px;padding:18px;margin-top:14px}
.lookup .k{color:var(--muted);font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.5px}.big{font-size:22px;font-weight:800}
.dl{display:grid;grid-template-columns:repeat(2,1fr);gap:16px}
.dlc{border:1px solid var(--line);border-radius:16px;padding:20px;text-align:center;background:#f9fbfe}
.dlc h4{margin:6px 0 4px;font-size:16px}.dlc .qr{width:150px;height:150px;margin:10px auto;border-radius:12px;background:#fff;border:1px solid var(--line)}
.dlc a.b{display:inline-block;margin-top:8px;padding:10px 18px;border-radius:10px;background:var(--cyan);color:#fff;font-weight:700;text-decoration:none;font-size:13.5px}
.treerow td:first-child{padding-left:10px}
.modalbg{position:fixed;inset:0;background:rgba(14,42,79,.45);display:none;align-items:center;justify-content:center;z-index:50;padding:20px}
.modalbg.on{display:flex}
.modal{background:#fff;border-radius:18px;padding:24px;width:100%;max-width:420px;box-shadow:0 30px 80px rgba(0,0,0,.3)}
.modal h3{margin:0 0 4px;font-size:17px}.modal .sub{color:var(--muted);font-size:12.5px;margin-bottom:14px}
.modal .f{margin-bottom:11px}.modal .f label{display:block;margin-bottom:5px}.modal .f input,.modal .f select{width:100%}
.modal .foot{display:flex;gap:10px;justify-content:flex-end;margin-top:8px}
.merr{color:var(--red);font-size:12.5px;min-height:16px;margin-top:2px}
@media(max-width:860px){.side{width:60px;padding:16px 6px}.side .brand .bt,.navi span,.rolechip{display:none}.navi{justify-content:center}.stats{grid-template-columns:repeat(2,1fr)}.dl{grid-template-columns:1fr}}
</style></head><body>

<div id="login" class="loginwrap"><div class="loginbox">
  <div class="lgo">SVGLOGO</div><h2><b>Zayron</b> Panel</h2><p>Sign in to your account</p>
  <input id="lu" placeholder="Username" autocapitalize="none" autocomplete="username">
  <input id="lp" type="password" placeholder="Password" autocomplete="current-password" onkeydown="if(event.key==='Enter')login()">
  <button onclick="login()">Sign in</button><div id="lerr" class="err"></div>
</div></div>

<div id="shell" class="shell" style="display:none">
  <aside class="side">
    <div class="brand"><div class="lgo">SVGLOGO</div><div class="bt"><b>ZAYRON</b><span>PANEL</span></div></div>
    <span class="rolechip" id="rolechip">—</span>
    <nav id="nav">
      <div class="navi on" data-view="dash"><svg viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/></svg><span>Dashboard</span></div>
      <div class="navi" data-view="cust"><svg viewBox="0 0 24 24"><circle cx="9" cy="8" r="3.2"/><path d="M3.5 20c0-3.3 2.7-5 5.5-5s5.5 1.7 5.5 5"/><path d="M17 9.5a2.7 2.7 0 1 0-1-5.2M20.5 20c0-2.6-1.6-4.2-3.5-4.7"/></svg><span>Customers</span></div>
      <div class="navi" data-view="activate"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 8v8M8 12h8"/></svg><span>Activate</span></div>
      <div class="navi" data-view="check"><svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.2-3.2"/></svg><span>Check MAC</span></div>
      <div class="navi" data-view="res"><svg viewBox="0 0 24 24"><rect x="3" y="6" width="18" height="13" rx="2"/><path d="M3 10h18M8 3v3M16 3v3"/></svg><span id="resNav">Resellers</span></div>
      <div class="navi" data-view="modes"><svg viewBox="0 0 24 24"><rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="8" cy="12" r="2.4"/><path d="M14 10h4M14 14h4"/></svg><span>Player Modes</span></div>
      <div class="navi" data-view="downloads"><svg viewBox="0 0 24 24"><path d="M12 3v12M7 10l5 5 5-5"/><path d="M5 21h14"/></svg><span>Downloads</span></div>
      <div class="navi" data-view="settings"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19.4 13a7.6 7.6 0 0 0 0-2l2-1.5-2-3.4-2.3 1a7.3 7.3 0 0 0-1.7-1L15 3h-4l-.4 2.6a7.3 7.3 0 0 0-1.7 1l-2.3-1-2 3.4 2 1.5a7.6 7.6 0 0 0 0 2l-2 1.5 2 3.4 2.3-1a7.3 7.3 0 0 0 1.7 1l.4 2.6h4l.4-2.6a7.3 7.3 0 0 0 1.7-1l2.3 1 2-3.4z"/></svg><span>Settings</span></div>
    </nav>
    <div class="foot"><button onclick="logout()">Sign out</button></div>
  </aside>

  <div class="main">
    <div class="topbar"><div id="ptitle">Dashboard</div><div class="right">
      <div class="credits">CREDITS <b id="credtot">0</b></div>
    </div></div>
    <div class="content">

      <section id="v-dash" class="view">
        <div class="row" id="liveHead" style="justify-content:space-between;align-items:baseline;margin:0 0 12px">
          <h3 style="margin:0;font-size:16px">Live usage <span id="liveDot" style="display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--green);margin-left:5px;vertical-align:middle;box-shadow:0 0 0 4px rgba(18,161,80,.15)"></span></h3>
          <span class="sub" style="margin:0">auto-updates every 30s</span></div>
        <div class="stats" id="liveStats">
          <div class="stat"><div class="lbl"><span class="ci gr"><svg viewBox="0 0 24 24" style="width:18px;height:18px"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3.5" fill="currentColor" stroke="none"/></svg></span>Online now</div><div class="num" id="u_online">0</div></div>
          <div class="stat"><div class="lbl"><span class="ci cy"><svg viewBox="0 0 24 24" style="width:18px;height:18px"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg></span>Active today</div><div class="num" id="u_today">0</div></div>
          <div class="stat"><div class="lbl"><span class="ci cy"><svg viewBox="0 0 24 24" style="width:18px;height:18px"><rect x="3" y="4" width="18" height="17" rx="2"/><path d="M3 9h18M8 2v4M16 2v4"/></svg></span>This week</div><div class="num" id="u_week">0</div></div>
          <div class="stat"><div class="lbl"><span class="ci am"><svg viewBox="0 0 24 24" style="width:18px;height:18px"><circle cx="9" cy="8" r="3"/><path d="M3.5 19c0-3 2.5-4.5 5.5-4.5s5.5 1.5 5.5 4.5"/></svg></span>Total users</div><div class="num" id="u_total">0</div></div>
        </div>
        <div class="card" id="byappCard"><h3>By app</h3><div class="sub">Which app your users are running.</div><div id="byapp"></div></div>
        <div class="card" id="recentCard"><div class="row" style="justify-content:space-between"><h3 style="margin:0">Recently active</h3><span class="sub" style="margin:0">Last 20 check-ins</span></div><table id="recent"></table></div>
        <h3 style="margin:24px 0 2px;font-size:16px" id="licHead">Licensing</h3><div class="sub" style="margin:0 0 12px">Paid activations &amp; expiry.</div>
        <div class="stats">
          <div class="stat"><div class="lbl"><span class="ci cy"><svg viewBox="0 0 24 24" style="width:18px;height:18px"><rect x="2" y="6" width="20" height="12" rx="2"/></svg></span>Activated devices</div><div class="num" id="s_total">0</div></div>
          <div class="stat"><div class="lbl"><span class="ci gr"><svg viewBox="0 0 24 24" style="width:18px;height:18px"><path d="M20 6L9 17l-5-5"/></svg></span>Active</div><div class="num" id="s_active">0</div></div>
          <div class="stat"><div class="lbl"><span class="ci am"><svg viewBox="0 0 24 24" style="width:18px;height:18px"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg></span>Expiring soon</div><div class="num" id="s_soon">0</div></div>
          <div class="stat"><div class="lbl"><span class="ci rd"><svg viewBox="0 0 24 24" style="width:18px;height:18px"><circle cx="12" cy="12" r="9"/><path d="M15 9l-6 6M9 9l6 6"/></svg></span>Expired / blocked</div><div class="num" id="s_dead">0</div></div>
        </div>
      </section>

      <section id="v-cust" class="view" hidden>
        <div class="card">
          <div class="row" style="justify-content:space-between"><div><h3 style="margin:0">Customers</h3><div class="sub" style="margin:2px 0 0">Every activated device, its plan and expiry.</div></div><button onclick="go('activate')">+ New activation</button></div>
          <div class="filters" style="margin-top:14px">
            <div class="chip on" data-f="all">All</div><div class="chip" data-f="active">Active</div><div class="chip" data-f="soon">Expires soon</div><div class="chip" data-f="expired">Expired</div><div class="chip" data-f="blocked">Blocked</div>
            <input id="q" class="grow" placeholder="Search MAC or note…" oninput="render()" style="min-width:180px"><button class="g" onclick="exportCsv()">Export CSV</button>
          </div>
          <table id="devs"></table>
        </div>
      </section>

      <section id="v-activate" class="view" hidden>
        <div class="card" style="max-width:640px"><h3>Activate a device</h3><div class="sub">1 credit = 1 year · 2 credits = lifetime. Admin activations are free.</div>
          <div class="row" style="margin-bottom:10px"><label style="width:120px">Device MAC</label><input id="amac" class="grow" placeholder="1A:2B:3C:4D:5E:6F"></div>
          <div class="row" style="margin-bottom:10px"><label style="width:120px">Note</label><input id="anote" class="grow" placeholder="Customer name / phone"></div>
          <div class="row" style="margin-bottom:10px"><label style="width:120px">App</label><select id="aapp" class="grow"><option value="any">Any app</option><option value="windows">Windows</option><option value="android">Android</option><option value="ios">iOS</option></select></div>
          <div class="row" style="margin-bottom:14px"><label style="width:120px">Plan</label><select id="aplan" class="grow"><option value="1y">1 Year (1 credit)</option><option value="lifetime">Lifetime (2 credits)</option></select></div>
          <button onclick="act()">Activate device</button><div id="aerr" class="note"></div>
        </div>
      </section>

      <section id="v-check" class="view" hidden>
        <div class="card" style="max-width:660px"><h3>Check a MAC</h3><div class="sub">See if the app is installed on that device, and its activation status.</div>
          <div class="row"><input id="cmac" class="grow" placeholder="Enter device MAC…" onkeydown="if(event.key==='Enter')checkMac()"><button onclick="checkMac()">Look up</button></div>
          <div id="cres"></div>
        </div>
      </section>

      <section id="v-res" class="view" hidden>
        <div class="card">
          <div class="row" style="justify-content:space-between"><div><h3 style="margin:0" id="resTitle">Resellers</h3><div class="sub" style="margin:2px 0 0">Create accounts, top up credits, reset passwords.</div></div><button onclick="openCreate()">+ Add account</button></div>
          <table id="restab"></table>
        </div>
      </section>

      <section id="v-modes" class="view" hidden>
        <div class="card"><h3>Player modes</h3><div class="sub">Turn each app Paid or Free, or kill it instantly. Free = nobody is blocked.</div>
          <div id="modes" style="display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin-top:6px"></div>
          <div class="row" style="margin-top:18px"><label style="width:150px">Free trial (days, 0 = off)</label><input id="trial" type="number" style="width:100px"></div>
          <div class="row" style="margin-top:10px"><label style="width:150px">Contact text (shown on block)</label><input id="contact" class="grow"></div>
          <div class="row" style="margin-top:14px"><button onclick="saveCfg()">Save settings</button><span id="cfgok" class="ok"></span></div>
        </div>
      </section>

      <section id="v-downloads" class="view" hidden>
        <div class="card"><h3>Download apps</h3><div class="sub">Share these links with your customers.</div><div class="dl" id="dlgrid"></div></div>
        <div class="card" id="dlEdit"><h3>Edit download links (admin)</h3><div class="sub">Where the buttons above point.</div>
          <div class="row" style="margin-bottom:10px"><label style="width:110px">Windows</label><input id="dlw" class="grow"></div>
          <div class="row" style="margin-bottom:12px"><label style="width:110px">Android</label><input id="dla" class="grow"></div>
          <div class="row"><button onclick="saveDl()">Save links</button><span id="dlok" class="ok"></span></div>
        </div>
      </section>

      <section id="v-settings" class="view" hidden>
        <div class="card" style="max-width:520px"><h3>Change my password</h3><div class="sub" id="setSub">Keep your login private.</div>
          <div class="row" id="unRow" style="margin-bottom:10px"><label style="width:150px">Admin username</label><input id="setUn" class="grow"></div>
          <div class="row" style="margin-bottom:10px"><label style="width:150px">Current password</label><input id="setOld" type="password" class="grow"></div>
          <div class="row" style="margin-bottom:12px"><label style="width:150px">New password</label><input id="setNew" type="password" class="grow"></div>
          <div class="row"><button onclick="changeMyPass()">Update</button><span id="setok" class="note"></span></div>
        </div>
      </section>

    </div>
  </div>
</div>

<div class="modalbg" id="modalbg"><div class="modal" id="modal"></div></div>

<script>
var S={},ROLE='',FILTER='all',SOON=14*24*3600*1000,__auto=null;
function $(id){return document.getElementById(id);}
function esc(s){return String(s==null?'':s).replace(/[&<>"]/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];});}
function api(action,extra){return fetch('admin/act',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(Object.assign({action:action},extra||{}))}).then(function(r){return r.json();});}
function login(){fetch('admin/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:$('lu').value,password:$('lp').value})}).then(function(r){return r.json();}).then(function(d){if(d.ok){$('login').style.display='none';$('shell').style.display='flex';load();startAuto();}else $('lerr').textContent=d.error||'Wrong username or password';});}
function logout(){api('state');fetch('admin/logout',{method:'POST'}).then(function(){if(__auto){clearInterval(__auto);__auto=null;}location.reload();});}
function startAuto(){if(__auto)return;__auto=setInterval(function(){load();},30000);}
function load(){api('state').then(function(d){if(d.error){if(__auto){clearInterval(__auto);__auto=null;}$('login').style.display='';$('shell').style.display='none';return;}S=d;ROLE=d.role;applyRole();render();});}
function applyRole(){
  $('rolechip').textContent=ROLE==='admin'?'Administrator':'Reseller';
  var admOnly=['modes'];var showModesEdit=(ROLE==='admin');
  document.querySelectorAll('.navi').forEach(function(n){var v=n.getAttribute('data-view');if(admOnly.indexOf(v)>=0)n.hidden=(ROLE!=='admin');});
  $('resNav').textContent=ROLE==='admin'?'Resellers':'My sub-resellers';
  $('resTitle').textContent=ROLE==='admin'?'Resellers & sub-resellers':'My sub-resellers';
  // admin-only dashboard blocks
  var admBlocks=[['liveHead',1],['liveStats',1],['byappCard',1],['recentCard',1]];
  admBlocks.forEach(function(x){var el=$(x[0]);if(el)el.style.display=(ROLE==='admin')?'':'none';});
  $('licHead').textContent=ROLE==='admin'?'Licensing':'My customers';
  $('dlEdit').style.display=(ROLE==='admin')?'':'none';
  $('unRow').style.display=(ROLE==='admin')?'':'none';
}
$('nav').addEventListener('click',function(e){var n=e.target.closest('.navi');if(n&&!n.hidden)go(n.getAttribute('data-view'));});
document.querySelector('.filters').addEventListener('click',function(e){var c=e.target.closest('.chip');if(!c)return;FILTER=c.getAttribute('data-f');document.querySelectorAll('.chip').forEach(function(x){x.classList.toggle('on',x===c);});render();});
function go(view){document.querySelectorAll('.navi').forEach(function(n){n.classList.toggle('on',n.getAttribute('data-view')===view);});document.querySelectorAll('.view').forEach(function(s){s.hidden=(s.id!=='v-'+view);});
  var t={dash:'Dashboard',cust:'Customers',activate:'Activate a device',check:'Check MAC',res:(ROLE==='admin'?'Resellers':'My sub-resellers'),modes:'Player modes',downloads:'Download apps',settings:'Settings'};$('ptitle').textContent=t[view]||'Dashboard';}

function expOf(d){return (d.plan==='lifetime'||d.expires==null)?null:d.expires;}
function classify(d){if(d.status==='blocked')return 'blocked';var e=expOf(d);if(e==null)return 'active';if(e<=Date.now())return 'expired';if(e-Date.now()<=SOON)return 'soon';return 'active';}
function fmt(ts){if(ts==null)return 'Lifetime';var x=new Date(ts);return x.getFullYear()+'-'+String(x.getMonth()+1).padStart(2,'0')+'-'+String(x.getDate()).padStart(2,'0');}
function daysLeft(ts){if(ts==null)return '∞';var d=Math.ceil((ts-Date.now())/86400000);return d+' d';}
function timeAgo(ts){if(!ts)return '—';var s=Math.floor((Date.now()-ts)/1000);if(s<60)return 'just now';var m=Math.floor(s/60);if(m<60)return m+'m ago';var h=Math.floor(m/60);if(h<24)return h+'h ago';return Math.floor(h/24)+'d ago';}
var APPMETA={windows:{label:'Windows',color:'#1fa6e8'},android:{label:'Android',color:'#12a150'},ios:{label:'iOS',color:'#7a5cff'},other:{label:'Other',color:'#94a3b8'},any:{label:'Any',color:'#94a3b8'}};
function am(a){return APPMETA[(a==='windows'||a==='android'||a==='ios')?a:'other'];}

function render(){
  // credits badge
  if(ROLE==='admin'){$('credtot').textContent='∞';}else{$('credtot').textContent=(S.me&&S.me.credits)||0;}
  if(ROLE==='admin')renderUsage();
  renderLicensing();
  renderDevices();
  renderResellers();
  renderModes();
  renderDownloads();
  renderSettings();
}
function renderUsage(){
  var u=S.stats||{online:0,today:0,week:0,total:0,byApp:{},recent:[]};
  $('u_online').textContent=u.online||0;$('u_today').textContent=u.today||0;$('u_week').textContent=u.week||0;$('u_total').textContent=u.total||0;
  var dot=$('liveDot');if(dot)dot.style.background=(u.online>0)?'var(--green)':'#c2ccd8';
  var ba=u.byApp||{},keys=['windows','android','ios','other'],max=1;keys.forEach(function(k){max=Math.max(max,ba[k]||0);});
  var h='';keys.forEach(function(k){var v=ba[k]||0,meta=APPMETA[k],pct=Math.round((v/max)*100);
    h+='<div style="display:flex;align-items:center;gap:12px;margin:11px 0"><div style="width:78px;font-size:13px;font-weight:700;color:'+meta.color+'">'+meta.label+'</div><div style="flex:1;background:#eef3f9;border-radius:8px;height:14px;overflow:hidden"><div style="height:100%;width:'+pct+'%;background:'+meta.color+';border-radius:8px;transition:width .4s"></div></div><div style="width:44px;text-align:right;font-weight:800">'+v+'</div></div>';});
  $('byapp').innerHTML=h;
  var rec=u.recent||[],rh='<tr><th>MAC</th><th>App</th><th>Version</th><th>Check-ins</th><th>Last seen</th></tr>';
  if(!rec.length)rh+='<tr><td colspan="5" class="empty">No devices have checked in yet.</td></tr>';
  rec.forEach(function(x){var meta=am(x.app);rh+='<tr><td class="mono">'+esc(x.mac)+'</td><td><span style="color:'+meta.color+';font-weight:700">'+meta.label+'</span></td><td>'+esc(x.ver||'—')+'</td><td>'+(x.count||0)+'</td><td>'+timeAgo(x.last)+'</td></tr>';});
  $('recent').innerHTML=rh;
}
function renderLicensing(){
  var devs=S.devices||{},macs=Object.keys(devs),st={total:macs.length,active:0,soon:0,dead:0};
  macs.forEach(function(m){var cl=classify(devs[m]);if(cl==='active')st.active++;if(cl==='soon'){st.soon++;st.active++;}if(cl==='expired'||cl==='blocked')st.dead++;});
  $('s_total').textContent=st.total;$('s_active').textContent=st.active;$('s_soon').textContent=st.soon;$('s_dead').textContent=st.dead;
}
function renderDevices(){
  var devs=S.devices||{},q=($('q').value||'').toUpperCase();
  var list=Object.keys(devs).filter(function(m){var d=devs[m],cl=classify(d);
    if(FILTER==='soon'&&cl!=='soon')return false;if(FILTER==='active'&&!(cl==='active'||cl==='soon'))return false;if(FILTER==='expired'&&cl!=='expired')return false;if(FILTER==='blocked'&&cl!=='blocked')return false;
    if(q&&m.indexOf(q)<0&&String(d.note||'').toUpperCase().indexOf(q)<0)return false;return true;}).sort(function(a,b){return (expOf(devs[a])||9e15)-(expOf(devs[b])||9e15);});
  var byCol=(ROLE==='admin')?'<th>By</th>':'';
  var t='<tr><th>MAC</th><th>Note</th><th>App</th><th>Plan</th><th>Expiry</th><th>Left</th>'+byCol+'<th>Status</th><th></th></tr>';
  if(!list.length)t+='<tr><td colspan="9" class="empty">No devices match this filter.</td></tr>';
  list.forEach(function(m){var d=devs[m],cl=classify(d),e=expOf(d);
    var tag=cl==='active'?'<span class="tag on">Active</span>':cl==='soon'?'<span class="tag soon">Expires soon</span>':cl==='expired'?'<span class="tag off">Expired</span>':'<span class="tag off">Blocked</span>';
    var plan=d.plan==='lifetime'?'<span class="tag life">Lifetime</span>':esc(d.plan);
    var byCell=(ROLE==='admin')?('<td>'+esc(d.activated_by==='admin'?'Admin':((S.accounts[d.activated_by]&&S.accounts[d.activated_by].name)||d.activated_by))+'</td>'):'';
    var actbtn=d.status==='blocked'?'<button class="g sm" data-act="unblock" data-mac="'+m+'">Unblock</button>':'<button class="g sm" data-act="block" data-mac="'+m+'">Block</button>';
    t+='<tr><td class="mono">'+m+'</td><td>'+esc(d.note||'—')+'</td><td>'+esc(d.app)+'</td><td>'+plan+'</td><td>'+fmt(e)+'</td><td>'+(cl==='expired'?'—':daysLeft(e))+'</td>'+byCell+'<td>'+tag+'</td><td style="white-space:nowrap"><button class="sm" data-renew="'+m+'">Renew</button> '+actbtn+' <button class="d sm" data-act="delete" data-mac="'+m+'">Del</button></td></tr>';});
  $('devs').innerHTML=t;
}
function renderResellers(){
  var accs=S.accounts||{},ids=Object.keys(accs);
  // build tree ordered (roots first, then children). roots = parent not in accs (i.e. my direct children)
  var roots=ids.filter(function(id){var p=accs[id].parent;return !p||!accs[p];});
  var out=[];function walk(id,depth){out.push({id:id,depth:depth});ids.filter(function(x){return accs[x].parent===id;}).sort(byName).forEach(function(c){walk(c,depth+1);});}
  function byName(a,b){return (accs[a].name||'').localeCompare(accs[b].name||'');}
  roots.sort(byName).forEach(function(r){walk(r,0);});
  var adminCol=(ROLE==='admin');
  var th='<tr><th>Account</th><th>Username</th>'+(adminCol?'<th>Email</th>':'')+'<th>Credits</th><th>Status</th><th>Actions</th></tr>';
  var t=th;
  if(!out.length)t+='<tr><td colspan="6" class="empty">No accounts yet. Tap “Add account”.</td></tr>';
  out.forEach(function(n){var a=accs[n.id];var pad=n.depth*18;
    var name='<span style="padding-left:'+pad+'px">'+(n.depth>0?'<span style="color:var(--muted)">↳ </span>':'')+'<b>'+esc(a.name)+'</b>'+(a.children?' <span class="sub" style="margin:0">('+a.children+')</span>':'')+'</span>';
    var reparent=(ROLE==='admin')?' <button class="g sm" data-reparent="'+n.id+'">Move</button>':'';
    var del=(ROLE==='admin'&&!a.children)?' <button class="d sm" data-delacc="'+n.id+'">Del</button>':'';
    t+='<tr class="treerow"><td>'+name+'</td><td class="mono">'+esc(a.username)+'</td>'+(adminCol?'<td>'+esc(a.email||'—')+'</td>':'')+'<td><b>'+(a.credits||0)+'</b></td>'+
      '<td><button class="'+(a.enabled?'g':'d')+' sm" data-tacc="'+n.id+'">'+(a.enabled?'Enabled':'Disabled')+'</button></td>'+
      '<td style="white-space:nowrap"><button class="sm" data-topup="'+n.id+'">Credits</button> <button class="g sm" data-reset="'+n.id+'">Password</button>'+reparent+del+'</td></tr>';});
  $('restab').innerHTML=t;
}
function renderModes(){
  if(ROLE!=='admin')return;var c=S.config;if(!c||!c.paid)return;var apps=['windows','android','ios'],h='';
  apps.forEach(function(a){h+='<div style="border:1px solid var(--line);border-radius:14px;padding:16px;background:#f9fbfe"><h4 style="margin:0 0 12px;font-size:14px">'+a.charAt(0).toUpperCase()+a.slice(1)+'</h4>'+
    '<div style="display:flex;align-items:center;justify-content:space-between;margin:9px 0"><span class="sub" style="margin:0">Billing</span><button class="sm" style="min-width:80px;background:'+(c.paid[a]?'var(--cyan)':'#eef3f9')+';color:'+(c.paid[a]?'#fff':'#455872')+'" data-tog="paid" data-app="'+a+'">'+(c.paid[a]?'PAID':'FREE')+'</button></div>'+
    '<div style="display:flex;align-items:center;justify-content:space-between;margin:9px 0"><span class="sub" style="margin:0">Availability</span><button class="sm" style="min-width:80px;background:'+(c.kill[a]?'var(--red)':'var(--greenbg)')+';color:'+(c.kill[a]?'#fff':'var(--green)')+'" data-tog="kill" data-app="'+a+'">'+(c.kill[a]?'KILLED':'LIVE')+'</button></div></div>';});
  $('modes').innerHTML=h;$('trial').value=c.trial_days||0;$('contact').value=c.contact||'';
}
function renderDownloads(){
  var dl=(S.config&&S.config.downloads)||{windows:'',android:''};
  function card(title,url,sub){var q='https://api.qrserver.com/v1/create-qr-code/?size=150x150&data='+encodeURIComponent(url||'');
    return '<div class="dlc"><h4>'+title+'</h4><div class="sub" style="margin:0">'+sub+'</div><img class="qr" src="'+q+'" alt="QR"><div class="mono" style="font-size:11.5px;word-break:break-all;color:var(--muted)">'+esc(url||'—')+'</div><a class="b" href="'+esc(url||'#')+'" target="_blank">Open</a></div>';}
  $('dlgrid').innerHTML=card('Windows',dl.windows,'PC installer (.exe)')+card('Android',dl.android,'APK for phones / TV boxes');
  if(ROLE==='admin'){$('dlw').value=dl.windows||'';$('dla').value=dl.android||'';}
}
function renderSettings(){if(ROLE==='admin'&&S.me)$('setUn').value=S.me.username||'';}

/* delegated clicks */
document.addEventListener('click',function(e){var b=e.target.closest('button');if(!b)return;
  if(b.dataset.tog){var c=S.config;c[b.dataset.tog][b.dataset.app]=!c[b.dataset.tog][b.dataset.app];api('setConfig',{config:c}).then(load);return;}
  if(b.dataset.act){var m=b.dataset.mac,a=b.dataset.act;if(a==='delete'){if(!confirm('Delete '+m+' ?'))return;}api(a,{mac:m}).then(load);return;}
  if(b.dataset.renew){openRenew(b.dataset.renew);return;}
  if(b.dataset.topup){openTopup(b.dataset.topup);return;}
  if(b.dataset.reset){openReset(b.dataset.reset);return;}
  if(b.dataset.tacc){api('toggleAccount',{id:b.dataset.tacc}).then(load);return;}
  if(b.dataset.reparent){openReparent(b.dataset.reparent);return;}
  if(b.dataset.delacc){if(confirm('Delete this account?'))api('deleteAccount',{id:b.dataset.delacc}).then(load);return;}
});

/* modals */
function modal(html){$('modal').innerHTML=html;$('modalbg').classList.add('on');}
function closeModal(){$('modalbg').classList.remove('on');}
$('modalbg').addEventListener('click',function(e){if(e.target===$('modalbg'))closeModal();});
function openCreate(){var isAdmin=ROLE==='admin';modal(
  '<h3>'+(isAdmin?'Add reseller':'Add sub-reseller')+'</h3><div class="sub">They will log in with this username &amp; password.</div>'+
  '<div class="f"><label>Display name</label><input id="m_name" placeholder="e.g. Ali Traders"></div>'+
  '<div class="f"><label>Username</label><input id="m_user" placeholder="login username" autocapitalize="none"></div>'+
  '<div class="f"><label>Password</label><input id="m_pass" placeholder="min 4 characters"></div>'+
  '<div class="f"><label>Email (optional)</label><input id="m_email" placeholder="email@example.com"></div>'+
  '<div class="f"><label>Starting credits (optional)</label><input id="m_cred" type="number" placeholder="0"></div>'+
  '<div class="merr" id="m_err"></div><div class="foot"><button class="g" onclick="closeModal()">Cancel</button><button onclick="submitCreate()">Create</button></div>');}
function submitCreate(){api('createAccount',{name:$('m_name').value,username:$('m_user').value,password:$('m_pass').value,email:$('m_email').value,credits:$('m_cred').value}).then(function(d){if(d.ok){closeModal();load();}else $('m_err').textContent=d.error||'error';});}
function openTopup(id){var a=S.accounts[id]||{};modal(
  '<h3>Credits — '+esc(a.name||'')+'</h3><div class="sub">Balance: <b>'+(a.credits||0)+'</b>. Enter a positive number to add, negative to take back.</div>'+
  '<div class="f"><label>Amount</label><input id="m_amt" type="number" placeholder="e.g. 10"></div>'+
  '<div class="merr" id="m_err"></div><div class="foot"><button class="g" onclick="closeModal()">Cancel</button><button onclick="submitTopup(\\''+id+'\\')">Apply</button></div>');}
function submitTopup(id){api('transfer',{id:id,amount:$('m_amt').value}).then(function(d){if(d.ok){closeModal();load();}else $('m_err').textContent=d.error||'error';});}
function openReset(id){var a=S.accounts[id]||{};modal(
  '<h3>Reset password — '+esc(a.name||'')+'</h3><div class="sub">Set a new password for this account.</div>'+
  '<div class="f"><label>New password</label><input id="m_np" placeholder="min 4 characters"></div>'+
  '<div class="merr" id="m_err"></div><div class="foot"><button class="g" onclick="closeModal()">Cancel</button><button onclick="submitReset(\\''+id+'\\')">Reset</button></div>');}
function submitReset(id){api('resetPass',{id:id,password:$('m_np').value}).then(function(d){if(d.ok){closeModal();load();}else $('m_err').textContent=d.error||'error';});}
function openRenew(mac){var d=S.devices[mac]||{};modal(
  '<h3>Renew device</h3><div class="sub">'+esc(mac)+' — choose a plan.</div>'+
  '<div class="f"><label>Plan</label><select id="m_plan"><option value="1y">1 Year (1 credit)</option><option value="lifetime">Lifetime (2 credits)</option></select></div>'+
  '<div class="merr" id="m_err"></div><div class="foot"><button class="g" onclick="closeModal()">Cancel</button><button onclick="submitRenew(\\''+mac+'\\')">Renew</button></div>');}
function submitRenew(mac){api('renew',{mac:mac,plan:$('m_plan').value}).then(function(d){if(d.ok){closeModal();load();}else $('m_err').textContent=d.error||'error';});}
function openReparent(id){var accs=S.accounts||{};var opts='<option value="admin">Top level (under Admin)</option>';
  Object.keys(accs).forEach(function(x){if(x!==id)opts+='<option value="'+x+'">'+esc(accs[x].name)+'</option>';});
  modal('<h3>Move account</h3><div class="sub">Re-assign this account under a new parent.</div><div class="f"><label>New parent</label><select id="m_par">'+opts+'</select></div><div class="merr" id="m_err"></div><div class="foot"><button class="g" onclick="closeModal()">Cancel</button><button onclick="submitReparent(\\''+id+'\\')">Move</button></div>');}
function submitReparent(id){api('reparent',{id:id,parent:$('m_par').value}).then(function(d){if(d.ok){closeModal();load();}else $('m_err').textContent=d.error||'error';});}

function act(){api('activate',{mac:$('amac').value,app:$('aapp').value,plan:$('aplan').value,note:$('anote').value}).then(function(d){if(d.ok){$('aerr').innerHTML='<span class="ok">Activated ✓</span>';$('amac').value='';$('anote').value='';load();}else $('aerr').innerHTML='<span style="color:var(--red)">Error: '+esc(d.error||'failed')+'</span>';});}
function checkMac(){var m=($('cmac').value||'').toUpperCase().replace(/[^0-9A-F:]/g,'');if(!m){$('cres').innerHTML='';return;}
  api('checkMac',{mac:m}).then(function(d){
    var inst=d.installed?'<span class="ok">Installed</span>':'<span style="color:var(--red);font-weight:700">Not installed</span>';
    var seen=d.seen?('App: <b>'+esc(am(d.seen.app).label)+'</b> · Version: <b>'+esc(d.seen.ver||'—')+'</b> · Last seen: <b>'+timeAgo(d.seen.last)+'</b> · Check-ins: <b>'+(d.seen.count||0)+'</b>'):'This device has never opened the app.';
    var act;
    if(d.device){var cl=d.device.active?'var(--green)':'var(--red)';act='<div style="margin-top:10px">Activation: <b style="color:'+cl+'">'+(d.device.active?'ACTIVE':(d.device.status==='blocked'?'BLOCKED':'EXPIRED'))+'</b> · Plan: <b>'+esc(d.device.plan)+'</b> · Expiry: <b>'+(d.device.expires?fmt(d.device.expires):'Lifetime')+'</b>'+(d.device.by?(' · By: <b>'+esc(d.device.by)+'</b>'):'')+'</div>';}
    else act='<div style="margin-top:10px">Activation: <b style="color:var(--muted)">not activated</b> (in Paid mode this device would be blocked).</div>';
    $('cres').innerHTML='<div class="lookup"><div class="k">'+esc(m)+'</div><div class="big" style="margin:6px 0">'+inst+'</div><div class="note" style="margin:0">'+seen+'</div>'+act+'</div>';});}
function saveCfg(){var c=S.config;c.trial_days=parseInt($('trial').value)||0;c.contact=$('contact').value;api('setConfig',{config:c}).then(function(){$('cfgok').textContent='Saved ✓';setTimeout(function(){$('cfgok').textContent='';},1600);load();});}
function saveDl(){api('setDownloads',{windows:$('dlw').value,android:$('dla').value}).then(function(){$('dlok').textContent='Saved ✓';setTimeout(function(){$('dlok').textContent='';},1600);load();});}
function changeMyPass(){api('changeMyPass',{username:$('setUn').value,oldpass:$('setOld').value,newpass:$('setNew').value}).then(function(d){$('setok').innerHTML=d.ok?'<span class="ok">Updated ✓</span>':'<span style="color:var(--red)">'+esc(d.error||'error')+'</span>';if(d.ok){$('setOld').value='';$('setNew').value='';}});}
function exportCsv(){var devs=S.devices||{},rows=[['MAC','Note','App','Plan','Expiry','Status','By']];
  Object.keys(devs).forEach(function(m){var d=devs[m];rows.push([m,(d.note||'').replace(/,/g,' '),d.app,d.plan,d.expires?fmt(d.expires):'Lifetime',classify(d),(d.activated_by==='admin'?'Admin':((S.accounts[d.activated_by]&&S.accounts[d.activated_by].name)||d.activated_by||''))]);});
  var csv=rows.map(function(r){return r.join(',');}).join('\\n');var a=document.createElement('a');a.href='data:text/csv;charset=utf-8,'+encodeURIComponent(csv);a.download='zayron-customers.csv';a.click();}
</script>
</body></html>`.replace(/SVGLOGO/g,'<svg viewBox="0 0 64 64" style="width:100%;height:100%"><defs><linearGradient id="zg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#63e2ff"/><stop offset="1" stop-color="#0e7fc0"/></linearGradient></defs><circle cx="32" cy="32" r="28" fill="none" stroke="url(#zg)" stroke-width="5"/><polygon points="26,20 44,20 30,44 46,44 46,50 20,50 34,26 26,26" fill="url(#zg)" stroke="none"/></svg>');

server.listen(PORT, '127.0.0.1', () => console.log('Zayron activation server on 127.0.0.1:' + PORT));

/*
 * DEPLOY (isolated — does not touch your other apps):
 *  1) Put this file at /root/zayron-activation/activation-server.js
 *  2) systemd unit runs it 24/7 on port 3800 (already set up).
 *  3) Caddy: handle /act* { reverse_proxy 127.0.0.1:3800 }  (already set up).
 *  Panel: https://zayron.tv/act/admin   ·   App check: https://zayron.tv/act/api/check
 */
