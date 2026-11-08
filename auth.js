// Hesap sistemi: kayit / giris / token dogrulama.
// Sifre scrypt ile hash'lenir (duz sifre ASLA saklanmaz). Giriste rastgele token verilir, sunucuda sadece token'in SHA-256'i tutulur.
// Depolama: DATABASE_URL varsa PostgreSQL (kalici), yoksa data/users.json dosyasi (Render ucretsiz planda KALICI DEGIL).
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

// Sapka fiyatlari (altin): server/hats.json -> {"sapka_id": fiyat}. Fiyati degistirmek icin bu dosyayi duzenle.
let HATS = {};
const GEM_ITEMS = new Set(["skin_10", "skin_11", "skin_12", "skin_17", "skin_18", "skin_19", "skin_20", "skin_21", "skin_22", "skin_23", "skin_24", "wing_1", "wing_2", "wing_3", "wing_4", "wing_5", "wing_6", "wing_7", "wing_8", "wing_9", "wing_10", "wing_11", "wing_12", "wing_13", "wing_14", "wing_15", "wing_16", "wing_17", "wing_18", "wing_19", "entry_reis"]);   // bu urunler ELMASLA satilir (fiyat hats.json'da), digerleri altinla

try { HATS = JSON.parse(fs.readFileSync(path.join(__dirname, "hats.json"), "utf8")); } catch (e) { console.error("hats.json okunamadi", e.message); }
const hatsFile = () => { try { return JSON.parse(fs.readFileSync(path.join(__dirname, "hats.json"), "utf8")); } catch (e) { return null; } };
const HATS_DEFAULT = { ...HATS };
// Panelden degisen fiyatlar veritabaninda (meta "hat_prices") SADECE hats.json'dan farkli olanlar olarak durur.
function applyPrices(o) {
  let n = 0;
  if (!o || typeof o !== "object") return 0;
  for (const k of Object.keys(o)) { const v = o[k]; if (Object.prototype.hasOwnProperty.call(HATS, k) && Number.isInteger(v) && v >= 0 && v <= 10000000 && HATS[k] !== v) { HATS[k] = v; n++; } }
  return n;
}
const ADMIN_KEY = process.env.ADMIN_KEY || "";       // oyuncuya para gondermek icin gizli anahtar (Render > Environment). Bos = admin kapali.

// RANKLAR: id'ler istemcideki textures/ranks/<id>.png ve script/rank_data.gd ile AYNI olmali. Rank vermeyi SADECE OP'ler yapabilir (/rank_set).
// Oyuncu (rank yok) = bos metin. Yeni rank eklemek: buraya id ekle + textures/ranks/<id>.png + rank_data.gd.
const RANKS = [
  "yonetici", "gelistirici", "moderator", "destekci", "yapimci", "vip_plus", "vip", "kurucu",
  "elmas", "zumrut", "altin", "demir", "lazuli", "redstone", "komur", "youtube", "twitch", "tiktok", "discord",
];
let rankListener = null;     // server.js: rank degisince bagli oyunculara haber verir
const setRankListener = (fn) => { rankListener = fn; };

const NAME_RE = /^[\p{L}\p{N}_]{3,16}$/u;
const MAX_TOKENS = 5;

// GUNLUK ODUL (7 gunluk dongu). Odulleri SUNUCU verir; istemciye guvenilmez.
// Gun 4 odulu "ates" (fire) - istemcide Auth.fire. Gun degisimi Turkiye saatiyle (UTC+3) gece yarisidir.
const DAILY = [
  { coins: 100 }, { coins: 250 }, { coins: 250 }, { fire: 2 },
  { coins: 10 }, { coins: 500 }, { gems: 10 },
];
const TZ_MS = 3 * 3600 * 1000;
const dayNum = () => Math.floor((Date.now() + TZ_MS) / 86400000);
const secondsToNextDay = () => Math.max(1, Math.ceil(86400 - (((Date.now() + TZ_MS) / 1000) % 86400)));
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
// Duz sifre (admin yedeginde "sifre" alani): diskte/veritabaninda ADMIN_KEY'den turetilen anahtarla SIFRELI durur, sadece yedek indirirken cozulur.
const PW_KEY = () => crypto.createHash("sha256").update("pw|" + ADMIN_KEY).digest();
function encPw(pw) {
  if (!ADMIN_KEY || typeof pw !== "string" || !pw) return "";
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv("aes-256-gcm", PW_KEY(), iv);
  const d = Buffer.concat([c.update(pw, "utf8"), c.final()]);
  return iv.toString("hex") + ":" + c.getAuthTag().toString("hex") + ":" + d.toString("hex");
}
function decPw(t) {
  try {
    if (!ADMIN_KEY || typeof t !== "string" || !t) return "";
    const [iv, tag, d] = t.split(":");
    const c = crypto.createDecipheriv("aes-256-gcm", PW_KEY(), Buffer.from(iv, "hex"));
    c.setAuthTag(Buffer.from(tag, "hex"));
    return Buffer.concat([c.update(Buffer.from(d, "hex")), c.final()]).toString("utf8");
  } catch (e) { return ""; }     // ADMIN_KEY degistiyse cozulemez
}
const scrypt = (pw, salt) => new Promise((res, rej) => crypto.scrypt(pw, salt, 64, { N: 16384, r: 8, p: 1 }, (e, k) => (e ? rej(e) : res(k.toString("hex")))));

// ------------------------------------------------------------ depolama
function fileStore() {
  const dir = process.env.DATA_DIR || path.join(__dirname, "data");
  const file = path.join(dir, "users.json");
  let users = {};
  try { users = JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) {}
  for (const k in users) { const u = users[k]; u.coins = Number(u.coins) || 0; u.gems = Number(u.gems) || 0; u.fire = Number(u.fire) || 0; u.daily_last = Number.isFinite(u.daily_last) ? u.daily_last : -1; u.daily_streak = Number(u.daily_streak) || 0; if (!Array.isArray(u.hats)) u.hats = []; u.op = u.op === true; u.rank = typeof u.rank === "string" ? u.rank : ""; u.mute_until = Number(u.mute_until) || 0; u.mute_by = typeof u.mute_by === "string" ? u.mute_by : ""; u.mute_reason = typeof u.mute_reason === "string" ? u.mute_reason : ""; u.ban_until = Number(u.ban_until) || 0; u.ban_by = typeof u.ban_by === "string" ? u.ban_by : ""; u.ban_reason = typeof u.ban_reason === "string" ? u.ban_reason : ""; }
  const metaFile = path.join(dir, "meta.json");
  let meta = {};
  try { meta = JSON.parse(fs.readFileSync(metaFile, "utf8")) || {}; } catch (e) {}
  let timer = null;
  const flush = () => {
    timer = null;
    try { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(file + ".tmp", JSON.stringify(users)); fs.renameSync(file + ".tmp", file); } catch (e) { console.error("users.json yazilamadi", e.message); }
  };
  const save = () => { if (!timer) timer = setTimeout(flush, 300); };
  return {
    kind: "file",
    async get(key) { return users[key] || null; },
    async byToken(th) { for (const k in users) if (users[k].tokens.includes(th)) return users[k]; return null; },
    async create(u) { if (users[u.key]) return false; users[u.key] = u; save(); return true; },
    async update(u) { users[u.key] = u; save(); },
    async buyHat(key, hat, price, gem) {
      const u = users[key];
      if (!u) return { err: "nouser" };
      if (u.hats.includes(hat)) return { err: "owned", user: u };
      if ((gem ? u.gems : u.coins) < price) return { err: "funds", user: u };
      if (gem) u.gems -= price; else u.coins -= price;
      u.hats.push(hat); save();
      return { user: u };
    },
    async top(n) {
      return Object.values(users).map((u) => ({ name: u.name, wins: Number(u.bw_wins) || 0, points: Number(u.bw_points) || 0, look: u.look || "" })).sort((a, b) => b.points - a.points || b.wins - a.wins || a.name.localeCompare(b.name)).slice(0, n);
    },
    async setLook(key, look) { const u = users[key]; if (!u) return null; u.look = look; save(); return u; },
    async getMeta(k) { return Object.prototype.hasOwnProperty.call(meta, k) ? meta[k] : null; },
    async allMeta() { return { ...meta }; },
    async setMeta(k, v) { meta[k] = String(v); try { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(metaFile, JSON.stringify(meta)); } catch (e) { console.error("meta.json yazilamadi", e.message); } },
    async resetBwPoints() { let n = 0; for (const k in users) { if (Number(users[k].bw_points) > 0) { users[k].bw_points = 0; n++; } } if (n) save(); return n; },
    async addBwPoints(key, n, win) { const u = users[key]; if (!u) return null; u.bw_points = (Number(u.bw_points) || 0) + n; if (win) u.bw_wins = (Number(u.bw_wins) || 0) + 1; save(); return u.bw_points; },
    async claimDaily(key, today, day, rw) {
      const u = users[key];
      if (!u || u.daily_last === today) return null;
      u.coins += rw.coins || 0; u.gems += rw.gems || 0; u.fire = (u.fire || 0) + (rw.fire || 0);
      u.daily_last = today; u.daily_streak = day; save();
      return u;
    },
    async addBalance(key, dc, dg) {
      const u = users[key];
      if (!u) return null;
      u.coins = Math.max(0, u.coins + dc); u.gems = Math.max(0, u.gems + dg); save();
      return u;
    },
    async all() { return Object.values(users).map((u) => ({ ...u })); },
    async raw(key) { return users[key] || null; },
    async adminUpdate(key, f) { const u = users[key]; if (!u) return null; Object.assign(u, f); save(); return u; },
    async setCreds(key, salt, hash) { const u = users[key]; if (!u) return null; u.salt = salt; u.hash = hash; u.tokens = []; save(); return u; },
    async remove(key) { if (!users[key]) return false; delete users[key]; save(); return true; },
    async setPw(key, enc) { const u = users[key]; if (!u) return false; u.pw = enc; save(); return true; },
    async importUser(u, overwrite) { if (users[u.key] && !overwrite) return "skipped"; const had = !!users[u.key]; users[u.key] = u; save(); return had ? "updated" : "added"; },
    async addBalanceAll(dc, dg) { let n = 0; for (const k in users) { const u = users[k]; u.coins = Math.max(0, u.coins + dc); u.gems = Math.max(0, u.gems + dg); n++; } if (n) save(); return n; },
    async setRank(key, rank) { const u = users[key]; if (!u) return null; u.rank = rank; save(); return u; },
    async setOp(key, op) { const u = users[key]; if (!u) return null; u.op = !!op; save(); return u; },
    async setMute(key, until, by, reason) { const u = users[key]; if (!u) return null; u.mute_until = until; u.mute_by = by; u.mute_reason = reason; save(); return u; },
    async setBan(key, until, by, reason) { const u = users[key]; if (!u) return null; u.ban_until = until; u.ban_by = by; u.ban_reason = reason; save(); return u; },
    async clearExpiredBans(now) { let n = 0; for (const k in users) { const u = users[k]; if (u.ban_until > 0 && u.ban_until <= now) { u.ban_until = 0; u.ban_by = ""; u.ban_reason = ""; n++; } } if (n) save(); return n; },
    async clearExpiredMutes(now) { let n = 0; for (const k in users) { const u = users[k]; if (u.mute_until > 0 && u.mute_until <= now) { u.mute_until = 0; u.mute_by = ""; u.mute_reason = ""; n++; } } if (n) save(); return n; },
  };
}

