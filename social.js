// SOSYAL: arkadas istegi / arkadas listesi / arkadas mesajlasmasi.
// Kimlik: istemci her istekte hesap token'ini yollar (auth.js > verify). Sunucu ismi token'dan alir, taklit edilemez.
// Depolama: DATABASE_URL varsa PostgreSQL (tek satirlik jsonb, kalici), yoksa data/social.json (Render ucretsiz planda kalici DEGIL).
// Uc noktalar (hepsi POST + JSON, govde: {token, ...}):
//   /friends/list                      -> {friends:[{name,unread,last}], incoming:[isim], outgoing:[isim]}
//   /friends/request {to}              -> arkadaslik istegi yolla (karsi taraf zaten istek attiysa direkt arkadas olur)
//   /friends/respond {from, accept}    -> gelen istegi kabul / reddet
//   /friends/cancel  {to}              -> gonderdigin istegi geri cek
//   /friends/remove  {name}            -> arkadasliktan cikar
//   /chat/send       {to, text}        -> arkadasina mesaj (en fazla 200 karakter)
//   /chat/history    {with}            -> son 60 mesaj (okundu isaretlenir)
const fs = require("fs");
const path = require("path");
const AUTH = require("./auth");

const MAX_FRIENDS = 100;
const MAX_OUT = 30;
const MAX_TEXT = 200;
const KEEP_MSGS = 100;
const ROUTES = ["/friends/list", "/friends/request", "/friends/respond", "/friends/cancel", "/friends/remove", "/chat/send", "/chat/history"];

// state: friends {anahtar: [anahtar]}, req {anahtar: [istek atanlarin anahtari]} (GELEN istekler), names {anahtar: gorunen isim},
//        msgs {"a|b": [{f, x, t}]}, read {"anahtar|a|b": son okunma zamani}
let state = { friends: {}, req: {}, names: {}, msgs: {}, read: {} };
let persist = () => {};
AUTH.setExtraExport(() => state);   // admin sayfasindan 'Tam yedek indir' icin arkadaslik / sohbet verisi
AUTH.setExtraImport((d) => {   // admin 'Yedek yukle': yedekteki arkadaslik / istek / sohbet verisi mevcut verinin ustune eklenir
  if (!d || typeof d !== "object") return;
  const lists = (dst, src) => { for (const k in src || {}) { if (!Array.isArray(src[k])) continue; const a = arr(dst, k); for (const v of src[k]) if (typeof v === "string" && !a.includes(v)) a.push(v); } };
  lists(state.friends, d.friends); lists(state.req, d.req);
  for (const k in d.names || {}) if (typeof d.names[k] === "string") state.names[k] = d.names[k];
  for (const pr in d.msgs || {}) if (Array.isArray(d.msgs[pr])) state.msgs[pr] = d.msgs[pr].slice(-KEEP_MSGS);
  for (const r in d.read || {}) if (Number.isFinite(d.read[r])) state.read[r] = d.read[r];
  persist();
});
AUTH.setUserPurge((k) => {   // admin bir hesabi silince: arkadaslik, istek ve sohbet izleri de silinir
  delete state.friends[k]; delete state.req[k]; delete state.names[k];
  for (const a in state.friends) state.friends[a] = (state.friends[a] || []).filter((x) => x !== k);
  for (const a in state.req) state.req[a] = (state.req[a] || []).filter((x) => x !== k);
  for (const pr in state.msgs) if (pr.split("|").includes(k)) delete state.msgs[pr];
  for (const r in state.read) if (r.split("|").includes(k)) delete state.read[r];
  persist();
});

