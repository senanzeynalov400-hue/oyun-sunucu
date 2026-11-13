"use strict";
// SMP: herkesin ayni dunyada oynadigi kalici survival dunyasi (v2: bolge bazli, sikistirilmis, yedekli).
//
// Arazi seed'den uretilir (istemci, Godot); sunucu oyuncularin DEGISTIRDIGI bloklari saklar: (x, y, z) -> blok id.
// Bloklar 512x512'lik BOLGELERE (region) ayrilir; her bolge ayri gzip dosyasi / veritabani satiridir.
// Degisen bolge en gec 15 sn'de yazilir, sadece o bolge (tum dunya tek dosya degil, event loop bloklanmaz).
//
// Depolama: DATABASE_URL varsa Postgres (tablolar: smp_regions, smp_backups), yoksa DATA_DIR/smp_regions/*.bin
//           + DATA_DIR/smp_backups/*.bak. Render ucretsiz planinda disk silinir -> kalici olmasi icin DATABASE_URL ver.
//
// GUVENLIK:
//  * Yukleme basarisiz olursa (DB kapali, bozuk dosya) kayit DURUR, dunya bos veriyle ezilmez; 30 sn'de bir tekrar denenir.
//  * Her bolge dosyasinin bir onceki surumu .bak olarak tutulur; ana dosya bozuksa .bak okunur.
//  * Otomatik yedek: 6 saatte bir (degisiklik varsa), en son 8 yedek tutulur (hepsi sikistirilmis). Yedek = tum dunya.
//  * Gecersiz blok kimligi (> SMP_MAX_BLOCK_ID, varsayilan 255) kabul edilmez; eski kayittaki gecersizler yuklerken silinir.
//
// Komut satiri (SUNUCUYU DURDURUP calistir):
//   node smp.js list                 -> yedekleri listele
//   node smp.js backup               -> simdi yedek al
//   node smp.js restore <id|latest>  -> yedekten geri yukle (once "before-restore" yedegi alinir)
//   node smp.js stats                -> blok / bolge sayisi
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const zlib = require("zlib");
const { promisify } = require("util");
const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

const MAX_BLOCKS = Number(process.env.SMP_MAX_BLOCKS) || 6000000;        // en fazla bu kadar degisen blok
const MAX_BLOCK_ID = Number(process.env.SMP_MAX_BLOCK_ID) || 255;        // chunk verisi bayt (PackedByteArray): blok id <= 255
const COORD = 1048576;                      // |x|, |z| sinirlari
const H = 128;
const REGION_SHIFT = 9;                     // bolge = 512x512 blok (32x32 chunk)
const SAVE_EVERY_MS = 15000;
const CHUNK_SEND = 3000;                    // girerken mesaj basina blok sayisi
const RETRY_LOAD_MS = 30000;
const PENDING_MAX = 200000;                 // yukleme bitmeden gelen degisiklikler
const BACKUP_EVERY_MS = (Number(process.env.SMP_BACKUP_HOURS) || 6) * 3600 * 1000;
const BACKUP_KEEP = Number(process.env.SMP_BACKUP_KEEP) || 8;
const MAGIC = Buffer.from("SMPB1");

const dir = process.env.DATA_DIR || path.join(__dirname, "data");
const regionDir = path.join(dir, "smp_regions");
const backupDir = path.join(dir, "smp_backups");
const legacyFile = path.join(dir, "smp_blocks.bin");      // v1 tek dosya (otomatik aktarilir, silinmez)

const regions = new Map();                  // "rx,rz" -> { rx, rz, m: Map(anahtar -> blok id) }
const dirty = new Set();                    // yazilmasi gereken bolgeler
let total = 0;
let state = "loading";                      // loading | ok | failed
let pending = [];
let saving = false;
let backingUp = false;
let changedSinceBackup = false;
let lastBackupAt = 0;
let pool = null;
let retryTimer = null;
let firstDone;
const firstLoad = new Promise((r) => { firstDone = r; });