function pgStore(url) {
  const { Pool } = require("pg");
  const pool = new Pool({ connectionString: url, ssl: /localhost|127\.0\.0\.1/.test(url) ? false : { rejectUnauthorized: false }, max: 4 });
  const ready = (async () => {
    await pool.query("CREATE TABLE IF NOT EXISTS users (key TEXT PRIMARY KEY, name TEXT NOT NULL, salt TEXT NOT NULL, hash TEXT NOT NULL, tokens JSONB NOT NULL DEFAULT '[]')");
    await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS coins BIGINT NOT NULL DEFAULT 0");
    await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS gems BIGINT NOT NULL DEFAULT 0");
    await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS hats JSONB NOT NULL DEFAULT '[]'");
    await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS fire BIGINT NOT NULL DEFAULT 0");
    await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS daily_last BIGINT NOT NULL DEFAULT -1");
    await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS daily_streak INT NOT NULL DEFAULT 0");
    await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS op BOOLEAN NOT NULL DEFAULT FALSE");
    await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS rank TEXT NOT NULL DEFAULT ''");
    await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS mute_until BIGINT NOT NULL DEFAULT 0");
    await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS mute_by TEXT NOT NULL DEFAULT ''");
    await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS mute_reason TEXT NOT NULL DEFAULT ''");
    await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS ban_until BIGINT NOT NULL DEFAULT 0");
    await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS ban_by TEXT NOT NULL DEFAULT ''");
    await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS ban_reason TEXT NOT NULL DEFAULT ''");
    await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS look TEXT NOT NULL DEFAULT ''");
    await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS bw_wins BIGINT NOT NULL DEFAULT 0");
    await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS bw_points BIGINT NOT NULL DEFAULT 0");
    await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS pw TEXT NOT NULL DEFAULT ''");
    await pool.query("CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)");
  })();
  const row = (r) => (r ? { key: r.key, name: r.name, salt: r.salt, hash: r.hash, tokens: r.tokens, coins: Number(r.coins), gems: Number(r.gems), fire: Number(r.fire) || 0, daily_last: r.daily_last == null ? -1 : Number(r.daily_last), daily_streak: Number(r.daily_streak) || 0, hats: r.hats, op: r.op === true, rank: r.rank || "", mute_until: Number(r.mute_until) || 0, mute_by: r.mute_by || "", mute_reason: r.mute_reason || "", ban_until: Number(r.ban_until) || 0, ban_by: r.ban_by || "", ban_reason: r.ban_reason || "", pw: r.pw || "" } : null);
  return {
    kind: "postgres",
    async get(key) { await ready; return row((await pool.query("SELECT * FROM users WHERE key=$1", [key])).rows[0]); },
    async byToken(th) { await ready; return row((await pool.query("SELECT * FROM users WHERE tokens ? $1", [th])).rows[0]); },
    async create(u) { await ready; const r = await pool.query("INSERT INTO users(key,name,salt,hash,tokens,pw) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING", [u.key, u.name, u.salt, u.hash, JSON.stringify(u.tokens), u.pw || ""]); return r.rowCount === 1; },
    async update(u) { await ready; await pool.query("UPDATE users SET tokens=$2 WHERE key=$1", [u.key, JSON.stringify(u.tokens)]); },
    async buyHat(key, hat, price, gem) {
      await ready;
      const col = gem ? "gems" : "coins";
      const r = await pool.query(`UPDATE users SET ${col} = ${col} - $3, hats = hats || to_jsonb($2::text) WHERE key=$1 AND ${col} >= $3 AND NOT (hats ? $2::text) RETURNING *`, [key, hat, price]);
      if (r.rowCount === 1) return { user: row(r.rows[0]) };
      const u = await this.get(key);
      if (!u) return { err: "nouser" };
      return { err: u.hats.includes(hat) ? "owned" : "funds", user: u };
    },
    async top(n) {
      await ready;
      const r = await pool.query("SELECT name, look, bw_wins, bw_points FROM users ORDER BY bw_points DESC, bw_wins DESC, name ASC LIMIT $1", [n]);
      return r.rows.map((x) => ({ name: x.name, wins: Number(x.bw_wins) || 0, points: Number(x.bw_points) || 0, look: x.look || "" }));
    },
    async setLook(key, look) { await ready; return row((await pool.query("UPDATE users SET look=$2 WHERE key=$1 RETURNING *", [key, look])).rows[0]); },
    async allMeta() { await ready; const o = {}; for (const r of (await pool.query("SELECT k, v FROM meta")).rows) o[r.k] = r.v; return o; },
    async getMeta(k) { await ready; const r = await pool.query("SELECT v FROM meta WHERE k=$1", [k]); return r.rows[0] ? r.rows[0].v : null; },
    async setMeta(k, v) { await ready; await pool.query("INSERT INTO meta(k, v) VALUES($1, $2) ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v", [k, String(v)]); },
    async resetBwPoints() { await ready; const r = await pool.query("UPDATE users SET bw_points = 0 WHERE bw_points <> 0"); return r.rowCount; },
    async addBwPoints(key, n, win) { await ready; const r = await pool.query("UPDATE users SET bw_points = bw_points + $2, bw_wins = bw_wins + $3 WHERE key=$1 RETURNING bw_points", [key, n, win ? 1 : 0]); return r.rows[0] ? Number(r.rows[0].bw_points) : null; },
    async claimDaily(key, today, day, rw) {
      await ready;
      const r = await pool.query("UPDATE users SET coins = coins + $2, gems = gems + $3, fire = fire + $4, daily_last = $5, daily_streak = $6 WHERE key=$1 AND daily_last < $5 RETURNING *", [key, rw.coins || 0, rw.gems || 0, rw.fire || 0, today, day]);
      return row(r.rows[0]);
    },
    async addBalance(key, dc, dg) {
      await ready;
      const r = await pool.query("UPDATE users SET coins = GREATEST(0, coins + $2), gems = GREATEST(0, gems + $3) WHERE key=$1 RETURNING *", [key, dc, dg]);
      return row(r.rows[0]);
    },
    async all() { await ready; return (await pool.query("SELECT * FROM users ORDER BY name")).rows; },
    async raw(key) { await ready; return (await pool.query("SELECT * FROM users WHERE key=$1", [key])).rows[0] || null; },
    async adminUpdate(key, f) {
      await ready;
      const cols = { coins: 1, gems: 1, fire: 1, bw_points: 1, bw_wins: 1, daily_streak: 1, daily_last: 1, rank: 1, op: 1 };   // beyaz liste: sutun adi disaridan gelmez
      const sets = [], vals = [key];
      for (const k of Object.keys(f)) {
        if (k === "hats") { vals.push(JSON.stringify(f.hats)); sets.push("hats = $" + vals.length + "::jsonb"); }
        else if (cols[k]) { vals.push(f[k]); sets.push(k + " = $" + vals.length); }
      }
      if (!sets.length) return this.raw(key);
      const r = await pool.query("UPDATE users SET " + sets.join(", ") + " WHERE key=$1 RETURNING *", vals);
      return r.rows[0] || null;
    },
    async setCreds(key, salt, hash) { await ready; const r = await pool.query("UPDATE users SET salt=$2, hash=$3, tokens='[]'::jsonb WHERE key=$1", [key, salt, hash]); return r.rowCount === 1; },
    async remove(key) { await ready; const r = await pool.query("DELETE FROM users WHERE key=$1", [key]); return r.rowCount === 1; },
    async setPw(key, enc) { await ready; const r = await pool.query("UPDATE users SET pw=$2 WHERE key=$1", [key, enc]); return r.rowCount === 1; },
    async importUser(u, overwrite) {
      await ready;
      const vals = [u.key, u.name, u.salt, u.hash, "[]", u.coins, u.gems, JSON.stringify(u.hats), u.fire, u.daily_last, u.daily_streak, u.op, u.rank, u.mute_until, u.mute_by, u.mute_reason, u.ban_until, u.ban_by, u.ban_reason, u.look, u.bw_wins, u.bw_points, u.pw || ""];
      const cols = "key,name,salt,hash,tokens,coins,gems,hats,fire,daily_last,daily_streak,op,rank,mute_until,mute_by,mute_reason,ban_until,ban_by,ban_reason,look,bw_wins,bw_points,pw";
      const ph = vals.map((_, i) => "$" + (i + 1)).join(",").replace("$5", "$5::jsonb").replace("$8", "$8::jsonb");
      const upd = cols.split(",").filter((c) => c !== "key").map((c) => c + "=EXCLUDED." + c).join(",");
      const r = await pool.query("INSERT INTO users(" + cols + ") VALUES(" + ph + ") ON CONFLICT (key) DO " + (overwrite ? "UPDATE SET " + upd : "NOTHING") + " RETURNING (xmax = 0) AS inserted", vals);
      if (r.rowCount === 0) return "skipped";
      return r.rows[0].inserted ? "added" : "updated";
    },
    async addBalanceAll(dc, dg) { await ready; const r = await pool.query("UPDATE users SET coins = GREATEST(0, coins + $1), gems = GREATEST(0, gems + $2)", [dc, dg]); return r.rowCount; },
    async setRank(key, rank) { await ready; return row((await pool.query("UPDATE users SET rank=$2 WHERE key=$1 RETURNING *", [key, rank])).rows[0]); },
    async setOp(key, op) { await ready; return row((await pool.query("UPDATE users SET op=$2 WHERE key=$1 RETURNING *", [key, !!op])).rows[0]); },
    async setMute(key, until, by, reason) { await ready; return row((await pool.query("UPDATE users SET mute_until=$2, mute_by=$3, mute_reason=$4 WHERE key=$1 RETURNING *", [key, until, by, reason])).rows[0]); },
    async setBan(key, until, by, reason) { await ready; return row((await pool.query("UPDATE users SET ban_until=$2, ban_by=$3, ban_reason=$4 WHERE key=$1 RETURNING *", [key, until, by, reason])).rows[0]); },
    async clearExpiredBans(now) { await ready; const r = await pool.query("UPDATE users SET ban_until=0, ban_by='', ban_reason='' WHERE ban_until > 0 AND ban_until <= $1", [now]); return r.rowCount; },
    async clearExpiredMutes(now) { await ready; const r = await pool.query("UPDATE users SET mute_until=0, mute_by='', mute_reason='' WHERE mute_until > 0 AND mute_until <= $1", [now]); return r.rowCount; },
  };
}

const store = process.env.DATABASE_URL ? pgStore(process.env.DATABASE_URL) : fileStore();
console.log("Hesap depolama: " + store.kind);
async function saveOverrides() {
  const def = hatsFile() || HATS_DEFAULT, d = {};
  for (const k of Object.keys(HATS)) if (HATS[k] !== def[k]) d[k] = HATS[k];
  await store.setMeta("hat_prices", Object.keys(d).length ? JSON.stringify(d) : "");
}
(async () => {
  try { const v = await store.getMeta("hat_prices"); if (v) { const n = applyPrices(JSON.parse(v)); if (n) console.log("Panelden degistirilen esya fiyatlari yuklendi (" + n + ")"); } }
  catch (e) { console.error("fiyatlar yuklenemedi", e.message); }
})();

// ------------------------------------------------------------ yardimcilar
async function issueToken(u) {
  const token = crypto.randomBytes(32).toString("hex");
  u.tokens = [...u.tokens, sha(token)].slice(-MAX_TOKENS);
  await store.update(u);
  return token;
}

async function register(name, password) {
  name = String(name || "").trim();
  password = String(password || "");
  if (!NAME_RE.test(name)) return { status: 400, error: "Isim 3-16 karakter olmali (harf, rakam, _)" };
  if (password.length < 6 || password.length > 64) return { status: 400, error: "Sifre en az 6 karakter olmali" };
  const salt = crypto.randomBytes(16).toString("hex");
  const u = { key: name.toLowerCase(), name, salt, hash: await scrypt(password, salt), tokens: [], coins: 0, gems: 0, fire: 0, daily_last: -1, daily_streak: 0, hats: [], op: false, rank: "", pw: encPw(password) };
  if (!(await store.create(u))) return { status: 409, error: "Bu isim zaten alinmis" };
  return { status: 200, ok: true, token: await issueToken(u), ...profile(u) };
}

async function login(name, password) {
  name = String(name || "").trim();
  const u = await store.get(name.toLowerCase());
  const salt = u ? u.salt : "0".repeat(32);
  const h = await scrypt(String(password || ""), salt);          // kullanici yoksa da ayni sure harcanir
  if (!u || !crypto.timingSafeEqual(Buffer.from(h, "hex"), Buffer.from(u.hash, "hex"))) return { status: 401, error: "Isim veya sifre yanlis" };
  const bn = banInfo(u);
  if (bn) return { status: 403, banned: true, error: banText(bn) };      // banli hesap giremez
  if (!u.pw && ADMIN_KEY) { try { await store.setPw(u.key, encPw(String(password || ""))); } catch (e) {} }   // eski hesaplar: sifre giriste yedege girer
  return { status: 200, ok: true, token: await issueToken(u), ...profile(u) };
}

// oyuncunun istemciye giden hali (hash / token YOK). prices: sapka fiyatlari (sunucudaki hats.json)
function profile(u) {
  return { name: u.name, coins: u.coins || 0, gems: u.gems || 0, fire: u.fire || 0, hats: u.hats || [], prices: HATS, daily: dailyInfo(u), op: u.op === true, rank: u.rank || "" };
}

// Gunluk odul durumu: done = bu dongude alinan gun sayisi (0-7), can_claim = bugun alabilir mi, next_in = gece yarisina kalan sn
function dailyInfo(u) {
  const today = dayNum();
  const last = Number.isFinite(u.daily_last) ? u.daily_last : -1;
  const streak = Math.min(7, Math.max(0, Number(u.daily_streak) || 0));
  let done = 0;
  if (last === today) done = streak;                                  // bugun zaten aldi
  else if (last === today - 1) done = streak >= 7 ? 0 : streak;       // dun aldiysa seri devam, 7. gunden sonra bastan
  return { done, can_claim: last !== today, next_in: secondsToNextDay(), rewards: DAILY };
}

async function userByToken(token) {
  if (typeof token !== "string" || token.length !== 64) return null;
  return await store.byToken(sha(token));
}

// Oyuncu var mi? Varsa gorunen ismini dondurur (sosyal.js arkadas istegi icin)
async function lookupName(name) {
  name = String(name || "").trim();
  if (!NAME_RE.test(name)) return null;
  const u = await store.get(name.toLowerCase());
  return u ? u.name : null;
}

async function verify(token) {
  const u = await userByToken(token);
  return u ? u.name : null;
}

// WebSocket "hello": isim + rank + op (hepsi hesaptan gelir, istemci taklit edemez)
async function verifyUser(token) {
  const u = await userByToken(token);
  if (u && banInfo(u)) return { banned: banInfo(u), name: u.name };
  return u ? { name: u.name, rank: u.rank || "", op: u.op === true, mute: muteInfo(u) } : null;
}

// Sapka satin al: fiyati SUNUCU belirler (istemciden gelen fiyata guvenilmez). Basarili olursa hesaba sonsuza kadar eklenir.
async function buyHat(token, hat) {
  const u = await userByToken(token);
  if (!u) return { status: 401, error: "Oturum gecersiz" };
  hat = String(hat || "");
  if (!Object.prototype.hasOwnProperty.call(HATS, hat)) return { status: 400, error: "Boyle bir sapka yok" };
  const gem = GEM_ITEMS.has(hat);
  const r = await store.buyHat(u.key, hat, HATS[hat], gem);
  if (r.err === "owned") return { status: 409, error: "Bu sapka zaten senin", ...profile(r.user) };
  if (r.err === "funds") return { status: 402, error: gem ? "Yeterli elmasin yok" : "Yeterli altinin yok", ...profile(r.user) };
  if (r.err) return { status: 404, error: "Hesap bulunamadi" };
  return { status: 200, ok: true, ...profile(r.user) };
}

