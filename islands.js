// v204: SKYBLOCK adalari SUNUCUDA, hesaba bagli saklanir -> baska telefondan girsen de adan gelir.
// Depolama: DATABASE_URL varsa PostgreSQL (kalici), yoksa data/islands/*.json dosyalari (Render ucretsiz planda KALICI DEGIL).
// Ada = oyuncunun degistirdigi bloklar + envanter (JSON, gzip). Oyuncu basina en fazla 300 KB (sikistirilmis). Sunucu adayi simule etmez, sadece saklar.
// Gunluk Discord yedegi (hesap yedegiyle ayni kanal, ayri dosya) ve geri yukleme: node server/island_restore.js <yedek.json>
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const crypto = require("crypto");
const AUTH = require("./auth");

const MAX_GZ = 300 * 1024;               // sikistirilmis ada siniri
const MAX_RAW = 6 * 1024 * 1024;         // acilmis JSON siniri (zip-bomb korumasi)
const MAX_B64 = Math.ceil(MAX_GZ / 3) * 4 + 8;
const MIN_GAP_MS = 10 * 1000;            // ayni oyuncu en sik 10 sn'de bir kaydedebilir
const lastSave = new Map();              // anahtar -> son kayit zamani

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
  if (req.method !== "POST" || (url !== "/island/load" && url !== "/island/save")) return false;
  const out = (code, obj) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); return true; };
  try {
    const body = await readBody(req);
    if (!body || typeof body !== "object") return out(400, { ok: false, error: "Geçersiz istek" });
    const name = await AUTH.verify(body.token);
    if (!name) return out(401, { ok: false, error: "Oturum geçersiz" });
    const key = keyOf(name);
    if (url === "/island/load") {
      const r = await get(key);
      return out(200, { ok: true, data: r ? r.gz.toString("base64") : "", t: r ? r.t : 0 });
    }
    // ---- kaydet
    const b64 = typeof body.data === "string" ? body.data : "";
    if (!b64 || b64.length > MAX_B64) return out(413, { ok: false, error: "Ada çok büyük (en fazla 300 KB)" });
    const now = Date.now();
    if (now - (lastSave.get(key) || 0) < MIN_GAP_MS) return out(429, { ok: false, error: "Çok sık kaydediyorsun" });
    const gz = Buffer.from(b64, "base64");
    if (gz.length === 0 || gz.length > MAX_GZ) return out(413, { ok: false, error: "Ada çok büyük (en fazla 300 KB)" });
    let j;
    try { j = JSON.parse(zlib.gunzipSync(gz, { maxOutputLength: MAX_RAW }).toString("utf8")); } catch (e) { return out(400, { ok: false, error: "Ada verisi geçersiz" }); }
    if (!j || typeof j !== "object" || typeof j.chunks !== "object") return out(400, { ok: false, error: "Ada verisi geçersiz" });
    let t = Math.floor(Number(body.t) || 0);
    t = Math.max(0, Math.min(t, Math.floor(now / 1000) + 86400));
    const old = await get(key);
    if (old && old.t > t + 5) return out(409, { ok: false, error: "Sunucudaki ada daha yeni" });
    lastSave.set(key, now);
    await put(key, gz, t);
    return out(200, { ok: true, bytes: gz.length });
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
      const buf = Buffer.from(JSON.stringify({ v: 1, day, islands: parts[i] }));
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

module.exports = { handleHttp, get, put, all, keyOf, stats };
