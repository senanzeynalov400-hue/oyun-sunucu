"use strict";
// SMP OCAKLARI (v247): ocak icerigi sunucuda tutulur (eskiden sadece oyuncunun telefon bellegindeydi: cikis-giriste icerik siliniyordu,
// baskalari bos goruyordu). Kayit: key "x,y,z" -> { i:[3], c:[3], b:yanma, bm:yanma_max, k:pisme, u:yazildigi zaman (ms) }.
// Istemci kaydi alinca gecen sureyi (e sn) ileri sarar, boylece ocak kapaliyken de erimeye devam etmis olur.
// Depolama: DATABASE_URL varsa Postgres (tablo smp_furnaces), yoksa DATA_DIR/smp_furnaces.json.
const fs = require("fs");
const path = require("path");

const FURNACE_ID = 145;           // blocks.gd enum sirasi: B.FURNACE
const MAX_ITEM_ID = 511;
const MAX_STACK = 64;
const MAX_FURNACES = 200000;
const COORD = 1048576;
const H = 128;

const dir = process.env.DATA_DIR || path.join(__dirname, "data");
const file = path.join(dir, "smp_furnaces.json");
let map = new Map();
let dirty = false, pool = null, ready = Promise.resolve();
if (process.env.DATABASE_URL) {
  const { Pool } = require("pg");
  const url = process.env.DATABASE_URL;
  pool = new Pool({ connectionString: url, ssl: /localhost|127\.0\.0\.1/.test(url) ? false : { rejectUnauthorized: false }, max: 1 });
  ready = pool.query("CREATE TABLE IF NOT EXISTS smp_furnaces (key TEXT PRIMARY KEY, data TEXT NOT NULL)").catch((e) => console.error("smp_furnaces tablo hatasi", e.message));
}
const loaded = (async () => {
  await ready;
  try {
    let txt = null;
    if (pool) { const r = await pool.query("SELECT data FROM smp_furnaces WHERE key='main'"); if (r.rows[0]) txt = r.rows[0].data; }
    else if (fs.existsSync(file)) txt = fs.readFileSync(file, "utf8");
    if (txt) { const j = JSON.parse(txt); for (const k of Object.keys(j)) map.set(k, j[k]); }
    console.log("SMP ocak: " + map.size + " kayit yuklendi");
  } catch (e) { console.error("SMP ocaklari yuklenemedi", e.message); }
})();
async function save() {
  if (!dirty) return;
  dirty = false;
  try {
    const txt = JSON.stringify(Object.fromEntries(map));
    if (pool) await pool.query("INSERT INTO smp_furnaces (key, data) VALUES ('main',$1) ON CONFLICT (key) DO UPDATE SET data=$1", [txt]);
    else { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(file + ".tmp", txt); fs.renameSync(file + ".tmp", file); }
  } catch (e) { dirty = true; console.error("SMP ocaklari yazilamadi", e.message); }
}
setInterval(save, 2000).unref();

const key = (x, y, z) => x + "," + y + "," + z;
const okPos = (x, y, z) => Number.isInteger(x) && Number.isInteger(y) && Number.isInteger(z) && y >= 0 && y < H && Math.abs(x) < COORD && Math.abs(z) < COORD;
const num = (v, lo, hi) => { v = Number(v); return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : 0; };

// Dondurulen kayda "e" (kayittan beri gecen saniye) eklenir.
function get(x, y, z) {
  if (!okPos(x, y, z)) return null;
  const r = map.get(key(x, y, z));
  if (!r) return null;
  return { i: r.i, c: r.c, b: r.b, bm: r.bm, k: r.k, e: Math.max(0, Math.min(86400, (Date.now() - r.u) / 1000)) };
}
// d: { i:[3], c:[3], b, bm, k }. Gecersizse null.
function set(x, y, z, d) {
  if (!okPos(x, y, z) || !d || !Array.isArray(d.i) || !Array.isArray(d.c) || d.i.length !== 3 || d.c.length !== 3) return null;
  const i = [], c = [];
  for (let n = 0; n < 3; n++) {
    let id = Math.floor(Number(d.i[n])), cnt = Math.floor(Number(d.c[n]));
    if (!Number.isFinite(id) || !Number.isFinite(cnt) || id < 1 || id > MAX_ITEM_ID || cnt < 1) { id = 0; cnt = 0; }
    if (cnt > MAX_STACK) cnt = MAX_STACK;
    i.push(id); c.push(cnt);
  }
  const k = key(x, y, z);
  if (!map.has(k) && map.size >= MAX_FURNACES) return null;
  const rec = { i, c, b: num(d.b, 0, 100000), bm: num(d.bm, 0, 100000), k: num(d.k, 0, 1000), u: Date.now() };
  map.set(k, rec); dirty = true;
  return { i, c, b: rec.b, bm: rec.bm, k: rec.k, e: 0 };
}
function remove(x, y, z) { if (map.delete(key(x, y, z))) dirty = true; }
async function flush() { await loaded; dirty = true; await save(); }
module.exports = { FURNACE_ID, get, set, remove, flush, loaded };