// GUNLUK ODUL AL: gunde 1 kez. Hangi gun / ne verecegi tamamen sunucuda hesaplanir.
async function dailyClaim(token) {
  const u = await userByToken(token);
  if (!u) return { status: 401, error: "Oturum gecersiz" };
  const info = dailyInfo(u);
  if (!info.can_claim) return { status: 409, error: "Bugünkü ödülü zaten aldın", ...profile(u) };
  const day = info.done + 1;
  const rw = DAILY[day - 1];
  const r = await store.claimDaily(u.key, dayNum(), day, rw);
  if (!r) return { status: 409, error: "Bugünkü ödülü zaten aldın", ...profile((await store.get(u.key)) || u) };
  return { status: 200, ok: true, day, reward: rw, ...profile(r) };
}

// HAFTALIK SIRALAMA ODULU: her hafta (Pazartesi 00:00, Turkiye saati) siralama SIFIRLANIR; sifirlanmadan once ilk 5'e elmas verilir.
// Puani 0 olan oyuncu odul alamaz. Zafer (bw_wins) sifirlanmaz.
const WEEKLY_GEMS = [350, 300, 250, 200, 150];     // 1. ... 5. sira
const weekNum = () => Math.floor((dayNum() + 3) / 7);   // 1 Ocak 1970 Persembe: +3 ile hafta Pazartesi baslar
const secondsToNextWeek = () => Math.max(1, Math.ceil(((weekNum() + 1) * 7 - 3) * 86400 - (Date.now() + TZ_MS) / 1000));
let settling = false;
async function settleSeason() {
  if (settling) return;
  settling = true;
  try {
    const cur = weekNum();
    const last = await store.getMeta("bw_season");
    if (last == null) { await store.setMeta("bw_season", String(cur)); return; }   // ilk kurulum: sezon simdi basliyor, odul yok
    if (Number(last) >= cur) return;
    await store.setMeta("bw_season", String(cur));        // once isaretle: cokme olursa iki kez odul verilmez
    const rows = await store.top(WEEKLY_GEMS.length);
    for (let i = 0; i < rows.length && i < WEEKLY_GEMS.length; i++) {
      if (!(rows[i].points > 0)) continue;
      await store.addBalance(String(rows[i].name).toLowerCase(), 0, WEEKLY_GEMS[i]);
      console.log("Haftalik odul: " + (i + 1) + ". " + rows[i].name + " (" + rows[i].points + " puan) -> " + WEEKLY_GEMS[i] + " elmas");
    }
    const n = await store.resetBwPoints();
    topCache.at = 0;
    console.log("Haftalik siralama sifirlandi (" + n + " oyuncu)");
  } catch (e) { console.error("haftalik odul hatasi", e); }
  finally { settling = false; }
}
setTimeout(() => settleSeason(), 5000).unref();
setInterval(() => settleSeason(), 60000).unref();

// SIRALAMA (BedWars): ilk 50 oyuncu -> isim, zafer, puan ve oyuncunun giydigi skin ("look", yuz cizmek icin).
// Puan: yatak kirinca /bw_points ile artar (bw_points). Mac kazanma da bw_wins'i artirir. 10 sn onbellek -> veritabani yorulmaz.
const TOP_N = 50;
let topCache = { at: 0, list: [] };
async function leaderboard() {
  if (Date.now() - topCache.at > 10000) {
    const rows = await store.top(TOP_N);
    topCache = { at: Date.now(), list: rows.map((r) => { let look = {}; try { look = JSON.parse(r.look || "{}") || {}; } catch (e) {} return { name: r.name, wins: r.wins, points: r.points, look }; }) };
  }
  return topCache.list;
}