(function init() {
  const dir = process.env.DATA_DIR || path.join(__dirname, "data");
  const file = path.join(dir, "social.json");
  const merge = (d) => { if (d && typeof d === "object") state = { friends: d.friends || {}, req: d.req || {}, names: d.names || {}, msgs: d.msgs || {}, read: d.read || {} }; };
  let timer = null;
  if (process.env.DATABASE_URL) {
    const { Pool } = require("pg");
    const url = process.env.DATABASE_URL;
    const pool = new Pool({ connectionString: url, ssl: /localhost|127\.0\.0\.1/.test(url) ? false : { rejectUnauthorized: false }, max: 2 });
    (async () => {
      try {
        await pool.query("CREATE TABLE IF NOT EXISTS social_state (id INT PRIMARY KEY, data JSONB NOT NULL)");
        const r = await pool.query("SELECT data FROM social_state WHERE id=1");
        if (r.rows[0]) merge(r.rows[0].data);
      } catch (e) { console.error("social yuklenemedi", e.message); }
    })();
    persist = () => {
      if (timer) return;
      timer = setTimeout(async () => {
        timer = null;
        try { await pool.query("INSERT INTO social_state(id,data) VALUES(1,$1) ON CONFLICT (id) DO UPDATE SET data=$1", [JSON.stringify(state)]); } catch (e) { console.error("social yazilamadi", e.message); }
      }, 500);
    };
  } else {
    try { merge(JSON.parse(fs.readFileSync(file, "utf8"))); } catch (e) {}
    persist = () => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        try { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(file + ".tmp", JSON.stringify(state)); fs.renameSync(file + ".tmp", file); } catch (e) { console.error("social.json yazilamadi", e.message); }
      }, 500);
    };
  }
})();

const keyOf = (n) => String(n || "").trim().toLowerCase();
const pairOf = (a, b) => [a, b].sort().join("|");
const arr = (o, k) => (Array.isArray(o[k]) ? o[k] : (o[k] = []));
const nameOf = (k) => state.names[k] || k;
const areFriends = (a, b) => arr(state.friends, a).includes(b);
const lastSend = new Map();   // anahtar -> son mesaj zamani (spam korumasi)

function outgoingOf(k) {
  const out = [];
  for (const target in state.req) if ((state.req[target] || []).includes(k)) out.push(nameOf(target));
  return out;
}

function unreadOf(me, other) {
  const pair = pairOf(me, other);
  const since = Number(state.read[me + "|" + pair]) || 0;
  let n = 0;
  for (const m of state.msgs[pair] || []) if (m.f !== me && m.t > since) n++;
  return n;
}

function listFor(me) {
  const friends = arr(state.friends, me).map((f) => {
    const msgs = state.msgs[pairOf(me, f)] || [];
    const last = msgs.length ? msgs[msgs.length - 1] : null;
    return { name: nameOf(f), unread: unreadOf(me, f), last: last ? { text: last.x, t: last.t, mine: last.f === me } : null };
  });
  friends.sort((a, b) => ((b.last && b.last.t) || 0) - ((a.last && a.last.t) || 0) || a.name.localeCompare(b.name));
  return { ok: true, friends, incoming: arr(state.req, me).map(nameOf), outgoing: outgoingOf(me), now: Date.now() };
}

function makeFriends(a, b) {
  if (!areFriends(a, b)) arr(state.friends, a).push(b);
  if (!areFriends(b, a)) arr(state.friends, b).push(a);
  state.req[a] = arr(state.req, a).filter((x) => x !== b);
  state.req[b] = arr(state.req, b).filter((x) => x !== a);
}