const keyOf = (x, y, z) => ((x + COORD) * 2097152 + (z + COORD)) * 128 + y;
function unkey(k) {
  const y = k % 128;
  const r = (k - y) / 128;
  const zz = r % 2097152;
  const xx = (r - zz) / 2097152;
  return [xx - COORD, y, zz - COORD];
}
const ridOf = (rx, rz) => rx + "," + rz;
const fileOf = (r) => path.join(regionDir, "r." + r.rx + "." + r.rz + ".bin");
const dbKeyOf = (r) => "r." + r.rx + "." + r.rz;

// ---------------------------------------------------------------- depolama
if (process.env.DATABASE_URL) {
  const { Pool } = require("pg");
  const url = process.env.DATABASE_URL;
  pool = new Pool({ connectionString: url, ssl: /localhost|127\.0\.0\.1/.test(url) ? false : { rejectUnauthorized: false }, max: 1 });
  pool.on("error", (e) => console.error("SMP db hata", e.message));
}

async function setupTables() {
  await pool.query("CREATE TABLE IF NOT EXISTS smp_regions (key TEXT PRIMARY KEY, data BYTEA NOT NULL, saved BIGINT NOT NULL DEFAULT 0)");
  await pool.query("CREATE TABLE IF NOT EXISTS smp_players (name TEXT PRIMARY KEY, data TEXT NOT NULL, saved BIGINT NOT NULL DEFAULT 0)");
  await pool.query("CREATE TABLE IF NOT EXISTS smp_backups (id TEXT PRIMARY KEY, created BIGINT NOT NULL, blocks INT NOT NULL DEFAULT 0, data BYTEA NOT NULL)");
}

// ---------------------------------------------------------------- bellek ici dunya
function valid(x, y, z, id) {
  return Number.isInteger(x) && Number.isInteger(y) && Number.isInteger(z) && Number.isInteger(id) &&
    y >= 0 && y < H && id >= 0 && id <= MAX_BLOCK_ID && Math.abs(x) < COORD && Math.abs(z) < COORD;
}

// Dogrulanmis blogu yazar. false = blok siniri dolu.
function put(x, y, z, id) {
  const rx = x >> REGION_SHIFT, rz = z >> REGION_SHIFT;
  const rid = ridOf(rx, rz);
  const k = keyOf(x, y, z);
  let r = regions.get(rid);
  const had = r ? r.m.has(k) : false;
  if (!had && total >= MAX_BLOCKS) return false;
  if (had && r.m.get(k) === id) return true;
  if (!r) { r = { rx, rz, m: new Map() }; regions.set(rid, r); }
  r.m.set(k, id);
  if (!had) total++;
  dirty.add(rid);
  return true;
}

// Yukleme sirasinda (sinir kontrolu yok, dirty isaretlemez)
function loadPut(x, y, z, id) {
  const rx = x >> REGION_SHIFT, rz = z >> REGION_SHIFT;
  const rid = ridOf(rx, rz);
  let r = regions.get(rid);
  if (!r) { r = { rx, rz, m: new Map() }; regions.set(rid, r); }
  const k = keyOf(x, y, z);
  if (!r.m.has(k)) total++;
  r.m.set(k, id);
}

function encodeRegion(r) {
  const buf = Buffer.alloc(r.m.size * 11);
  let o = 0;
  for (const [k, id] of r.m) {
    const [x, y, z] = unkey(k);
    buf.writeInt32LE(x, o); buf.writeInt32LE(z, o + 4); buf.writeUInt8(y, o + 8); buf.writeUInt16LE(id, o + 9);
    o += 11;
  }
  return buf;
}

