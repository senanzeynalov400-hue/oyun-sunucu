"use strict";
// SMP SANDIKLARI (v234): sandik ICERIGI + yonu sunucuda tutulur (blok kaydi sadece "burada sandik var" der).
// Eskiden icerik sadece sandigi koyan telefonun bellegindeydi: baska oyuncu sandigi bos goruyor, cikis-giriste icerik siliniyordu.
// Kayit: key "x,y,z" -> { i:[27 esya kimligi], c:[27 adet], t: yon (radyan) }.
// Depolama: DATABASE_URL varsa Postgres (tablo smp_chests, tek satir JSON), yoksa DATA_DIR/smp_chests.json. Degisince en gec 2 sn'de yazilir.
const fs = require("fs");
const path = require("path");

const CHEST_ID = 49;              // blocks.gd enum sirasi: B.CHEST
const MAX_ITEM_ID = 275;          // blocks.gd BLOCK_COUNT - 1
const MAX_STACK = 64;
const MAX_CHESTS = 200000;
const COORD = 1048576;
const H = 128;

const dir = process.env.DATA_DIR || path.join(__dirname, "data");
const file = path.join(dir, "smp_chests.json");
let map = new Map();
let dirty = false, pool = null, ready = Promise.resolve();
if (process.env.DATABASE_URL) {
  const { Pool } = require("pg");
  const url = process.env.DATABASE_URL;
  pool = new Pool({ connectionString: url, ssl: /localhost|127\.0\.0\.1/.test(url) ? false : { rejectUnauthorized: false }, max: 1 });
  ready = pool.query("CREATE TABLE IF NOT EXISTS smp_chests (key TEXT PRIMARY KEY, data TEXT NOT NULL)").catch((e) => console.error("smp_chests tablo hatasi", e.message));
}
const loaded = (async () => {
  await ready;
  try {
    let txt = null;
    if (pool) { const r = await pool.query("SELECT data FROM smp_chests WHERE key='main'"); if (r.rows[0]) txt = r.rows[0].data; }
    else if (fs.existsSync(file)) txt = fs.readFileSync(file, "utf8");
    if (txt) { const j = JSON.parse(txt); for (const k of Object.keys(j)) map.set(k, j[k]); }
    console.log("SMP sandik: " + map.size + " kayit yuklendi");
  } catch (e) { console.error("SMP sandiklari yuklenemedi", e.message); }
})();
async function save() {
  if (!dirty) return;
  dirty = false;
  try {
    const txt = JSON.stringify(Object.fromEntries(map));
    if (pool) await pool.query("INSERT INTO smp_chests (key, data) VALUES ('main',$1) ON CONFLICT (key) DO UPDATE SET data=$1", [txt]);
    else { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(file + ".tmp", txt); fs.renameSync(file + ".tmp", file); }
  } catch (e) { dirty = true; console.error("SMP sandiklari yazilamadi", e.message); }
}
setInterval(save, 2000).unref();

const key = (x, y, z) => x + "," + y + "," + z;
const okPos = (x, y, z) => Number.isInteger(x) && Number.isInteger(y) && Number.isInteger(z) && y >= 0 && y < H && Math.abs(x) < COORD && Math.abs(z) < COORD;

function get(x, y, z) {
  if (!okPos(x, y, z)) return null;
  return map.get(key(x, y, z)) || null;
}
// d: { i:[27], c:[27], t }. Gecersizse null. Basarili: kaydedilen kayit.
function set(x, y, z, d) {
  if (!okPos(x, y, z) || !d || !Array.isArray(d.i) || !Array.isArray(d.c) || d.i.length !== 27 || d.c.length !== 27) return null;
  const i = [], c = [];
  for (let n = 0; n < 27; n++) {
    let id = Math.floor(Number(d.i[n])), cnt = Math.floor(Number(d.c[n]));
    if (!Number.isFinite(id) || !Number.isFinite(cnt) || id < 1 || id > MAX_ITEM_ID || cnt < 1) { id = 0; cnt = 0; }
    if (cnt > MAX_STACK) cnt = MAX_STACK;
    i.push(id); c.push(cnt);
  }
  let t = Number(d.t); if (!Number.isFinite(t) || Math.abs(t) > 10) t = 0;
  const k = key(x, y, z);
  if (!map.has(k) && map.size >= MAX_CHESTS) return null;
  const rec = { i, c, t: Math.round(t * 1000) / 1000 };
  map.set(k, rec); dirty = true;
  return rec;
}
function remove(x, y, z) { if (map.delete(key(x, y, z))) dirty = true; }
async function flush() { await loaded; dirty = true; await save(); }
module.exports = { CHEST_ID, get, set, remove, flush, loaded };
