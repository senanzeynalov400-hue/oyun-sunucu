// v204: SKYBLOCK adalari SUNUCUDA, hesaba bagli saklanir -> baska telefondan girsen de adan gelir.
// Depolama: DATABASE_URL varsa PostgreSQL (kalici), yoksa data/islands/*.json dosyalari (Render ucretsiz planda KALICI DEGIL).
// Ada = oyuncunun degistirdigi bloklar + envanter (JSON, gzip). Oyuncu basina en fazla 1 MB (sikistirilmis). Sunucu adayi simule etmez, sadece saklar.
// Gunluk Discord yedegi (hesap yedegiyle ayni kanal, ayri dosya) ve geri yukleme: node server/island_restore.js <yedek.json>
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const crypto = require("crypto");
const AUTH = require("./auth");
const POINTS = require("./island_points.json");   // v214: blok kimligi -> ada puani (script/skyblock.gd > _fill_points ile ayni; blocks.gd'den uretilir)

const MAX_GZ = 1024 * 1024;              // sikistirilmis ada siniri (1 MB: barikatin izin verdigi en buyuk ada bile sigar)
const MAX_RAW = 24 * 1024 * 1024;        // acilmis JSON siniri (zip-bomb korumasi)
const MAX_B64 = Math.ceil(MAX_GZ / 3) * 4 + 8;
const MIN_GAP_MS = 10 * 1000;            // ayni oyuncu en sik 10 sn'de bir kaydedebilir
const lastSave = new Map();              // anahtar -> son kayit zamani
// v214: ADA SEVIYESI + DINAR (PARA) hesapla birlikte SUNUCUDA saklanir (islands.js > "cuzdan").
// Puan ada JSON'undan sunucuda yeniden hesaplanir (istemcinin yolladigi dinar / maxlv DIKKATE ALINMAZ). Seviye ilk kez ulasilinca LEVEL_REWARD Dinar sunucu tarafindan verilir.
const LEVEL_COST = 100, LEVEL_REWARD = 100;       // skyblock.gd ile ayni
const RADIUS = 50, BUILD_TOP = 114;               // ada siniri (skyblock.gd > RADIUS / BUILD_TOP): disindaki bloklar puan vermez
const GEN_CHUNK = "0,0", GEN_IDX = 16642;         // tas ureteci hucresi (2, 65, 0) puan vermez

const keyOf = (n) => String(n || "").trim().toLowerCase();
const dir = path.join(process.env.DATA_DIR || path.join(__dirname, "data"), "islands");
const fileOf = (k) => path.join(dir, crypto.createHash("sha1").update(k).digest("hex") + ".json");

// ---------------------------------------------------------------- depolama
let pool = null;
let ready = Promise.resolve();
if (process.env.DATABASE_URL) {
  const { Pool } = require("pg");
  const url = process.env.DATABASE_URL;
  pool = new Pool({ connectionString: url, ssl: /localhost|127\.0\.0\.1/.test(url) ? false : { rejectUnauthorized: false }, max: 2 });
  ready = pool.query("CREATE TABLE IF NOT EXISTS islands (key TEXT PRIMARY KEY, data BYTEA NOT NULL, t BIGINT NOT NULL DEFAULT 0, saved BIGINT NOT NULL DEFAULT 0)")
    .then(() => pool.query("CREATE TABLE IF NOT EXISTS island_wallet (key TEXT PRIMARY KEY, dinar BIGINT NOT NULL DEFAULT 0, maxlv INT NOT NULL DEFAULT 0, level INT NOT NULL DEFAULT 0, points BIGINT NOT NULL DEFAULT 0, updated BIGINT NOT NULL DEFAULT 0)"))
    .catch((e) => console.error("islands tablo hatasi", e.message));
}
console.log("Ada depolama: " + (pool ? "postgres" : "file"));