// OYUNCUNUN SKINI: sadece skin kimlikleri/renk kodlari (kisa, harf-rakam-#-_) kabul edilir. Siralamada yuz olarak gorunur.
const LOOK_KEYS = ["pskin", "skin", "eye", "hair", "cloth"];
async function lookSet(body) {
  const u = await userByToken(body.token);
  if (!u) return { status: 401, error: "Oturum gecersiz" };
  const src = body.look && typeof body.look === "object" ? body.look : {};
  const look = {};
  for (const k of LOOK_KEYS) {
    const v = typeof src[k] === "string" ? src[k] : "";
    if (v && /^[A-Za-z0-9_#]{1,16}$/.test(v)) look[k] = v;
  }
  const json = JSON.stringify(look);
  await store.setLook(u.key, json);
  topCache.at = 0;   // yeni skin siralamada hemen gorunsun
  return { status: 200, ok: true };
}

// ------------------------------------------------------------ SUSTURMA (/mute)
// Susturma HESABA bagli ve veritabaninda (ya da users.json'da) saklanir -> sunucu kapanip acilsa da gitmez.
// Sadece sure dolunca silinir (asagidaki sweepMutes her dakika temizler; kontrol de her zaman bitis zamanina bakar).
const MUTE_UNITS = { dk: 60e3, s: 3600e3, g: 86400e3, h: 604800e3 };   // dk = dakika, s = saat, g = gun, h = hafta
const MUTE_MAX_MS = 365 * 86400e3;                                       // en fazla 1 yil
function parseDuration(v) {
  const m = /^(\d{1,4})(dk|s|g|h)$/i.exec(String(v || "").trim());
  if (!m) return 0;
  const ms = Number(m[1]) * MUTE_UNITS[m[2].toLowerCase()];
  return ms > 0 && ms <= MUTE_MAX_MS ? ms : 0;
}
// aktif susturma varsa {until, by, reason}, yoksa null
function muteInfo(u) {
  if (!u || !(u.mute_until > Date.now())) return null;
  return { until: u.mute_until, by: u.mute_by || "Yetkili", reason: u.mute_reason || "Belirtilmedi" };
}
let muteListener = null;     // server.js: susturma degisince bagli oyuncuya haber verir
const setMuteListener = (fn) => { muteListener = fn; };
const notifyMute = (u) => { if (muteListener) { try { muteListener(u.name, muteInfo(u)); } catch (e) { console.error("mute bildirimi", e); } } };
async function sweepMutes() { try { await store.clearExpiredMutes(Date.now()); } catch (e) { console.error("mute temizligi", e); } }
sweepMutes();
setInterval(sweepMutes, 60000).unref();

// SUSTUR: istegi atan OP olmali (kontrol SUNUCUDA). duration: 30dk / 1s (saat) / 1g (gun) / 1h (hafta)
async function muteSet(body) {
  const me = await userByToken(body.token);
  if (!me) return { status: 401, error: "Oturum gecersiz" };
  if (me.op !== true) return { status: 403, error: "Bu islem sadece OP'ler icin" };
  const target = await store.get(String(body.name || "").trim().toLowerCase());
  if (!target) return { status: 404, error: "Oyuncu bulunamadı" };
  if (target.op === true) return { status: 409, error: "OP'ler susturulamaz" };
  const ms = parseDuration(body.duration);
  if (!ms) return { status: 400, error: "Geçersiz süre. Örnek: 1s (saat), 1g (gün), 1h (hafta)" };
  const reason = String(body.reason || "").replace(/[\u0000-\u001f]+/g, " ").trim().slice(0, 80) || "Belirtilmedi";
  const r = await store.setMute(target.key, Date.now() + ms, me.name, reason);
  if (!r) return { status: 404, error: "Oyuncu bulunamadı" };
  notifyMute(r);
  return { status: 200, ok: true, name: r.name, left: Math.ceil(ms / 1000), reason };
}

async function unmuteSet(body) {
  const me = await userByToken(body.token);
  if (!me) return { status: 401, error: "Oturum gecersiz" };
  if (me.op !== true) return { status: 403, error: "Bu islem sadece OP'ler icin" };
  const target = await store.get(String(body.name || "").trim().toLowerCase());
  if (!target) return { status: 404, error: "Oyuncu bulunamadı" };
  const was = !!muteInfo(target);
  const r = await store.setMute(target.key, 0, "", "");
  if (!r) return { status: 404, error: "Oyuncu bulunamadı" };
  notifyMute(r);
  return { status: 200, ok: true, name: r.name, was_muted: was };
}

// ------------------------------------------------------------ BAN (/panel > Ban)
// Ban HESABA bagli ve kalici saklanir. Banli hesap giris yapamaz; banlandigi anda tokenlari silinir ve bagli oyuncu sunucudan atilir.
// Sure: 30dk / 1s (saat) / 1g (gun) / 1h (hafta) ya da "kalici" (sonsuz).
const BAN_PERM = 32503680000000;      // yil 3000 = kalici ban
function parseBanDuration(v) {
  const t = String(v || "").trim().toLowerCase();
  if (t === "kalici" || t === "kalıcı" || t === "perm" || t === "surekli") return BAN_PERM - Date.now();
  return parseDuration(t);
}
function banInfo(u) {
  if (!u || !(u.ban_until > Date.now())) return null;
  return { until: u.ban_until, by: u.ban_by || "Yetkili", reason: u.ban_reason || "Belirtilmedi", perm: u.ban_until >= BAN_PERM - 86400e3 };
}
function fmtLeft(ms) {
  let s = Math.max(1, Math.ceil(ms / 1000));
  const w = Math.floor(s / 604800); s %= 604800;
  const d = Math.floor(s / 86400); s %= 86400;
  const h = Math.floor(s / 3600); s %= 3600;
  const m = Math.floor(s / 60);
  const out = [];
  if (w) out.push(w + " hafta");
  if (d) out.push(d + " gün");
  if (h) out.push(h + " saat");
  if (m && !w && !d) out.push(m + " dakika");
  return out.length ? out.join(" ") : s + " saniye";
}
function banText(b) {
  return b.by + " Yetkilisi Tarafından Banlandınız\nSebep: " + b.reason + "\nKalan süre: " + (b.perm ? "Kalıcı" : fmtLeft(b.until - Date.now()));
}
let banListener = null;      // server.js: banlanan oyuncu bagliysa sunucudan atar
const setBanListener = (fn) => { banListener = fn; };
async function sweepBans() { try { await store.clearExpiredBans(Date.now()); } catch (e) { console.error("ban temizligi", e); } }
sweepBans();
setInterval(sweepBans, 60000).unref();

async function banSet(body) {
  const me = await userByToken(body.token);
  if (!me) return { status: 401, error: "Oturum gecersiz" };
  if (me.op !== true) return { status: 403, error: "Bu islem sadece OP'ler icin" };
  const target = await store.get(String(body.name || "").trim().toLowerCase());
  if (!target) return { status: 404, error: "Oyuncu bulunamadı" };
  if (target.op === true) return { status: 409, error: "OP'ler banlanamaz" };
  const ms = parseBanDuration(body.duration);
  if (!ms) return { status: 400, error: "Geçersiz süre. Örnek: 1s (saat), 1g (gün), 1h (hafta), kalici" };
  const reason = String(body.reason || "").replace(/[\u0000-\u001f]+/g, " ").trim().slice(0, 80) || "Belirtilmedi";
  const r = await store.setBan(target.key, Date.now() + ms, me.name, reason);
  if (!r) return { status: 404, error: "Oyuncu bulunamadı" };
  r.tokens = [];                         // tum oturumlari kapat
  await store.update(r);
  if (banListener) { try { banListener(r.name, banInfo(r)); } catch (e) { console.error("ban bildirimi", e); } }
  const bi = banInfo(r);
  return { status: 200, ok: true, name: r.name, left: Math.ceil(ms / 1000), perm: !!(bi && bi.perm), reason };
}

async function unbanSet(body) {
  const me = await userByToken(body.token);
  if (!me) return { status: 401, error: "Oturum gecersiz" };
  if (me.op !== true) return { status: 403, error: "Bu islem sadece OP'ler icin" };
  const target = await store.get(String(body.name || "").trim().toLowerCase());
  if (!target) return { status: 404, error: "Oyuncu bulunamadı" };
  const was = !!banInfo(target);
  const r = await store.setBan(target.key, 0, "", "");
  if (!r) return { status: 404, error: "Oyuncu bulunamadı" };
  return { status: 200, ok: true, name: r.name, was_banned: was };
}

// RANK VER: istegi atan hesap OP olmali (kontrol SUNUCUDA, veritabanindaki op alanindan). rank = "" -> rankini kaldirir.
async function rankSet(body) {
  const me = await userByToken(body.token);
  if (!me) return { status: 401, error: "Oturum gecersiz" };
  if (me.op !== true) return { status: 403, error: "Bu islem sadece OP'ler icin" };
  const rank = String(body.rank || "").trim();
  if (rank !== "" && !RANKS.includes(rank)) return { status: 400, error: "Boyle bir rank yok" };
  const target = await store.get(String(body.name || "").trim().toLowerCase());
  if (!target) return { status: 404, error: "Oyuncu bulunamadi" };
  const r = await store.setRank(target.key, rank);
  if (!r) return { status: 404, error: "Oyuncu bulunamadi" };
  if (rankListener) { try { rankListener(r.name, r.rank || ""); } catch (e) { console.error("rank bildirimi", e); } }
  return { status: 200, ok: true, name: r.name, rank: r.rank || "" };
}

// ADMIN (sadece Render'daki ADMIN_KEY'i bilen): oyuncuya altin / elmas ver (negatif = al).
function adminOk(key) {
  if (!ADMIN_KEY || typeof key !== "string") return false;
  const a = crypto.createHash("sha256").update(key).digest();
  const b = crypto.createHash("sha256").update(ADMIN_KEY).digest();
  return crypto.timingSafeEqual(a, b);
}
const amount = (v) => { const n = Math.trunc(Number(v) || 0); return Math.abs(n) <= 1e9 ? n : 0; };

async function adminGive(body) {
  const u = await store.get(String(body.name || "").trim().toLowerCase());
  if (!u) return { status: 404, error: "Oyuncu bulunamadi" };
  const r = await store.addBalance(u.key, amount(body.coins), amount(body.gems));
  return { status: 200, ok: true, name: r.name, coins: r.coins, gems: r.gems, hats: r.hats, op: r.op === true, rank: r.rank || "" };
}

// OP ver / al (ADMIN_KEY ile, /admin sayfasindan)
async function adminOp(body) {
  const u = await store.get(String(body.name || "").trim().toLowerCase());
  if (!u) return { status: 404, error: "Oyuncu bulunamadi" };
  const on = body.op === true || body.op === "true" || body.op === 1 || body.op === "1";
  const r = await store.setOp(u.key, on);
  return { status: 200, ok: true, name: r.name, op: r.op === true };
}

// ---- HESAP DUZENLEME (admin sayfasi > Oyuncular)
let userPurge = null;       // social.js: silinen hesabin arkadaslik / sohbet izlerini temizler
function setUserPurge(fn) { userPurge = fn; }
const lowName = (v) => String(v || "").trim().toLowerCase();
const num0 = (v) => Number(v) || 0;
const clampInt = (v, lo, hi) => { const n = Math.trunc(Number(v)); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : null; };
function adminView(u) {
  return { name: u.name, coins: num0(u.coins), gems: num0(u.gems), fire: num0(u.fire), bw_points: num0(u.bw_points), bw_wins: num0(u.bw_wins), daily_streak: num0(u.daily_streak),
    hats: Array.isArray(u.hats) ? u.hats : [], rank: u.rank || "", op: u.op === true, ban: banInfo(u), mute: muteInfo(u) };
}
async function adminPlayers(body) {
  const q = lowName(body.q);
  let rows = await store.all();
  const total = rows.length;
  if (q) rows = rows.filter((u) => String(u.name).toLowerCase().includes(q));
  const sorts = { coins: (a, b) => num0(b.coins) - num0(a.coins), gems: (a, b) => num0(b.gems) - num0(a.gems), points: (a, b) => num0(b.bw_points) - num0(a.bw_points) };
  const byName = (a, b) => String(a.name).localeCompare(String(b.name));
  const cmp = sorts[body.sort];
  rows.sort(cmp ? (a, b) => cmp(a, b) || byName(a, b) : byName);
  const players = rows.slice(0, 100).map((u) => ({ name: u.name, coins: num0(u.coins), gems: num0(u.gems), bw_points: num0(u.bw_points), rank: u.rank || "", op: u.op === true, banned: !!banInfo(u), muted: !!muteInfo(u) }));
  return { status: 200, ok: true, total, matched: rows.length, players };
}
async function adminPlayer(body) {
  const u = await store.raw(lowName(body.name));
  if (!u) return { status: 404, error: "Oyuncu bulunamadi" };
  return { status: 200, ok: true, player: adminView(u), all_hats: Object.keys(HATS), ranks: RANKS };
}
async function adminUpdateHandler(body) {
  const key = lowName(body.name);
  const u = await store.raw(key);
  if (!u) return { status: 404, error: "Oyuncu bulunamadi" };
  const oldRank = u.rank || "";
  const oldHats = new Set(Array.isArray(u.hats) ? u.hats : []);
  const f = {};
  for (const k of ["coins", "gems", "fire", "bw_points", "bw_wins"]) {
    if (body[k] === undefined || body[k] === "") continue;
    const v = clampInt(body[k], 0, 1e9);
    if (v === null) return { status: 400, error: "Gecersiz sayi: " + k };
    f[k] = v;
  }
  if (body.daily_streak !== undefined && body.daily_streak !== "") {
    const v = clampInt(body.daily_streak, 0, 7);
    if (v === null) return { status: 400, error: "Gecersiz gunluk seri" };
    f.daily_streak = v;
  }
  if (body.reset_daily === true) f.daily_last = -1;
  if (Array.isArray(body.hats)) {
    const list = [];
    for (const h of body.hats) {
      if (typeof h !== "string") continue;
      if (HATS[h] === undefined && !oldHats.has(h)) return { status: 400, error: "Bilinmeyen esya: " + h };
      if (!list.includes(h)) list.push(h);
    }
    f.hats = list;
  }
  if (body.rank !== undefined) {
    const rk = String(body.rank).trim();
    if (rk !== "" && !RANKS.includes(rk)) return { status: 400, error: "Boyle bir rank yok" };
    f.rank = rk;
  }
  if (body.op !== undefined) f.op = body.op === true;
  if (!Object.keys(f).length) return { status: 400, error: "Degisiklik yok" };
  const r = await store.adminUpdate(key, f);
  if (!r) return { status: 404, error: "Oyuncu bulunamadi" };
  if (f.rank !== undefined && f.rank !== oldRank && rankListener) { try { rankListener(r.name, r.rank || ""); } catch (e) { console.error("rank bildirimi", e); } }
  if (f.bw_points !== undefined || f.bw_wins !== undefined) topCache.at = 0;
  console.log("ADMIN duzenledi: " + r.name + " -> " + Object.keys(f).join(", "));
  return { status: 200, ok: true, player: adminView(r) };
}
async function adminPunish(body) {
  const key = lowName(body.name);
  const u = await store.raw(key);
  if (!u) return { status: 404, error: "Oyuncu bulunamadi" };
  const type = String(body.type || "");
  const reason = String(body.reason || "").replace(/[\u0000-\u001f]+/g, " ").trim().slice(0, 80) || "Belirtilmedi";
  if (type === "ban") {
    const ms = parseBanDuration(body.duration);
    if (!ms) return { status: 400, error: "Gecersiz sure. Ornek: 30dk, 1s, 1g, 1h, kalici" };
    const r = await store.setBan(key, Date.now() + ms, "Admin", reason);
    if (!r) return { status: 404, error: "Oyuncu bulunamadi" };
    r.tokens = [];
    await store.update(r);
    if (banListener) { try { banListener(r.name, banInfo(r)); } catch (e) { console.error("ban bildirimi", e); } }
    return { status: 200, ok: true };
  }
  if (type === "unban") { const r = await store.setBan(key, 0, "", ""); return r ? { status: 200, ok: true } : { status: 404, error: "Oyuncu bulunamadi" }; }
  if (type === "mute") {
    const ms = parseDuration(body.duration);
    if (!ms) return { status: 400, error: "Gecersiz sure. Ornek: 30dk, 1s, 1g, 1h" };
    const r = await store.setMute(key, Date.now() + ms, "Admin", reason);
    if (!r) return { status: 404, error: "Oyuncu bulunamadi" };
    notifyMute(r);
    return { status: 200, ok: true };
  }
  if (type === "unmute") { const r = await store.setMute(key, 0, "", ""); if (!r) return { status: 404, error: "Oyuncu bulunamadi" }; notifyMute(r); return { status: 200, ok: true }; }
  return { status: 400, error: "Bilinmeyen islem" };
}
async function adminSetPass(body) {
  const key = lowName(body.name);
  const pw = String(body.password || "");
  if (pw.length < 6 || pw.length > 64) return { status: 400, error: "Sifre 6-64 karakter olmali" };
  const salt = crypto.randomBytes(16).toString("hex");
  const ok = await store.setCreds(key, salt, await scrypt(pw, salt));
  if (!ok) return { status: 404, error: "Oyuncu bulunamadi" };
  await store.setPw(key, encPw(pw));
  console.log("ADMIN sifre degistirdi: " + key);
  return { status: 200, ok: true };
}
async function adminDelete(body) {
  const key = lowName(body.name);
  const u = await store.raw(key);
  if (!u) return { status: 404, error: "Oyuncu bulunamadi" };
  if (String(body.confirm || "") !== u.name) return { status: 400, error: "Onay ismi uyusmadi" };
  if (!(await store.remove(key))) return { status: 404, error: "Oyuncu bulunamadi" };
  if (userPurge) { try { userPurge(key); } catch (e) { console.error("sosyal temizlik", e); } }
  topCache.at = 0;
  console.log("ADMIN hesap sildi: " + u.name);
  return { status: 200, ok: true };
}

// HERKESE altin / elmas (negatif = geri al)
async function adminGiveAll(body) {
  const c = amount(body.coins), g = amount(body.gems);
  if (!c && !g) return { status: 400, error: "Altin veya elmas miktari gir" };
  const n = await store.addBalanceAll(c, g);
  console.log("ADMIN herkese: " + c + " altin, " + g + " elmas -> " + n + " oyuncu");
  return { status: 200, ok: true, players: n, coins: c, gems: g };
}

// VERI INDIR: json = tam yedek (hesaplar + arkadaslik/sohbet), csv = oyuncu listesi. Oturum anahtarlari (tokens) dosyaya KONMAZ.
let extraExport = null;
function setExtraExport(fn) { extraExport = fn; }
const csvCell = (v) => { const t = String(v == null ? "" : v); return /[",\n;]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t; };
// ---- minik ZIP yazici (ek paket gerekmez): dosyalar deflate ile sikistirilir
const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(buf) { let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function makeZip(files) {
  const zlib = require("zlib");
  const d = new Date();
  const dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const dosDate = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  const parts = [], central = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, "utf8");
    const raw = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data, "utf8");
    const comp = zlib.deflateRawSync(raw, { level: 9 });
    const crc = crc32(raw);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(8, 8);
    lh.writeUInt16LE(dosTime, 10); lh.writeUInt16LE(dosDate, 12); lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(raw.length, 22); lh.writeUInt16LE(name.length, 26); lh.writeUInt16LE(0, 28);
    parts.push(lh, name, comp);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(8, 10);
    ch.writeUInt16LE(dosTime, 12); ch.writeUInt16LE(dosDate, 14); ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(raw.length, 24); ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(offset, 42);
    central.push(ch, name);
    offset += lh.length + name.length + comp.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, end]);
}

const NUM_COLS = ["coins", "gems", "fire", "daily_last", "daily_streak", "bw_wins", "bw_points", "mute_until", "ban_until"];
async function exportParts() {
  const rows = await store.all();
  const nowMs = Date.now();
  const users = rows.map((u) => { const { tokens, pw, ...rest } = u; rest.sifre = decPw(pw); for (const k of NUM_COLS) if (rest[k] !== undefined && rest[k] !== null) rest[k] = Number(rest[k]) || 0; return rest; });   // oturum anahtarlari (tokens) konmaz
  let social = null;
  try { social = extraExport ? extraExport() : null; } catch (e) {}
  let meta = {};
  try { meta = await store.allMeta(); } catch (e) {}
  const head = ["isim", "altin", "elmas", "ates", "bw_puan", "bw_zafer", "rank", "op", "sapka_sayisi", "gunluk_seri", "ban", "susturma"];
  const lines = [head.join(",")];
  for (const u of users) {
    lines.push([u.name, u.coins || 0, u.gems || 0, u.fire || 0, u.bw_points || 0, u.bw_wins || 0, u.rank || "", u.op === true ? 1 : 0,
      Array.isArray(u.hats) ? u.hats.length : 0, u.daily_streak || 0, u.ban_until > nowMs ? 1 : 0, u.mute_until > nowMs ? 1 : 0].map(csvCell).join(","));
  }
  return { users, social, meta, csv: "\ufeff" + lines.join("\r\n"), day: new Date().toISOString().slice(0, 10), at: new Date().toISOString() };
}
function backupZip(x) {
    const info = "OYUN YEDEGI\r\nTarih: " + x.at + "\r\nDepolama: " + store.kind + "\r\nOyuncu sayisi: " + x.users.length + "\r\n\r\n"
      + "hesaplar.json   : tum hesaplar (altin, elmas, esyalar, rank, OP, puan, ban/susturma, sifre ozetleri ve sifre alani = duz sifre). Oturum anahtarlari yoktur.\r\n"
      + "sosyal.json     : arkadaslik, istekler ve sohbet mesajlari\r\n"
      + "sezon.json      : haftalik siralama sezon bilgisi + panelden degistirilen esya fiyatlari\r\n"
      + "oyuncular.csv   : Excel / Google Sheets icin ozet liste\r\n\r\n"
      + "DIKKAT: Bu dosyalar DUZ SIFRELERI, sifre ozetleri ve ozel mesajlar icerir. Kimseyle paylasma.\r\n";
  const zip = makeZip([
      { name: "BENI_OKU.txt", data: info },
      { name: "hesaplar.json", data: JSON.stringify({ exported_at: x.at, storage: store.kind, user_count: x.users.length, users: x.users }, null, 1) },
      { name: "sosyal.json", data: JSON.stringify(x.social || {}, null, 1) },
      { name: "sezon.json", data: JSON.stringify(x.meta || {}, null, 1) },
      { name: "oyuncular.csv", data: x.csv },
    ]);
  return zip;
}
async function adminExport(body, res) {
  const x = await exportParts();
  const send = (type, name, data) => { res.writeHead(200, { "Content-Type": type, "Content-Disposition": 'attachment; filename="' + name + '"', "Cache-Control": "no-store" }); res.end(data); };
  if (body.format === "csv") return send("text/csv; charset=utf-8", "oyuncular-" + x.day + ".csv", x.csv);
  if (body.format === "zip") {
    const zip = backupZip(x);
    console.log("ADMIN zip yedek indirdi (" + x.users.length + " oyuncu, " + zip.length + " bayt)");
    return send("application/zip", "oyun-yedek-" + x.day + ".zip", zip);
  }
  return send("application/json; charset=utf-8", "oyun-yedek-" + x.day + ".json", JSON.stringify({ exported_at: x.at, storage: store.kind, user_count: x.users.length, users: x.users, social: x.social, meta: x.meta }, null, 1));
}

// ---- YEDEK YUKLE (admin > Yedek): indirilen oyun-yedek-*.zip (veya .json) dosyasini sunucuya geri yukler.
// Hesaplar (isim, sifre ozeti, altin, elmas, esyalar, rank, puan...) ve arkadaslik / sohbet verisi geri gelir.
// Oturum anahtarlari (tokens) yedekte yoktur: oyuncular ayni isim + sifreyle tekrar giris yapar.
let extraImport = null;
function setExtraImport(fn) { extraImport = fn; }
function unzip(buf) {       // minik ZIP okuyucu (makeZip ile yazilan veya normal zip dosyalari)
  const zlib = require("zlib");
  let e = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { e = i; break; }
  if (e < 0) throw new Error("Bu bir ZIP dosyasi degil");
  const total = buf.readUInt16LE(e + 10);
  let p = buf.readUInt32LE(e + 16);
  const out = {};
  for (let n = 0; n < total; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("ZIP bozuk");
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20), nlen = buf.readUInt16LE(p + 28), elen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32), off = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nlen).toString("utf8");
    const lnlen = buf.readUInt16LE(off + 26), lelen = buf.readUInt16LE(off + 28);
    const data = buf.slice(off + 30 + lnlen + lelen, off + 30 + lnlen + lelen + csize);
    if (!name.endsWith("/")) out[name.split("/").pop()] = method === 0 ? data : zlib.inflateRawSync(data);
    p += 46 + nlen + elen + clen;
  }
  return out;
}
const HEX = /^[0-9a-f]+$/i;
const intOr = (v, d) => { const n = Number(v); return Number.isFinite(n) ? Math.trunc(n) : d; };
function cleanUser(x) {     // yedekteki bir hesabi dogrula + temizle. Gecersizse null.
  if (!x || typeof x !== "object") return null;
  const name = String(x.name || "").trim();
  if (!NAME_RE.test(name)) return null;
  const salt = String(x.salt || ""), hash = String(x.hash || "");
  if (salt.length < 16 || salt.length > 64 || !HEX.test(salt) || hash.length !== 128 || !HEX.test(hash)) return null;
  const str = (v, m) => (typeof v === "string" ? v.slice(0, m) : "");
  return {
    key: name.toLowerCase(), name, salt, hash, tokens: [],
    coins: Math.max(0, intOr(x.coins, 0)), gems: Math.max(0, intOr(x.gems, 0)), fire: Math.max(0, intOr(x.fire, 0)),
    daily_last: intOr(x.daily_last, -1), daily_streak: Math.min(7, Math.max(0, intOr(x.daily_streak, 0))),
    hats: Array.isArray(x.hats) ? x.hats.filter((h) => typeof h === "string" && h.length <= 64).slice(0, 500) : [],
    op: x.op === true, rank: RANKS.includes(x.rank) ? x.rank : "",
    mute_until: Math.max(0, intOr(x.mute_until, 0)), mute_by: str(x.mute_by, 64), mute_reason: str(x.mute_reason, 200),
    ban_until: Math.max(0, intOr(x.ban_until, 0)), ban_by: str(x.ban_by, 64), ban_reason: str(x.ban_reason, 200),
    look: str(x.look, 2000), pw: typeof x.sifre === "string" && x.sifre ? encPw(x.sifre.slice(0, 64)) : "", bw_wins: Math.max(0, intOr(x.bw_wins, 0)), bw_points: Math.max(0, intOr(x.bw_points, 0)),
  };
}
async function adminImport(body) {
  if (typeof body.zip !== "string" || !body.zip) return { status: 400, error: "Dosya gelmedi" };
  let hes = null, soc = null, metaObj = null;
  try {
    const buf = Buffer.from(body.zip, "base64");
    if (buf.length > 3 && buf[0] === 0x50 && buf[1] === 0x4b) {          // ZIP
      const f = unzip(buf);
      if (!f["hesaplar.json"]) return { status: 400, error: "ZIP icinde hesaplar.json yok (oyun-yedek zip'i degil)" };
      hes = JSON.parse(f["hesaplar.json"].toString("utf8"));
      if (f["sosyal.json"]) { try { soc = JSON.parse(f["sosyal.json"].toString("utf8")); } catch (e) {} }
      if (f["sezon.json"]) { try { metaObj = JSON.parse(f["sezon.json"].toString("utf8")); } catch (e) {} }
    } else {                                                              // tek dosya .json yedegi
      hes = JSON.parse(buf.toString("utf8")); soc = hes && hes.social; metaObj = hes && hes.meta;
    }
  } catch (e) { return { status: 400, error: "Dosya okunamadi: " + e.message }; }
  const list = hes && Array.isArray(hes.users) ? hes.users : null;
  if (!list) return { status: 400, error: "Yedekte hesap listesi yok" };
  const overwrite = body.overwrite !== false && body.overwrite !== "false";
  const r = { added: 0, updated: 0, skipped: 0, invalid: 0 };
  for (const x of list) {
    const u = cleanUser(x);
    if (!u) { r.invalid++; continue; }
    r[await store.importUser(u, overwrite)]++;
  }
  let social = false;
  if (soc && typeof soc === "object" && extraImport) { try { extraImport(soc); social = true; } catch (e) { console.error("sosyal yuklenemedi", e); } }
  let prices = false;
  if (metaObj && typeof metaObj.hat_prices === "string" && metaObj.hat_prices) { try { applyPrices(JSON.parse(metaObj.hat_prices)); await saveOverrides(); prices = true; } catch (e) {} }
  topCache.at = 0;       // siralama hemen guncellensin
  console.log("ADMIN yedek yukledi: " + JSON.stringify(r) + (social ? " + sosyal" : ""));
  return { status: 200, ok: true, ...r, total: list.length, social, prices };
}

