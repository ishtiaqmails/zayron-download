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

// ---------- version.json (force-update for CURRENT apps, generated from the dashboard) ----------
const VERSION_JSON_PATH = process.env.ZAYRON_VERSION_JSON || '';
function buildVersionJson() {
  const up = (db.config && db.config.update) || {}, kill = (db.config && db.config.kill) || {};
  const w = up.windows || {}, a = up.android || {};
  return {
    min_version: (a.on ? (parseInt(a.min) || 0) : 0), update_url: a.url || '', disabled: !!kill.android,
    win_min_version: (w.on ? (parseInt(w.min) || 0) : 0), win_update_url: w.url || '', win_disabled: !!kill.windows,
    title: 'Update Required',
    message: (w.on && w.msg) ? w.msg : ((a.on && a.msg) ? a.msg : 'A new version of Zayron is available. Please update to continue.')
  };
}
function writeVersionJson() { if (!VERSION_JSON_PATH) return; try { fs.writeFileSync(VERSION_JSON_PATH, JSON.stringify(buildVersionJson(), null, 2)); } catch (e) {} }

const now = () => Date.now();
const YEAR = 365 * 24 * 3600 * 1000;
const LOGO_URI = 'data:image/png;base64,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';   // real Zayron logo (injected)

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
if (!db.config.update) db.config.update = { windows: { on: false, min: 0, latest: '', url: '', msg: '' }, android: { on: false, min: 0, latest: '', url: '', msg: '' } };
// The list of apps you actually ship (drives Player Modes + Force Update). Add more as you build them.
if (!db.config.apps) db.config.apps = [{ id: 'windows', label: 'Windows' }, { id: 'android', label: 'Android' }];
if (!db.maxver) db.maxver = {};   // highest version code seen per app (for 1-tap "force to latest")
if (!db.admin.api_key) db.admin.api_key = crypto.randomBytes(16).toString('hex');
Object.keys(db.accounts).forEach(function (id) { if (!db.accounts[id].api_key) db.accounts[id].api_key = crypto.randomBytes(16).toString('hex'); if (db.accounts[id].api_enabled === undefined) db.accounts[id].api_enabled = false; if (!db.accounts[id].type) db.accounts[id].type = 'reseller'; });
if (db.resellers && Object.keys(db.resellers).length && !Object.keys(db.accounts).length) {
  Object.keys(db.resellers).forEach(function (id) {
    const r = db.resellers[id];
    db.accounts[id] = { id: id, username: (r.name || id).toLowerCase().replace(/[^a-z0-9]/g, '') || id, salt: '', hash: '', name: r.name || id, email: '', credits: r.credits || 0, parent: r.parent || null, enabled: r.enabled !== false, created: r.created || now() };
  });
  delete db.resellers; save(db);
}

// ---------- helpers ----------
function normMac(m) { return String(m || '').toUpperCase().replace(/[^0-9A-F:]/g, '').trim(); }
// canonical device key: accepts "C3:6E:74:61:7B:13" OR "C36E74617B13" (any separators) → colon form
function macKey(m) { const hex = String(m || '').toUpperCase().replace(/[^0-9A-F]/g, ''); if (hex.length === 12) return hex.match(/.{2}/g).join(':'); return normMac(m); }
function json(res, code, obj) { res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }); res.end(JSON.stringify(obj)); }
function readBody(req) { return new Promise(r => { let b = ''; req.on('data', c => { b += c; if (b.length > 100000) req.destroy(); }); req.on('end', () => r(b)); }); }
function cookie(req, name) { const c = (req.headers.cookie || '').split(';').map(s => s.trim()); for (const p of c) if (p.indexOf(name + '=') === 0) return p.slice(name.length + 1); return ''; }

// ---------- sessions (persisted) ----------
const SESSION_TTL = 30 * 24 * 3600 * 1000;
function newSession(uid, role) { const t = crypto.randomBytes(24).toString('hex'); db.sessions[t] = { uid: uid, role: role, exp: now() + SESSION_TTL }; save(db); return t; }
function getSession(t) { const s = db.sessions[t]; if (!s) return null; if (s.exp < now()) { delete db.sessions[t]; return null; } return s; }
function dropSession(t) { if (t && db.sessions[t]) { delete db.sessions[t]; save(db); } }
function tokenOf(req) { return req.headers['x-auth'] || cookie(req, 'zadm'); }   // header first (survives Cloudflare), cookie fallback
function currentUser(req) { return getSession(tokenOf(req)); }

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

function activate(uid, mac, app, plan, note, isRenew, mint) {
  mac = macKey(mac); if (!mac) return { ok: false, error: 'bad mac' };
  const cur = db.devices[mac];
  if (isRenew && !mint && cur && !isDesc(uid, cur.activated_by)) return { ok: false, error: 'not your device' };
  const cost = creditsFor(plan);
  if (!mint) { if (balanceOf(uid) < cost) return { ok: false, error: 'not enough credits' }; db.accounts[uid].credits -= cost; }
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
  db.ledger.push({ ts: now(), type: isRenew ? 'renew' : 'activate', from: uid, mac: mac, amount: (mint ? 0 : -cost), note: plan });
  save(db); return { ok: true };
}