async function get(key) {                // -> { gz: Buffer, t } | null
  await ready;
  if (pool) {
    const r = await pool.query("SELECT data, t FROM islands WHERE key=$1", [key]);
    return r.rows[0] ? { gz: r.rows[0].data, t: Number(r.rows[0].t) } : null;
  }
  try {
    const j = JSON.parse(fs.readFileSync(fileOf(key), "utf8"));
    return { gz: Buffer.from(j.d, "base64"), t: Number(j.t) || 0 };
  } catch (e) { return null; }
}
async function put(key, gz, t) {
  await ready;
  if (pool) {
    await pool.query("INSERT INTO islands (key, data, t, saved) VALUES ($1,$2,$3,$4) ON CONFLICT (key) DO UPDATE SET data=$2, t=$3, saved=$4", [key, gz, t, Date.now()]);
    return;
  }
  fs.mkdirSync(dir, { recursive: true });
  const f = fileOf(key);
  fs.writeFileSync(f + ".tmp", JSON.stringify({ k: key, t, saved: Date.now(), d: gz.toString("base64") }));
  fs.renameSync(f + ".tmp", f);
}
async function all() {                   // yedek icin: [{ k, t, d(base64) }]
  await ready;
  if (pool) {
    const r = await pool.query("SELECT key, data, t FROM islands");
    return r.rows.map((x) => ({ k: x.key, t: Number(x.t), d: Buffer.from(x.data).toString("base64") }));
  }
  const out = [];
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith(".json")) continue;
      try { const j = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")); out.push({ k: j.k, t: Number(j.t) || 0, d: j.d }); } catch (e) {}
    }
  } catch (e) {}
  return out;
}

async function del(key) {
  await ready;
  if (pool) { await pool.query("DELETE FROM islands WHERE key=$1", [key]); return; }
  try { fs.unlinkSync(fileOf(key)); } catch (e) {}
}

// ---------------------------------------------------------------- CUZDAN (ada seviyesi + Dinar), hesap basina
const wdir = path.join(process.env.DATA_DIR || path.join(__dirname, "data"), "island_wallet");
const wfileOf = (k) => path.join(wdir, crypto.createHash("sha1").update(k).digest("hex") + ".json");
const num0 = (v, max) => { const n = Math.floor(Number(v)); return Number.isFinite(n) ? Math.max(0, Math.min(n, max || 1e12)) : 0; };
const cleanWallet = (x) => ({ dinar: num0(x && x.dinar, 1e12), maxlv: num0(x && x.maxlv, 1e9), level: num0(x && x.level, 1e9), points: num0(x && x.points, 1e12), updated: num0(x && x.updated, 1e15) });
async function wGet(key) {              // -> { dinar, maxlv, level, points, updated } | null
  await ready;
  if (pool) {
    const r = await pool.query("SELECT dinar, maxlv, level, points, updated FROM island_wallet WHERE key=$1", [key]);
    return r.rows[0] ? cleanWallet(r.rows[0]) : null;
  }
  try { return cleanWallet(JSON.parse(fs.readFileSync(wfileOf(key), "utf8"))); } catch (e) { return null; }
}
async function wPut(key, w) {
  await ready;
  const c = cleanWallet(w); c.updated = Date.now();
  if (pool) {
    await pool.query("INSERT INTO island_wallet (key, dinar, maxlv, level, points, updated) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (key) DO UPDATE SET dinar=$2, maxlv=$3, level=$4, points=$5, updated=$6", [key, c.dinar, c.maxlv, c.level, c.points, c.updated]);
    return c;
  }
  fs.mkdirSync(wdir, { recursive: true });
  const f = wfileOf(key);
  fs.writeFileSync(f + ".tmp", JSON.stringify({ k: key, ...c }));
  fs.renameSync(f + ".tmp", f);
  return c;
}
async function wDel(key) {
  await ready;
  if (pool) { await pool.query("DELETE FROM island_wallet WHERE key=$1", [key]); return; }
  try { fs.unlinkSync(wfileOf(key)); } catch (e) {}
}
async function wAll() {                 // yedek icin: [{ k, dinar, maxlv, level, points, updated }]
  await ready;
  if (pool) {
    const r = await pool.query("SELECT key, dinar, maxlv, level, points, updated FROM island_wallet");
    return r.rows.map((x) => ({ k: x.key, ...cleanWallet(x) }));
  }
  const out = [];
  try {
    for (const f of fs.readdirSync(wdir)) {
      if (!f.endsWith(".json")) continue;
      try { const j = JSON.parse(fs.readFileSync(path.join(wdir, f), "utf8")); if (j.k) out.push({ k: j.k, ...cleanWallet(j) }); } catch (e) {}
    }
  } catch (e) {}
  return out;
}