// ---- DISCORD'A OTOMATIK YEDEK: Render > Environment > DISCORD_WEBHOOK = kanalin webhook adresi. Her gun Turkiye saatiyle 04:00'ten sonra ZIP kanala gonderilir.
const DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK || "https://discord.com/api/webhooks/1485988808645411018/m7S98LCUIcFxyUR-gbOe3odaLze2NB330lr5PU2fZx76Poa8NsyFr8KSCk3wbkDPGGAz";   // Render > Environment > DISCORD_WEBHOOK varsa o kullanilir, yoksa buradaki adres
const DISCORD_OK = /^https:\/\/(?:[a-z]+\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]+$/.test(DISCORD_WEBHOOK);
const BACKUP_HOUR = 4;
const DISCORD_MAX = 9 * 1024 * 1024;     // Discord dosya siniri kucuk sunucularda ~10 MB
let sendingBackup = false;
async function sendBackupToDiscord(why) {
  if (!DISCORD_WEBHOOK) return { status: 400, error: "DISCORD_WEBHOOK ayarlanmamis (Render > Environment)" };
  if (!DISCORD_OK) return { status: 400, error: "DISCORD_WEBHOOK adresi gecersiz (https://discord.com/api/webhooks/... olmali)" };
  if (sendingBackup) return { status: 429, error: "Yedek zaten gonderiliyor" };
  sendingBackup = true;
  try {
    const x = await exportParts();
    const zip = backupZip(x);
    if (zip.length > DISCORD_MAX) return { status: 413, error: "Yedek cok buyuk (" + Math.round(zip.length / 1048576) + " MB), Discord sigdirmaz. Admin sayfasindan elle indir." };
    const fd = new FormData();
    fd.append("payload_json", JSON.stringify({ content: "Oyun yedegi (" + why + "): " + x.users.length + " oyuncu, " + x.at.slice(0, 16).replace("T", " ") + " UTC", allowed_mentions: { parse: [] } }));
    fd.append("files[0]", new Blob([zip], { type: "application/zip" }), "oyun-yedek-" + x.day + ".zip");
    const r = await fetch(DISCORD_WEBHOOK, { method: "POST", body: fd });
    if (!r.ok) return { status: 502, error: "Discord reddetti (" + r.status + "). Webhook adresini kontrol et." };
    console.log("Discord yedek gonderildi (" + why + "): " + x.users.length + " oyuncu, " + zip.length + " bayt");
    return { status: 200, ok: true, players: x.users.length, bytes: zip.length };
  } catch (e) {
    console.error("Discord yedek hatasi", e.message);
    return { status: 500, error: "Gonderilemedi: " + e.message };
  } finally { sendingBackup = false; }
}
async function dailyBackupTick() {
  if (!DISCORD_OK) return;
  try {
    const hourTR = Math.floor(((Date.now() + TZ_MS) / 3600000) % 24);
    if (hourTR < BACKUP_HOUR) return;
    const day = String(dayNum());
    if ((await store.getMeta("discord_backup_day")) === day) return;
    await store.setMeta("discord_backup_day", day);       // once isaretle: ayni gun iki kez gonderilmez
    const r = await sendBackupToDiscord("gunluk");
    if (!r.ok) await store.setMeta("discord_backup_day", "");   // basarisizsa sonraki denemede tekrar dene
  } catch (e) { console.error("gunluk yedek hatasi", e.message); }
}
if (DISCORD_WEBHOOK) {
  console.log(DISCORD_OK ? "Discord gunluk yedek: acik" : "Discord gunluk yedek: DISCORD_WEBHOOK adresi gecersiz");
  setTimeout(dailyBackupTick, 20000).unref();
  setInterval(dailyBackupTick, 5 * 60 * 1000).unref();
}
async function adminBackupNow() { return await sendBackupToDiscord("elle"); }

// ---- SOHBETE MESAJ (admin > Sohbet): oyundaki lobi / arena / mac sohbetine sunucudan mesaj yazar (server.js baglar)
let adminSay = null;
function setAdminSay(fn) { adminSay = fn; }
let statusProvider = null;
function setStatusProvider(fn) { statusProvider = fn; }
const cleanTxt = (v, m) => String(v == null ? "" : v).replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, m);
async function adminSayHandler(body) {
  if (!adminSay) return { status: 503, error: "Sohbet baglantisi hazir degil" };
  const text = cleanTxt(body.text, 120);
  if (!text) return { status: 400, error: "Mesaj bos" };
  const name = cleanTxt(body.name, 16) || "Sunucu";
  const tag = cleanTxt(body.tag, 10);
  const target = ["all", "lobby", "arena", "player"].includes(body.target) ? body.target : "all";
  const to = lowName(body.to);
  if (target === "player" && !to) return { status: 400, error: "Oyuncu ismi yaz" };
  const sent = adminSay({ name, text, tag, target, to });
  console.log("ADMIN sohbete yazdi (" + target + (to ? ":" + to : "") + ", " + sent + " kisi): " + text);
  return { status: 200, ok: true, sent };
}

// ---- ESYA FIYATLARI (admin > Fiyatlar): hats.json'u yeniden yuklemeden fiyat degistir
async function adminPrices() {
  const def = hatsFile() || HATS_DEFAULT;
  return { status: 200, ok: true, items: Object.keys(HATS).map((id) => ({ id, price: HATS[id], def: def[id] === undefined ? HATS[id] : def[id], gem: GEM_ITEMS.has(id) })) };
}
async function adminPricesSet(body) {
  const src = body.prices;
  if (!src || typeof src !== "object" || Array.isArray(src)) return { status: 400, error: "Fiyat listesi yok" };
  const o = {};
  for (const k of Object.keys(src)) {
    if (!Object.prototype.hasOwnProperty.call(HATS, k)) return { status: 400, error: "Bilinmeyen esya: " + k };
    const v = Number(src[k]);
    if (!Number.isInteger(v) || v < 0 || v > 10000000) return { status: 400, error: "Gecersiz fiyat: " + k };
    o[k] = v;
  }
  const changed = applyPrices(o);
  await saveOverrides();
  console.log("ADMIN esya fiyati degistirdi: " + Object.keys(o).join(", "));
  return { status: 200, ok: true, changed };
}
async function adminPricesReset() {
  const f = hatsFile();
  if (!f) return { status: 500, error: "hats.json okunamadi" };
  for (const k of Object.keys(f)) if (Number.isInteger(f[k])) HATS[k] = f[k];     // dosyada yeni esya varsa o da gelir
  await saveOverrides();
  console.log("ADMIN fiyatlari hats.json varsayilanina dondurdu");
  return { status: 200, ok: true };
}