// Ham (gunzip edilmis) veriyi dunyaya isler. Once tamamen dogrular, sonra yazar (yarim kalmaz). Silinen gecersiz blok sayisini doner.
function decodeRaw(buf) {
  if (buf.length % 11 !== 0) throw new Error("bozuk bolge boyutu");
  let dropped = 0;
  for (let o = 0; o + 11 <= buf.length; o += 11) {
    const x = buf.readInt32LE(o), z = buf.readInt32LE(o + 4), y = buf.readUInt8(o + 8), id = buf.readUInt16LE(o + 9);
    if (!valid(x, y, z, id)) { dropped++; continue; }
    loadPut(x, y, z, id);
  }
  return dropped;
}
let droppedTotal = 0;
async function decodeInto(gz) { droppedTotal += decodeRaw(await gunzip(gz)); }

// ---------------------------------------------------------------- yukleme
async function importLegacy() {
  let gz = null;
  try {
    if (pool) {
      const r = await pool.query("SELECT data FROM smp_world WHERE key='blocks'");
      if (r.rows[0]) gz = Buffer.from(r.rows[0].data);
    } else if (fs.existsSync(legacyFile)) {
      gz = await fsp.readFile(legacyFile);
    }
  } catch (e) {
    if (!/does not exist/i.test(e.message)) throw e;     // eski tablo yoksa sorun degil
  }
  if (!gz) return;
  await decodeInto(gz);
  for (const rid of regions.keys()) dirty.add(rid);
  console.log("SMP: eski tek-parca kayit bolge formatina aktarildi (" + total + " blok). Eski kayit silinmedi.");
}

async function loadAll() {
  regions.clear(); total = 0; dirty.clear(); droppedTotal = 0;
  let failed = 0, files = 0;
  if (pool) {
    const r = await pool.query("SELECT key, data FROM smp_regions");
    for (const row of r.rows) {
      files++;
      try { await decodeInto(Buffer.from(row.data)); }
      catch (e) { failed++; console.error("SMP bolge okunamadi (" + row.key + "):", e.message); }
    }
  } else {
    await fsp.mkdir(regionDir, { recursive: true });
    const bases = new Set();
    for (const n of await fsp.readdir(regionDir)) {
      const m = /^(r\.-?\d+\.-?\d+\.bin)(\.bak)?$/.exec(n);
      if (m) bases.add(m[1]);
    }
    for (const base of bases) {
      files++;
      let ok = false;
      for (const cand of [base, base + ".bak"]) {
        try {
          await decodeInto(await fsp.readFile(path.join(regionDir, cand)));
          ok = true;
          if (cand !== base) {
            console.error("SMP: " + base + " bozuk, .bak'tan okundu");
            const mm = /^r\.(-?\d+)\.(-?\d+)\.bin$/.exec(base);
            dirty.add(ridOf(Number(mm[1]), Number(mm[2])));      // ana dosya yeniden yazilsin
          }
          break;
        } catch (e) { console.error("SMP bolge okunamadi (" + cand + "):", e.message); }
      }
      if (!ok) failed++;
    }
  }
  if (failed) throw new Error(failed + " bolge okunamadi (ana dosya ve .bak)");
  if (files === 0) await importLegacy();
  if (droppedTotal) { console.log("SMP: " + droppedTotal + " gecersiz blok kaydi silindi"); }
}

async function initLoad() {
  state = "loading";
  try {
    if (pool) await setupTables();
    await loadAll();
    state = "ok";
    for (const p of pending) put(p[0], p[1], p[2], p[3]);
    if (pending.length) changedSinceBackup = true;
    pending = [];
    try {
      const bl = await listBackups();
      lastBackupAt = bl.length ? bl[0].created : 0;
    } catch (e) { console.error("SMP yedek listesi okunamadi", e.message); }
    console.log("SMP: " + total + " blok / " + regions.size + " bolge yuklendi (" + (pool ? "postgres" : "dosya") + ")");
    if (droppedTotal) for (const rid of regions.keys()) dirty.add(rid);       // temizlenmis hali yazilsin
    await save();
    maybeBackup();
  } catch (e) {
    state = "failed";
    regions.clear(); total = 0; dirty.clear();
    console.error("SMP YUKLENEMEDI -> kayit DURDURULDU (dunya ezilmez), " + (RETRY_LOAD_MS / 1000) + " sn sonra tekrar denenecek:", e.message);
    retryTimer = setTimeout(initLoad, RETRY_LOAD_MS);
    retryTimer.unref();
  } finally {
    firstDone();
  }
}