// Cuzdan islemleri tek sirada yapilir (ayni anda iki istek bakiyeyi bozmasin). Tek sunucu ornegi icin yeterli.
let chain = Promise.resolve();
function locked(fn) { const p = chain.then(fn); chain = p.catch(() => {}); return p; }

// Ada JSON'undan puan: ada siniri icindeki, tas ureteci disindaki bloklarin puan toplami (skyblock.gd > calc_points ile ayni).
function calcPoints(j) {
  let total = 0;
  const ch = j && j.chunks;
  if (!ch || typeof ch !== "object") return 0;
  for (const k of Object.keys(ch)) {
    const m = /^(-?\d{1,6}),(-?\d{1,6})$/.exec(k);
    const arr = ch[k];
    if (!m || !Array.isArray(arr)) continue;
    const cx = Number(m[1]), cz = Number(m[2]);
    for (let i = 0; i + 1 < arr.length; i += 2) {
      const idx = arr[i], id = arr[i + 1];
      if (!Number.isInteger(idx) || !Number.isInteger(id) || idx < 0 || idx >= 16 * 16 * 128 || id < 0 || id >= POINTS.length) continue;
      const x = cx * 16 + (idx & 15), z = cz * 16 + ((idx >> 4) & 15), y = idx >> 8;
      if (x < -RADIUS || x > RADIUS || z < -RADIUS || z > RADIUS || y > BUILD_TOP) continue;
      if (k === GEN_CHUNK && idx === GEN_IDX) continue;
      total += POINTS[id];
    }
  }
  return total;
}
const levelOf = (points) => Math.floor(Math.max(0, points) / LEVEL_COST);

// Yeni puani isler: seviye daha once hic ulasilmamis bir degere ciktiysa odul verir. (en yuksek ulasilan seviye = maxlv, dusup cikinca tekrar odul YOK)
function applyLevel(key, points) {
  return locked(async () => {
    const w = (await wGet(key)) || { dinar: 0, maxlv: 0, level: 0, points: 0 };
    const level = levelOf(points);
    let reward = 0;
    if (level > w.maxlv) { reward = (level - w.maxlv) * LEVEL_REWARD; w.dinar += reward; w.maxlv = level; }
    w.level = level; w.points = points;
    return { w: await wPut(key, w), reward };
  });
}
// Cuzdan yoksa ama ada varsa (v204-v213'ten kalan adalar, yedekten gelen ada) adadan olusturur. Ada da yoksa null.
async function ensureWallet(key, isl) {
  const w = await wGet(key);
  if (w) return w;
  const r = isl === undefined ? await get(key) : isl;
  if (!r) return null;
  let j;
  try { j = JSON.parse(zlib.gunzipSync(r.gz, { maxOutputLength: MAX_RAW }).toString("utf8")); } catch (e) { return null; }
  if (!j || typeof j !== "object" || typeof j.chunks !== "object") return null;
  return (await applyLevel(key, calcPoints(j))).w;
}
const walletOut = (w) => (w ? { has_wallet: true, dinar: w.dinar, maxlv: w.maxlv, level: w.level, points: w.points } : { has_wallet: false, dinar: 0, maxlv: 0, level: 0, points: 0 });

// ---------------------------------------------------------------- HTTP
function readBody(req) {
  return new Promise((resolve) => {
    let b = "";
    req.on("data", (d) => { b += d; if (b.length > MAX_B64 + 2048) { req.destroy(); resolve(null); } });
    req.on("end", () => { try { resolve(JSON.parse(b || "{}")); } catch (e) { resolve(null); } });
    req.on("error", () => resolve(null));
  });
}