async function handle(url, me, myName, body) {
  state.names[me] = myName;
  if (url === "/friends/list") return listFor(me);

  if (url === "/friends/request") {
    const to = await AUTH.lookupName(body.to);
    if (!to) return { status: 404, error: "Oyuncu bulunamadı" };
    const t = keyOf(to);
    if (t === me) return { status: 400, error: "Kendine istek atamazsın" };
    state.names[t] = to;
    if (areFriends(me, t)) return { status: 409, error: "Zaten arkadaşsınız" };
    if (arr(state.req, t).includes(me)) return { status: 409, error: "Zaten istek gönderdin" };
    if (arr(state.friends, me).length >= MAX_FRIENDS) return { status: 400, error: "Arkadaş listesi dolu" };
    if (arr(state.req, me).includes(t)) { makeFriends(me, t); persist(); return { ...listFor(me), accepted: to }; }   // o da sana istek atmisti -> direkt arkadas
    if (outgoingOf(me).length >= MAX_OUT) return { status: 400, error: "Çok fazla bekleyen isteğin var" };
    state.req[t].push(me);
    persist();
    return { ...listFor(me), sent: to };
  }

  if (url === "/friends/respond") {
    const f = keyOf(body.from);
    if (!arr(state.req, me).includes(f)) return { status: 404, error: "İstek bulunamadı" };
    if (body.accept === true) makeFriends(me, f);
    else state.req[me] = state.req[me].filter((x) => x !== f);
    persist();
    return listFor(me);
  }

  if (url === "/friends/cancel") {
    const t = keyOf(body.to);
    state.req[t] = arr(state.req, t).filter((x) => x !== me);
    persist();
    return listFor(me);
  }

  if (url === "/friends/remove") {
    const f = keyOf(body.name);
    state.friends[me] = arr(state.friends, me).filter((x) => x !== f);
    state.friends[f] = arr(state.friends, f).filter((x) => x !== me);
    persist();
    return listFor(me);
  }

  if (url === "/chat/send") {
    const t = keyOf(body.to);
    if (!areFriends(me, t)) return { status: 403, error: "Sadece arkadaşlarına yazabilirsin" };
    const text = String(body.text || "").replace(/[\u0000-\u001f]+/g, " ").trim().slice(0, MAX_TEXT);
    if (!text) return { status: 400, error: "Boş mesaj" };
    const now = Date.now();
    if (now - (lastSend.get(me) || 0) < 500) return { status: 429, error: "Çok hızlı yazıyorsun" };
    lastSend.set(me, now);
    const pair = pairOf(me, t);
    const list = (state.msgs[pair] = state.msgs[pair] || []);
    list.push({ f: me, x: text, t: now });
    if (list.length > KEEP_MSGS) list.splice(0, list.length - KEEP_MSGS);
    state.read[me + "|" + pair] = now;
    persist();
    return { status: 200, ok: true, now };
  }

  if (url === "/chat/history") {
    const t = keyOf(body.with);
    if (!areFriends(me, t)) return { status: 403, error: "Arkadaş değilsiniz" };
    const pair = pairOf(me, t);
    const now = Date.now();
    const msgs = (state.msgs[pair] || []).slice(-60).map((m) => ({ from: nameOf(m.f), text: m.x, t: m.t, mine: m.f === me }));
    if ((Number(state.read[me + "|" + pair]) || 0) < now) { state.read[me + "|" + pair] = now; persist(); }
    return { status: 200, ok: true, msgs, now };
  }
  return { status: 404, error: "Bilinmeyen istek" };
}

function readBody(req) {
  return new Promise((resolve) => {
    let b = "";
    req.on("data", (d) => { b += d; if (b.length > 4096) { req.destroy(); resolve(null); } });
    req.on("end", () => { try { resolve(JSON.parse(b || "{}")); } catch (e) { resolve(null); } });
    req.on("error", () => resolve(null));
  });
}

// true dondururse istegi isledi (server.js > http.createServer icinden cagrilir)
async function handleHttp(req, res) {
  const url = (req.url || "").split("?")[0];
  if (req.method !== "POST" || !ROUTES.includes(url)) return false;
  const out = (code, obj) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); return true; };
  try {
    const body = await readBody(req);
    if (!body || typeof body !== "object") return out(400, { ok: false, error: "Geçersiz istek" });
    const myName = await AUTH.verify(body.token);
    if (!myName) return out(401, { ok: false, error: "Oturum geçersiz" });
    const r = await handle(url, keyOf(myName), myName, body);
    const { status, ...rest } = r;
    return out(status || 200, { ok: r.ok !== false && !r.error, ...rest });
  } catch (e) {
    console.error("social hatasi", e);
    return out(500, { ok: false, error: "Sunucu hatası" });
  }
}

module.exports = { handleHttp, areFriends: (a, b) => areFriends(keyOf(a), keyOf(b)) };    // v203: ada ziyareti icin arkadaslik kontrolu
