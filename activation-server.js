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
    ledger: []       // { ts, type, reseller, amount, mac, note }
  };
  save(db);
  console.log('First run. ADMIN KEY = ' + db.admin_key + '  (change it in the panel; keep it secret)');
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
      if (a === 'state') return json(res, 200, { config: db.config, resellers: db.resellers, devices: db.devices, ledger: db.ledger.slice(-100).reverse() });
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

// ---------- admin panel HTML (single page) ----------
const PANEL = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Zayron — Activation Admin</title><style>
:root{--cyan:#25b6ff;--cb:#63e2ff;--bg:#05080f;--card:#0e1a30;--line:rgba(140,185,245,.16);--muted:#93a6c4;--gold:#f4c33c}
*{box-sizing:border-box;font-family:'Segoe UI',Arial,sans-serif}body{margin:0;background:var(--bg);color:#eaf2fb}
.wrap{max-width:1000px;margin:0 auto;padding:18px}
h1{font-size:20px}h1 b{color:var(--cb)}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px;margin:14px 0}
.row{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
input,select{padding:9px 11px;border-radius:9px;border:1px solid var(--line);background:#0a1424;color:#fff;font-size:14px}
button{padding:9px 15px;border-radius:9px;border:0;background:var(--cyan);color:#fff;font-weight:700;cursor:pointer;font-size:14px}
button.g{background:rgba(255,255,255,.08);border:1px solid var(--line);color:#dbe8fa}
button.d{background:#e5546e}
table{width:100%;border-collapse:collapse;margin-top:8px}th,td{text-align:left;padding:8px;border-bottom:1px solid var(--line);font-size:13px}
th{color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.5px}
.tag{font-size:11px;font-weight:700;padding:2px 8px;border-radius:20px}
.tag.on{background:rgba(0,200,83,.15);color:#22c55e}.tag.off{background:rgba(229,84,110,.15);color:#e5546e}
.sw{display:inline-flex;align-items:center;gap:6px;margin:4px 12px 4px 0;font-size:13px}
.muted{color:var(--muted);font-size:12px}label{font-size:12.5px;color:var(--muted)}
</style></head><body><div class="wrap">
<h1><b>Zayron</b> Activation — Admin</h1>
<div id="login" class="card"><div class="row"><input id="key" type="password" placeholder="Admin key" style="flex:1"><button onclick="login()">Sign in</button></div><div id="lerr" class="muted"></div></div>
<div id="app" style="display:none">
  <div class="card"><b>Player mode</b> — turn each app Paid or Free, or kill it.
    <div id="toggles" style="margin-top:10px"></div>
    <div class="row" style="margin-top:8px"><label>Trial days (0 = off)</label><input id="trial" type="number" style="width:90px"><label>Contact text</label><input id="contact" style="flex:1"><button onclick="saveCfg()">Save</button></div>
  </div>
  <div class="card"><b>Activate a device</b>
    <div class="row" style="margin-top:10px">
      <input id="amac" placeholder="Device MAC (1A:2B:...)" style="flex:1">
      <select id="aapp"><option value="any">Any app</option><option value="windows">Windows</option><option value="android">Android</option><option value="ios">iOS</option></select>
      <select id="aplan"><option value="1y">1 Year (1 credit)</option><option value="lifetime">Lifetime (2 credits)</option></select>
      <select id="aby"><option value="admin">As Admin (free)</option></select>
      <button onclick="act()">Activate</button>
    </div><div id="aerr" class="muted"></div>
  </div>
  <div class="card"><div class="row"><b style="flex:1">Devices</b><input id="q" placeholder="search MAC" oninput="render()" style="width:200px"></div>
    <table id="devs"></table>
  </div>
  <div class="card"><b>Resellers &amp; credits</b>
    <div class="row" style="margin-top:10px"><input id="rname" placeholder="New reseller name"><button onclick="addR()">Add reseller</button></div>
    <table id="res"></table>
  </div>
  <div class="card"><div class="row"><label>Change admin key</label><input id="nkey" placeholder="new key (min 6)"><button class="g" onclick="setKey()">Update key</button></div></div>
</div>
<script>
var S={};
function post(action,extra){return fetch('admin/act',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(Object.assign({action:action},extra||{}))}).then(function(r){return r.json();});}
function login(){fetch('admin/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key:document.getElementById('key').value})}).then(function(r){return r.json();}).then(function(d){if(d.ok){document.getElementById('login').style.display='none';document.getElementById('app').style.display='';load();}else document.getElementById('lerr').textContent='Wrong key';});}
function load(){post('state').then(function(d){if(d.error){document.getElementById('login').style.display='';document.getElementById('app').style.display='none';return;}S=d;render();});}
function render(){
  var c=S.config;
  var apps=['windows','android','ios'];var h='';
  apps.forEach(function(a){h+='<span class="sw">'+a.toUpperCase()+': <button class="'+(c.paid[a]?'':'g')+'" onclick="tog(\\''+a+'\\',\\'paid\\')">'+(c.paid[a]?'PAID':'FREE')+'</button> <button class="'+(c.kill[a]?'d':'g')+'" onclick="tog(\\''+a+'\\',\\'kill\\')">'+(c.kill[a]?'KILLED':'live')+'</button></span>';});
  document.getElementById('toggles').innerHTML=h;
  document.getElementById('trial').value=c.trial_days||0;document.getElementById('contact').value=c.contact||'';
  // reseller options in activate
  var aby=document.getElementById('aby');var cur=aby.value;aby.innerHTML='<option value="admin">As Admin (free)</option>';Object.keys(S.resellers).forEach(function(id){var r=S.resellers[id];aby.innerHTML+='<option value="'+id+'">'+r.name+' ('+r.credits+' cr)</option>';});aby.value=cur;
  // devices
  var q=(document.getElementById('q').value||'').toUpperCase();
  var t='<tr><th>MAC</th><th>App</th><th>Plan</th><th>Expires</th><th>By</th><th>Status</th><th></th></tr>';
  Object.keys(S.devices).filter(function(m){return m.indexOf(q)>=0;}).forEach(function(m){var d=S.devices[m];var exp=d.expires?new Date(d.expires).toISOString().slice(0,10):'Lifetime';
    t+='<tr><td>'+m+'</td><td>'+d.app+'</td><td>'+d.plan+'</td><td>'+exp+'</td><td>'+d.activated_by+'</td><td><span class="tag '+(d.status==='active'?'on':'off')+'">'+d.status+'</span></td><td>'+(d.status==='blocked'?'<button class="g" onclick="dev(\\'unblock\\',\\''+m+'\\')">unblock</button>':'<button class="g" onclick="dev(\\'block\\',\\''+m+'\\')">block</button>')+' <button class="d" onclick="dev(\\'delete\\',\\''+m+'\\')">del</button></td></tr>';});
  document.getElementById('devs').innerHTML=t;
  // resellers
  var r='<tr><th>Name</th><th>Key</th><th>Credits</th><th>Status</th><th>Add credits</th></tr>';
  Object.keys(S.resellers).forEach(function(id){var x=S.resellers[id];r+='<tr><td>'+x.name+'</td><td class="muted">'+x.key+'</td><td>'+x.credits+'</td><td><button class="'+(x.enabled?'':'g')+'" onclick="post(\\'toggleReseller\\',{id:\\''+id+'\\'}).then(load)">'+(x.enabled?'enabled':'disabled')+'</button></td><td><input id="cr_'+id+'" type="number" style="width:70px" placeholder="+/-"> <button class="g" onclick="addCr(\\''+id+'\\')">apply</button></td></tr>';});
  document.getElementById('res').innerHTML=r;
}
function tog(a,kind){var c=S.config;c[kind][a]=!c[kind][a];post('setConfig',{config:c}).then(load);}
function saveCfg(){var c=S.config;c.trial_days=parseInt(document.getElementById('trial').value)||0;c.contact=document.getElementById('contact').value;post('setConfig',{config:c}).then(function(){alert('Saved');load();});}
function act(){post('activate',{mac:document.getElementById('amac').value,app:document.getElementById('aapp').value,plan:document.getElementById('aplan').value,by:document.getElementById('aby').value}).then(function(d){document.getElementById('aerr').textContent=d.ok?'Activated ✓':('Error: '+d.error);load();});}
function dev(action,m){if(action==='delete'&&!confirm('Delete '+m+'?'))return;post(action,{mac:m}).then(load);}
function addR(){var n=document.getElementById('rname').value.trim();if(!n)return;post('reseller',{name:n}).then(function(){document.getElementById('rname').value='';load();});}
function addCr(id){var v=document.getElementById('cr_'+id).value;post('credits',{id:id,amount:v}).then(load);}
function setKey(){var k=document.getElementById('nkey').value;post('setAdminKey',{key:k}).then(function(d){alert(d.ok?'Key updated':'Error: '+(d.error||''));});}
load();
</script></div></body></html>`;

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