async function handleHttp(req, res) {
  const url = (req.url || "").split("?")[0];
  if (req.method !== "POST" || (url !== "/island/load" && url !== "/island/save" && url !== "/island/wallet" && url !== "/island/spend")) return false;
  const out = (code, obj) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); return true; };
  try {
    const body = await readBody(req);
    if (!body || typeof body !== "object") return out(400, { ok: false, error: "Geçersiz istek" });
    const name = await AUTH.verify(body.token);
    if (!name) return out(401, { ok: false, error: "Oturum geçersiz" });
    const key = keyOf(name);
    if (url === "/island/load") {
      const r = await get(key);
      const w = await ensureWallet(key, r);
      return out(200, { ok: true, data: r ? r.gz.toString("base64") : "", t: r ? r.t : 0, ...walletOut(w) });
    }
    if (url === "/island/wallet") {                  // v214: sadece bakiye + seviye (HUD / baska cihaz yenilemesi)
      return out(200, { ok: true, ...walletOut(await ensureWallet(key)) });
    }
    if (url === "/island/spend") {                   // v214: Dinar harca (market vb.). Bakiye yetmezse dusmez.
      const amount = Math.floor(Number(body.amount));
      if (!Number.isFinite(amount) || amount < 1 || amount > 1e9) return out(400, { ok: false, error: "Geçersiz miktar" });
      await ensureWallet(key);
      const res = await locked(async () => {
        const w = await wGet(key);
        if (!w || w.dinar < amount) return { ok: false, w };
        w.dinar -= amount;
        return { ok: true, w: await wPut(key, w) };
      });
      return out(res.ok ? 200 : 402, res.ok ? { ok: true, spent: amount, ...walletOut(res.w) } : { ok: false, error: "Yetersiz Dinar", ...walletOut(res.w) });
    }
    // ---- kaydet
    const b64 = typeof body.data === "string" ? body.data : "";
    if (!b64 || b64.length > MAX_B64) return out(413, { ok: false, error: "Ada çok büyük (en fazla 1 MB)" });
    const now = Date.now();
    if (now - (lastSave.get(key) || 0) < MIN_GAP_MS) return out(429, { ok: false, error: "Çok sık kaydediyorsun" });
    const gz = Buffer.from(b64, "base64");
    if (gz.length === 0 || gz.length > MAX_GZ) return out(413, { ok: false, error: "Ada çok büyük (en fazla 1 MB)" });
    let j;
    try { j = JSON.parse(zlib.gunzipSync(gz, { maxOutputLength: MAX_RAW }).toString("utf8")); } catch (e) { return out(400, { ok: false, error: "Ada verisi geçersiz" }); }
    if (!j || typeof j !== "object" || typeof j.chunks !== "object") return out(400, { ok: false, error: "Ada verisi geçersiz" });
    let t = Math.floor(Number(body.t) || 0);
    t = Math.max(0, Math.min(t, Math.floor(now / 1000) + 86400));
    const old = await get(key);
    if (old && old.t > t + 5) return out(409, { ok: false, error: "Sunucudaki ada daha yeni" });
    lastSave.set(key, now);
    await put(key, gz, t);
    const lv = await applyLevel(key, calcPoints(j));          // v214: puan sunucuda hesaplanir, Dinar odulu sunucu verir
    return out(200, { ok: true, bytes: gz.length, reward: lv.reward, ...walletOut(lv.w) });
  } catch (e) {
    console.error("island hatasi", e);
    return out(500, { ok: false, error: "Sunucu hatası" });
  }
}

