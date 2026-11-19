"use strict";
// SMP DEPO (v251): /depo komutu. Oyuncu basina 54 slotluk KALICI depo (ender chest gibi): kapatinca da, cikis-giriste de, sunucu yeniden
// baslayinca da silinmez. Kayit: key = kucuk harfli oyuncu adi -> { i:[54 esya kimligi], c:[54 adet] }.
// Depolama: DATABASE_URL varsa Postgres (tablo smp_depo, oyuncu basina bir satir), yoksa DATA_DIR/smp_depo.json. Degisince en gec 2 sn'de yazilir.
// Ayni hesap iki cihazdan ayni anda acarsa ezme / esya cogaltma olmasin diye acan cihaz KILIT alir (kapaninca / kopunca / 3 dk sonra kalkar).
const fs = require("fs");
const path = require("path");

const SLOTS = 54;
const MAX_ITEM_ID = 511;   // sandik ile ayni: BLOCK_COUNT buyuse de esya silinmesin diye genis tutulur
const MAX_STACK = 64;
const MAX_PLAYERS = 200000;
const LOCK_MS = 180000;

const dir = process.env.DATA_DIR || path.join(__dirname, "data");
const file = path.join(dir, "smp_depo.json");
const map = new Map();
const dirty = new Set();
let pool = null, ready = Promise.resolve(), saving = false;
if (process.env.DATABASE_URL) {
  const { Pool } = require("pg");
  const url = process.env.DATABASE_URL;
  pool = new Pool({ connectionString: url, ssl: /localhost|127\.0\.0\.1/.test(url) ? false : { rejectUnauthorized: false }, max: 1 });
  ready = pool.query("CREATE TABLE IF NOT EXISTS smp_depo (key TEXT PRIMARY KEY, data TEXT NOT NULL)").catch((e) => console.error("smp_depo tablo hatasi", e.message));
}
const loaded = (async () => {
  await ready;
  try {
    if (pool) {
      const r = await pool.query("SELECT key, data FROM smp_depo");
      for (const row of r.rows) { try { map.set(row.key, JSON.parse(row.data)); } catch (e) { console.error("smp_depo bozuk kayit", row.key); } }
    } else if (fs.existsSync(file)) {
      const j = JSON.parse(fs.readFileSync(file, "utf8"));
      for (const k of Object.keys(j)) map.set(k, j[k]);
    }
    console.log("SMP depo: " + map.size + " oyuncu yuklendi");
  } catch (e) { console.error("SMP depolari yuklenemedi", e.message); }
})();

async function save() {
  if (saving || !dirty.size) return;
  saving = true;
  const keys = [...dirty];
  dirty.clear();
  try {
    if (pool) {
      for (const k of keys) {
        const r = map.get(k);
        if (r) await pool.query("INSERT INTO smp_depo (key, data) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET data=$2", [k, JSON.stringify(r)]);
      }
    } else {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file + ".tmp", JSON.stringify(Object.fromEntries(map)));
      fs.renameSync(file + ".tmp", file);
    }
  } catch (e) { for (const k of keys) dirty.add(k); console.error("SMP depolari yazilamadi", e.message); }
  saving = false;
}
setInterval(save, 2000).unref();

const keyOf = (name) => { const k = String(name || "").trim().toLowerCase(); return k && k.length <= 64 ? k : null; };
function get(k) { return k ? (map.get(k) || null) : null; }
function set(k, d) {
  if (!k || !d || !Array.isArray(d.i) || !Array.isArray(d.c) || d.i.length !== SLOTS || d.c.length !== SLOTS) return null;
  const i = [], c = [];
  for (let n = 0; n < SLOTS; n++) {
    let id = Math.floor(Number(d.i[n])), cnt = Math.floor(Number(d.c[n]));
    if (!Number.isFinite(id) || !Number.isFinite(cnt) || id < 1 || id > MAX_ITEM_ID || cnt < 1) { id = 0; cnt = 0; }
    if (cnt > MAX_STACK) cnt = MAX_STACK;
    i.push(id); c.push(cnt);
  }
  if (!map.has(k) && map.size >= MAX_PLAYERS) return null;
  const rec = { i, c };
  map.set(k, rec); dirty.add(k);
  return rec;
}

// KILIT (ayni hesap, iki cihaz)
const locks = new Map();   // key -> { ws, t }
function lockHeldByOther(k, ws) {
  const l = locks.get(k);
  if (!l || l.ws === ws) return false;
  if (l.ws.readyState !== 1 || Date.now() - l.t > LOCK_MS) { locks.delete(k); return false; }
  return true;
}
function tryLock(k, ws) { if (!k || lockHeldByOther(k, ws)) return false; locks.set(k, { ws, t: Date.now() }); return true; }
function unlock(k, ws) { const l = locks.get(k); if (l && l.ws === ws) locks.delete(k); }
function unlockAll(ws) { for (const [k, l] of locks) if (l.ws === ws) locks.delete(k); }
async function flush() { await loaded; for (const k of map.keys()) dirty.add(k); await save(); }

module.exports = { SLOTS, keyOf, get, set, tryLock, unlock, unlockAll, lockHeldByOther, flush, loaded };