// ---- SUNUCU DURUMU / LAG (admin > Sunucu)
const LAG = [];
let lagAt = Date.now();
setInterval(() => { const n = Date.now(); LAG.push(Math.max(0, n - lagAt - 250)); lagAt = n; if (LAG.length > 240) LAG.shift(); }, 250).unref();   // son 60 sn: sunucu ne kadar dondu
async function adminStatus() {
  const t0 = Date.now();
  try { await store.get("__ping__"); } catch (e) {}
  const db = Date.now() - t0;
  const lag = LAG.length ? LAG : [0];
  const ex = statusProvider ? statusProvider() : { online: 0, players: [] };
  const pl = ex.players.filter((p) => Number.isFinite(p.ms));
  const ms = pl.map((p) => p.ms);
  return {
    status: 200, ok: true, uptime_s: Math.round(process.uptime()), mem_mb: Math.round(process.memoryUsage().rss / 1048576), storage: store.kind, db_ms: db,
    lag_avg: Math.round(lag.reduce((a, b) => a + b, 0) / lag.length), lag_max: Math.max(...lag), lag_now: lag[lag.length - 1],
    online: ex.online || 0, rtt_n: ms.length, rtt_avg: ms.length ? Math.round(ms.reduce((a, b) => a + b, 0) / ms.length) : 0, rtt_max: ms.length ? Math.max(...ms) : 0,
    worst: pl.slice().sort((a, b) => b.ms - a.ms).slice(0, 3),
  };
}

async function adminBalance(body) {
  const u = await store.get(String(body.name || "").trim().toLowerCase());
  if (!u) return { status: 404, error: "Oyuncu bulunamadi" };
  return { status: 200, ok: true, name: u.name, coins: u.coins || 0, gems: u.gems || 0, hats: u.hats || [], op: u.op === true, rank: u.rank || "" };
}

// ---- OYUN GUNCELLEMESI (admin > Guncelle): yeni APK baglantisi + surum. Oyun acilirken /app_version'a sorar, surum yeniyse "Guncelle" penceresi cikar.
async function readAppUpdate() {
  try { const v = await store.getMeta("app_update"); if (v) { const o = JSON.parse(v); if (o && typeof o === "object") return o; } } catch (e) {}
  return { code: 0, name: "", url: "", notes: "", force: false, at: 0 };
}
async function adminAppUpdate() { return { status: 200, ok: true, update: await readAppUpdate() }; }
async function adminAppUpdateSet(body) {
  const code = Number(body.code);
  const url = String(body.url || "").trim();
  if (url && !/^https:\/\/[^\s]{4,500}$/i.test(url)) return { status: 400, error: "APK baglantisi https:// ile baslamali" };
  if (url && (!Number.isInteger(code) || code < 1 || code > 100000000)) return { status: 400, error: "Surum kodu 1 veya daha buyuk tam sayi olmali" };
  const prev = await readAppUpdate();
  let image = prev.image || "";                                 // gorsel secilmediyse eskisi kalir
  if (body.image_clear === true) image = "";
  if (typeof body.image === "string" && body.image) {
    const b64 = body.image.replace(/^data:image\/[a-z]+;base64,/i, "");
    if (b64.length > 700000 || !/^[A-Za-z0-9+\/=]+$/.test(b64)) return { status: 400, error: "Gorsel cok buyuk veya gecersiz" };
    const head = Buffer.from(b64.slice(0, 16), "base64");
    const isJpg = head[0] === 0xff && head[1] === 0xd8, isPng = head[0] === 0x89 && head[1] === 0x50;
    if (!isJpg && !isPng) return { status: 400, error: "Gorsel JPG veya PNG olmali" };
    image = b64;
  }
  const o = url
    ? { code, name: String(body.name || "").trim().slice(0, 20), url, notes: String(body.notes || "").trim().slice(0, 400), force: body.force === true, image, at: Date.now() }
    : { code: 0, name: "", url: "", notes: "", force: false, image: "", at: Date.now() };     // baglanti bos = guncelleme kapali
  await store.setMeta("app_update", JSON.stringify(o));
  console.log(url ? "ADMIN guncelleme yayinladi: surum " + code + (o.force ? " (zorunlu)" : "") + (image ? " (gorselli)" : "") : "ADMIN guncellemeyi kapatti");
  return { status: 200, ok: true, update: o };
}
// Herkese acik: oyun acilirken surumu sorar. Sadece yeni surum varsa baglanti doner.
async function appVersion(body) {
  const u = await readAppUpdate();
  const mine = Number(body.code) || 0;
  if (!u.url || u.code <= mine) return { status: 200, ok: true, update: false };
  return { status: 200, ok: true, update: true, code: u.code, name: u.name, url: u.url, notes: u.notes, force: !!u.force, image: u.image || "" };
}