// ---------------------------------------------------------------- gunluk Discord yedegi (hesap yedegiyle ayni kanal, ayri dosya)
const PART_MAX = 8 * 1024 * 1024;
async function backupTick() {
  try {
    const day = AUTH.backupDay();
    if (!day) return;
    if ((await AUTH.meta.get("island_backup_day")) === day) return;
    await AUTH.meta.set("island_backup_day", day);          // once isaretle: ayni gun iki kez gonderilmez
    const items = await all();
    if (items.length === 0) return;
    const wallets = await wAll();
    const parts = [];
    let cur = [], size = 0;
    for (const it of items) {
      const sz = (it.d || "").length + 64;
      if (cur.length && size + sz > PART_MAX) { parts.push(cur); cur = []; size = 0; }
      cur.push(it); size += sz;
    }
    if (cur.length) parts.push(cur);
    let ok = true;
    for (let i = 0; i < parts.length; i++) {
      const buf = Buffer.from(JSON.stringify({ v: 2, day, islands: parts[i], wallets: i === 0 ? wallets : [] }));
      const r = await AUTH.discordFile(buf, "ada-yedek-" + day + (parts.length > 1 ? "-" + (i + 1) : "") + ".json", "Skyblock ada yedeği: " + parts[i].length + " ada (" + (i + 1) + "/" + parts.length + ")");
      if (!r.ok) { ok = false; console.error("ada yedegi gonderilemedi:", r.error); break; }
    }
    if (!ok) await AUTH.meta.set("island_backup_day", "");  // basarisizsa sonraki denemede tekrar dene
  } catch (e) { console.error("ada yedek hatasi", e.message); }
}
setTimeout(backupTick, 40000).unref();
setInterval(backupTick, 5 * 60 * 1000).unref();

// v207: admin paneli icin: kac ada, toplam boyut (sikistirilmis)
async function stats() {
  await ready;
  if (pool) {
    const r = await pool.query("SELECT count(*)::int AS c, COALESCE(sum(octet_length(data)),0)::bigint AS b FROM islands");
    return { count: r.rows[0].c, bytes: Number(r.rows[0].b) };
  }
  let count = 0, bytes = 0;
  try { for (const f of fs.readdirSync(dir)) if (f.endsWith(".json")) { count++; bytes += fs.statSync(path.join(dir, f)).size; } } catch (e) {}
  return { count, bytes };
}

// v214: admin > Yedek (auth.js) icin kancalar: ZIP indirirken adalar + cuzdanlar dosyaya girer, yedek yuklenince geri gelir, hesap silinince ada + cuzdan da silinir.
async function exportAll(withIslands) {
  const wallets = await wAll();
  return { islands: withIslands ? await all() : null, wallets };
}
async function importAll(d, overwrite) {
  const r = { islands: 0, islands_skipped: 0, wallets: 0, bad: 0 };
  const touched = [];
  for (const it of Array.isArray(d && d.islands) ? d.islands : []) {
    const k = keyOf(it && it.k);
    if (!k || typeof it.d !== "string" || !it.d) { r.bad++; continue; }
    const gz = Buffer.from(it.d, "base64");
    if (gz.length === 0 || gz.length > MAX_GZ) { r.bad++; continue; }
    let j;
    try { j = JSON.parse(zlib.gunzipSync(gz, { maxOutputLength: MAX_RAW }).toString("utf8")); } catch (e) { r.bad++; continue; }
    if (!j || typeof j !== "object" || typeof j.chunks !== "object") { r.bad++; continue; }
    if (!overwrite && (await get(k))) { r.islands_skipped++; continue; }
    await put(k, gz, num0(it.t, Math.floor(Date.now() / 1000) + 86400));
    touched.push(k); r.islands++;
  }
  for (const x of Array.isArray(d && d.wallets) ? d.wallets : []) {
    const k = keyOf(x && x.k);
    if (!k) { r.bad++; continue; }
    if (!overwrite && (await wGet(k))) continue;
    await locked(() => wPut(k, x));
    r.wallets++;
  }
  for (const k of touched) { try { await ensureWallet(k); } catch (e) {} }     // yedekte cuzdani olmayan ada: seviye / Dinar adadan hesaplanir
  return r;
}
async function purge(key) {                  // hesap silinince
  const k = keyOf(key);
  lastSave.delete(k);
  await locked(async () => { await del(k); await wDel(k); });
}
AUTH.setIslandHooks({ export: exportAll, import: importAll, purge });

module.exports = { handleHttp, get, put, all, keyOf, stats, wAll, wGet, ensureWallet, importAll, calcPoints, levelOf };
