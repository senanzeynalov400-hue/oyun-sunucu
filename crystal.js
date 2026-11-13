"use strict";
// CRYSTAL ARENA: eslesmesiz, herkesin ayni "crystal" odasina girdigi 400x400 kum duzlugu (CrystalPvP).
// Harita SUNUCUDA tutulur: arazi sabit (kum + bedrock), sunucu oyuncularin DEGISTIRDIGI bloklari ve KOYDUGU end kristallerini bellekte saklar.
// Yeni giren oyuncuya tum degisiklikler gonderilir; her 10 dakikada bir harita sifirlanir ("crystal_reset" herkese gider).
// Arazi (istemci crystal_map.gd ile ayni): x, z = -200..199 | y = 30 bedrock, 31..60 kum, ustu hava.
const HALF = 200;
const BEDROCK_Y = 30;
const GROUND_Y = 60;
const MAX_Y = 127;
const AIR = 0, SAND = 4, BEDROCK = 12, OBSIDIAN = 50;
const RESET_MS = (Number(process.env.CRYSTAL_RESET_MIN) || 10) * 60 * 1000;
const MAX_BLOCKS = 400000;           // bellek sigortasi
const MAX_CRYSTALS = 600;
const BLOCK_REACH = 16;              // konum paketine gore bu mesafeden uzak blok degisikligi reddedilir
const BLOCKS_PER_SEC = 60;
const SEND_CHUNK = 1500;

const blocks = new Map();            // "x,y,z" -> blok id (arazinin KENDISINDEN farkli olanlar)
const crystals = new Map();          // "x,y,z" -> true
let nextResetAt = Date.now() + RESET_MS;
let onReset = null;

const key = (x, y, z) => x + "," + y + "," + z;
const inBounds = (x, y, z) => Number.isInteger(x) && Number.isInteger(y) && Number.isInteger(z) && x >= -HALF && x < HALF && z >= -HALF && z < HALF && y >= 0 && y <= MAX_Y;

function baseAt(y) {
  if (y === BEDROCK_Y) return BEDROCK;
  if (y > BEDROCK_Y && y <= GROUND_Y) return SAND;
  return AIR;
}
function blockAt(x, y, z) {
  const v = blocks.get(key(x, y, z));
  return v === undefined ? baseAt(y) : v;
}

// Oyuncu bir blok koydu / kirdi. Gecerliyse saklanir (true), degilse false (kimseye iletilmez)
function setBlock(x, y, z, id) {
  x = Number(x); y = Number(y); z = Number(z); id = Number(id);
  if (!inBounds(x, y, z) || !Number.isInteger(id) || id < 0 || id > 255) return false;
  if (y <= BEDROCK_Y) return false;                      // bedrock ve alti degismez
  if (id === BEDROCK) return false;
  const k = key(x, y, z);
  if (id === baseAt(y)) blocks.delete(k);
  else {
    if (blocks.size >= MAX_BLOCKS && !blocks.has(k)) return false;
    blocks.set(k, id);
  }
  if (id !== AIR) crystals.delete(k);                    // kristalin oldugu hucreye blok konursa kristal gider
  return true;
}

// Rate limit (istemci basina)
function rateOk(c, now) {
  if (!c.cbl || now - c.cbl.t >= 1000) c.cbl = { t: now, n: 0 };
  return ++c.cbl.n <= BLOCKS_PER_SEC;
}
function reachOk(c, x, y, z, now) {
  const ps = c.pst;
  if (!ps || !Array.isArray(ps.p) || now - ps.t > 5000) return true;     // konum bilinmiyorsa (yeni girdi) engelleme
  return Math.hypot(Number(x) - ps.p[0], Number(y) - ps.p[1], Number(z) - ps.p[2]) <= BLOCK_REACH;
}

// End kristali: sadece obsidyen / bedrock USTUNE konur, hucre bos olmali
function placeCrystal(x, y, z) {
  x = Number(x); y = Number(y); z = Number(z);
  if (!inBounds(x, y, z) || y <= BEDROCK_Y || crystals.size >= MAX_CRYSTALS) return false;
  if (crystals.has(key(x, y, z)) || blockAt(x, y, z) !== AIR) return false;
  const below = blockAt(x, y - 1, z);
  if (below !== OBSIDIAN && below !== BEDROCK) return false;
  crystals.set(key(x, y, z), true);
  return true;
}
// Kristal patladi: sunucuda varsa silinir (true). Olmayan kristal icin sahte patlama paketi iletilmez
function boomCrystal(x, y, z) {
  return crystals.delete(key(Number(x), Number(y), Number(z)));
}

function resetIn() { return Math.max(0, nextResetAt - Date.now()); }

// Girene tum degisiklikleri yolla (arazi zaten sabit; sadece farklar). alive(): baglanti hala ayni odada mi
function sendAll(ws, send, alive) {
  const list = [];
  for (const [k, id] of blocks) { const p = k.split(","); list.push([+p[0], +p[1], +p[2], id]); }
  let i = 0;
  const step = () => {
    if (!alive()) return;
    if (i < list.length) {
      send(ws, { type: "crystal_blocks", b: list.slice(i, i + SEND_CHUNK) });
      i += SEND_CHUNK;
      setImmediate(step);
      return;
    }
    const cr = [];
    for (const k of crystals.keys()) { const p = k.split(","); cr.push([+p[0], +p[1], +p[2]]); }
    send(ws, { type: "crystal_blocks", b: [], c: cr, done: true });
  };
  step();
}

function reset() {
  blocks.clear();
  crystals.clear();
  nextResetAt = Date.now() + RESET_MS;
  if (onReset) onReset(RESET_MS);
}

function start(cb) {
  onReset = cb;
  setInterval(() => { if (Date.now() >= nextResetAt) reset(); }, 1000).unref();
}

module.exports = { start, reset, setBlock, rateOk, reachOk, placeCrystal, boomCrystal, resetIn, sendAll, blockAt, RESET_MS, HALF, BEDROCK_Y, GROUND_Y };
