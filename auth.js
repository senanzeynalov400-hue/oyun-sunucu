// Hesap sistemi: kayit / giris / token dogrulama.
// Sifre scrypt ile hash'lenir (duz sifre ASLA saklanmaz). Giriste rastgele token verilir, sunucuda sadece token'in SHA-256'i tutulur.
// Depolama: DATABASE_URL varsa PostgreSQL (kalici), yoksa data/users.json dosyasi (Render ucretsiz planda KALICI DEGIL).
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

// Sapka fiyatlari (altin): server/hats.json -> {"sapka_id": fiyat}. Fiyati degistirmek icin bu dosyayi duzenle.
let HATS = {};
const GEM_ITEMS = new Set(["skin_10", "skin_11", "skin_12", "skin_17", "skin_18", "skin_19", "skin_20", "skin_21", "skin_22", "skin_23", "skin_24", "wing_1", "wing_2", "wing_3", "wing_4", "wing_5", "wing_6", "wing_7", "wing_8", "wing_9", "wing_10", "wing_11", "wing_12", "wing_13", "wing_14", "wing_15", "wing_16", "wing_17", "wing_18", "wing_19"]);   // bu urunler ELMASLA satilir (fiyat hats.json'da), digerleri altinla

try { HATS = JSON.parse(fs.readFileSync(path.join(__dirname, "hats.json"), "utf8")); } catch (e) { console.error("hats.json okunamadi", e.message); }
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
    await pool.query("CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)");
  })();
  const row = (r) => (r ? { key: r.key, name: r.name, salt: r.salt, hash: r.hash, tokens: r.tokens, coins: Number(r.coins), gems: Number(r.gems), fire: Number(r.fire) || 0, daily_last: r.daily_last == null ? -1 : Number(r.daily_last), daily_streak: Number(r.daily_streak) || 0, hats: r.hats, op: r.op === true, rank: r.rank || "", mute_until: Number(r.mute_until) || 0, mute_by: r.mute_by || "", mute_reason: r.mute_reason || "", ban_until: Number(r.ban_until) || 0, ban_by: r.ban_by || "", ban_reason: r.ban_reason || "" } : null);
  return {
    kind: "postgres",
    async get(key) { await ready; return row((await pool.query("SELECT * FROM users WHERE key=$1", [key])).rows[0]); },
    async byToken(th) { await ready; return row((await pool.query("SELECT * FROM users WHERE tokens ? $1", [th])).rows[0]); },
    async create(u) { await ready; const r = await pool.query("INSERT INTO users(key,name,salt,hash,tokens) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING", [u.key, u.name, u.salt, u.hash, JSON.stringify(u.tokens)]); return r.rowCount === 1; },
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
  const u = { key: name.toLowerCase(), name, salt, hash: await scrypt(password, salt), tokens: [], coins: 0, gems: 0, fire: 0, daily_last: -1, daily_streak: 0, hats: [], op: false, rank: "" };
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

async function adminBalance(body) {
  const u = await store.get(String(body.name || "").trim().toLowerCase());
  if (!u) return { status: 404, error: "Oyuncu bulunamadi" };
  return { status: 200, ok: true, name: u.name, coins: u.coins || 0, gems: u.gems || 0, hats: u.hats || [], op: u.op === true, rank: u.rank || "" };
}

const ADMIN_PAGE = `<!doctype html><html lang="tr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Admin</title>
<style>body{font-family:system-ui,sans-serif;background:#0b0f18;color:#e8eefc;margin:0;padding:18px;max-width:460px;margin:auto}h1{font-size:22px}input,button{width:100%;box-sizing:border-box;font-size:18px;padding:12px;margin:6px 0;border-radius:10px;border:1px solid #38425a;background:#161d2e;color:#fff}button{background:#4cc9ff;color:#06202e;border:0;font-weight:700}pre{background:#161d2e;padding:12px;border-radius:10px;white-space:pre-wrap;word-break:break-all}</style></head><body>
<h1>Oyuncuya para gonder</h1>
<input id="key" type="password" placeholder="Admin anahtari" autocomplete="off">
<input id="name" placeholder="Oyuncu ismi">
<input id="coins" type="number" placeholder="Altin (negatif = geri al)">
<input id="gems" type="number" placeholder="Elmas (negatif = geri al)">
<button onclick="go('give')">Gonder</button>
<button onclick="go('balance')" style="background:#2a3550;color:#e8eefc">Bakiyeyi goster</button>
<h1 style="margin-top:26px">OP ver / al</h1>
<p style="color:#9fb0cf;font-size:14px;margin:0 0 4px">Yukaridaki anahtar + oyuncu ismi kullanilir. OP olan oyuncu oyunda /panel yazip rank verebilir.</p>
<button onclick="go('op',true)" style="background:#7bd88f;color:#06260f">OP ver</button>
<button onclick="go('op',false)" style="background:#ff6b6b;color:#2b0505">OP al (kaldir)</button>
<pre id="out"></pre>
<script>
async function go(a,op){const g=id=>document.getElementById(id).value;const b={key:g('key'),name:g('name'),coins:g('coins'),gems:g('gems'),op:op===true};
try{const r=await fetch('/admin/'+a,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)});out.textContent=r.status+' '+JSON.stringify(await r.json(),null,1)}catch(e){out.textContent='Hata: '+e}}
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

function readBody(req) {
  return new Promise((resolve) => {
    let b = "";
    req.on("data", (d) => { b += d; if (b.length > 2048) { req.destroy(); resolve(null); } });
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
  if (req.method !== "POST" || !["/register", "/login", "/me", "/logout", "/profile", "/buy_hat", "/daily_claim", "/top", "/look", "/bw_points", "/rank_set", "/mute", "/unmute", "/ban", "/unban", "/admin/give", "/admin/balance", "/admin/op"].includes(url)) return false;
  const out = (code, obj) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
  try {
    const ip = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
    const body = await readBody(req);
    if (!body || typeof body !== "object") return out(400, { ok: false, error: "Gecersiz istek" }), true;
    if ((url === "/register" || url === "/login" || url.startsWith("/admin/")) && limited(ip)) return out(429, { ok: false, error: "Cok fazla deneme, biraz bekle" }), true;
    const send = (r) => { const { status, ...rest } = r; out(status, { ok: !!r.ok, ...rest }); return true; };
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
      if (!adminOk(body.key)) return send({ status: 403, error: "Yetkisiz" });
      return send(url === "/admin/give" ? await adminGive(body) : url === "/admin/op" ? await adminOp(body) : await adminBalance(body));
    }
    await logout(body.token);
    return out(200, { ok: true }), true;
  } catch (e) {
    console.error("auth hatasi", e);
    return out(500, { ok: false, error: "Sunucu hatasi" }), true;
  }
}

module.exports = { handleHttp, verify, verifyUser, lookupName, setRankListener, setMuteListener, setBanListener, RANKS };
