// SMP: /ah (acik artirma / oyuncu pazari) + /sell (sunucu fiyatina hizli satis). Para birimi: Dinar (Skyblock ile AYNI cuzdan, islands.js).
// Her sey SUNUCUDA tutulur: ilanlar, oyuncu posta kutusu (satin alinan / geri gelen esya, "satildi" mesaji). Dinar islemleri atomik (islands.js > walletTransfer).
// Depolama: DATABASE_URL varsa Postgres (tek satir JSON), yoksa DATA_DIR/ah_state.json. Degisince en gec 2 sn'de yazilir.
// Not: esya envanteri istemcide durur (SMP zaten oyle). Sunucu: ilan sayisi, fiyat, saatlik /sell tavani ve esya kimligi sinirlariyla kotuye kullanimi azaltir.
const fs = require("fs");
const path = require("path");
const AUTH = require("./auth");
const ISL = require("./islands");
const PRICES = require("./ah_prices.json");      // esya kimligi -> /sell Dinar fiyati (tools/gen_ah_prices.py)

const MAX_ID = 275;                  // blocks.gd BLOCK_COUNT - 1 (v234: 274 idi -> Uc Kristali (275) /sell'de sessizce kayboluyordu)
const MAX_STACK = 64;
const MAX_PRICE = 1000000000;
const MAX_LISTINGS = 25;             // oyuncu basina
const LIST_TTL_MS = 48 * 3600 * 1000;      // 48 saat sonra ilan kalkar, esya sahibinin posta kutusuna gider
const SELL_CAP_PER_HOUR = 60000;     // /sell ile saatte en fazla bu kadar Dinar (hileli istemci esya uydurup para basmasin)
const PAGE = 45;

const keyOf = (n) => String(n || "").trim().toLowerCase();
const dir = process.env.DATA_DIR || path.join(__dirname, "data");
const file = path.join(dir, "ah_state.json");

let state = { next: 1, listings: [], inbox: {}, sold: {} };   // listings: {id, sk, seller, item, n, price, t}; inbox[key]: [{id, kind, item, n, text}]; sold[key]: {t, sum}
let dirty = false, pool = null, ready = Promise.resolve();
if (process.env.DATABASE_URL) {
  const { Pool } = require("pg");
  const url = process.env.DATABASE_URL;
  pool = new Pool({ connectionString: url, ssl: /localhost|127\.0\.0\.1/.test(url) ? false : { rejectUnauthorized: false }, max: 1 });
  ready = pool.query("CREATE TABLE IF NOT EXISTS ah_state (key TEXT PRIMARY KEY, data TEXT NOT NULL)").catch((e) => console.error("ah tablo hatasi", e.message));
}
const loaded = (async () => {
  await ready;
  try {
    let txt = null;
    if (pool) { const r = await pool.query("SELECT data FROM ah_state WHERE key='main'"); if (r.rows[0]) txt = r.rows[0].data; }
    else if (fs.existsSync(file)) txt = fs.readFileSync(file, "utf8");
    if (txt) { const j = JSON.parse(txt); state = { next: j.next || 1, listings: j.listings || [], inbox: j.inbox || {}, sold: j.sold || {} }; }
    console.log("AH: " + state.listings.length + " ilan yuklendi");
  } catch (e) { console.error("AH yuklenemedi", e.message); }
})();
async function save() {
  if (!dirty) return;
  dirty = false;
  try {
    const txt = JSON.stringify(state);
    if (pool) await pool.query("INSERT INTO ah_state (key, data) VALUES ('main',$1) ON CONFLICT (key) DO UPDATE SET data=$1", [txt]);
    else { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(file + ".tmp", txt); fs.renameSync(file + ".tmp", file); }
  } catch (e) { dirty = true; console.error("AH yazilamadi", e.message); }
}
setInterval(save, 2000).unref();
const touch = () => { dirty = true; };

let chain = Promise.resolve();       // tum ah islemleri sirayla (iki kisi ayni ilani ayni anda alamaz)
const locked = (fn) => { const p = chain.then(fn); chain = p.catch(() => {}); return p; };

function post(key, entry) { (state.inbox[key] || (state.inbox[key] = [])).push({ id: state.next++, ...entry }); touch(); }
function sweep() {                    // suresi dolan ilanlar -> sahibine geri
  const now = Date.now();
  const keep = [];
  for (const l of state.listings) {
    if (now - l.t >= LIST_TTL_MS) post(l.sk, { kind: "item", item: l.item, n: l.n, text: "İlanının süresi doldu, eşyan geri geldi." });
    else keep.push(l);
  }
  if (keep.length !== state.listings.length) { state.listings = keep; touch(); }
}
setInterval(() => locked(async () => { await loaded; sweep(); }), 60000).unref();

const pubL = (l) => ({ id: l.id, seller: l.seller, item: l.item, n: l.n, price: l.price, left: Math.max(0, Math.ceil((l.t + LIST_TTL_MS - Date.now()) / 1000)) });
const okItem = (id, n) => Number.isInteger(id) && id >= 1 && id <= MAX_ID && Number.isInteger(n) && n >= 1 && n <= MAX_STACK;