// ---------------------------------------------------------------- kayit
async function writeRegion(r, gz) {
  if (pool) {
    await pool.query("INSERT INTO smp_regions (key, data, saved) VALUES ($1,$2,$3) ON CONFLICT (key) DO UPDATE SET data=$2, saved=$3", [dbKeyOf(r), gz, Date.now()]);
    return;
  }
  await fsp.mkdir(regionDir, { recursive: true });
  const f = fileOf(r);
  await fsp.writeFile(f + ".tmp", gz);
  try { await fsp.copyFile(f, f + ".bak"); } catch (e) { if (e.code !== "ENOENT") throw e; }   // onceki surum yedegi
  await fsp.rename(f + ".tmp", f);                                                           // atomik degistir
}

async function save() {
  if (saving || state !== "ok" || dirty.size === 0) return;
  saving = true;
  const ids = Array.from(dirty);
  dirty.clear();
  let i = 0;
  try {
    for (; i < ids.length; i++) {
      const r = regions.get(ids[i]);
      if (!r) continue;
      const gz = await gzip(encodeRegion(r));      // sikistirma ayri thread'de: sunucu donmaz
      await writeRegion(r, gz);
    }
  } catch (e) {
    for (let j = i; j < ids.length; j++) dirty.add(ids[j]);
    console.error("SMP yazilamadi", e.message);
  }
  saving = false;
}
setInterval(save, SAVE_EVERY_MS).unref();

// ---------------------------------------------------------------- yedek
const stamp = () => new Date().toISOString().replace(/[:.]/g, "-");

// Tum dunyanin sikistirilmis yedegi. Bolgeler tek tek sikistirilir (event loop serbest kalir).
async function backup(reason) {
  await firstLoad;
  if (state !== "ok" || backingUp || total === 0) return null;
  backingUp = true;
  try {
    const parts = [MAGIC];
    let n = 0;
    for (const r of Array.from(regions.values())) {
      if (!r.m.size) continue;
      const gz = await gzip(encodeRegion(r), { level: 9 });
      const h = Buffer.alloc(12);
      h.writeInt32LE(r.rx, 0); h.writeInt32LE(r.rz, 4); h.writeUInt32LE(gz.length, 8);
      parts.push(h, gz);
      n += r.m.size;
    }
    const blob = Buffer.concat(parts);
    const id = "smp_" + stamp() + "_" + String(reason || "manual").replace(/[^a-z0-9-]/gi, "").slice(0, 20);
    if (pool) {
      await pool.query("INSERT INTO smp_backups (id, created, blocks, data) VALUES ($1,$2,$3,$4)", [id, Date.now(), n, blob]);
      await pool.query("DELETE FROM smp_backups WHERE id NOT IN (SELECT id FROM smp_backups ORDER BY created DESC LIMIT $1)", [BACKUP_KEEP]);
    } else {
      await fsp.mkdir(backupDir, { recursive: true });
      await fsp.writeFile(path.join(backupDir, id + ".bak.tmp"), blob);
      await fsp.rename(path.join(backupDir, id + ".bak.tmp"), path.join(backupDir, id + ".bak"));
      const all = (await fsp.readdir(backupDir)).filter((f) => f.endsWith(".bak")).sort();
      for (const old of all.slice(0, Math.max(0, all.length - BACKUP_KEEP))) await fsp.unlink(path.join(backupDir, old)).catch(() => {});
    }
    lastBackupAt = Date.now();
    changedSinceBackup = false;
    console.log("SMP yedek alindi: " + id + " (" + n + " blok, " + (blob.length / 1024).toFixed(0) + " KB)");
    return { id, blocks: n, bytes: blob.length };
  } catch (e) {
    console.error("SMP yedek alinamadi", e.message);
    return null;
  } finally {
    backingUp = false;
  }
}