const ADMIN_PAGE = `<!doctype html><html lang="tr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Admin</title>
<style>
*{box-sizing:border-box}body{font-family:system-ui,sans-serif;background:#0b0f18;color:#e8eefc;margin:0;padding:14px;max-width:560px;margin:auto}
h1{font-size:20px;margin:6px 0 10px}h2{font-size:16px;margin:18px 0 6px;color:#9fb0cf}
input,select,button{width:100%;font-size:16px;padding:11px;margin:4px 0;border-radius:10px;border:1px solid #38425a;background:#161d2e;color:#e8eefc}
button{background:#4c8dff;border:0;font-weight:600;color:#fff}button.alt{background:#2a3550}button.ok{background:#7bd88f;color:#06260f}button.warn{background:#f5c542;color:#2b2200}button.bad{background:#ff6b6b;color:#2b0505}
.row{display:flex;gap:6px}.row>*{flex:1;min-width:0}.row3{display:grid;grid-template-columns:1fr 1fr;gap:6px}
.tabs{display:flex;flex-wrap:wrap;gap:6px;margin:10px 0}.tabs button{flex:1 1 30%;padding:9px 4px;font-size:14px;background:#161d2e;border:1px solid #38425a;font-weight:500}.tabs button.on{background:#4c8dff;border-color:#4c8dff}
.card{background:#121827;border:1px solid #2a3550;border-radius:12px;padding:10px 12px;margin:6px 0;cursor:pointer}.card:active{background:#1b2540}
.nm{font-weight:700;font-size:17px}.meta{color:#9fb0cf;font-size:14px;margin-top:2px}
.b{display:inline-block;font-size:12px;border-radius:8px;padding:2px 7px;margin-left:5px;background:#2a3550}.b.r{background:#ff6b6b;color:#2b0505}.b.y{background:#f5c542;color:#2b2200}.b.g{background:#7bd88f;color:#06260f}
.lbl{font-size:13px;color:#9fb0cf;margin-top:6px}.chip{display:inline-block;background:#2a3550;border-radius:14px;padding:5px 10px;margin:3px 4px 3px 0;font-size:14px}.chip b{color:#ff8b8b;margin-left:6px;cursor:pointer}
.mini{display:flex;gap:5px}.mini button{padding:6px;font-size:13px;margin:0 0 4px;background:#2a3550;font-weight:500}
#ed{display:none;background:#0f1524;border:1px solid #4c8dff;border-radius:14px;padding:12px;margin-top:10px}
#toast{position:fixed;left:10px;right:10px;bottom:12px;padding:12px;border-radius:12px;background:#1b2540;border:1px solid #4c8dff;display:none;z-index:9;max-width:540px;margin:auto}
.chk{display:flex;align-items:center;gap:8px;margin:8px 0}.chk input{width:22px;height:22px;margin:0}
p.h{color:#9fb0cf;font-size:14px;margin:0 0 4px}
</style></head><body>
<h1>Admin paneli</h1>
<input id="key" type="password" placeholder="Admin anahtari" autocomplete="off">
<div class="tabs"><button id="tb1" class="on" onclick="tab(1)">Oyuncular</button><button id="tb2" onclick="tab(2)">Herkese</button><button id="tb3" onclick="tab(3)">Yedek</button><button id="tb4" onclick="tab(4)">Sohbet</button><button id="tb5" onclick="tab(5)">Fiyatlar</button><button id="tb6" onclick="tab(6)">Sunucu</button><button id="tb7" onclick="tab(7)">Guncelle</button></div>

<div id="t1">
<div class="row"><input id="q" placeholder="Oyuncu ara (isim)" onkeydown="if(event.key==='Enter')load()"><select id="sort" onchange="load()"><option value="name">A-Z</option><option value="coins">En cok altin</option><option value="gems">En cok elmas</option><option value="points">En cok puan</option></select></div>
<button onclick="load()">Listele / Ara</button>
<p class="h" id="cnt"></p>
<div id="list"></div>

<div id="ed">
<h1 id="e_name"></h1>
<div id="e_flags"></div>
<h2>Bakiye ve istatistik</h2>
<div class="lbl">Altin</div><input id="f_coins" type="number" inputmode="numeric">
<div class="mini"><button onclick="add('f_coins',100)">+100</button><button onclick="add('f_coins',1000)">+1000</button><button onclick="add('f_coins',10000)">+10000</button><button onclick="add('f_coins',-100)">-100</button><button onclick="put('f_coins',0)">0</button></div>
<div class="lbl">Elmas</div><input id="f_gems" type="number" inputmode="numeric">
<div class="mini"><button onclick="add('f_gems',10)">+10</button><button onclick="add('f_gems',100)">+100</button><button onclick="add('f_gems',1000)">+1000</button><button onclick="add('f_gems',-10)">-10</button><button onclick="put('f_gems',0)">0</button></div>
<div class="row3"><div><div class="lbl">Ates</div><input id="f_fire" type="number" inputmode="numeric"></div><div><div class="lbl">Gunluk seri (0-7)</div><input id="f_streak" type="number" inputmode="numeric"></div>
<div><div class="lbl">BedWars puani</div><input id="f_points" type="number" inputmode="numeric"></div><div><div class="lbl">BedWars zafer</div><input id="f_wins" type="number" inputmode="numeric"></div></div>
<div class="chk"><input id="f_daily" type="checkbox"><label for="f_daily">Gunluk odulu sifirla (bugun tekrar alabilsin)</label></div>
<h2>Rank ve yetki</h2>
<select id="f_rank"></select>
<div class="chk"><input id="f_op" type="checkbox"><label for="f_op">OP (oyunda /panel kullanabilir)</label></div>
<h2>Sapka / skin / kanat</h2>
<div id="hats"></div>
<div class="row"><select id="addsel"></select><button class="alt" style="flex:0 0 90px" onclick="addHat()">Ekle</button></div>
<div class="row"><button class="alt" onclick="allHats()">Hepsini ver</button><button class="alt" onclick="noHats()">Hepsini sil</button></div>
<button class="ok" onclick="save()">KAYDET</button>

<h2>Ban / Susturma</h2>
<div class="row"><input id="p_dur" placeholder="Sure: 30dk, 1s, 1g, 1h, kalici"><input id="p_reason" placeholder="Sebep"></div>
<div class="row3"><button class="bad" onclick="pun('ban')">Banla</button><button class="alt" onclick="pun('unban')">Ban kaldir</button><button class="warn" onclick="pun('mute')">Sustur</button><button class="alt" onclick="pun('unmute')">Susturma kaldir</button></div>
<p class="h">Sure harfleri: dk = dakika, s = saat, g = gun, h = hafta.</p>
<h2>Sifre</h2>
<input id="f_pw" type="text" placeholder="Yeni sifre (en az 6 karakter)" autocomplete="off">
<button class="warn" onclick="setpw()">Sifreyi degistir (oyuncu cikis yapar)</button>
<h2>Tehlikeli</h2>
<button class="bad" onclick="del()">Hesabi sil</button>
<button class="alt" onclick="closeEd()">Kapat</button>
</div>
</div>

<div id="t2" style="display:none">
<h2>Herkese gonder</h2>
<p class="h">Kayitli TUM oyunculara eklenir (negatif = geri al).</p>
<input id="allcoins" type="number" placeholder="Herkese altin">
<input id="allgems" type="number" placeholder="Herkese elmas">
<button class="warn" onclick="giveAll()">Herkese gonder</button>
</div>

<div id="t3" style="display:none">
<h2>Veri indir</h2>
<p class="h">Sunucunun kaydettigi TUM veri tek ZIP dosyasinda: hesaplar, arkadaslik / sohbet, sezon bilgisi ve Excel listesi. Dosya sifre ozetleri ve ozel mesajlar icerir, kimseyle paylasma.</p>
<button class="ok" onclick="dl('zip')">TUM VERIYI ZIP INDIR</button>
<h2>Discord'a otomatik yedek</h2>
<p class="h">Render'da DISCORD_WEBHOOK ayarliysa yedek her gun kanala kendiliginden gider. Deneme icin simdi gonderebilirsin.</p>
<button class="alt" onclick="dcnow()">YEDEGI SIMDI DISCORD'A GONDER</button>
<h2>Yedek yukle (geri yukle)</h2>
<p class="h">Daha once indirdigin oyun-yedek ZIP dosyasini sec: tum hesaplar (isim, sifre, altin, elmas, esyalar, rank, siralama puani) ve arkadaslik / sohbet sunucuya geri gelir. Oyuncular ayni isim ve sifreyle girer.</p>
<input id="zipf" type="file" accept=".zip,.json,application/zip,application/json">
<select id="zipmode"><option value="1">Zip'teki hesap, ayni isimli hesabin ustune yazsin (onerilen)</option><option value="0">Sunucuda zaten olan hesaplara dokunma</option></select>
<button class="warn" onclick="imp()">YEDEGI SUNUCUYA YUKLE</button>
<p class="h" style="margin-top:14px">Tek tek indirmek istersen:</p>
<button class="alt" onclick="dl('json')">Tek dosya (.json)</button>
<button class="alt" onclick="dl('csv')">Oyuncu listesi (.csv)</button>
</div>
<div id="t4" style="display:none">
<h2>Oyunun sohbetine mesaj yaz</h2>
<p class="h">Mesaj oyunda lobide, arenada veya macta olan oyuncularin sohbetinde gorunur. Menude olanlar gormez.</p>
<div class="row"><input id="s_name" maxlength="16" value="Sunucu" placeholder="Gonderen adi"><input id="s_tag" maxlength="10" value="Duyuru" placeholder="Etiket"></div>
<select id="s_target" onchange="onTarget()"><option value="all">Herkese</option><option value="lobby">Sadece lobidekilere</option><option value="arena">Sadece arenadakilere</option><option value="player">Tek bir oyuncuya</option></select>
<input id="s_to" placeholder="Oyuncu ismi" style="display:none">
<input id="s_text" maxlength="120" placeholder="Mesaj (en fazla 120 karakter)" onkeydown="if(event.key==='Enter')say()">
<button class="ok" onclick="say()">GONDER</button>
</div>

<div id="t5" style="display:none">
<h2>Kozmetik fiyatlari</h2>
<p class="h">Fiyati degistirip KAYDET'e bas. Dosyayi yeniden yuklemene gerek yok. Oyuncular oyuna tekrar girince yeni fiyati gorur.</p>
<input id="pq" placeholder="Esya ara" oninput="renderPrices()">
<div id="plist"></div>
<button class="ok" onclick="savePrices()">KAYDET</button>
<button class="alt" onclick="loadPrices()">Listeyi yenile</button>
<button class="warn" onclick="resetPrices()">hats.json varsayilanina don</button>
</div>

<div id="t6" style="display:none">
<h2>Sunucu durumu / lag</h2>
<div id="verdict" class="card" style="cursor:default"></div>
<div id="stbox"></div>
<div class="chk"><input id="auto" type="checkbox" onchange="autoOn()"><label for="auto">Kendiliginden yenile (3 sn)</label></div>
<button onclick="stat()">Simdi olc</button>
<button class="alt" onclick="SR=[];stat()">Olcumleri sifirla</button>
<p class="h">Telefon-sunucu gecikmesi senin baglantinla sunucu arasidir. Sunucu donmasi ve veritabani sunucunun kendi yavasligidir. Oyuncu pingi oyunculardan olculur.</p>
</div>
<div id="t7" style="display:none">
<h2>Oyun guncellemesi</h2>
<p class="h">Surum kodu, APK linki ve istersen bir gorsel yaz. Oyuncular oyunu acinca gorselli "Guncelle" penceresi cikar; butona basinca yazdigin linke gider.</p>
<div class="lbl">Su an yayinda</div><div id="u_cur" class="card" style="cursor:default">...</div>
<div class="row"><div><div class="lbl">Surum kodu (her APK'da +1)</div><input id="u_code" type="number" inputmode="numeric" placeholder="2"></div><div><div class="lbl">Surum adi</div><input id="u_name" maxlength="20" placeholder="v1.1"></div></div>
<div class="lbl">APK indirme baglantisi (https://...)</div><input id="u_url" placeholder="https://github.com/.../VoxelEdition.apk">
<div class="lbl">Yenilikler (oyuncu gorur)</div><input id="u_notes" maxlength="400" placeholder="Yeni kanatlar, hata duzeltmeleri...">
<div class="lbl">Guncelleme gorseli (oyuncu pencerede gorur)</div><input id="u_img" type="file" accept="image/*" onchange="pickImg()">
<img id="u_prev" style="display:none;max-width:100%;border-radius:10px;margin:6px 0"><button class="alt" id="u_imgdel" style="display:none" onclick="delImg()">Gorseli kaldir</button>
<div class="chk"><input id="u_force" type="checkbox"><label for="u_force">Zorunlu guncelleme (pencere kapatilamaz)</label></div>
<button class="ok" onclick="pubUpdate()">YAYINLA</button>
<button class="warn" onclick="offUpdate()">Guncellemeyi kapat</button>
<p class="h">Oyundaki surum kodu (script/updater.gd > VERSION_CODE) buradaki koddan KUCUKSE pencere cikar. APK'yi export ederken ayni sayiyi version/code'a da yaz.</p>
</div>
<div id="toast"></div>
<script>
const $=id=>document.getElementById(id);
let cur=null,ALLH=[],tt=null;
$('key').value=sessionStorage.getItem('ak')||'';
$('key').addEventListener('input',()=>sessionStorage.setItem('ak',$('key').value));
function msg(t){const x=$('toast');x.textContent=t;x.style.display='block';clearTimeout(tt);tt=setTimeout(()=>{x.style.display='none'},4500)}
async function api(path,body){try{const r=await fetch('/admin/'+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(Object.assign({key:$('key').value},body||{}))});let j;try{j=await r.json()}catch(e){j={error:'Cevap okunamadi'}}j._status=r.status;return j}catch(e){return {ok:false,error:'Baglanti hatasi: '+e}}}
function tab(n){for(let i=1;i<=7;i++){$('t'+i).style.display=i===n?'block':'none';$('tb'+i).className=i===n?'on':''}
if(n===5&&!PR.length)loadPrices();if(n===7)loadUpd();if(n===6)stat();else stopAuto()}
let IMG='',IMGDEL=false;
function showPrev(b64){const p=$('u_prev');if(b64){p.src='data:image/jpeg;base64,'+b64;p.style.display='block';$('u_imgdel').style.display='block'}else{p.style.display='none';$('u_imgdel').style.display='none'}}
function pickImg(){const f=$('u_img').files[0];if(!f)return;const r=new FileReader();r.onload=()=>{const im=new Image();im.onload=()=>{const m=1024,k=Math.min(1,m/Math.max(im.width,im.height));const c=document.createElement('canvas');c.width=Math.round(im.width*k);c.height=Math.round(im.height*k);c.getContext('2d').drawImage(im,0,0,c.width,c.height);let q=0.85,d=c.toDataURL('image/jpeg',q);while(d.length>600000&&q>0.3){q-=0.1;d=c.toDataURL('image/jpeg',q)}IMG=d.split(',')[1];IMGDEL=false;showPrev(IMG);msg('Gorsel hazir ('+Math.round(IMG.length/1024)+' KB). YAYINLA ile kaydet.')};im.onerror=()=>msg('Gorsel okunamadi');im.src=r.result};r.readAsDataURL(f)}
function delImg(){IMG='';IMGDEL=true;$('u_img').value='';showPrev('');msg('Gorsel kaldirilacak (YAYINLA ile kaydet)')}
async function loadUpd(){const j=await api('app_update',{});if(!j.ok){msg(j.error||('Hata '+j._status));return}const u=j.update||{};$('u_cur').textContent=u.url?('Surum '+u.code+(u.name?' ('+u.name+')':'')+(u.force?' - ZORUNLU':'')+(u.image?' - gorselli':'')+' | '+u.url):'Yayinda guncelleme yok';IMG='';IMGDEL=false;showPrev(u.image||'');if(u.url){$('u_code').value=u.code;$('u_name').value=u.name||'';$('u_url').value=u.url;$('u_notes').value=u.notes||'';$('u_force').checked=!!u.force}}
async function pubUpdate(){const body={code:parseInt($('u_code').value,10),name:$('u_name').value,url:$('u_url').value.trim(),notes:$('u_notes').value,force:$('u_force').checked};if(IMG)body.image=IMG;else if(IMGDEL)body.image_clear=true;const j=await api('app_update_set',body);if(!j.ok){msg(j.error||('Hata '+j._status));return}msg('Yayinlandi. Oyuncular oyunu acinca guncelleme gorecek.');loadUpd()}
async function offUpdate(){if(!confirm('Guncelleme penceresi kapatilsin mi?'))return;const j=await api('app_update_set',{url:'',image_clear:true});if(!j.ok){msg(j.error||('Hata '+j._status));return}msg('Guncelleme kapatildi');$('u_url').value='';loadUpd()}
let PR=[],SR=[],auto=null;
function onTarget(){$('s_to').style.display=$('s_target').value==='player'?'block':'none'}
async function say(){const text=$('s_text').value.trim();if(!text){msg('Mesaj yaz');return}
const t=$('s_target').value;if(t==='player'&&!$('s_to').value.trim()){msg('Oyuncu ismi yaz');return}
const j=await api('say',{name:$('s_name').value,tag:$('s_tag').value,text:text,target:t,to:$('s_to').value});
if(!j.ok){msg(j.error||('Hata '+j._status));return}
msg(j.sent?('Gonderildi: '+j.sent+' baglantiya'):'Gonderildi ama su an kimse bagli degil');$('s_text').value=''}
async function loadPrices(){const j=await api('prices',{});if(!j.ok){msg(j.error||('Hata '+j._status));return}PR=j.items;renderPrices()}
function renderPrices(){const q=$('pq').value.trim().toLowerCase();const box=$('plist');box.textContent='';
PR.filter(x=>!q||x.id.toLowerCase().indexOf(q)>=0).forEach(x=>{const r=el('div','row');
const n=el('div','lbl',x.id+(x.gem?' (elmas)':' (altin)')+(x.def!==x.price?'  varsayilan '+x.def:''));n.style.flex='1.5';
const i=document.createElement('input');i.type='number';i.inputMode='numeric';i.value=x.cur!==undefined?x.cur:x.price;
i.oninput=()=>{x.cur=i.value;i.style.borderColor=(i.value!==''&&Number(i.value)!==x.price)?'#f5c542':''};
r.appendChild(n);r.appendChild(i);box.appendChild(r)})}
async function savePrices(){const ch={};PR.forEach(x=>{if(x.cur!==undefined&&x.cur!==''&&Number(x.cur)!==x.price)ch[x.id]=Number(x.cur)});
if(!Object.keys(ch).length){msg('Degisiklik yok');return}
const j=await api('prices_set',{prices:ch});if(!j.ok){msg(j.error||('Hata '+j._status));return}
msg(j.changed+' fiyat kaydedildi');loadPrices()}
async function resetPrices(){if(!confirm('Tum fiyatlar hats.json dosyasindaki varsayilana donsun mu?'))return;
const j=await api('prices_reset',{});if(!j.ok){msg(j.error||('Hata '+j._status));return}msg('Varsayilan fiyatlara donuldu');loadPrices()}
function stopAuto(){if(auto){clearInterval(auto);auto=null}}
function autoOn(){stopAuto();if($('auto').checked)auto=setInterval(stat,3000)}
function lv(v,a,b){return v<a?0:(v<b?1:2)}
function upt(s){return Math.floor(s/3600)+' sa '+Math.floor((s%3600)/60)+' dk'}
async function stat(){const t0=performance.now();const j=await api('status',{});const ms=Math.round(performance.now()-t0);
if(!j.ok){msg(j.error||('Hata '+j._status));return}
SR.push(ms);if(SR.length>20)SR.shift();
const avg=Math.round(SR.reduce((a,b)=>a+b,0)/SR.length),mx=Math.max.apply(null,SR);
const rows=[['Telefon - sunucu gecikmesi',ms+' ms (ort '+avg+', en yuksek '+mx+')',lv(avg,200,600)],
['Sunucu donmasi',j.lag_avg+' ms ort, '+j.lag_max+' ms en yuksek (son 1 dk)',Math.max(lv(j.lag_avg,30,100),lv(j.lag_max,150,500))],
['Veritabani',j.db_ms+' ms ('+j.storage+')',lv(j.db_ms,100,400)]];
if(j.rtt_n)rows.push(['Oyuncu pingi',j.rtt_avg+' ms ort, '+j.rtt_max+' ms en yuksek ('+j.rtt_n+' oyuncu)'+(j.worst.length?' - en yuksek: '+j.worst.map(p=>p.name+' '+p.ms).join(', '):''),Math.max(lv(j.rtt_avg,150,300),lv(j.rtt_max,300,700))]);
rows.push(['Online oyuncu',String(j.online),-1],['Sunucu acik',upt(j.uptime_s),-1],['Bellek',j.mem_mb+' MB',-1]);
const box=$('stbox');box.textContent='';let w=0;
rows.forEach(r=>{if(r[2]>w)w=r[2];const d=el('div','card',r[0]+': '+r[1]);d.style.cursor='default';if(r[2]>=0)d.appendChild(el('span','b '+['g','y','r'][r[2]],['iyi','orta','kotu'][r[2]]));box.appendChild(d)});
const v=$('verdict');v.textContent='';v.appendChild(el('span','b '+['g','y','r'][w],['LAG YOK','Hafif yavaslik var','LAG VAR'][w]));v.style.fontSize='18px'}
function el(t,c,x){const e=document.createElement(t);if(c)e.className=c;if(x!==undefined)e.textContent=x;return e}
function add(id,n){$(id).value=Math.max(0,(Number($(id).value)||0)+n)}
function put(id,n){$(id).value=n}
async function load(){const j=await api('players',{q:$('q').value,sort:$('sort').value});if(!j.ok){msg(j.error||('Hata '+j._status));return}
$('cnt').textContent=j.matched+' / '+j.total+' oyuncu'+(j.matched>j.players.length?' (ilk '+j.players.length+' gosteriliyor, aramayi daralt)':'');
const box=$('list');box.textContent='';
j.players.forEach(p=>{const d=el('div','card');const n=el('div','nm',p.name);if(p.rank)n.appendChild(el('span','b',p.rank));if(p.op)n.appendChild(el('span','b g','OP'));if(p.banned)n.appendChild(el('span','b r','BAN'));if(p.muted)n.appendChild(el('span','b y','SUSTURMA'));d.appendChild(n);d.appendChild(el('div','meta','Altin '+p.coins+'  |  Elmas '+p.gems+'  |  Puan '+p.bw_points));d.onclick=()=>openP(p.name);box.appendChild(d)})}
function fill(p){cur=p;$('e_name').textContent=p.name;const fl=$('e_flags');fl.textContent='';
if(p.ban)fl.appendChild(el('span','b r','BANLI: '+(p.ban.perm?'kalici':'bitis '+new Date(p.ban.until).toLocaleString())+' ('+p.ban.reason+')'));
if(p.mute)fl.appendChild(el('span','b y','SUSTURULMUS: bitis '+new Date(p.mute.until).toLocaleString()+' ('+p.mute.reason+')'));
$('f_coins').value=p.coins;$('f_gems').value=p.gems;$('f_fire').value=p.fire;$('f_streak').value=p.daily_streak;$('f_points').value=p.bw_points;$('f_wins').value=p.bw_wins;
$('f_daily').checked=false;$('f_op').checked=p.op;$('f_rank').value=p.rank;$('f_pw').value='';
cur.hats=p.hats.slice();renderHats()}
function renderHats(){const h=$('hats');h.textContent='';if(!cur.hats.length)h.appendChild(el('p','h','Hic esyasi yok'));
cur.hats.forEach((x,i)=>{const c=el('span','chip',x);const r=el('b',null,'x');r.onclick=()=>{cur.hats.splice(i,1);renderHats()};c.appendChild(r);h.appendChild(c)});
const s=$('addsel');s.textContent='';s.appendChild(new Option('Esya sec...',''));ALLH.filter(x=>!cur.hats.includes(x)).forEach(x=>s.appendChild(new Option(x,x)))}
function addHat(){const v=$('addsel').value;if(!v)return;cur.hats.push(v);renderHats()}
function allHats(){cur.hats=ALLH.slice();renderHats()}
function noHats(){cur.hats=[];renderHats()}
async function openP(name){const j=await api('player',{name});if(!j.ok){msg(j.error||('Hata '+j._status));return}
ALLH=j.all_hats;const rs=$('f_rank');rs.textContent='';rs.appendChild(new Option('Rank yok',''));j.ranks.forEach(r=>rs.appendChild(new Option(r,r)));
fill(j.player);$('ed').style.display='block';$('ed').scrollIntoView({behavior:'smooth'})}
function closeEd(){$('ed').style.display='none';cur=null}
async function save(){if(!cur)return;const j=await api('update',{name:cur.name,coins:$('f_coins').value,gems:$('f_gems').value,fire:$('f_fire').value,daily_streak:$('f_streak').value,bw_points:$('f_points').value,bw_wins:$('f_wins').value,reset_daily:$('f_daily').checked,rank:$('f_rank').value,op:$('f_op').checked,hats:cur.hats});
if(!j.ok){msg(j.error||('Hata '+j._status));return}fill(j.player);msg('Kaydedildi: '+j.player.name);load()}
async function pun(type){if(!cur)return;if((type==='ban'||type==='mute')&&!$('p_dur').value.trim()){msg('Sure yaz (ornek 1g veya kalici)');return}
const j=await api('punish',{name:cur.name,type:type,duration:$('p_dur').value,reason:$('p_reason').value});if(!j.ok){msg(j.error||('Hata '+j._status));return}msg('Tamam: '+type);openP(cur.name);load()}
async function setpw(){if(!cur)return;const pw=$('f_pw').value;if(pw.length<6){msg('Sifre en az 6 karakter');return}if(!confirm(cur.name+' icin sifre degissin mi?'))return;const j=await api('setpass',{name:cur.name,password:pw});if(!j.ok){msg(j.error||('Hata '+j._status));return}$('f_pw').value='';msg('Sifre degisti, oyuncu tum cihazlarda cikis yapti')}
async function del(){if(!cur)return;const t=prompt('Hesabi KALICI silmek icin oyuncu ismini aynen yaz: '+cur.name);if(t!==cur.name){if(t!==null)msg('Isim uyusmadi, silinmedi');return}const j=await api('delete',{name:cur.name,confirm:t});if(!j.ok){msg(j.error||('Hata '+j._status));return}msg('Hesap silindi: '+t);closeEd();load()}
async function giveAll(){const c=Number($('allcoins').value)||0,e=Number($('allgems').value)||0;if(!c&&!e){msg('Altin veya elmas yaz');return}if(!confirm('TUM oyunculara '+c+' altin ve '+e+' elmas eklensin mi?'))return;const j=await api('give_all',{coins:c,gems:e});msg(j.ok?(j.players+' oyuncuya gonderildi: '+j.coins+' altin, '+j.gems+' elmas'):(j.error||('Hata '+j._status)))}
function b64(buf){let s='';const u=new Uint8Array(buf);for(let i=0;i<u.length;i+=32768)s+=String.fromCharCode.apply(null,u.subarray(i,i+32768));return btoa(s)}
async function imp(){const f=$('zipf').files[0];if(!f){msg('Once yedek dosyasini sec');return}
if(!confirm(f.name+' sunucuya yuklensin mi?'))return;
msg('Yukleniyor...');let z;try{z=b64(await f.arrayBuffer())}catch(x){msg('Dosya okunamadi: '+x);return}
const j=await api('import',{zip:z,overwrite:$('zipmode').value==='1'});
if(!j.ok){msg(j.error||('Hata '+j._status));return}
msg('Tamam: '+j.added+' yeni, '+j.updated+' guncellendi, '+j.skipped+' atlandi'+(j.invalid?', '+j.invalid+' gecersiz':'')+(j.social?' + arkadaslik/sohbet':'')+(j.prices?' + fiyatlar':''));load()}
async function dcnow(){msg('Gonderiliyor...');const j=await api('backup_now',{});msg(j.ok?('Discord kanalina gonderildi ('+j.players+' oyuncu)'):(j.error||('Hata '+j._status)))}
async function dl(f){try{const r=await fetch('/admin/export',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key:$('key').value,format:f})});if(!r.ok){msg('Hata '+r.status+' '+await r.text());return}const cd=r.headers.get('Content-Disposition')||'';const m=/filename="([^"]+)"/.exec(cd);const bl=await r.blob();const a=document.createElement('a');a.href=URL.createObjectURL(bl);a.download=m?m[1]:'yedek.'+f;document.body.appendChild(a);a.click();a.remove();msg('Indirildi: '+a.download)}catch(x){msg('Hata: '+x)}}
</script></body></html>`;