// ---------- usage tracking (debounced saves) ----------
let __dirty = false;
function markDirty() { __dirty = true; }
setInterval(function () { if (__dirty) { __dirty = false; try { save(db); } catch (e) {} } }, 15000).unref();
function recordSeen(mac, app, ver, verc) {
  if (!mac || mac.replace(/[^0-9A-F]/g, '').length < 6) return;
  const s = db.seen[mac] || { first: now(), count: 0 };
  s.app = app || s.app || 'unknown'; if (ver) s.ver = String(ver).slice(0, 20); if (verc) s.verc = parseInt(verc) || 0; s.last = now(); s.count = (s.count || 0) + 1;
  db.seen[mac] = s;
  const vc = parseInt(verc) || 0; if (vc > 0 && app) { if (!db.maxver[app] || vc > db.maxver[app]) db.maxver[app] = vc; }   // newest version in the wild
  markDirty();
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

// ---------- roles & permissions ----------
// Owner (admin login) = full. super_admin / mini_admin = staff (see everything, no global switches).
// reseller / sub_reseller = scoped to their own tree.
const RANK = { admin: 4, super_admin: 3, mini_admin: 2, reseller: 1, sub_reseller: 1 };
function rankOf(role) { return RANK[role] || 1; }
function permsOf(role) {
  if (role === 'admin')       return { staff: true, scope: 'all', global: true,  assign: ['super_admin', 'mini_admin', 'reseller', 'sub_reseller'] };
  if (role === 'super_admin') return { staff: true, scope: 'all', global: false, assign: ['mini_admin', 'reseller', 'sub_reseller'] };
  if (role === 'mini_admin')  return { staff: true, scope: 'all', global: false, assign: ['reseller', 'sub_reseller'] };
  return { staff: false, scope: 'own', global: false, assign: ['sub_reseller', 'reseller'] };   // reseller makes sub-resellers
}
function accType(id) { return (db.accounts[id] && db.accounts[id].type) || 'reseller'; }
function canTouchDevice(cu, mac) { return permsOf(cu.role).scope === 'all' ? true : ownsDevice(cu.uid, mac); }
// Can cu manage (edit/reset/move/delete/role) the target account?
function canManageAccount(cu, id) {
  if (!db.accounts[id]) return false;
  const p = permsOf(cu.role);
  if (p.scope === 'all') return rankOf(cu.role) > rankOf(accType(id));   // staff manage strictly-lower ranks only
  return isDesc(cu.uid, id);                                            // reseller manages own subtree
}
function isMint(cu) { return permsOf(cu.role).staff; }   // owner + staff issue credits like a mint

// ---------- build role-scoped state for the panel ----------
function accountView(id) { const a = db.accounts[id]; return { id: id, username: a.username, name: a.name, email: a.email || '', credits: a.credits || 0, parent: a.parent || null, enabled: a.enabled !== false, api_enabled: a.api_enabled === true, type: a.type || 'reseller', created: a.created, hasPass: !!a.hash, children: directChildren(id).length }; }
function stateFor(cu) {
  const p = permsOf(cu.role);
  if (p.scope === 'all') {   // owner + super_admin + mini_admin see everything
    const accs = {}; Object.keys(db.accounts).forEach(function (id) { accs[id] = accountView(id); });
    const meName = cu.uid === 'admin' ? db.admin.username : ((db.accounts[cu.uid] || {}).username || 'staff');
    return { role: cu.role, perms: { global: p.global, assign: p.assign, staff: true, rank: rankOf(cu.role) },
      me: { id: cu.uid, username: meName, credits: null },
      config: db.config, accounts: accs, devices: db.devices, stats: computeStats(), maxver: db.maxver,
      allseen: db.seen, ledger: db.ledger.slice(-160).reverse().map(fmtLedger) };
  }
  const uid = cu.uid, ids = subtreeIds(uid); const accs = {}; ids.forEach(function (id) { accs[id] = accountView(id); });
  const devs = {}; Object.keys(db.devices).forEach(function (m) { if (ownsDevice(uid, m) && db.devices[m].activated_by !== 'admin' && isDesc(uid, db.devices[m].activated_by)) devs[m] = db.devices[m]; });
  const me = db.accounts[uid] || {};
  const led = db.ledger.filter(function (e) { return e.from === uid || e.to === uid || (e.mac && devs[e.mac]); }).slice(-120).reverse().map(fmtLedger);
  return { role: cu.role, perms: { global: false, assign: p.assign, staff: false, rank: 1 },
    me: { id: uid, username: me.username, name: me.name, email: me.email || '', credits: me.credits || 0, api_enabled: me.api_enabled === true },
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
    const app = (body.app || 'windows').toLowerCase(); const mac = macKey(body.mac); const c = db.config;
    recordSeen(mac, app, body.ver, body.verc);
    const uc = (c.update && c.update[app]) || null;                                  // force-update config
    const upd = (uc && uc.on) ? { on: true, min: uc.min || 0, latest: uc.latest || '', url: uc.url || '', msg: uc.msg || '' } : null;
    const reply = (o) => json(res, 200, upd ? Object.assign({ upd: upd }, o) : o);   // app compares its verCode < upd.min
    if (c.kill[app]) return reply({ active: false, kill: true, message: 'This app is temporarily unavailable. ' + c.contact });
    // A device you explicitly BLOCK is blocked in FREE mode too (an admin kill-switch for one device).
    let bd = db.devices[mac];
    if (bd && bd.status === 'blocked') return reply({ active: false, blocked: true, message: 'This device has been blocked. ' + c.contact });
    if (!c.paid[app]) return reply({ active: true, free: true });
    let dev = db.devices[mac];
    if (deviceActive(dev)) return reply({ active: true, plan: dev.plan, expires: dev.expires });
    if (!dev && c.trial_days > 0) { db.devices[mac] = { app, plan: 'trial', expires: now() + c.trial_days * 24 * 3600 * 1000, activated_by: 'trial', created: now(), status: 'active', note: 'auto-trial' }; save(db); return reply({ active: true, plan: 'trial', expires: db.devices[mac].expires }); }
    if (dev && dev.plan === 'trial' && deviceActive(dev)) return reply({ active: true, plan: 'trial', expires: dev.expires });
    return reply({ active: false, mac, message: 'This device is not activated. Send this MAC to your provider: ' + mac + '  —  ' + c.contact });
  }

  // ===== RESELLER AUTOMATION API (v1) — authenticated by api_key (header X-API-Key or ?key=) =====
  if (p.indexOf('/api/v1/') >= 0) {
    const key = req.headers['x-api-key'] || u.searchParams.get('key') || '';
    let acct = null;
    if (key && key === db.admin.api_key) acct = 'admin';
    else if (key) { const id = Object.keys(db.accounts).find(function (i) { return db.accounts[i].api_key === key; }); if (id && db.accounts[id].enabled !== false && db.accounts[id].api_enabled === true) acct = id; }
    if (!acct) return json(res, 401, { ok: false, error: 'invalid api key or API access not enabled' });
    let body = {}; if (req.method === 'POST') { try { body = JSON.parse(await readBody(req) || '{}'); } catch (e) {} }
    const q = u.searchParams;
    if (p.endsWith('/api/v1/balance')) return json(res, 200, { ok: true, credits: (acct === 'admin') ? 'unlimited' : (db.accounts[acct].credits || 0) });
    if (p.endsWith('/api/v1/activate')) { const r = activate(acct, body.mac || q.get('mac'), body.app || q.get('app'), body.plan || q.get('plan') || '1y', body.note || q.get('note'), false); const mk = macKey(body.mac || q.get('mac')); return json(res, 200, r.ok ? { ok: true, mac: mk, plan: db.devices[mk].plan, expires: db.devices[mk].expires } : r); }
    if (p.endsWith('/api/v1/renew')) { const r = activate(acct, body.mac || q.get('mac'), body.app || q.get('app'), body.plan || q.get('plan') || '1y', body.note || q.get('note'), true); const mk = macKey(body.mac || q.get('mac')); return json(res, 200, r.ok ? { ok: true, mac: mk, plan: db.devices[mk].plan, expires: db.devices[mk].expires } : r); }
    if (p.endsWith('/api/v1/check')) { const mac = macKey(q.get('mac') || body.mac); const d = db.devices[mac]; if (!d) return json(res, 200, { ok: true, mac: mac, activated: false }); const mine = acct === 'admin' || isDesc(acct, d.activated_by); return json(res, 200, { ok: true, mac: mac, activated: true, active: deviceActive(d), plan: d.plan, expires: d.expires, status: d.status, note: mine ? d.note : undefined }); }
    if (p.endsWith('/api/v1/devices')) { const out = []; Object.keys(db.devices).forEach(function (m) { const d = db.devices[m]; if (acct === 'admin' || isDesc(acct, d.activated_by)) out.push({ mac: m, plan: d.plan, expires: d.expires, status: d.status, active: deviceActive(d), note: d.note }); }); return json(res, 200, { ok: true, count: out.length, devices: out }); }
    return json(res, 404, { ok: false, error: 'unknown endpoint' });
  }

  // AUTH: login
  if (p.endsWith('/admin/login') && req.method === 'POST') {
    let b = {}; try { b = JSON.parse(await readBody(req) || '{}'); } catch (e) {}
    const un = String(b.username || '').trim(), pw = String(b.password || '');
    if (un.toLowerCase() === (db.admin.username || 'admin').toLowerCase() && chkPass(pw, db.admin)) {
      const t = newSession('admin', 'admin'); res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': 'zadm=' + t + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000' }); return res.end(JSON.stringify({ ok: true, role: 'admin', token: t }));
    }
    const id = Object.keys(db.accounts).find(function (i) { return (db.accounts[i].username || '').toLowerCase() === un.toLowerCase(); });
    if (id) { const a = db.accounts[id]; if (a.enabled === false) return json(res, 200, { ok: false, error: 'account disabled' }); if (chkPass(pw, a)) { const role = a.type || 'reseller'; const t = newSession(id, role); res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': 'zadm=' + t + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000' }); return res.end(JSON.stringify({ ok: true, role: role, token: t })); } }
    return json(res, 200, { ok: false, error: 'wrong username or password' });
  }
  if (p.endsWith('/admin/logout') && req.method === 'POST') { dropSession(tokenOf(req)); res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': 'zadm=; Path=/; HttpOnly; Max-Age=0' }); return res.end('{"ok":true}'); }

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
      if (a === 'setConfig') { if (!adminOnly()) return json(res, 403, { error: 'admins only' }); db.config = Object.assign(db.config, b.config || {}); save(db); writeVersionJson(); return json(res, 200, { ok: true }); }
      if (a === 'setDownloads') { if (!adminOnly()) return json(res, 403, { error: 'admins only' }); db.config.downloads = { windows: (b.windows || '').trim(), android: (b.android || '').trim() }; save(db); return json(res, 200, { ok: true }); }

      // change my own login (admin: username+password; reseller: password)
      if (a === 'changeMyPass') { if (!b.newpass || b.newpass.length < 4) return json(res, 200, { ok: false, error: 'password too short (min 4)' });
        if (role === 'admin') { if (!chkPass(b.oldpass || '', db.admin)) return json(res, 200, { ok: false, error: 'current password is wrong' }); const np = mkPass(b.newpass); db.admin.salt = np.salt; db.admin.hash = np.hash; if (b.username) db.admin.username = String(b.username).trim(); save(db); return json(res, 200, { ok: true }); }
        const me = db.accounts[uid]; if (!chkPass(b.oldpass || '', me)) return json(res, 200, { ok: false, error: 'current password is wrong' }); const np = mkPass(b.newpass); me.salt = np.salt; me.hash = np.hash; save(db); return json(res, 200, { ok: true }); }

      // create a reseller / sub-reseller / staff account
      if (a === 'createAccount') {
        const P = permsOf(role);
        const un = String(b.username || '').trim(); if (un.length < 3) return json(res, 200, { ok: false, error: 'username too short (min 3)' });
        if (!/^[a-zA-Z0-9_.-]+$/.test(un)) return json(res, 200, { ok: false, error: 'username: letters, numbers, . _ - only' });
        if (usernameTaken(un)) return json(res, 200, { ok: false, error: 'username already taken' });
        if (!b.password || b.password.length < 4) return json(res, 200, { ok: false, error: 'password too short (min 4)' });
        let type = 'reseller'; if (b.type && P.assign.indexOf(b.type) >= 0) type = b.type;
        const staffType = (type === 'super_admin' || type === 'mini_admin');
        const startCr = parseInt(b.credits) || 0;
        if (startCr > 0 && !isMint(cu) && balanceOf(uid) < startCr) return json(res, 200, { ok: false, error: 'not enough credits for that starting balance' });
        const id = crypto.randomBytes(4).toString('hex'); const pw = mkPass(b.password);
        // staff / owner create top-level (or under a chosen parent); a reseller creates under itself
        const parent = P.staff ? (b.parent && db.accounts[b.parent] ? b.parent : null) : uid;
        db.accounts[id] = { id: id, username: un, salt: pw.salt, hash: pw.hash, name: (b.name || un).trim(), email: (b.email || '').trim(), credits: 0, parent: (staffType ? null : parent), enabled: true, api_enabled: false, type: type, created: now(), api_key: crypto.randomBytes(16).toString('hex') };
        save(db);
        if (startCr > 0 && !staffType) { if (isMint(cu)) { db.accounts[id].credits = startCr; db.ledger.push({ ts: now(), type: 'credit', from: uid, to: id, amount: startCr }); save(db); } else transfer(uid, id, startCr); }
        return json(res, 200, { ok: true, id: id });
      }
      // give / take credits
      if (a === 'transfer') { const to = db.accounts[b.id]; if (!to) return json(res, 200, { ok: false, error: 'unknown account' });
        if (isMint(cu)) { if (!canManageAccount(cu, b.id)) return json(res, 403, { error: 'not allowed' }); const amt = parseInt(b.amount) || 0; if (amt < 0 && (to.credits || 0) < -amt) return json(res, 200, { ok: false, error: 'account does not have that many credits' }); to.credits = (to.credits || 0) + amt; db.ledger.push({ ts: now(), type: 'credit', from: uid, to: b.id, amount: amt }); save(db); return json(res, 200, { ok: true }); }
        if (to.parent !== uid) return json(res, 403, { error: 'not your direct account' }); return json(res, 200, transfer(uid, b.id, b.amount)); }
      // reset password
      if (a === 'resetPass') { const t = db.accounts[b.id]; if (!t) return json(res, 200, { ok: false, error: 'unknown account' }); if (!canManageAccount(cu, b.id)) return json(res, 403, { error: 'not allowed' }); if (!b.password || b.password.length < 4) return json(res, 200, { ok: false, error: 'password too short (min 4)' }); const np = mkPass(b.password); t.salt = np.salt; t.hash = np.hash; save(db); return json(res, 200, { ok: true }); }
      // enable / disable
      if (a === 'toggleAccount') { const t = db.accounts[b.id]; if (!t) return json(res, 200, { ok: false, error: 'unknown' }); if (!canManageAccount(cu, b.id)) return json(res, 403, { error: 'not allowed' }); t.enabled = !(t.enabled !== false); save(db); return json(res, 200, { ok: true, enabled: t.enabled }); }
      // assign a role type (owner / super-admin, within what they may assign)
      if (a === 'setRole') { const P = permsOf(role); const t = db.accounts[b.id]; if (!t) return json(res, 200, { ok: false, error: 'unknown' }); if (!canManageAccount(cu, b.id)) return json(res, 403, { error: 'not allowed' }); if (P.assign.indexOf(b.type) < 0) return json(res, 200, { ok: false, error: 'you cannot assign that role' }); t.type = b.type; if (b.type === 'super_admin' || b.type === 'mini_admin') t.parent = null; save(db); return json(res, 200, { ok: true }); }
      // re-assign to a new parent
      if (a === 'reparent') { const t = db.accounts[b.id]; if (!t) return json(res, 200, { ok: false, error: 'unknown' }); if (!canManageAccount(cu, b.id)) return json(res, 403, { error: 'not allowed' }); const np = (b.parent === 'admin' || !b.parent) ? null : b.parent; if (np && !db.accounts[np]) return json(res, 200, { ok: false, error: 'unknown new parent' }); if (np === b.id) return json(res, 200, { ok: false, error: 'cannot parent to itself' }); if (np && isDesc(b.id, np)) return json(res, 200, { ok: false, error: 'cannot move under its own sub-account' }); t.parent = np; save(db); return json(res, 200, { ok: true }); }
      // delete an account (must have no children)
      if (a === 'deleteAccount') { const t = db.accounts[b.id]; if (!t) return json(res, 200, { ok: false, error: 'unknown' }); if (!canManageAccount(cu, b.id)) return json(res, 403, { error: 'not allowed' }); if (directChildren(b.id).length) return json(res, 200, { ok: false, error: 'move or remove its sub-accounts first' }); delete db.accounts[b.id]; save(db); return json(res, 200, { ok: true }); }

      // activate / renew a device (staff + owner activate free; resellers spend credits)
      if (a === 'activate') return json(res, 200, activate(uid, b.mac, b.app, b.plan, b.note, false, isMint(cu)));
      if (a === 'renew') return json(res, 200, activate(uid, b.mac, b.app, b.plan, b.note, true, isMint(cu)));
      // block / unblock / delete a device
      if (a === 'block' || a === 'unblock' || a === 'delete') { const mac = macKey(b.mac); if (!canTouchDevice(cu, mac)) return json(res, 403, { error: 'not your device' });
        if (a === 'delete') { delete db.devices[mac]; save(db); return json(res, 200, { ok: true }); }
        const d = db.devices[mac]; if (d) { d.status = (a === 'block') ? 'blocked' : 'active'; save(db); } return json(res, 200, { ok: !!d }); }
      // edit a device fully (plan / expiry / status / note) — for fixing mistakes
      if (a === 'editDevice') { const mac = macKey(b.mac); if (!canTouchDevice(cu, mac)) return json(res, 403, { error: 'not your device' }); const d = db.devices[mac]; if (!d) return json(res, 200, { ok: false, error: 'device not found' });
        if (b.plan) d.plan = b.plan;
        if (b.status === 'active' || b.status === 'blocked') d.status = b.status;
        if (b.note != null) d.note = String(b.note);
        if (b.expires === 'lifetime' || b.expires === null || b.expires === '') { d.expires = null; if (b.expires === 'lifetime') d.plan = 'lifetime'; }
        else if (b.expires) { const t = Date.parse(b.expires); if (!isNaN(t)) d.expires = t; }
        save(db); db.ledger.push({ ts: now(), type: 'edit', from: uid, mac: mac, note: 'manual edit' }); return json(res, 200, { ok: true }); }
      // MAC lookup (installed? + activation)
      if (a === 'checkMac') { const mac = macKey(b.mac); const s = db.seen[mac] || null; const d = db.devices[mac] || null; let dv = null;
        if (d) { const mine = role === 'admin' || isDesc(uid, d.activated_by); dv = { plan: d.plan, expires: d.expires, status: d.status, active: deviceActive(d), note: mine ? d.note : '', app: d.app, mine: mine }; }
        return json(res, 200, { ok: true, mac: mac, installed: !!s, seen: s ? { app: s.app, ver: s.ver || '', last: s.last, first: s.first, count: s.count || 0 } : null, device: dv }); }

      // edit a reseller/sub-reseller's details (admin, or a parent editing its own tree)
      if (a === 'editAccount') { const t = db.accounts[b.id]; if (!t) return json(res, 200, { ok: false, error: 'unknown account' }); if (!canManageAccount(cu, b.id)) return json(res, 403, { error: 'not allowed' });
        if (b.username != null) { const un = String(b.username).trim(); if (un.length < 3) return json(res, 200, { ok: false, error: 'username too short' }); if (!/^[a-zA-Z0-9_.-]+$/.test(un)) return json(res, 200, { ok: false, error: 'username: letters, numbers, . _ - only' }); if (un.toLowerCase() !== (t.username || '').toLowerCase() && usernameTaken(un)) return json(res, 200, { ok: false, error: 'username already taken' }); t.username = un; }
        if (b.name != null) t.name = String(b.name).trim() || t.name;
        if (b.email != null) t.email = String(b.email).trim();
        save(db); return json(res, 200, { ok: true }); }

      // apps registry (admin) — which apps you ship; drives Player Modes + Force Update
      if (a === 'addApp') { if (!adminOnly()) return json(res, 403, { error: 'admins only' }); const id = String(b.id || '').toLowerCase().replace(/[^a-z0-9]/g, ''); if (!id) return json(res, 200, { ok: false, error: 'bad app id' }); if (db.config.apps.some(function (x) { return x.id === id; })) return json(res, 200, { ok: false, error: 'app already exists' }); db.config.apps.push({ id: id, label: (b.label || id).trim() }); db.config.paid[id] = false; db.config.kill[id] = false; db.config.update[id] = { on: false, min: 0, latest: '', url: '', msg: '' }; save(db); return json(res, 200, { ok: true }); }
      if (a === 'removeApp') { if (!adminOnly()) return json(res, 403, { error: 'admins only' }); db.config.apps = db.config.apps.filter(function (x) { return x.id !== b.id; }); save(db); return json(res, 200, { ok: true }); }
      // 1-tap force-update: set the minimum to the newest version currently live (no typing)
      if (a === 'forceLatest') { if (!adminOnly()) return json(res, 403, { error: 'admins only' }); const ap = b.app; const latest = db.maxver[ap] || 0; if (!latest) return json(res, 200, { ok: false, error: 'no live version seen yet for this app' }); if (!db.config.update[ap]) db.config.update[ap] = {}; const cu = db.config.update[ap]; cu.on = true; cu.min = latest; if (b.url) cu.url = String(b.url).trim(); if (!cu.msg) cu.msg = 'A new version is available. Please update to continue.'; save(db); writeVersionJson(); return json(res, 200, { ok: true, min: latest }); }

      // force-update config (admin only)
      if (a === 'setUpdate') { if (!adminOnly()) return json(res, 403, { error: 'admins only' }); const ap = b.app; if (!db.config.update[ap]) db.config.update[ap] = {}; db.config.update[ap] = { on: !!b.on, min: parseInt(b.min) || 0, latest: (b.latest || '').trim(), url: (b.url || '').trim(), msg: (b.msg || '').trim() }; save(db); writeVersionJson(); return json(res, 200, { ok: true }); }
      // reseller automation API key (self, or admin regen for a child)
      if (a === 'apiKey') { if (b.id && b.id !== uid) { if (!canManageAccount(cu, b.id)) return json(res, 403, { error: 'not in your tree' }); if (b.regen) db.accounts[b.id].api_key = crypto.randomBytes(16).toString('hex'); save(db); return json(res, 200, { ok: true, key: db.accounts[b.id].api_key }); }
        if (uid === 'admin') { if (b.regen) db.admin.api_key = crypto.randomBytes(16).toString('hex'); save(db); return json(res, 200, { ok: true, key: db.admin.api_key }); }
        const me = db.accounts[uid]; if (me.api_enabled !== true) return json(res, 200, { ok: false, disabled: true, error: 'API access is turned off by your administrator' }); if (b.regen) me.api_key = crypto.randomBytes(16).toString('hex'); save(db); return json(res, 200, { ok: true, key: me.api_key }); }
      // admin turns a reseller's API access on/off
      if (a === 'toggleApi') { if (!adminOnly()) return json(res, 403, { error: 'admins only' }); const t = db.accounts[b.id]; if (!t) return json(res, 200, { ok: false, error: 'unknown' }); t.api_enabled = !(t.api_enabled === true); save(db); return json(res, 200, { ok: true, api_enabled: t.api_enabled }); }

      return json(res, 200, { error: 'unknown action' });
    } catch (e) { return json(res, 200, { error: String(e) }); }
  }

  if (p.endsWith('/version.json')) { res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' }); return res.end(JSON.stringify(buildVersionJson())); }
  if (p.endsWith('/forcepreview')) {
    const app = (u.searchParams.get('app') || 'windows').toLowerCase();
    const uc = (db.config.update && db.config.update[app]) || {};
    const msg = uc.msg || 'A new version of Zayron is available. Please update to continue.';
    const url = uc.url || db.config.downloads[app === 'android' ? 'android' : 'windows'] || 'https://zayron.tv';
    const latest = uc.latest ? (' (v' + uc.latest + ')') : '';
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(forcePreviewHtml(msg, url, latest, app));
  }
  if (p.endsWith('/panel') || p.endsWith('/login') || p.endsWith('/admin') || p.endsWith('/admin/')) { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(PANEL); }
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
.pager{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-top:12px;flex-wrap:wrap}
.pager .pinfo{font-size:12.5px;color:var(--muted)}
.pager .pbtns{display:flex;gap:6px;align-items:center}
.pager .pbtns button{padding:6px 12px;font-size:13px;border-radius:8px;background:#eef3f9;border:1px solid var(--line);color:#455872;font-weight:700}
.pager .pbtns button:disabled{opacity:.4;cursor:default}
.pager .pbtns .cur{background:var(--navy);color:#fff;border-color:var(--navy)}
.rbadge{font-size:9px;font-weight:800;padding:2px 7px;border-radius:20px;color:#fff;letter-spacing:.4px;text-transform:uppercase}
.rbadge.owner{background:#0e2a4f}.rbadge.super_admin{background:#7a5cff}.rbadge.mini_admin{background:#c9860a}.rbadge.reseller{background:var(--cyd)}.rbadge.sub_reseller{background:#94a3b8}
.lookup{background:#f9fbfe;border:1px dashed var(--line);border-radius:14px;padding:18px;margin-top:14px}
.lookup .k{color:var(--muted);font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.5px}.big{font-size:22px;font-weight:800}
.dl{display:grid;grid-template-columns:repeat(2,1fr);gap:16px}
.dlc{border:1px solid var(--line);border-radius:16px;padding:20px;text-align:center;background:#f9fbfe}
.dlc h4{margin:6px 0 4px;font-size:16px}.dlc .qr{width:150px;height:150px;margin:10px auto;border-radius:12px;background:#fff;border:1px solid var(--line)}
.dlc a.b{display:inline-block;margin-top:8px;padding:10px 18px;border-radius:10px;background:var(--cyan);color:#fff;font-weight:700;text-decoration:none;font-size:13.5px}
.treerow td:first-child{padding-left:10px}
.tnode{margin:4px 0}
.tbar{display:flex;align-items:center;gap:10px;padding:9px 12px;border:1px solid var(--line);border-radius:12px;background:#fff;cursor:grab;transition:.12s}
.tbar:hover{border-color:var(--cyan);box-shadow:0 6px 16px rgba(31,166,232,.12)}
.tbar.dragging{opacity:.4}.tbar.drop{border-color:var(--green);background:var(--greenbg);box-shadow:0 0 0 2px var(--green) inset}
.tbar .tav{width:32px;height:32px;border-radius:9px;background:linear-gradient(160deg,var(--navy),var(--cyd));color:#fff;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:13px;flex:none}
.tbar .tnm{font-weight:700;font-size:14px}.tbar .tmeta{font-size:11px;color:var(--muted)}
.tbar .tcr{margin-left:auto;font-weight:800;color:var(--navy);white-space:nowrap;font-size:13px}
.tbar .tacts{display:flex;gap:5px;flex-wrap:wrap}
.tkids{list-style:none;margin:0 0 0 26px;padding:0;border-left:2px dashed var(--line)}
.tdrop-top{border:1.5px dashed var(--cyan);border-radius:12px;padding:9px 12px;text-align:center;color:var(--cyd);font-weight:700;font-size:12.5px;margin-bottom:8px;background:#f5fbff}
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
  <div class="lgo"><img class="zlogo" alt="Zayron" style="width:100%;height:100%;object-fit:contain"></div><h2><b>Zayron</b> Panel</h2><p>Sign in to your account</p>
  <input id="lu" placeholder="Username" autocapitalize="none" autocomplete="username">
  <input id="lp" type="password" placeholder="Password" autocomplete="current-password" onkeydown="if(event.key==='Enter')login()">
  <button onclick="login()">Sign in</button><div id="lerr" class="err"></div>
</div></div>

<div id="shell" class="shell" style="display:none">
  <aside class="side">
    <div class="brand"><div class="lgo"><img class="zlogo" alt="Zayron" style="width:100%;height:100%;object-fit:contain"></div><div class="bt"><b>ZAYRON</b><span>PANEL</span></div></div>
    <span class="rolechip" id="rolechip">—</span>
    <nav id="nav">
      <div class="navi on" data-view="dash"><svg viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/></svg><span>Dashboard</span></div>
      <div class="navi" data-view="cust"><svg viewBox="0 0 24 24"><circle cx="9" cy="8" r="3.2"/><path d="M3.5 20c0-3.3 2.7-5 5.5-5s5.5 1.7 5.5 5"/><path d="M17 9.5a2.7 2.7 0 1 0-1-5.2M20.5 20c0-2.6-1.6-4.2-3.5-4.7"/></svg><span>Customers</span></div>
      <div class="navi" data-view="users"><svg viewBox="0 0 24 24"><rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="8" cy="12" r="2"/><path d="M13 10h5M13 14h5"/></svg><span>Users</span></div>
      <div class="navi" data-view="activate"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 8v8M8 12h8"/></svg><span>Activate</span></div>
      <div class="navi" data-view="check"><svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.2-3.2"/></svg><span>Check MAC</span></div>
      <div class="navi" data-view="res"><svg viewBox="0 0 24 24"><rect x="3" y="6" width="18" height="13" rx="2"/><path d="M3 10h18M8 3v3M16 3v3"/></svg><span id="resNav">Resellers</span></div>
      <div class="navi" data-view="modes"><svg viewBox="0 0 24 24"><rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="8" cy="12" r="2.4"/><path d="M14 10h4M14 14h4"/></svg><span>Player Modes</span></div>
      <div class="navi" data-view="forceupd"><svg viewBox="0 0 24 24"><path d="M21 12a9 9 0 1 1-2.6-6.3M21 4v5h-5"/></svg><span>Force Update</span></div>
      <div class="navi" data-view="api"><svg viewBox="0 0 24 24"><path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M8 21H5a2 2 0 0 1-2-2v-3M16 21h3a2 2 0 0 0 2-2v-3"/><circle cx="12" cy="12" r="2.5"/></svg><span>API</span></div>
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
          <div class="row" style="justify-content:space-between"><div><h3 style="margin:0">Customers</h3><div class="sub" style="margin:2px 0 0">Paying customers — every activated device, its plan and expiry.</div></div><button onclick="go('activate')">+ New activation</button></div>
          <div class="filters" style="margin-top:14px">
            <div class="chip on" data-f="all">All</div><div class="chip" data-f="active">Active</div><div class="chip" data-f="soon">Expires soon</div><div class="chip" data-f="expired">Expired</div><div class="chip" data-f="blocked">Blocked</div>
            <input id="q" class="grow" placeholder="Search MAC or note…" oninput="PAGE.cust=1;render()" style="min-width:180px"><button class="g" onclick="exportCsv()">Export CSV</button>
          </div>
          <table id="devs"></table>
          <div class="pager" id="pg_cust"></div>
        </div>
      </section>

      <section id="v-users" class="view" hidden>
        <div class="card">
          <div class="row" style="justify-content:space-between"><div><h3 style="margin:0">Users</h3><div class="sub" style="margin:2px 0 0">Every device that has ever opened the app — by app and by device. This is your real reach.</div></div></div>
          <div class="filters" style="margin-top:14px">
            <span id="ufChips"></span>
            <input id="uq" class="grow" placeholder="Search MAC or version…" oninput="PAGE.users=1;renderUsers()" style="min-width:180px">
          </div>
          <div id="uSummary" style="display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin:12px 0"></div>
          <table id="usersTab"></table>
          <div class="pager" id="pg_users"></div>
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
          <div class="row" style="justify-content:space-between"><div><h3 style="margin:0" id="resTitle">Resellers</h3><div class="sub" style="margin:2px 0 0" id="resSub">Drag any account onto another to move it. Top up credits, reset passwords, control API.</div></div><button onclick="openCreate()">+ Add account</button></div>
          <ul id="restree" style="list-style:none;margin:12px 0 0;padding:0;display:none"></ul>
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

      <section id="v-forceupd" class="view" hidden>
        <div class="card"><h3>Force update</h3><div class="sub">Force customers onto a minimum version, per app. When ON, any app older than the minimum version code is blocked on launch and shown your message + update link. <b>Takes effect once the updated apps (with this built in) are published.</b></div>
          <div id="fupd"></div>
          <div class="row" style="margin-top:14px"><button onclick="previewForce()" class="g">Preview what the customer sees</button><span id="fupdok" class="ok"></span></div>
        </div>
      </section>

      <section id="v-api" class="view" hidden>
        <div class="card"><h3>Automation API</h3><div class="sub">Use this to activate / renew / check devices from your own website, bot or billing panel. Keep your key secret — anyone with it can spend your credits.</div>
          <div class="row" style="margin:6px 0 4px"><label style="width:90px">Your API key</label><input id="apik" class="grow mono" readonly style="background:#f1f6fb"><button class="g" onclick="copyApi()">Copy</button><button class="g" onclick="regenApi()">Regenerate</button></div>
          <div id="apiExamples"></div>
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
var PAGE={cust:1,users:1,res:1},PER=25,UFILTER='all';
function isOwner(){return ROLE==='admin';}
function isStaff(){return !!(S.perms&&S.perms.staff);}
function canGlobal(){return !!(S.perms&&S.perms.global);}
function roleLabel(r){return {admin:'Owner',super_admin:'Super Admin',mini_admin:'Mini Admin',reseller:'Reseller',sub_reseller:'Sub-Reseller'}[r]||r;}
var LOGO="data:image/png;base64,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";
function $(id){return document.getElementById(id);}
function setLogos(){try{document.querySelectorAll('.zlogo').forEach(function(i){i.src=LOGO;});}catch(e){}}
setLogos();
function esc(s){return String(s==null?'':s).replace(/[&<>"]/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];});}
function tok(){try{return localStorage.getItem('zadm_tok')||'';}catch(e){return '';}}
function api(action,extra){return fetch('admin/act',{method:'POST',headers:{'Content-Type':'application/json','X-Auth':tok()},body:JSON.stringify(Object.assign({action:action},extra||{}))}).then(function(r){return r.json();});}
function enterShell(){$('login').style.display='none';$('shell').style.display='flex';}
function showLogin(){$('login').style.display='';$('shell').style.display='none';}
function login(){$('lerr').textContent='';fetch('admin/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:$('lu').value,password:$('lp').value})}).then(function(r){return r.json();}).then(function(d){if(d.ok){try{localStorage.setItem('zadm_tok',d.token||'');}catch(e){}enterShell();load();startAuto();}else $('lerr').textContent=d.error||'Wrong username or password';});}
function logout(){var t=tok();try{localStorage.removeItem('zadm_tok');}catch(e){}if(__auto){clearInterval(__auto);__auto=null;}fetch('admin/logout',{method:'POST',headers:{'X-Auth':t}}).then(function(){location.reload();}).catch(function(){location.reload();});}
function startAuto(){if(__auto)return;__auto=setInterval(function(){load();},30000);}
function load(){api('state').then(function(d){if(d.error){try{localStorage.removeItem('zadm_tok');}catch(e){}if(__auto){clearInterval(__auto);__auto=null;}showLogin();return;}S=d;ROLE=d.role;applyRole();render();});}
function applyRole(){
  $('rolechip').textContent=roleLabel(ROLE);
  var staff=isStaff(),owner=isOwner(),global=canGlobal();
  // nav visibility
  var vis={dash:true,cust:true,users:staff,activate:true,check:true,res:true,modes:global,forceupd:global,api:(owner||!staff),downloads:true,settings:true};
  document.querySelectorAll('.navi').forEach(function(n){var v=n.getAttribute('data-view');if(vis.hasOwnProperty(v))n.hidden=!vis[v];});
  $('resNav').textContent=staff?'Resellers':'My sub-resellers';
  $('resTitle').textContent=staff?'Resellers, staff & sub-accounts':'My sub-resellers';
  var rs=$('resSub');if(rs)rs.textContent=staff?'Drag any account onto another to move it. Top up credits, reset passwords, assign roles.':'Create sub-resellers under you, top up their credits, reset passwords.';
  // usage blocks: staff see them (global reach); resellers don't
  var usageBlocks=[['liveHead',1],['liveStats',1],['byappCard',1],['recentCard',1]];
  usageBlocks.forEach(function(x){var el=$(x[0]);if(el)el.style.display=staff?'':'none';});
  $('licHead').textContent=staff?'Licensing (paid)':'My customers';
  $('dlEdit').style.display=owner?'':'none';
  $('unRow').style.display=owner?'':'none';
}
$('nav').addEventListener('click',function(e){var n=e.target.closest('.navi');if(n&&!n.hidden)go(n.getAttribute('data-view'));});
document.querySelector('.filters').addEventListener('click',function(e){var c=e.target.closest('.chip[data-f]');if(!c)return;FILTER=c.getAttribute('data-f');PAGE.cust=1;document.querySelectorAll('.chip[data-f]').forEach(function(x){x.classList.toggle('on',x===c);});render();});
function go(view){document.querySelectorAll('.navi').forEach(function(n){n.classList.toggle('on',n.getAttribute('data-view')===view);});document.querySelectorAll('.view').forEach(function(s){s.hidden=(s.id!=='v-'+view);});
  var t={dash:'Dashboard',cust:'Customers',users:'Users',activate:'Activate a device',check:'Check MAC',res:(isStaff()?'Resellers & staff':'My sub-resellers'),modes:'Player modes',forceupd:'Force update',api:'Automation API',downloads:'Download apps',settings:'Settings'};$('ptitle').textContent=t[view]||'Dashboard';}
var PLANLBL={'1y':'1 Year',lifetime:'Lifetime',trial:'Trial',free:'Free'};
function planLabel(p){return PLANLBL[p]||p;}
// reusable pagination: returns the slice for the current page and renders the pager bar
function paginate(arr,key,pgId){
  var total=arr.length,pages=Math.max(1,Math.ceil(total/PER));
  if(PAGE[key]>pages)PAGE[key]=pages; if(PAGE[key]<1)PAGE[key]=1;
  var start=(PAGE[key]-1)*PER, slice=arr.slice(start,start+PER);
  var el=$(pgId); if(el){
    if(total<=PER){el.innerHTML='';}
    else{
      var nums='';var from=Math.max(1,PAGE[key]-2),to=Math.min(pages,from+4);from=Math.max(1,to-4);
      for(var i=from;i<=to;i++)nums+='<button class="'+(i===PAGE[key]?'cur':'')+'" data-pg="'+key+'" data-pn="'+i+'">'+i+'</button>';
      el.innerHTML='<div class="pinfo">Showing '+(start+1)+'–'+(start+slice.length)+' of '+total+'</div>'+
        '<div class="pbtns"><button data-pg="'+key+'" data-pn="'+(PAGE[key]-1)+'" '+(PAGE[key]<=1?'disabled':'')+'>‹ Prev</button>'+nums+'<button data-pg="'+key+'" data-pn="'+(PAGE[key]+1)+'" '+(PAGE[key]>=pages?'disabled':'')+'>Next ›</button></div>';
    }
  }
  return slice;
}
document.addEventListener('click',function(e){var b=e.target.closest('button[data-pg]');if(!b)return;PAGE[b.getAttribute('data-pg')]=parseInt(b.getAttribute('data-pn'))||1;render();});
document.addEventListener('click',function(e){var c=e.target.closest('[data-uf]');if(!c)return;UFILTER=c.getAttribute('data-uf');PAGE.users=1;renderUsers();});

function expOf(d){return (d.plan==='lifetime'||d.expires==null)?null:d.expires;}
function classify(d){if(d.status==='blocked')return 'blocked';var e=expOf(d);if(e==null)return 'active';if(e<=Date.now())return 'expired';if(e-Date.now()<=SOON)return 'soon';return 'active';}
function fmt(ts){if(ts==null)return 'Lifetime';var x=new Date(ts);return x.getFullYear()+'-'+String(x.getMonth()+1).padStart(2,'0')+'-'+String(x.getDate()).padStart(2,'0');}
function daysLeft(ts){if(ts==null)return '∞';var d=Math.ceil((ts-Date.now())/86400000);return d+' d';}
function timeAgo(ts){if(!ts)return '—';var s=Math.floor((Date.now()-ts)/1000);if(s<60)return 'just now';var m=Math.floor(s/60);if(m<60)return m+'m ago';var h=Math.floor(m/60);if(h<24)return h+'h ago';return Math.floor(h/24)+'d ago';}
var APPMETA={windows:{label:'Windows',color:'#1fa6e8'},android:{label:'Android',color:'#12a150'},ios:{label:'iOS',color:'#7a5cff'},other:{label:'Other',color:'#94a3b8'},any:{label:'Any',color:'#94a3b8'}};
function am(a){return APPMETA[(a==='windows'||a==='android'||a==='ios')?a:'other'];}

function render(){
  $('credtot').textContent=isStaff()?'∞':((S.me&&S.me.credits)||0);
  if(isStaff())renderUsage();
  renderLicensing();
  renderDevices();
  if(isStaff())renderUsers();
  renderResellers();
  renderModes();
  renderForce();
  renderApi();
  renderDownloads();
  renderSettings();
}
function renderUsers(){
  var seen=S.allseen||{};var keys=Object.keys(seen);
  // filter chips (build once per render)
  var uq=($('uq').value||'').toUpperCase();
  var list=keys.filter(function(m){var s=seen[m];var a=(s.app==='windows'||s.app==='android'||s.app==='ios')?s.app:'other';
    if(UFILTER!=='all'&&a!==UFILTER)return false;
    if(uq&&m.indexOf(uq)<0&&String(s.ver||'').toUpperCase().indexOf(uq)<0)return false;return true;})
    .sort(function(a,b){return (seen[b].last||0)-(seen[a].last||0);});
  // summary tiles by app
  var by={windows:0,android:0,ios:0,other:0};keys.forEach(function(m){var s=seen[m];var a=(s.app==='windows'||s.app==='android'||s.app==='ios')?s.app:'other';by[a]++;});
  var tiles='';['windows','android','ios','other'].forEach(function(k){var meta=APPMETA[k];tiles+='<div class="stat" style="padding:12px 14px"><div class="lbl" style="font-size:11px"><span class="ci" style="width:26px;height:26px;background:'+meta.color+'22;color:'+meta.color+'"></span>'+meta.label+'</div><div class="num" style="font-size:22px">'+by[k]+'</div></div>';});
  $('uSummary').innerHTML=tiles;
  var chips='<span class="chip'+(UFILTER==='all'?' on':'')+'" data-uf="all">All apps</span>';
  ['windows','android','ios','other'].forEach(function(k){if(by[k]||k==='windows'||k==='android')chips+='<span class="chip'+(UFILTER===k?' on':'')+'" data-uf="'+k+'">'+APPMETA[k].label+' ('+by[k]+')</span>';});
  $('ufChips').innerHTML=chips;
  var slice=paginate(list,'users','pg_users');
  var t='<tr><th>MAC (device)</th><th>App</th><th>Version</th><th>First seen</th><th>Last seen</th><th>Check-ins</th></tr>';
  if(!list.length)t+='<tr><td colspan="6" class="empty">No app users yet — installs appear here the moment they open the app.</td></tr>';
  slice.forEach(function(m){var s=seen[m];var meta=am(s.app);
    t+='<tr><td class="mono">'+esc(m)+'</td><td><span style="color:'+meta.color+';font-weight:700">'+meta.label+'</span></td><td>'+esc(s.ver||'—')+'</td><td>'+(s.first?fmt(s.first):'—')+'</td><td>'+timeAgo(s.last)+'</td><td>'+(s.count||0)+'</td></tr>';});
  $('usersTab').innerHTML=t;
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
  var byCol=isStaff()?'<th>By</th>':'';
  var t='<tr><th>MAC</th><th>Note</th><th>App</th><th>Plan</th><th>Expiry</th><th>Left</th>'+byCol+'<th>Status</th><th></th></tr>';
  if(!list.length)t+='<tr><td colspan="9" class="empty">No devices match this filter.</td></tr>';
  var slice=paginate(list,'cust','pg_cust');
  slice.forEach(function(m){var d=devs[m],cl=classify(d),e=expOf(d);
    var tag=cl==='active'?'<span class="tag on">Active</span>':cl==='soon'?'<span class="tag soon">Expires soon</span>':cl==='expired'?'<span class="tag off">Expired</span>':'<span class="tag off">Blocked</span>';
    var plan=d.plan==='lifetime'?'<span class="tag life">Lifetime</span>':'<span class="tag" style="background:#eef3f9;color:#455872">'+esc(planLabel(d.plan))+'</span>';
    var byCell=isStaff()?('<td>'+esc(d.activated_by==='admin'?'Owner':((S.accounts[d.activated_by]&&S.accounts[d.activated_by].name)||d.activated_by))+'</td>'):'';
    var actbtn=d.status==='blocked'?'<button class="g sm" data-act="unblock" data-mac="'+m+'">Unblock</button>':'<button class="g sm" data-act="block" data-mac="'+m+'">Block</button>';
    t+='<tr><td class="mono">'+m+'</td><td>'+esc(d.note||'—')+'</td><td>'+esc(d.app)+'</td><td>'+plan+'</td><td>'+fmt(e)+'</td><td>'+(cl==='expired'?'—':daysLeft(e))+'</td>'+byCell+'<td>'+tag+'</td><td style="white-space:nowrap"><button class="sm" data-edit="'+m+'">Edit</button> <button class="sm" data-renew="'+m+'">Renew</button> '+actbtn+' <button class="d sm" data-act="delete" data-mac="'+m+'">Del</button></td></tr>';});
  $('devs').innerHTML=t;
}
function renderResellers(){
  if(isStaff()){ $('restab').style.display='none'; $('restree').style.display=''; renderResTree(); return; }
  $('restree').style.display='none'; $('restab').style.display='';
  var accs=S.accounts||{},ids=Object.keys(accs);
  var roots=ids.filter(function(id){var p=accs[id].parent;return !p||!accs[p];});
  var out=[];function walk(id,depth){out.push({id:id,depth:depth});ids.filter(function(x){return accs[x].parent===id;}).sort(byName).forEach(function(c){walk(c,depth+1);});}
  function byName(a,b){return (accs[a].name||'').localeCompare(accs[b].name||'');}
  roots.sort(byName).forEach(function(r){walk(r,0);});
  var th='<tr><th>Account</th><th>Username</th><th>Credits</th><th>Status</th><th>Actions</th></tr>';
  var t=th;
  if(!out.length)t+='<tr><td colspan="5" class="empty">No sub-resellers yet. Tap “Add account”.</td></tr>';
  out.forEach(function(n){var a=accs[n.id];var pad=n.depth*18;
    var name='<span style="padding-left:'+pad+'px">'+(n.depth>0?'<span style="color:var(--muted)">↳ </span>':'')+'<b>'+esc(a.name)+'</b>'+(a.children?' <span class="sub" style="margin:0">('+a.children+')</span>':'')+'</span>';
    t+='<tr class="treerow"><td>'+name+'</td><td class="mono">'+esc(a.username)+'</td><td><b>'+(a.credits||0)+'</b></td>'+
      '<td><button class="'+(a.enabled?'g':'d')+' sm" data-tacc="'+n.id+'">'+(a.enabled?'Enabled':'Disabled')+'</button></td>'+
      '<td style="white-space:nowrap"><button class="g sm" data-editacc="'+n.id+'">Edit</button> <button class="sm" data-topup="'+n.id+'">Credits</button> <button class="g sm" data-reset="'+n.id+'">Password</button></td></tr>';});
  $('restab').innerHTML=t;
}
function openEditAccount(id){var a=(S.accounts||{})[id]||{};modal(
  '<h3>Edit account</h3><div class="sub">Change this account\\'s details.</div>'+
  '<div class="f"><label>Display name</label><input id="ea_name" value="'+esc(a.name||'')+'"></div>'+
  '<div class="f"><label>Username</label><input id="ea_user" value="'+esc(a.username||'')+'" autocapitalize="none"></div>'+
  '<div class="f"><label>Email</label><input id="ea_email" value="'+esc(a.email||'')+'"></div>'+
  '<div class="merr" id="m_err"></div><div class="foot"><button class="g" onclick="closeModal()">Cancel</button><button onclick="submitEditAccount(\\''+id+'\\')">Save</button></div>');}
function submitEditAccount(id){api('editAccount',{id:id,name:$('ea_name').value,username:$('ea_user').value,email:$('ea_email').value}).then(function(d){if(d.ok){closeModal();load();}else $('m_err').textContent=d.error||'error';});}
// ADMIN ONLY — full drag-and-drop tree. Drop an account onto another to move it (uses the reparent action).
function acInit(nm){return String(nm||'?').split(' ').map(function(w){return w[0]||'';}).join('').slice(0,2).toUpperCase();}
function renderResTree(){
  var accs=S.accounts||{},ids=Object.keys(accs);
  function kids(pid){return ids.filter(function(id){return (accs[id].parent||null)===pid;}).sort(function(a,b){return (accs[a].name||'').localeCompare(accs[b].name||'');});}
  var canAssign=(S.perms&&S.perms.assign&&S.perms.assign.length>0);
  var isStaffType=function(t){return t==='super_admin'||t==='mini_admin';};
  function node(id){var a=accs[id];var ck=kids(id);var typ=a.type||'reseller';
    var isCredit=!isStaffType(typ);
    var apiOwner=isOwner();
    var h='<li class="tnode"><div class="tbar" draggable="true" data-id="'+id+'">'+
      '<span class="tav">'+esc(acInit(a.name))+'</span>'+
      '<span><span class="tnm">'+esc(a.name)+' <span class="rbadge '+typ+'">'+roleLabel(typ)+'</span></span><div class="tmeta">@'+esc(a.username)+(ck.length?(' · '+ck.length+' sub'):'')+(a.enabled?'':' · <span style="color:var(--red)">disabled</span>')+'</div></span>'+
      '<span class="tcr">'+(isCredit?((a.credits||0)+' cr'):'staff')+'</span>'+
      '<span class="tacts">'+
        '<button class="g sm" data-editacc="'+id+'">Edit</button>'+
        (isCredit?'<button class="sm" data-topup="'+id+'">Credits</button>':'')+
        '<button class="g sm" data-reset="'+id+'">Pass</button>'+
        (canAssign?'<button class="g sm" data-setrole="'+id+'">Role</button>':'')+
        (apiOwner&&isCredit?'<button class="'+(a.api_enabled?'':'g')+' sm" style="'+(a.api_enabled?'background:var(--violet)':'')+'" data-tapi="'+id+'">API '+(a.api_enabled?'ON':'off')+'</button>':'')+
        '<button class="'+(a.enabled?'g':'d')+' sm" data-tacc="'+id+'">'+(a.enabled?'On':'Off')+'</button>'+
        (a.children?'':'<button class="d sm" data-delacc="'+id+'">Del</button>')+
      '</span></div>';
    if(ck.length){h+='<ul class="tkids">'+ck.map(node).join('')+'</ul>';}
    return h+'</li>';}
  var roots=ids.filter(function(id){return !accs[id].parent||!accs[accs[id].parent];}).sort(function(a,b){return (accs[a].name||'').localeCompare(accs[b].name||'');});
  var html='<div class="tdrop-top" data-droptop="1">⇧ Drop here to make an account top-level (Master)</div>';
  html+= roots.length?roots.map(node).join(''):'<div class="empty">No accounts yet. Tap “Add account”.</div>';
  $('restree').innerHTML=html;
  bindResTreeDnD();
}
var __dragId=null;
function isDescId(anc,id){var cur=id,g=0;var accs=S.accounts||{};while(cur&&g++<200){if(cur===anc)return true;cur=accs[cur]?accs[cur].parent:null;}return false;}
function bindResTreeDnD(){
  var bars=document.querySelectorAll('#restree .tbar');
  bars.forEach(function(bar){
    bar.addEventListener('dragstart',function(e){__dragId=bar.getAttribute('data-id');bar.classList.add('dragging');try{e.dataTransfer.effectAllowed='move';e.dataTransfer.setData('text','x');}catch(_){}});
    bar.addEventListener('dragend',function(){bar.classList.remove('dragging');document.querySelectorAll('#restree .drop').forEach(function(b){b.classList.remove('drop');});});
    bar.addEventListener('dragover',function(e){e.preventDefault();if(bar.getAttribute('data-id')!==__dragId)bar.classList.add('drop');});
    bar.addEventListener('dragleave',function(){bar.classList.remove('drop');});
    bar.addEventListener('drop',function(e){e.preventDefault();bar.classList.remove('drop');resMove(__dragId,bar.getAttribute('data-id'));});
  });
  var top=document.querySelector('#restree [data-droptop]');
  if(top){top.addEventListener('dragover',function(e){e.preventDefault();top.style.background='var(--greenbg)';});
    top.addEventListener('dragleave',function(){top.style.background='';});
    top.addEventListener('drop',function(e){e.preventDefault();top.style.background='';resMove(__dragId,'admin');});}
}
function resMove(id,target){ if(!id||id===target)return;
  if(target!=='admin'&&isDescId(id,target)){toast('Can’t move an account under its own sub-account');return;}
  api('reparent',{id:id,parent:target}).then(function(d){if(d.ok)load();else toast(d.error||'move failed');});
}
function appList(){return (S.config&&S.config.apps)||[{id:'windows',label:'Windows'},{id:'android',label:'Android'}];}
function renderModes(){
  if(ROLE!=='admin')return;var c=S.config;if(!c||!c.paid)return;var h='';
  appList().forEach(function(ap){var a=ap.id;h+='<div style="border:1px solid var(--line);border-radius:14px;padding:16px;background:#f9fbfe;position:relative"><h4 style="margin:0 0 12px;font-size:14px">'+esc(ap.label)+' <button class="g sm" style="position:absolute;right:12px;top:12px;padding:3px 8px" data-rmapp="'+a+'" title="Remove app">✕</button></h4>'+
    '<div style="display:flex;align-items:center;justify-content:space-between;margin:9px 0"><span class="sub" style="margin:0">Billing</span><button class="sm" style="min-width:80px;background:'+(c.paid[a]?'var(--cyan)':'#eef3f9')+';color:'+(c.paid[a]?'#fff':'#455872')+'" data-tog="paid" data-app="'+a+'">'+(c.paid[a]?'PAID':'FREE')+'</button></div>'+
    '<div style="display:flex;align-items:center;justify-content:space-between;margin:9px 0"><span class="sub" style="margin:0">Availability</span><button class="sm" style="min-width:80px;background:'+(c.kill[a]?'var(--red)':'var(--greenbg)')+';color:'+(c.kill[a]?'#fff':'var(--green)')+'" data-tog="kill" data-app="'+a+'">'+(c.kill[a]?'KILLED':'LIVE')+'</button></div></div>';});
  h+='<div style="border:1.5px dashed var(--line);border-radius:14px;padding:16px;display:flex;flex-direction:column;gap:8px;justify-content:center"><div class="sub" style="margin:0">Add an app you ship</div><input id="newAppLabel" placeholder="Name e.g. Fire TV" style="width:100%"><button class="sm" onclick="addApp()">+ Add app</button></div>';
  $('modes').innerHTML=h;$('trial').value=c.trial_days||0;$('contact').value=c.contact||'';
}
function addApp(){var label=($('newAppLabel').value||'').trim();if(!label)return;var id=label.toLowerCase().replace(/[^a-z0-9]/g,'');api('addApp',{id:id,label:label}).then(function(d){if(d.ok)load();else toast(d.error||'error');});}
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
  if(b.dataset.edit){openEdit(b.dataset.edit);return;}
  if(b.dataset.actmac){$('amac').value=b.dataset.actmac;go('activate');return;}
  if(b.dataset.topup){openTopup(b.dataset.topup);return;}
  if(b.dataset.reset){openReset(b.dataset.reset);return;}
  if(b.dataset.tacc){api('toggleAccount',{id:b.dataset.tacc}).then(load);return;}
  if(b.dataset.reparent){openReparent(b.dataset.reparent);return;}
  if(b.dataset.delacc){if(confirm('Delete this account?'))api('deleteAccount',{id:b.dataset.delacc}).then(load);return;}
  if(b.dataset.fon){toggleForce(b.dataset.fon);return;}
  if(b.dataset.fsave){saveForce(b.dataset.fsave);return;}
  if(b.dataset.flatest){if(confirm('Force EVERY user of this app onto the newest version now?'))forceLatest(b.dataset.flatest);return;}
  if(b.dataset.rmapp){if(confirm('Remove this app from the panel?'))api('removeApp',{id:b.dataset.rmapp}).then(load);return;}
  if(b.dataset.tapi){api('toggleApi',{id:b.dataset.tapi}).then(load);return;}
  if(b.dataset.editacc){openEditAccount(b.dataset.editacc);return;}
  if(b.dataset.setrole){openSetRole(b.dataset.setrole);return;}
});
function roleOptions(sel){var opts=(S.perms&&S.perms.assign)||['reseller'];var h='';opts.forEach(function(t){h+='<option value="'+t+'"'+(t===sel?' selected':'')+'>'+roleLabel(t)+'</option>';});return h;}
function openSetRole(id){var a=(S.accounts||{})[id]||{};modal(
  '<h3>Assign role — '+esc(a.name||'')+'</h3><div class="sub">This sets what this account can do and which dashboard they see.</div>'+
  '<div class="f"><label>Role</label><select id="sr_type">'+roleOptions(a.type||'reseller')+'</select></div>'+
  '<div class="merr" id="m_err"></div><div class="foot"><button class="g" onclick="closeModal()">Cancel</button><button onclick="submitSetRole(\\''+id+'\\')">Apply</button></div>');}
function submitSetRole(id){api('setRole',{id:id,type:$('sr_type').value}).then(function(d){if(d.ok){closeModal();load();}else $('m_err').textContent=d.error||'error';});}

/* modals */
function modal(html){$('modal').innerHTML=html;$('modalbg').classList.add('on');}
function closeModal(){$('modalbg').classList.remove('on');}
$('modalbg').addEventListener('click',function(e){if(e.target===$('modalbg'))closeModal();});
function openCreate(){var staff=isStaff();var roleField=staff?('<div class="f"><label>Role</label><select id="m_type">'+roleOptions('reseller')+'</select></div>'):'';modal(
  '<h3>'+(staff?'Add account':'Add sub-reseller')+'</h3><div class="sub">They will log in with this username &amp; password.</div>'+
  '<div class="f"><label>Display name</label><input id="m_name" placeholder="e.g. Ali Traders"></div>'+
  '<div class="f"><label>Username</label><input id="m_user" placeholder="login username" autocapitalize="none"></div>'+
  '<div class="f"><label>Password</label><input id="m_pass" placeholder="min 4 characters"></div>'+
  '<div class="f"><label>Email (optional)</label><input id="m_email" placeholder="email@example.com"></div>'+
  roleField+
  '<div class="f"><label>Starting credits (optional)</label><input id="m_cred" type="number" placeholder="0"></div>'+
  '<div class="merr" id="m_err"></div><div class="foot"><button class="g" onclick="closeModal()">Cancel</button><button onclick="submitCreate()">Create</button></div>');}
function submitCreate(){var type=$('m_type')?$('m_type').value:'';api('createAccount',{name:$('m_name').value,username:$('m_user').value,password:$('m_pass').value,email:$('m_email').value,credits:$('m_cred').value,type:type}).then(function(d){if(d.ok){closeModal();load();}else $('m_err').textContent=d.error||'error';});}
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

function openEdit(mac){var d=S.devices[mac]||{};var exp=(d.expires?new Date(d.expires).toISOString().slice(0,10):'');
  modal('<h3>Edit device</h3><div class="sub">'+esc(mac)+' — fix a plan or expiry.</div>'+
  '<div class="f"><label>Plan</label><select id="e_plan"><option value="1y">1 Year</option><option value="lifetime">Lifetime</option><option value="trial">Trial</option></select></div>'+
  '<div class="f"><label>Expiry date (leave blank = Lifetime / no expiry)</label><input id="e_exp" type="date" value="'+exp+'"></div>'+
  '<div class="f"><label>Status</label><select id="e_status"><option value="active">Active</option><option value="blocked">Blocked</option></select></div>'+
  '<div class="f"><label>Note</label><input id="e_note" value="'+esc(d.note||'')+'"></div>'+
  '<div class="merr" id="m_err"></div><div class="foot"><button class="g" onclick="closeModal()">Cancel</button><button onclick="submitEdit(\\''+mac+'\\')">Save changes</button></div>');
  setTimeout(function(){$('e_plan').value=d.plan||'1y';$('e_status').value=d.status||'active';},0);}
function submitEdit(mac){var exp=$('e_exp').value;var plan=$('e_plan').value;var payload={mac:mac,plan:plan,status:$('e_status').value,note:$('e_note').value,expires:(plan==='lifetime'?'lifetime':(exp||''))};
  api('editDevice',payload).then(function(d){if(d.ok){closeModal();load();}else $('m_err').textContent=d.error||'error';});}

function renderForce(){if(ROLE!=='admin')return;var upd=(S.config&&S.config.update)||{};var mv=(S.maxver)||{};var h='';
  appList().forEach(function(ap){var a=ap.id;var u=upd[a]||{};var latest=mv[a]||0;
    h+='<div style="border:1px solid var(--line);border-radius:14px;padding:16px;background:#f9fbfe;margin-bottom:12px">'+
    '<div class="row" style="justify-content:space-between"><h4 style="margin:0;font-size:15px">'+esc(ap.label)+' <span class="sub" style="margin:0;font-weight:600">'+(latest?('newest live: v-code '+latest):'no live version seen yet')+'</span></h4>'+
    '<button class="sm" style="min-width:88px;background:'+(u.on?'var(--green)':'#eef3f9')+';color:'+(u.on?'#fff':'#455872')+'" data-fon="'+a+'">'+(u.on?'FORCED ON':'OFF')+'</button></div>'+
    '<div class="row" style="margin-top:12px"><button style="background:var(--navy)" data-flatest="'+a+'">⚡ Force everyone to the newest version</button><span class="sub" style="margin:0">one tap — no typing</span><span class="ok" id="fu_ok_'+a+'"></span></div>'+
    '<div class="sub" style="margin:12px 0 4px">Or set it manually:</div>'+
    '<div class="row" style="margin-top:2px"><label style="width:130px">Minimum version code</label><input id="fu_min_'+a+'" type="number" value="'+(u.min||0)+'" style="width:110px"><span class="sub" style="margin:0">apps older than this are blocked</span></div>'+
    '<div class="row" style="margin-top:8px"><label style="width:130px">Update link</label><input id="fu_url_'+a+'" class="grow" value="'+esc(u.url||'')+'" placeholder="direct .apk / .exe for auto-install"></div>'+
    '<div class="row" style="margin-top:8px"><label style="width:130px">Message</label><input id="fu_msg_'+a+'" class="grow" value="'+esc(u.msg||'')+'" placeholder="A new version is available. Please update."></div>'+
    '<div class="row" style="margin-top:10px"><button class="sm" data-fsave="'+a+'">Save</button></div></div>';});
  $('fupd').innerHTML=h;}
function saveForce(a){var u=(S.config.update&&S.config.update[a])||{};api('setUpdate',{app:a,on:!!u.on,min:$('fu_min_'+a).value,latest:u.latest||'',url:$('fu_url_'+a).value,msg:$('fu_msg_'+a).value}).then(function(){toast('Saved');load();});}
function toggleForce(a){var u=(S.config.update&&S.config.update[a])||{};api('setUpdate',{app:a,on:!u.on,min:$('fu_min_'+a).value,latest:u.latest||'',url:$('fu_url_'+a).value,msg:$('fu_msg_'+a).value}).then(load);}
function forceLatest(a){var dl=(S.config&&S.config.downloads)||{};var url=(a==='android')?dl.android:(a==='windows')?dl.windows:'';api('forceLatest',{app:a,url:url}).then(function(d){if(d.ok){toast('Forcing everyone to version-code '+d.min);load();}else toast(d.error||'error');});}
function previewForce(){window.open('https://zayron.tv/act/forcepreview','_blank');}

function renderApi(){
  if(isStaff()&&!isOwner())return;   // staff (super/mini admin) don't use the automation API
  if(!isStaff()&&S.me&&S.me.api_enabled!==true){$('apik').value='';$('apik').placeholder='API access is turned off by your administrator';$('apiExamples').innerHTML='<div class="lookup" style="margin-top:12px">Your administrator has not enabled API access for your account. Ask them to turn it on if you want to automate activations.</div>';var rg=document.querySelector('#v-api button[onclick="regenApi()"]');if(rg)rg.style.display='none';return;}
  var rg2=document.querySelector('#v-api button[onclick="regenApi()"]');if(rg2)rg2.style.display='';
  if($('apik').value)return;   // fetch the key once
  api('apiKey',{}).then(function(d){if(d.ok){$('apik').value=d.key;$('apiExamples').innerHTML=apiDocs(d.key);}else if(d.disabled){$('apik').placeholder=d.error;$('apiExamples').innerHTML='<div class="lookup" style="margin-top:12px">'+esc(d.error)+'</div>';}});}
function apiDocs(key){var base='https://zayron.tv/act/api/v1';
  function box(title,cmd){return '<div style="margin-top:14px"><div class="sub" style="margin:0 0 5px;font-weight:700">'+title+'</div><pre style="background:#0e1a30;color:#cfe6f5;padding:12px 14px;border-radius:10px;overflow:auto;font-size:12px;margin:0">'+esc(cmd)+'</pre></div>';}
  return '<div class="sub" style="margin-top:10px">Base URL: <b class="mono">'+base+'</b> · send your key as header <b class="mono">X-API-Key</b> (or <b class="mono">?key=</b>).</div>'+
    box('Check your credit balance','curl -H "X-API-Key: '+key+'" '+base+'/balance')+
    box('Activate a device (1 credit = 1 year, 2 = lifetime)','curl -X POST -H "X-API-Key: '+key+'" -H "Content-Type: application/json" \\\\\\n  -d \\'{"mac":"C3:6E:74:61:7B:13","app":"windows","plan":"1y","note":"Customer name"}\\' \\\\\\n  '+base+'/activate')+
    box('Renew / extend a device','curl -X POST -H "X-API-Key: '+key+'" -H "Content-Type: application/json" -d \\'{"mac":"C3:6E:74:61:7B:13","plan":"lifetime"}\\' '+base+'/renew')+
    box('Check one device','curl -H "X-API-Key: '+key+'" "'+base+'/check?mac=C36E74617B13"')+
    box('List all my devices','curl -H "X-API-Key: '+key+'" '+base+'/devices');}
function copyApi(){var t=$('apik').value;try{navigator.clipboard.writeText(t);toast('API key copied');}catch(e){}}
function regenApi(){if(!confirm('Regenerate your API key? The old key stops working immediately.'))return;api('apiKey',{regen:true}).then(function(d){if(d.ok){$('apik').value=d.key;$('apiExamples').innerHTML=apiDocs(d.key);toast('New key generated');}});}
function toast(m){var t=document.createElement('div');t.textContent=m;t.style.cssText='position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:#0e2a4f;color:#fff;padding:11px 18px;border-radius:10px;font-weight:700;z-index:99;box-shadow:0 10px 30px rgba(0,0,0,.3)';document.body.appendChild(t);setTimeout(function(){t.remove();},1600);}

function act(){api('activate',{mac:$('amac').value,app:$('aapp').value,plan:$('aplan').value,note:$('anote').value}).then(function(d){if(d.ok){$('aerr').innerHTML='<span class="ok">Activated ✓</span>';$('amac').value='';$('anote').value='';load();}else $('aerr').innerHTML='<span style="color:var(--red)">Error: '+esc(d.error||'failed')+'</span>';});}
function checkMac(){var raw=($('cmac').value||'');if(!raw.trim()){$('cres').innerHTML='';return;}
  api('checkMac',{mac:raw}).then(function(d){var m=d.mac||raw;
    var inst=d.installed?'<span class="ok">Installed</span>':'<span style="color:var(--red);font-weight:700">Not installed</span>';
    var seen=d.seen?('App: <b>'+esc(am(d.seen.app).label)+'</b> · Version: <b>'+esc(d.seen.ver||'—')+'</b> · Last seen: <b>'+timeAgo(d.seen.last)+'</b> · Check-ins: <b>'+(d.seen.count||0)+'</b>'):'This device has never opened the app.';
    var act,btn='';
    if(d.device){var cl=d.device.active?'var(--green)':'var(--red)';act='<div style="margin-top:10px">Activation: <b style="color:'+cl+'">'+(d.device.active?'ACTIVE':(d.device.status==='blocked'?'BLOCKED':'EXPIRED'))+'</b> · Plan: <b>'+esc(planLabel(d.device.plan))+'</b> · Expiry: <b>'+(d.device.expires?fmt(d.device.expires):'Lifetime')+'</b></div>';
      btn='<div style="margin-top:14px"><button data-renew="'+esc(m)+'">Renew / change plan</button></div>';}
    else {act='<div style="margin-top:10px">Activation: <b style="color:var(--muted)">not activated</b> (in Paid mode this device would be blocked).</div>';
      if(d.installed)btn='<div style="margin-top:14px"><button data-actmac="'+esc(m)+'">Activate this device</button></div>';}
    $('cres').innerHTML='<div class="lookup"><div class="k">'+esc(m)+'</div><div class="big" style="margin:6px 0">'+inst+'</div><div class="note" style="margin:0">'+seen+'</div>'+act+btn+'</div>';});}
function saveCfg(){var c=S.config;c.trial_days=parseInt($('trial').value)||0;c.contact=$('contact').value;api('setConfig',{config:c}).then(function(){$('cfgok').textContent='Saved ✓';setTimeout(function(){$('cfgok').textContent='';},1600);load();});}
function saveDl(){api('setDownloads',{windows:$('dlw').value,android:$('dla').value}).then(function(){$('dlok').textContent='Saved ✓';setTimeout(function(){$('dlok').textContent='';},1600);load();});}
function changeMyPass(){api('changeMyPass',{username:$('setUn').value,oldpass:$('setOld').value,newpass:$('setNew').value}).then(function(d){$('setok').innerHTML=d.ok?'<span class="ok">Updated ✓</span>':'<span style="color:var(--red)">'+esc(d.error||'error')+'</span>';if(d.ok){$('setOld').value='';$('setNew').value='';}});}
function exportCsv(){var devs=S.devices||{},rows=[['MAC','Note','App','Plan','Expiry','Status','By']];
  Object.keys(devs).forEach(function(m){var d=devs[m];rows.push([m,(d.note||'').replace(/,/g,' '),d.app,d.plan,d.expires?fmt(d.expires):'Lifetime',classify(d),(d.activated_by==='admin'?'Admin':((S.accounts[d.activated_by]&&S.accounts[d.activated_by].name)||d.activated_by||''))]);});
  var csv=rows.map(function(r){return r.join(',');}).join('\\n');var a=document.createElement('a');a.href='data:text/csv;charset=utf-8,'+encodeURIComponent(csv);a.download='zayron-customers.csv';a.click();}
/* restore session on refresh — token lives in localStorage, sent as X-Auth header (Cloudflare-proof) */
(function boot(){if(tok()){enterShell();load();startAuto();}})();
</script>
</body></html>`;

// forced-update customer screen (mirrors the app's real #updGate look) — shown by the panel "Preview" button
function forcePreviewHtml(msg, url, latest, app) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Zayron — Update Required (customer view)</title><style>
*{box-sizing:border-box;font-family:'Segoe UI',Arial,sans-serif}html,body{margin:0;height:100%}
body{display:flex;align-items:center;justify-content:center;padding:24px;
  background:radial-gradient(120% 120% at 50% 0%,#0b1622 0%,#070d15 55%,#04070c 100%)}
.badge{position:fixed;top:14px;left:14px;background:rgba(255,255,255,.06);color:#8fb6d8;font-size:11px;font-weight:700;padding:6px 12px;border-radius:20px;letter-spacing:.5px}
.card{width:100%;max-width:460px;text-align:center;padding:36px 28px 32px;border-radius:22px;
  background:rgba(20,32,46,.72);border:1px solid rgba(99,226,255,.22);box-shadow:0 24px 70px rgba(0,0,0,.55);backdrop-filter:blur(14px)}
.mark{width:92px;height:92px;margin:0 auto 18px;border-radius:22px;display:flex;align-items:center;justify-content:center;
  background:linear-gradient(160deg,rgba(37,182,255,.16),rgba(37,182,255,.04));border:1px solid rgba(99,226,255,.28)}
.mark img{width:62px;height:62px;object-fit:contain}
.title{font-size:23px;font-weight:800;color:#eaf6ff;margin:4px 0 10px}
.msg{font-size:14.5px;line-height:1.55;color:#a9c2d6;margin:0 auto 24px;max-width:360px}
.btn{display:inline-flex;align-items:center;gap:8px;padding:14px 34px;border:0;border-radius:13px;font-size:15px;font-weight:800;letter-spacing:.5px;
  color:#04121c;background:linear-gradient(135deg,#63e2ff,#25b6ff);box-shadow:0 10px 26px rgba(37,182,255,.4);cursor:pointer;text-decoration:none}
</style></head><body>
<div class="badge">CUSTOMER VIEW — ${app.toUpperCase()}</div>
<div class="card">
  <div class="mark"><img alt="Zayron" src="${LOGO_URI}"></div>
  <div class="title">Update Required${latest}</div>
  <div class="msg">${String(msg).replace(/</g, '&lt;')}</div>
  <a class="btn" href="${String(url).replace(/"/g, '')}" target="_blank">UPDATE NOW</a>
</div></body></html>`;
}

try { writeVersionJson(); } catch (e) {}   // refresh the file on boot
server.listen(PORT, '127.0.0.1', () => console.log('Zayron activation server on 127.0.0.1:' + PORT));

/*
 * DEPLOY (isolated — does not touch your other apps):
 *  1) Put this file at /root/zayron-activation/activation-server.js
 *  2) systemd unit runs it 24/7 on port 3800 (already set up).
 *  3) Caddy: handle /act* { reverse_proxy 127.0.0.1:3800 }  (already set up).
 *  Panel: https://zayron.tv/act/admin   ·   App check: https://zayron.tv/act/api/check
 */
