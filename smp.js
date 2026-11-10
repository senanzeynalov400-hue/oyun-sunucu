// SMP: herkesin ayni dunyada oynadigi kalici survival dunyasi.
// Arazi seed'den uretilir (istemci), burada SADECE oyuncularin degistirdigi bloklar saklanir: (x, y, z) -> blok id.
// Depolama: DATABASE_URL varsa Postgres (tek satir, gzip), yoksa DATA_DIR/smp_blocks.bin (gzip). Degisince en gec 15 sn'de yazilir.
// Not: Render ucretsiz planinda disk silinir -> kalici olmasi icin DATABASE_URL (ornegin Neon) ver.
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const MAX_BLOCKS = 6000000;                 // en fazla bu kadar degisen blok (yaklasik 60-70 MB bellek)
const COORD = 1048576;                      // |x|, |z| sinirlari
const H = 128;
const SAVE_EVERY_MS = 15000;
const CHUNK_SEND = 3000;                    // girerken mesaj basina blok sayisi

const dir = process.env.DATA_DIR || path.join(__dirname, "data");
const file = path.join(dir, "smp_blocks.bin");

const blocks = new Map();                   // sayisal anahtar -> blok id
let dirty = false;
let saving = false;
let pool = null;
let ready = Promise.resolve();

const keyOf = (x, y, z) => ((x + COORD) * 2097152 + (z + COORD)) * 128 + y;
function unkey(k) {
  const y = k % 128;
  const r = (k - y) / 128;
  const zz = r % 2097152;
  const xx = (r - zz) / 2097152;
  return [xx - COORD, y, zz - COORD];
}

// ---------------------------------------------------------------- depolama
if (process.env.DATABASE_URL) {
  const { Pool } = require("pg");
  const url = process.env.DATABASE_URL;
  pool = new Pool({ connectionString: url, ssl: /localhost|127\.0\.0\.1/.test(url) ? false : { rejectUnauthorized: false }, max: 1 });
  ready = pool.query("CREATE TABLE IF NOT EXISTS smp_world (key TEXT PRIMARY KEY, data BYTEA NOT NULL, saved BIGINT NOT NULL DEFAULT 0)")
    .catch((e) => console.error("smp tablo hatasi", e.message));
}

function encode() {
  const buf = Buffer.alloc(blocks.size * 11);
  let o = 0;
  for (const [k, id] of blocks) {
    const [x, y, z] = unkey(k);
    buf.writeInt32LE(x, o); buf.writeInt32LE(z, o + 4); buf.writeUInt8(y, o + 8); buf.writeUInt16LE(id, o + 9);
    o += 11;
  }
  return zlib.gzipSync(buf);
}
function decode(gz) {
  const buf = zlib.gunzipSync(gz);
  for (let o = 0; o + 11 <= buf.length; o += 11) {
    const x = buf.readInt32LE(o), z = buf.readInt32LE(o + 4), y = buf.readUInt8(o + 8), id = buf.readUInt16LE(o + 9);
    if (y < H) blocks.set(keyOf(x, y, z), id);
  }
}

async function load() {
  await ready;
  try {
    if (pool) {
      const r = await pool.query("SELECT data FROM smp_world WHERE key='blocks'");
      if (r.rows[0]) decode(Buffer.from(r.rows[0].data));
    } else if (fs.existsSync(file)) {
      decode(fs.readFileSync(file));
    }
    console.log("SMP: " + blocks.size + " blok yuklendi (" + (pool ? "postgres" : "dosya") + ")");
  } catch (e) { console.error("SMP yuklenemedi", e.message); }
}
const loaded = load();

async function save() {
  if (saving || !dirty) return;
  saving = true;
  dirty = false;
  try {
    await loaded;
    const gz = encode();
    if (pool) {
      await pool.query("INSERT INTO smp_world (key, data, saved) VALUES ('blocks',$1,$2) ON CONFLICT (key) DO UPDATE SET data=$1, saved=$2", [gz, Date.now()]);
    } else {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file + ".tmp", gz);
      fs.renameSync(file + ".tmp", file);
    }
  } catch (e) { dirty = true; console.error("SMP yazilamadi", e.message); }
  saving = false;
}
setInterval(save, SAVE_EVERY_MS).unref();

// ---------------------------------------------------------------- API
function setBlock(x, y, z, id) {
  x = Number(x); y = Number(y); z = Number(z); id = Number(id);
  if (!Number.isInteger(x) || !Number.isInteger(y) || !Number.isInteger(z) || !Number.isInteger(id)) return false;
  if (y < 0 || y >= H || id < 0 || id > 65535 || Math.abs(x) >= COORD || Math.abs(z) >= COORD) return false;
  const k = keyOf(x, y, z);
  if (!blocks.has(k) && blocks.size >= MAX_BLOCKS) return false;
  if (blocks.get(k) === id) return true;
  blocks.set(k, id);
  dirty = true;
  return true;
}

// Girene tum degisen bloklari parca parca gonderir; son mesajda done:true. Gonderirken guncel deger okunur (arada degisen blok eskisiyle ezilmez).
async function sendAll(ws, send, stillHere) {
  await loaded;
  const keys = Array.from(blocks.keys());
  for (let i = 0; i < keys.length; i += CHUNK_SEND) {
    if (!stillHere()) return;
    const flat = [];
    const end = Math.min(keys.length, i + CHUNK_SEND);
    for (let j = i; j < end; j++) {
      const [x, y, z] = unkey(keys[j]);
      flat.push(x, y, z, blocks.get(keys[j]));
    }
    send(ws, { type: "smp_blocks", b: flat, done: false });
    if (ws.bufferedAmount > 4 * 1024 * 1024) await new Promise((r) => setTimeout(r, 50));   // yavas hat: tampon bosalsin
    else await new Promise((r) => setImmediate(r));
  }
  if (stillHere()) send(ws, { type: "smp_blocks", b: [], done: true });
}

async function flush() { while (saving) await new Promise((r) => setTimeout(r, 50)); await save(); }
const count = () => blocks.size;

module.exports = { setBlock, sendAll, flush, count };