async function logout(token) {
  if (typeof token !== "string" || token.length !== 64) return;
  const th = sha(token);
  const u = await store.byToken(th);
  if (u) { u.tokens = u.tokens.filter((t) => t !== th); await store.update(u); }
}

// ------------------------------------------------------------ HTTP
const hits = new Map();   // ip -> [zaman damgalari]
// BED WARS PUAN (sunucu belirler, istemci sadece "ne oldu" der): yatak kirma 10, oldurme 5, mac kazanma 25 (+1 zafer).
// Hile olmasin diye: oyuncu basina 10 dakikada en fazla 150 puan, zafer en az 3 dakika arayla.
const PTS = { bed: 10, kill: 5, win: 25 };
const PTS_MAX_PER_10MIN = 150;
const WIN_GAP_MS = 3 * 60 * 1000;
const ptsLog = new Map();   // user key -> [{t, n, k}]
async function bwPointsAdd(body) {
  const u = await userByToken(body.token);
  if (!u) return { status: 401, error: "Oturum gecersiz" };
  const kind = String(body.kind || "");
  if (!Object.prototype.hasOwnProperty.call(PTS, kind)) return { status: 400, error: "Gecersiz puan turu" };
  const n = PTS[kind];
  const now = Date.now();
  const log = (ptsLog.get(u.key) || []).filter((e) => now - e.t < 10 * 60 * 1000);
  const total = log.reduce((a, e) => a + e.n, 0);
  if (total + n > PTS_MAX_PER_10MIN) return { status: 429, error: "Cok fazla puan istegi" };
  if (kind === "win" && log.some((e) => e.k === "win" && now - e.t < WIN_GAP_MS)) return { status: 429, error: "Zafer cok sik" };
  log.push({ t: now, n, k: kind });
  ptsLog.set(u.key, log);
  const pts = await store.addBwPoints(u.key, n, kind === "win");
  topCache.at = 0;   // siralama hemen guncellensin
  return { status: 200, ok: true, bw_points: pts, added: n };
}
setInterval(() => { const now = Date.now(); for (const [k, a] of ptsLog) if (!a.some((e) => now - e.t < 600000)) ptsLog.delete(k); }, 600000).unref();

function limited(ip) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter((t) => now - t < 10 * 60 * 1000);
  arr.push(now);
  hits.set(ip, arr);
  return arr.length > 20;     // 10 dk'da en fazla 20 kayit/giris denemesi
}
setInterval(() => { const now = Date.now(); for (const [ip, a] of hits) if (!a.some((t) => now - t < 600000)) hits.delete(ip); }, 600000).unref();

function readBody(req, max) {
  max = max || 2048;
  return new Promise((resolve) => {
    let b = "";
    req.on("data", (d) => { b += d; if (b.length > max) { req.destroy(); resolve(null); } });
    req.on("end", () => { try { resolve(JSON.parse(b || "{}")); } catch (e) { resolve(null); } });
    req.on("error", () => resolve(null));
  });
}

// true dondururse istegi isledi
async function handleHttp(req, res) {
  const url = (req.url || "").split("?")[0];
  if (req.method === "GET" && url === "/admin") {
    if (!ADMIN_KEY) { res.writeHead(404); res.end("Admin kapali (ADMIN_KEY ayarlanmamis)"); return true; }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(ADMIN_PAGE);
    return true;
  }
  if (req.method !== "POST" || !["/register", "/login", "/me", "/logout", "/profile", "/buy_hat", "/daily_claim", "/top", "/look", "/bw_points", "/rank_set", "/mute", "/unmute", "/ban", "/unban", "/admin/give", "/admin/give_all", "/admin/export", "/admin/players", "/admin/player", "/admin/update", "/admin/punish", "/admin/setpass", "/admin/delete", "/admin/balance", "/admin/op", "/admin/import", "/admin/backup_now", "/admin/say", "/admin/prices", "/admin/prices_set", "/admin/prices_reset", "/admin/status", "/admin/app_update", "/admin/app_update_set", "/app_version"].includes(url)) return false;
  const out = (code, obj) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
  try {
    const ip = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
    const body = await readBody(req, url === "/admin/import" ? 40 * 1024 * 1024 : url === "/admin/prices_set" ? 65536 : url === "/admin/app_update_set" ? 900000 : 2048);   // yedek zip'i base64 geldigi icin buyuk
    if (!body || typeof body !== "object") return out(400, { ok: false, error: "Gecersiz istek" }), true;
    if ((url === "/register" || url === "/login") && limited(ip)) return out(429, { ok: false, error: "Cok fazla deneme, biraz bekle" }), true;
    const send = (r) => { const { status, ...rest } = r; out(status, { ok: !!r.ok, ...rest }); return true; };
    if (url === "/app_version") return send(await appVersion(body));
    if (url === "/top") return send({ status: 200, ok: true, list: await leaderboard(), rewards: WEEKLY_GEMS, reset_in: secondsToNextWeek() });
    if (url === "/look") return send(await lookSet(body));
    if (url === "/bw_points") return send(await bwPointsAdd(body));
    if (url === "/register") return send(await register(body.name, body.password));
    if (url === "/login") return send(await login(body.name, body.password));
    if (url === "/me" || url === "/profile") { const u = await userByToken(body.token); return u ? send({ status: 200, ok: true, ...profile(u) }) : send({ status: 401, error: "Oturum gecersiz" }); }
    if (url === "/buy_hat") return send(await buyHat(body.token, body.hat));
    if (url === "/daily_claim") return send(await dailyClaim(body.token));
    if (url === "/rank_set") return send(await rankSet(body));
    if (url === "/mute") return send(await muteSet(body));
    if (url === "/unmute") return send(await unmuteSet(body));
    if (url === "/ban") return send(await banSet(body));
    if (url === "/unban") return send(await unbanSet(body));
    if (url.startsWith("/admin/")) {
      if (!adminOk(body.key)) {            // sadece YANLIS anahtar denemeleri sayilir (10 dk'da 20)
        if (limited(ip)) return send({ status: 429, error: "Cok fazla deneme, biraz bekle" });
        return send({ status: 403, error: "Yetkisiz" });
      }
      if (url === "/admin/export") { await adminExport(body, res); return true; }
      const AH = { "/admin/give": adminGive, "/admin/give_all": adminGiveAll, "/admin/op": adminOp, "/admin/balance": adminBalance, "/admin/players": adminPlayers, "/admin/player": adminPlayer,
        "/admin/update": adminUpdateHandler, "/admin/punish": adminPunish, "/admin/setpass": adminSetPass, "/admin/delete": adminDelete, "/admin/import": adminImport, "/admin/backup_now": adminBackupNow,
        "/admin/say": adminSayHandler, "/admin/prices": adminPrices, "/admin/prices_set": adminPricesSet, "/admin/prices_reset": adminPricesReset, "/admin/status": adminStatus, "/admin/app_update": adminAppUpdate, "/admin/app_update_set": adminAppUpdateSet };
      return send(await AH[url](body));
    }
    await logout(body.token);
    return out(200, { ok: true }), true;
  } catch (e) {
    console.error("auth hatasi", e);
    return out(500, { ok: false, error: "Sunucu hatasi" }), true;
  }
}

module.exports = { setExtraExport, setExtraImport, setAdminSay, setStatusProvider, setUserPurge, handleHttp, verify, verifyUser, lookupName, setRankListener, setMuteListener, setBanListener, RANKS };