function maybeBackup() {
  if (state !== "ok") return;
  if (Date.now() - lastBackupAt >= BACKUP_EVERY_MS && (changedSinceBackup || lastBackupAt === 0)) backup("auto");
}
setInterval(maybeBackup, 10 * 60 * 1000).unref();

// [{id, created, blocks, bytes}] yeniden eskiye
async function listBackups() {
  if (pool) {
    const r = await pool.query("SELECT id, created, blocks, length(data) AS bytes FROM smp_backups ORDER BY created DESC");
    return r.rows.map((x) => ({ id: x.id, created: Number(x.created), blocks: x.blocks, bytes: Number(x.bytes) }));
  }
  try {
    const out = [];
    for (const f of (await fsp.readdir(backupDir)).filter((n) => n.endsWith(".bak"))) {
      const st = await fsp.stat(path.join(backupDir, f));
      out.push({ id: f.slice(0, -4), created: st.mtimeMs, blocks: null, bytes: st.size });
    }
    return out.sort((a, b) => b.created - a.created);
  } catch (e) { if (e.code === "ENOENT") return []; throw e; }
}

// Yedekten geri yukler. SUNUCU KAPALIYKEN calistir (acikken bellekteki dunya eskisiyle yeniden yazar).
async function restoreBackup(id) {
  await firstLoad;
  const wasOk = state === "ok";          // bozuk bolge yuzunden "failed" ise de geri yukleme calisir (zaten her seyi yedekten yazar)
  if (!wasOk && state !== "failed") throw new Error("SMP yukleniyor, biraz sonra tekrar dene");
  const list = await listBackups();
  if (!list.length) throw new Error("yedek yok");
  const pick = id === "latest" || !id ? list[0] : list.find((b) => b.id === id);
  if (!pick) throw new Error("yedek bulunamadi: " + id);
  let blob;
  if (pool) blob = Buffer.from((await pool.query("SELECT data FROM smp_backups WHERE id=$1", [pick.id])).rows[0].data);
  else blob = await fsp.readFile(path.join(backupDir, pick.id + ".bak"));
  if (blob.length < MAGIC.length || !blob.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error("yedek dosyasi gecersiz");
  const raws = [];
  for (let o = MAGIC.length; o + 12 <= blob.length;) {
    const len = blob.readUInt32LE(o + 8);
    if (o + 12 + len > blob.length) throw new Error("yedek dosyasi eksik/bozuk");
    raws.push(await gunzip(blob.subarray(o + 12, o + 12 + len)));        // once TAMAMI dogrulanir, sonra silinir
    o += 12 + len;
  }
  if (retryTimer) clearTimeout(retryTimer);
  if (wasOk) { await save(); await backup("before-restore"); }
  regions.clear(); total = 0; dirty.clear(); droppedTotal = 0; pending = [];
  if (pool) await pool.query("DELETE FROM smp_regions");
  else if (!wasOk) await fsp.rename(regionDir, regionDir + "_bozuk_" + stamp()).catch(() => {});   // bozuk dosyalar silinmez, yanina alinir
  else for (const n of await fsp.readdir(regionDir).catch(() => [])) if (/^r\./.test(n)) await fsp.unlink(path.join(regionDir, n));
  for (const raw of raws) decodeRaw(raw);
  state = "ok";
  for (const rid of regions.keys()) dirty.add(rid);
  await save();
  changedSinceBackup = false;
  return { id: pick.id, blocks: total, regions: regions.size };
}

// ---------------------------------------------------------------- API
// true = kabul edildi (sunucu herkese iletebilir), false = reddedildi (iletme).
function setBlock(x, y, z, id) {
  x = Number(x); y = Number(y); z = Number(z); id = Number(id);
  if (!valid(x, y, z, id)) return false;
  if (state !== "ok") {                      // yukleme bitmeden gelenler beklemeye alinir (sonra uygulanir, eski veriyi ezmez)
    if (pending.length >= PENDING_MAX) return false;
    pending.push([x, y, z, id]);
    return true;
  }
  const ok = put(x, y, z, id);
  if (ok) changedSinceBackup = true;
  return ok;
}

// Bir bolgenin tum bloklarini parca parca gonderir (gonderirken guncel deger okunur). false = iptal (oyuncu cikti / yeni istek).
async function streamRegion(ws, send, r, cur) {
  const keys = Array.from(r.m.keys());
  for (let i = 0; i < keys.length; i += CHUNK_SEND) {
    if (!cur()) return false;
    const flat = [];
    const end = Math.min(keys.length, i + CHUNK_SEND);
    for (let j = i; j < end; j++) {
      const id = r.m.get(keys[j]);
      if (id === undefined) continue;
      const [x, y, z] = unkey(keys[j]);
      flat.push(x, y, z, id);
    }
    if (flat.length) send(ws, { type: "smp_blocks", b: flat, done: false });
    if (ws.bufferedAmount > 4 * 1024 * 1024) await new Promise((res) => setTimeout(res, 50));   // yavas hat: tampon bosalsin
    else await new Promise((res) => setImmediate(res));
  }
  return true;
}

// ESKI istemciler (join_smp, lazy yok): girene tum degisen bloklari gonderir; son mesajda done:true.
// Ayni soket icin yeni sendAll eskisini durdurur (cift join_smp ayni blogu iki kez gondermez, erken done olmaz).
async function sendAll(ws, send, stillHere) {
  await firstLoad;
  const token = (ws._smpTok = (ws._smpTok || 0) + 1);
  const cur = () => ws._smpTok === token && stillHere();
  for (const r of Array.from(regions.values())) {
    if (!(await streamRegion(ws, send, r, cur))) return;
  }
  if (cur()) send(ws, { type: "smp_blocks", b: [], done: true });
}

// YENI istemciler (join_smp lazy:true): sadece istedigi bolgeleri alir. Istekler sirayla islenir; her istek sonunda {type:"smp_done"}.
function sendRegions(ws, send, stillHere, list) {
  const run = async () => {
    await firstLoad;
    for (const e of list) {
      const r = regions.get(ridOf(e[0], e[1]));
      if (r && !(await streamRegion(ws, send, r, stillHere))) return;
    }
    if (stillHere()) send(ws, { type: "smp_done" });
  };
  ws._smpChain = (ws._smpChain || Promise.resolve()).then(run).catch((e) => console.error("SMP bolge gonderilemedi", e.message));
  return ws._smpChain;
}

// ---------------------------------------------------------------- oyuncu verisi (envanter, home'lar, son konum): hesaba bagli, sunucuda
// Istemci sadece bu alanlari gonderir; sunucu temizler ve eski kayitla birlestirir. (Istemci-otoriter: hileye karsi koruma DEGIL, kayip/cihaz degistirme icin.)
const PLAYER_MAX_BYTES = 65536;
const phex = (name) => Buffer.from(String(name).toLowerCase()).toString("hex");
const playerFile = (name) => path.join(dir, "smp_players", phex(name) + ".json");
const fin = (v) => typeof v === "number" && Number.isFinite(v) && Math.abs(v) < 1e7;

function cleanPlayerData(d) {
  if (!d || typeof d !== "object" || Array.isArray(d)) return null;
  const out = {};
  const iv = (v) => Number.isInteger(v) && v >= 0 && v <= 65535;
  if (d.inv && typeof d.inv === "object" && Array.isArray(d.inv.slots)) {
    const slots = d.inv.slots.slice(0, 200);
    const equip = Array.isArray(d.inv.equip) ? d.inv.equip.slice(0, 40) : [];
    if (slots.every(iv) && equip.every(iv)) out.inv = { slots, equip };
  }
  if (d.homes && typeof d.homes === "object" && !Array.isArray(d.homes)) {
    const homes = {};
    for (const k of Object.keys(d.homes).slice(0, 10)) {
      const v = d.homes[k];
      if (/^[a-z0-9_-]{1,16}$/.test(k) && Array.isArray(v) && v.length === 4 && v.every(fin)) homes[k] = v;
    }
    out.homes = homes;
  }
  if (Array.isArray(d.home) && d.home.length === 3 && d.home.every(fin)) out.home = d.home;
  if (Array.isArray(d.last) && d.last.length === 4 && d.last.every(fin)) out.last = d.last;
  return out;
}

// -> {t, d} | null
async function getPlayer(name) {
  if (pool) {
    const r = await pool.query("SELECT data, saved FROM smp_players WHERE name=$1", [String(name).toLowerCase()]);
    if (!r.rows[0]) return null;
    return { t: Number(r.rows[0].saved), d: JSON.parse(r.rows[0].data) };
  }
  for (const f of [playerFile(name), playerFile(name) + ".bak"]) {
    try { const o = JSON.parse(await fsp.readFile(f, "utf8")); if (o && typeof o.t === "number") return o; } catch (e) { if (e.code !== "ENOENT") console.error("SMP oyuncu verisi okunamadi", f, e.message); }
  }
  return null;
}

// Temizleyip eski kayitla birlestirir; yeni sunucu zamanini (t) doner. null = gecersiz / cok buyuk.
async function setPlayer(name, d) {
  if (state !== "ok") return null;
  const clean = cleanPlayerData(d);
  if (!clean) return null;
  const old = await getPlayer(name);
  const merged = Object.assign({}, old ? old.d : {}, clean);
  const t = Date.now();
  const text = JSON.stringify({ t, d: merged });
  if (text.length > PLAYER_MAX_BYTES) return null;
  if (pool) {
    await pool.query("INSERT INTO smp_players (name, data, saved) VALUES ($1,$2,$3) ON CONFLICT (name) DO UPDATE SET data=$2, saved=$3", [String(name).toLowerCase(), JSON.stringify(merged), t]);
  } else {
    const f = playerFile(name);
    await fsp.mkdir(path.dirname(f), { recursive: true });
    await fsp.writeFile(f + ".tmp", text);
    try { await fsp.copyFile(f, f + ".bak"); } catch (e) { if (e.code !== "ENOENT") throw e; }
    await fsp.rename(f + ".tmp", f);
  }
  return t;
}

async function flush() { while (saving) await new Promise((r) => setTimeout(r, 50)); await save(); }
const count = () => total;
const status = () => state;
const whenReady = () => firstLoad;
const stats = () => ({ state, blocks: total, regions: regions.size, dirty: dirty.size, pending: pending.length, lastBackupAt });

initLoad();

module.exports = { setBlock, sendAll, sendRegions, getPlayer, setPlayer, flush, count, status, whenReady, stats, backup, listBackups, restoreBackup };

// ---------------------------------------------------------------- komut satiri
if (require.main === module) {
  (async () => {
    await firstLoad;
    const cmd = process.argv[2];
    try {
      if (state !== "ok" && cmd !== "restore" && cmd !== "list") throw new Error("SMP yuklenemedi (bozuk bolge?). Cozum: node smp.js restore latest");
      if (cmd === "list") {
        for (const b of await listBackups()) console.log(new Date(b.created).toISOString(), b.id, (b.bytes / 1024).toFixed(0) + " KB", b.blocks == null ? "" : b.blocks + " blok");
      } else if (cmd === "backup") {
        console.log(await backup("manual") || "yedek alinamadi (dunya bos olabilir)");
      } else if (cmd === "restore") {
        console.log("Geri yuklendi:", await restoreBackup(process.argv[3] || "latest"));
      } else if (cmd === "stats") {
        console.log(stats());
      } else {
        console.log("Kullanim: node smp.js list | backup | restore <id|latest> | stats");
      }
    } catch (e) { console.error("HATA:", e.message); process.exitCode = 1; }
    process.exit();
  })();
}