async function handleHttp(req, res) {
  const url = (req.url || "").split("?")[0];
  if (req.method !== "POST" || !url.startsWith("/ah/")) return false;
  const out = (code, obj) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); return true; };
  try {
    const body = await ISL.readBody(req);
    if (!body || typeof body !== "object") return out(400, { ok: false, error: "Geçersiz istek" });
    const name = await AUTH.verify(body.token);
    if (!name) return out(401, { ok: false, error: "Oturum geçersiz" });
    const me = keyOf(name);
    await loaded;
    const r = await locked(async () => {
      sweep();
      switch (url) {
        case "/ah/balance": return { ok: true, dinar: await ISL.walletBalance(me) };
        case "/ah/list": {                       // {page, mine, sort}
          let arr = state.listings.filter((l) => (body.mine ? l.sk === me : true));
          const sort = String(body.sort || "new");
          if (sort === "low") arr = arr.slice().sort((a, b) => a.price - b.price);
          else if (sort === "high") arr = arr.slice().sort((a, b) => b.price - a.price);
          else arr = arr.slice().sort((a, b) => b.t - a.t);
          const pages = Math.max(1, Math.ceil(arr.length / PAGE));
          const page = Math.max(0, Math.min(pages - 1, Math.floor(Number(body.page) || 0)));
          return { ok: true, page, pages, total: arr.length, items: arr.slice(page * PAGE, page * PAGE + PAGE).map(pubL), dinar: await ISL.walletBalance(me) };
        }
        case "/ah/set": {                        // {item, n, price} -> ilan acar. Esyayi istemci SADECE ok:true gelince elinden siler.
          const item = Math.floor(Number(body.item)), n = Math.floor(Number(body.n)), price = Math.floor(Number(body.price));
          if (!okItem(item, n)) return { ok: false, error: "Geçersiz eşya" };
          if (!Number.isFinite(price) || price < 1 || price > MAX_PRICE) return { ok: false, error: "Fiyat 1 ile " + MAX_PRICE + " arasında olmalı" };
          if (state.listings.filter((l) => l.sk === me).length >= MAX_LISTINGS) return { ok: false, error: "En fazla " + MAX_LISTINGS + " ilanın olabilir" };
          const l = { id: state.next++, sk: me, seller: name, item, n, price, t: Date.now() };
          state.listings.push(l); touch();
          return { ok: true, id: l.id, price };
        }
        case "/ah/cancel": {                     // {id} -> kendi ilani: esya posta kutusuna
          const i = state.listings.findIndex((l) => l.id === Math.floor(Number(body.id)));
          if (i < 0) return { ok: false, error: "İlan bulunamadı" };
          const l = state.listings[i];
          if (l.sk !== me) return { ok: false, error: "Bu senin ilanın değil" };
          state.listings.splice(i, 1);
          post(me, { kind: "item", item: l.item, n: l.n, text: "İlanını kaldırdın, eşyan geri geldi." });
          return { ok: true };
        }
        case "/ah/buy": {                        // {id}
          const i = state.listings.findIndex((l) => l.id === Math.floor(Number(body.id)));
          if (i < 0) return { ok: false, error: "Bu ilan artık yok (başkası aldı)" };
          const l = state.listings[i];
          if (l.sk === me) return { ok: false, error: "Kendi ilanını alamazsın" };
          const t = await ISL.walletTransfer(me, l.sk, l.price);     // alicidan dus, saticiya ekle (atomik)
          if (!t.ok) return { ok: false, error: "Yetersiz Dinar", dinar: t.dinar || 0 };
          state.listings.splice(i, 1);
          post(me, { kind: "item", item: l.item, n: l.n, text: "Satın alındı." });
          post(l.sk, { kind: "msg", text: name + " eşyanı " + l.price + " Dinar'a satın aldı!" });
          touch();
          return { ok: true, dinar: t.dinar };
        }
        case "/ah/inbox": {                      // bekleyen esyalar + mesajlar (istemci uygular, sonra /ah/ack)
          return { ok: true, items: (state.inbox[me] || []).slice(0, 40), dinar: await ISL.walletBalance(me) };
        }
        case "/ah/ack": {                        // {ids:[...]}
          const ids = new Set((Array.isArray(body.ids) ? body.ids : []).map(Number));
          if (state.inbox[me]) { state.inbox[me] = state.inbox[me].filter((e) => !ids.has(e.id)); if (!state.inbox[me].length) delete state.inbox[me]; touch(); }
          return { ok: true };
        }
        case "/ah/sell": {                       // {items:[[id,n],...]} -> sunucu fiyatiyla hesaplar, Dinar'i hesaba yazar
          const list = Array.isArray(body.items) ? body.items.slice(0, 60) : [];
          let total = 0; const sold = [], back = [];
          for (const it of list) {
            const id = Math.floor(Number(it && it[0])), n = Math.floor(Number(it && it[1]));
            if (!okItem(id, n)) { if (Number.isInteger(id) && id >= 1 && Number.isInteger(n) && n >= 1) back.push([id, Math.min(n, MAX_STACK)]); continue; }   // v234: gecersiz esya sessizce silinmez, geri verilir
            const p = PRICES[String(id)] || 0;
            if (p > 0) { total += p * n; sold.push([id, n]); } else back.push([id, n]);
          }
          const now = Date.now();
          const s = state.sold[me] && now - state.sold[me].t < 3600 * 1000 ? state.sold[me] : { t: now, sum: 0 };
          if (s.sum + total > SELL_CAP_PER_HOUR) return { ok: false, error: "Saatlik satış sınırına ulaştın (" + SELL_CAP_PER_HOUR + " Dinar). Biraz sonra tekrar dene." };
          if (total > 0) { s.sum += total; state.sold[me] = s; touch(); }
          const w = total > 0 ? await ISL.walletCredit(me, total) : null;
          return { ok: true, total, sold, back, dinar: w ? w.dinar : await ISL.walletBalance(me) };
        }
      }
      return { ok: false, error: "Bilinmeyen uç" };
    });
    return out(r.ok ? 200 : 400, r);
  } catch (e) { console.error("AH hata", e); return out(500, { ok: false, error: "Sunucu hatası" }); }
}
async function flush() { dirty = true; await save(); }
module.exports = { handleHttp, flush };
