// MoMinecraft online sunucu (Render): LOBI + ARENA PVP (herkes ayni odada) + BedWars / PILLARS (8 kisilik bekleme odasi) ve DUELS 1v1 eslesme (her oyunun kendi kuyrugu var).
// Baslatma: npm start   (Node 18+)   Saglik kontrolu: GET /
const http = require("http");
const { WebSocketServer } = require("ws");
const PVP = require("./pvp_check");     // v219: sunucuda vurus dogrulama
const AUTH = require("./auth");
const KUFUR = require("./kufur");
const SOCIAL = require("./social");
const CRY = require("./crystal");            // Crystal Arena: sunucuda tutulan 400x400 kum haritasi, 10 dk'da bir sifirlanir
const SMPF = require("./smp_furnaces");     // v247: SMP ocak icerigi (sunucuda kalici)
const SMPD = require("./smp_depo");          // v251: /depo (oyuncu basina 54 slot, kalici)
const SMPC = require("./smp_chests");      // v234: SMP sandik icerigi (sunucuda kalici)
const SMP = require("./smp");              // SMP: herkesin ortak, kalici survival dunyasi (sadece degisen bloklar saklanir)
const AH = require("./ah");                  // SMP: /ah (oyuncu pazari) + /sell (Dinar)
const ISLANDS = require("./islands");      // v204: Skyblock adalari hesapla birlikte sunucuda saklanir
const REQUIRE_LOGIN = process.env.REQUIRE_LOGIN !== "0";   // giris yapmayan oyuncu lobiye / eslesmeye giremez

const PORT = process.env.PORT || 3000;
const STATE_BACKLOG_MAX = 8192;     // bir istemcide bu kadar bayttan fazla gonderilmemis veri varsa konum paketleri atlanir
const LOBBY_MAX = 40;
const SMP_MAX = 40;              // SMP odasi en fazla 40 kisi
const SMP_BLOCKS_PER_SEC = 600;  // SMP: oyuncu basina saniyede en fazla bu kadar blok degisikligi (TNT patlamalari icin genis)
const SMP_BLOCK_REACH = 64;      // SMP: konum paketine gore bu mesafeden uzak blok degisikligi reddedilir
const CRYSTAL_MAX = 40;          // Crystal Arena: ayni haritada en fazla bu kadar oyuncu
const ARENA_MAX = 30;            // Arena PvP: herkes ayni acik arenada (eslesme yok)
const MATCH_SIZE = 2;            // Duels 1v1
const BW_MAX = 8;               // BedWars: en fazla 8 oyuncu (1/8)
const BW_MIN = 2;               // 2 oyuncu olunca sayim baslar
const BW_COUNTDOWN = 30;        // saniye
const BW_TEAM_ORDER = [3, 5, 2, 4, 0, 6, 1, 7];   // SOLO: her oyuncu ayri takim/ada (ilk iki oyuncu karsi adalarda)

let nextId = 1;
const clients = new Map();   // ws -> {id, name, room, alive}
const rooms = new Map();     // oda adi -> Set<ws>     ("lobby" ve "m-xxxx")
const queues = { bedwars: [], bedwars_siege: [], bedwars_pirate: [], bedwars_frost: [], bedwars_citadel: [], duels: [], pillars: [] };   // oyuna gore eslesme bekleyenler (ws)
// v184: BedWars ve PILLARS ayni bekleme odasi mantigini kullanir (1/8, 2 oyuncuda 30 sn sayim, 8 oyuncuda hemen)
const GROUPS = {
  bedwars: { max: BW_MAX, min: BW_MIN, cd: BW_COUNTDOWN, prefix: "m-", order: BW_TEAM_ORDER, timer: null, startAt: 0 },
  bedwars_siege: { max: BW_MAX, min: BW_MIN, cd: BW_COUNTDOWN, prefix: "m-", order: BW_TEAM_ORDER, timer: null, startAt: 0 },   // Siege haritasi: ayri bekleme odasi (harita karismasin)
  bedwars_pirate: { max: BW_MAX, min: BW_MIN, cd: BW_COUNTDOWN, prefix: "m-", order: BW_TEAM_ORDER, timer: null, startAt: 0 },   // Pirate Isles haritasi: ayri bekleme odasi
  bedwars_frost: { max: BW_MAX, min: BW_MIN, cd: BW_COUNTDOWN, prefix: "m-", order: BW_TEAM_ORDER, timer: null, startAt: 0 },   // Frostdune haritasi: ayri bekleme odasi
  bedwars_citadel: { max: BW_MAX, min: BW_MIN, cd: BW_COUNTDOWN, prefix: "m-", order: BW_TEAM_ORDER, timer: null, startAt: 0 },   // Stone Citadel haritasi: ayri bekleme odasi (harita karismasin)
  pillars: { max: 8, min: 2, cd: 30, prefix: "p-", order: [0, 1, 2, 3, 4, 5, 6, 7], timer: null, startAt: 0 },   // order = sutun sirasi
};
function dequeue(ws) {
  const had = [];
  for (const g of Object.keys(GROUPS)) if (queues[g].includes(ws)) had.push(g);
  for (const g of Object.keys(queues)) queues[g] = queues[g].filter((w) => w !== ws);
  for (const g of had) qUpdate(g);
}
function qBroadcast(g) {
  const G = GROUPS[g];
  const q = queues[g];
  const names = q.map((w) => (clients.get(w) || {}).name || "Oyuncu");
  // v183: eslesme ekraninda herkes kendi skiniyle gorunsun -> her oyuncunun kiyafeti + rozeti de gider
  const players = q.map((w) => { const c = clients.get(w) || {}; return { id: c.id || 0, name: c.name || "Oyuncu", rank: c.rank || "", outfit: c.outfit || null }; });
  const left = G.timer ? Math.max(0, Math.ceil((G.startAt - Date.now()) / 1000)) : -1;
  q.forEach((w) => send(w, { type: "queue", game: (g === "bedwars_siege" || g === "bedwars_pirate" || g === "bedwars_frost" || g === "bedwars_citadel") ? "bedwars" : g, count: q.length, need: G.max, min: G.min, countdown: left, names, players }));
}
function qUpdate(g) {
  const G = GROUPS[g];
  const q = queues[g];
  if (q.length >= G.max) { qStart(g); return; }
  if (q.length >= G.min && !G.timer) {
    G.startAt = Date.now() + G.cd * 1000;
    G.timer = setTimeout(() => qStart(g), G.cd * 1000);
  } else if (q.length < G.min && G.timer) {
    clearTimeout(G.timer);
    G.timer = null;
  }
  qBroadcast(g);
}
function qStart(g) {
  const G = GROUPS[g];
  if (G.timer) { clearTimeout(G.timer); G.timer = null; }
  if (queues[g].length < G.min) { qBroadcast(g); return; }
  const group = queues[g].splice(0, G.max);
  const code = G.prefix + (matchCounter++);
  group.forEach((w, i) => { clients.get(w).team = G.order[i % G.order.length]; });
  group.forEach((w) => joinRoom(w, code));
  const players = listOf(code);
  group.forEach((w) => send(w, { type: "match_found", code, game: (g === "bedwars_siege" || g === "bedwars_pirate" || g === "bedwars_frost" || g === "bedwars_citadel") ? "bedwars" : g, you: clients.get(w).id, players }));
  if (queues[g].length > 0) qUpdate(g);
}
const bwUpdate = () => qUpdate("bedwars");
let matchCounter = 1;

const server = http.createServer(async (req, res) => {
  if (await AUTH.handleHttp(req, res)) return;
  if (await SOCIAL.handleHttp(req, res)) return;
  if (await ISLANDS.handleHttp(req, res)) return;
  if (await AH.handleHttp(req, res)) return;
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true, online: clients.size, lobby: (rooms.get("lobby") || new Set()).size, arena: (rooms.get("arena") || new Set()).size, queue: { bedwars: queues.bedwars.length, duels: queues.duels.length, pillars: queues.pillars.length }, playing: (() => { const s = statsNow(); return { bedwars: s.bedwars, duels: s.duels, pillars: s.pillars }; })() }));
});
const wss = new WebSocketServer({ server, maxPayload: 4096 });
// v221: tikali hat bosaldiginda her gondericinin SADECE son konum paketi yollanir (eski paketler yigilip toptan gelmez; gonderen durmussa da konum guncel kalir)
setInterval(() => {
  for (const w of wss.clients) {
    if (!w._pend || !w._pend.size || w.readyState !== 1 || w.bufferedAmount > STATE_BACKLOG_MAX) continue;
    for (const o of w._pend.values()) w.send(o);
    w._pend.clear();
  }
}, 60);

// Bir OP rank verince / alinca: o oyuncu su an bagliysa rankini guncelle, kendisine ve odadaki herkese haber ver.
AUTH.setRankListener((name, rank) => {
  const low = String(name).toLowerCase();
  for (const [ws, c] of clients) {
    if (!c.authed || String(c.name).toLowerCase() !== low) continue;
    c.rank = rank;
    const msg = { type: "rank", id: c.id, rank };
    send(ws, msg);
    const set = c.room && rooms.get(c.room);
    if (set) for (const w of set) if (w !== ws) send(w, msg);
  }
});

// Bir OP susturunca / susturmayi kaldirinca: o oyuncu su an bagliysa hemen haber ver (sohbet mesajlari sunucuda zaten engellenir)
const muteMsg = (m) => (m ? { left: Math.max(1, Math.ceil((m.until - Date.now()) / 1000)), by: m.by, reason: m.reason } : { left: 0 });
AUTH.setMuteListener((name, info) => {
  const low = String(name).toLowerCase();
  for (const [ws, c] of clients) {
    if (!c.authed || String(c.name).toLowerCase() !== low) continue;
    c.mute = info;
    send(ws, { type: "mute", ...muteMsg(info) });
  }
});

// Bir OP banlayinca: o oyuncu su an bagliysa "banned" mesaji gonder ve baglantiyi kes.
AUTH.setBanListener((name, info) => {
  const low = String(name).toLowerCase();
  for (const [ws, c] of clients) {
    if (String(c.name).toLowerCase() !== low) continue;
    send(ws, { type: "banned", by: info.by, reason: info.reason, perm: !!info.perm, left: Math.max(1, Math.ceil((info.until - Date.now()) / 1000)) });
    setTimeout(() => { try { ws.close(); } catch (e) {} }, 400);
  }
});

// ADMIN > Sohbet: sunucudan oyun sohbetine mesaj (istemci "relay" + kind:"chat" + from:0 mesajini zaten gosteriyor)
AUTH.setAdminSay(({ name, text, tag, target, to }) => {
  const out = JSON.stringify({ type: "relay", from: 0, data: { kind: "chat", name, text, tag } });
  let n = 0;
  for (const [ws, c] of clients) {
    if (ws.readyState !== 1) continue;
    if (target === "lobby" && c.room !== "lobby") continue;
    if (target === "arena" && c.room !== "arena") continue;
    if (target === "player" && String(c.name).toLowerCase() !== to) continue;
    ws.send(out); n++;
  }
  return n;
});
// ADMIN > Sunucu: online sayisi + oyuncu pingleri
AUTH.setResourceExtra(async () => ({ islands: await ISLANDS.stats(), ws: clients.size, rooms: rooms.size }));     // v207: admin > Sunucu kaynaklari
AUTH.setStatusProvider(() => ({ online: clients.size, players: [...clients.values()].filter((c) => c.crtt !== undefined || c.rtt !== undefined).map((c) => ({ name: c.name, ms: c.crtt !== undefined ? c.crtt : c.rtt })) }));

// ---- ADMIN > SMP (admin sitesi): seed degistir, harita 0'la, envanter 0'la
// Odadaki (ya da sadece adi verilen) SMP oyunculara "smp_reset" yollar. inv = envanteri bosalt (oyun surer), world = Hub'a at (harita / seed degisti).
function smpNotify(msg, only) {
  const set = rooms.get("smp");
  let n = 0;
  if (!set) return 0;
  for (const w of [...set]) {
    const c = clients.get(w);
    if (only && String((c && c.name) || "").toLowerCase() !== only) continue;
    send(w, msg);
    n++;
  }
  return n;
}
async function smpKickAll(text) {
  const set = rooms.get("smp");
  const list = set ? [...set] : [];
  for (const w of list) send(w, { type: "smp_reset", world: true, inv: false, text });
  await new Promise((r) => setTimeout(r, 400));
  for (const w of list) leaveRoom(w);           // artik blok / kayit paketleri kabul edilmez
  await new Promise((r) => setTimeout(r, 1500));
  return list.length;
}
async function smpWipeAll(why) {
  const kicked = await smpKickAll(why);
  const m = await SMP.resetMap();
  const chests = SMPC.clearAll(), furnaces = SMPF.clearAll();
  const players = await SMP.resetPlayers({ pos: true }, null);
  await SMPC.flush(); await SMPF.flush();
  return { kicked, blocks: m.blocks, regions: m.regions, backup: m.backup, chests, furnaces, players };
}
AUTH.setSmpAdmin({
  seed: () => SMP.getSeed(),
  async info() {
    await SMP.whenReady();
    return { ...SMP.stats(), online: (rooms.get("smp") || new Set()).size, chests: SMPC.size(), furnaces: SMPF.size() };
  },
  async inv(name, depo) {
    await SMP.whenReady();
    const only = name || null;
    const players = await SMP.resetPlayers({ inv: true }, only);
    const depoN = depo ? await SMPD.clearAll(only) : 0;
    const notified = smpNotify({ type: "smp_reset", inv: true, world: false, text: "Envanterin yöneticiler tarafından sıfırlandı." }, only);
    return { players, depo: depoN, notified };
  },
  async seedSet(n, wipe) {
    await SMP.whenReady();
    const old = SMP.getSeed();
    await SMP.setSeed(n);
    const why = "SMP haritası değişti (yeni seed). Hub'a dönüyorsun, tekrar girebilirsin.";
    if (wipe) return { old, seed: n, ...(await smpWipeAll(why)) };
    const kicked = await smpKickAll(why);
    const players = await SMP.resetPlayers({ pos: true }, null);
    return { old, seed: n, kicked, players };
  },
  async mapReset() {
    await SMP.whenReady();
    return await smpWipeAll("SMP haritası sıfırlandı. Hub'a dönüyorsun, tekrar girebilirsin.");
  },
});

function send(ws, obj) {
  if (ws.readyState === 1) ws.send(JSON.stringify(obj));
}
// SMP: ORTAK GUN SAATI. t = 0..1 (0 gun dogumu, 0.25 ogle, 0.5 aksam, 0.75 gece yarisi); 720 sn = 1 gun (istemcideki day_night.gd ile ayni).
// Biri yatakta uyursa saat sabaha (0.03) alinir ve odadaki HERKESE yayilir.
const SMP_DAY_SEC = 720;
const SMP_MORNING_T = 0.03;
let smpClock = { base: 0.12, at: Date.now() };
function smpDayT() { return (((smpClock.base + (Date.now() - smpClock.at) / 1000 / SMP_DAY_SEC) % 1) + 1) % 1; }
function smpBroadcastTime(by) {
  const roomSet = rooms.get("smp");
  if (!roomSet) return;
  const t = smpDayT();
  for (const w of roomSet) send(w, { type: "smp_time", t, by: by || "" });
}
setInterval(() => smpBroadcastTime(""), 60000).unref();      // saat kaymasin: dakikada bir herkesi esitle
let smpLastSleep = 0;
// Oyunda kac kisi var: BedWars odalari ("m-..."), Duels odalari ("d-...") + eslesme kuyrugunda bekleyenler.
function statsNow() {
  let bedwars = queues.bedwars.length + queues.bedwars_siege.length + queues.bedwars_pirate.length + queues.bedwars_frost.length + queues.bedwars_citadel.length;
  let duels = queues.duels.length;
  let pillars = queues.pillars.length;
  for (const [, c] of clients) {
    if (!c.room) continue;
    if (c.room.startsWith("m-")) bedwars++;
    else if (c.room.startsWith("d-")) duels++;
    else if (c.room.startsWith("p-")) pillars++;
  }
  return { type: "stats", bedwars, duels, pillars, lobby: (rooms.get("lobby") || new Set()).size, arena: (rooms.get("arena") || new Set()).size, crystal: (rooms.get("crystal") || new Set()).size, smp: (rooms.get("smp") || new Set()).size, online: clients.size };
}
// v203: SKYBLOCK ada ziyareti. Ada sahibin telefonunda durur; sunucu sadece "s-<sahip>" odasi acar ve mesajlari iletir (oyunu simule etmez, ada verisi saklamaz).
// Ziyaret kurali: ada sahibi o an adasinda ve cevrimici olmali; ziyaretci sahibin ARKADASI (ya da OP) olmali; odada en fazla ISLAND_MAX kisi.
const ISLAND_MAX = 9;
async function islandCheck(c, ownerRaw) {
  const self = String(c.name).toLowerCase();
  const want = String(ownerRaw || "").trim().toLowerCase().slice(0, 24);
  if (want === "" || want === self) return { own: true, room: "s-" + self, ownerName: c.name };
  const room = "s-" + want;
  let hostWs = null, hostC = null;
  for (const [w, tc] of clients) if (tc.room === room && tc.islandHost) { hostWs = w; hostC = tc; break; }
  if (!hostC) return { err: "offline" };
  let allowed = SOCIAL.areFriends(c.name, hostC.name);
  if (!allowed && c.authed && c.token) { const acc = await AUTH.verifyUser(c.token); allowed = !!(acc && acc.op === true); }
  if (!allowed) return { err: "friends" };
  const set = rooms.get(room);
  if (set && set.size >= ISLAND_MAX) return { err: "full" };
  return { own: false, room, hostWs, ownerName: hostC.name };
}
function listOf(room) {
  const out = [];
  for (const w of rooms.get(room) || []) {
    const c = clients.get(w);
    if (c) out.push({ id: c.id, name: c.name, team: c.team, rank: c.rank || "", outfit: c.outfit || null });
  }
  return out;
}
function leaveRoom(ws) {
  const c = clients.get(ws);
  if (!c || !c.room) return;
  const set = rooms.get(c.room);
  const old = c.room;
  const wasHost = !!c.islandHost;
  c.room = null;
  c.islandHost = false;
  if (set) {
    set.delete(ws);
    for (const w of set) send(w, { type: "player_left", id: c.id });
    if (wasHost && old.startsWith("s-")) for (const w of set) send(w, { type: "island_closed" });   // v203: ada sahibi cikti -> ziyaretciler kendi adasina doner
    if (set.size === 0) rooms.delete(old);
  }
}
function joinRoom(ws, room) {
  const c = clients.get(ws);
  leaveRoom(ws);
  if (!rooms.has(room)) rooms.set(room, new Set());
  const set = rooms.get(room);
  for (const w of set) send(w, { type: "player_joined", id: c.id, name: c.name, rank: c.rank || "" });
  set.add(ws);
  c.room = room;
}
function cleanName(v) {
  let s = String(v || "Oyuncu").replace(/[^\p{L}\p{N} _\-.]/gu, "").trim().slice(0, 16);
  return s || "Oyuncu";
}

// ---- SESLI SOHBET (v180): SES KANALLARI. "Genel" herkese acik; oyuncular sifreli / sifresiz oda kurabilir.
// Ses paketi: istemciden [0x01][seq][u-law ses...]  ->  ayni KANALDAKI digerlerine [0x01][gonderen id u32 LE][seq][u-law ses...]
// Ses sunucuda islenmez / kaydedilmez, sadece iletilir. Susturulmus (/mute) oyuncunun sesi de kimseye gitmez.
const crypto = require("crypto");
const VOICE_MAX_BYTES = 1500;      // tek paket ust siniri (normal paket ~642 bayt = 40 ms)
const VOICE_MAX_PER_SEC = 60;      // spam / sel korumasi (normal ~25 paket/sn)
const VOICE_GENEL_MAX = 30;        // Genel kanal en fazla 30 kisi
const VOICE_ROOM_MAX = 10;         // kurulan oda en fazla 10 kisi
const VOICE_ROOMS_LIMIT = 40;      // ayni anda en fazla 40 oda
const vrooms = new Map();          // kanal id -> {id, name, pass(hash|null), max, members:Set<ws>, ownerName, fixed}
vrooms.set("genel", { id: "genel", name: "Genel", pass: null, max: VOICE_GENEL_MAX, members: new Set(), ownerName: "", fixed: true });
let vCounter = 1;
const hashPass = (p) => crypto.createHash("sha256").update("vc:" + p).digest("hex");
function vInfo(r) { return { id: r.id, name: r.name, count: r.members.size, max: r.max, locked: !!r.pass, owner: r.ownerName }; }
function vMembers(r) {
  const out = [];
  for (const w of r.members) { const c = clients.get(w); if (c) out.push({ id: c.id, name: c.name }); }
  return out;
}
function vBroadcast(r) {
  const m = vMembers(r);
  for (const w of r.members) send(w, { type: "voice_update", id: r.id, name: r.name, members: m });
}
function vLeave(ws) {
  const c = clients.get(ws);
  if (!c || !c.voice) return;
  const r = vrooms.get(c.voice);
  c.voice = null;
  if (!r) return;
  r.members.delete(ws);
  if (!r.fixed && r.members.size === 0) vrooms.delete(r.id);   // bos oda silinir
  else vBroadcast(r);
}
function vEnter(ws, c, r) {
  if (c.voice !== r.id) { vLeave(ws); r.members.add(ws); c.voice = r.id; }
  send(ws, { type: "voice_joined", id: r.id, name: r.name, locked: !!r.pass, members: vMembers(r) });
  vBroadcast(r);
}
function vList() {
  const arr = [...vrooms.values()];
  arr.sort((x, y) => (y.fixed ? 1 : 0) - (x.fixed ? 1 : 0));   // Genel hep ilk
  return arr.map(vInfo);
}
function cleanRoomName(v) {
  return String(v || "").replace(/[^\p{L}\p{N} _\-.]/gu, "").replace(/\s+/g, " ").trim().slice(0, 16);
}
function voiceMsg(ws, c, msg) {
  if (REQUIRE_LOGIN && !c.authed) { send(ws, { type: "voice_error", message: "Giris gerekli" }); return; }
  switch (msg.type) {
    case "voice_list":
      send(ws, { type: "voice_list", rooms: vList(), you: c.voice || "" });
      break;
    case "voice_join": {
      const r = vrooms.get(String(msg.id || ""));
      if (!r) { send(ws, { type: "voice_error", message: "Oda bulunamadi" }); break; }
      if (c.voice !== r.id) {
        if (r.members.size >= r.max) { send(ws, { type: "voice_error", message: "Oda dolu" }); break; }
        if (r.pass && hashPass(String(msg.pass || "").slice(0, 16)) !== r.pass) { send(ws, { type: "voice_error", message: "Sifre yanlis" }); break; }
      }
      vEnter(ws, c, r);
      break;
    }
    case "voice_create": {
      const name = cleanRoomName(msg.name);
      if (name.length < 2) { send(ws, { type: "voice_error", message: "Oda adi en az 2 harf olmali" }); break; }
      if (vrooms.size >= VOICE_ROOMS_LIMIT) { send(ws, { type: "voice_error", message: "Cok fazla oda var, biraz sonra dene" }); break; }
      for (const r0 of vrooms.values()) if (r0.name.toLowerCase() === name.toLowerCase()) { send(ws, { type: "voice_error", message: "Bu isimde bir oda var" }); return; }
      const pw = String(msg.pass || "").slice(0, 16);
      const r = { id: "v-" + (vCounter++), name, pass: pw ? hashPass(pw) : null, max: VOICE_ROOM_MAX, members: new Set(), ownerName: c.name, fixed: false };
      vrooms.set(r.id, r);
      vEnter(ws, c, r);
      break;
    }
    case "voice_leave":
      vLeave(ws);
      send(ws, { type: "voice_left" });
      break;
  }
}
function relayVoice(ws, c, buf) {
  if (!c.voice || !Buffer.isBuffer(buf)) return;
  if (REQUIRE_LOGIN && !c.authed) return;
  if (buf.length < 3 || buf.length > VOICE_MAX_BYTES || buf[0] !== 1) return;
  if (c.mute) {
    if (c.mute.until > Date.now()) return;
    c.mute = null;
  }
  const now = Date.now();
  if (now - c.vWin >= 1000) { c.vWin = now; c.vCnt = 0; }
  if (++c.vCnt > VOICE_MAX_PER_SEC) return;
  const r = vrooms.get(c.voice);
  if (!r || r.members.size < 2) return;
  const out = Buffer.allocUnsafe(buf.length + 4);
  out[0] = 1;
  out.writeUInt32LE(c.id >>> 0, 1);
  buf.copy(out, 5, 1);
  for (const w of r.members) if (w !== ws && w.readyState === 1) w.send(out, { binary: true });
}

wss.on("connection", (ws) => {
  const c = { id: nextId++, name: "Oyuncu", room: null, alive: true, authed: false, rank: "", mute: null, chain: Promise.resolve(), vWin: 0, vCnt: 0, voice: null };
  clients.set(ws, c);
  send(ws, { type: "welcome", id: c.id });

  ws.on("pong", () => { c.alive = true; if (c.pingAt) { c.rtt = Date.now() - c.pingAt; c.pingAt = 0; } });   // rtt = oyuncunun ping'i (admin > Sunucu)
  const onMsg = async (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch (e) { return; }
    if (!msg || typeof msg !== "object") return;
    switch (msg.type) {
      case "hello": {
        const acc = await AUTH.verifyUser(msg.token);   // gecerli token -> isim + rank hesaptan gelir (taklit edilemez)
        if (acc && acc.banned) {                         // banli hesap: bildir + at
          send(ws, { type: "banned", by: acc.banned.by, reason: acc.banned.reason, perm: !!acc.banned.perm, left: Math.max(1, Math.ceil((acc.banned.until - Date.now()) / 1000)) });
          setTimeout(() => { try { ws.close(); } catch (e) {} }, 400);
          break;
        }
        c.authed = !!acc;
        c.name = acc ? acc.name : cleanName(msg.name);
        c.rank = acc ? acc.rank : "";
        c.mute = acc ? acc.mute : null;
        send(ws, { type: "mute", ...muteMsg(c.mute) });   // susturulduysa istemci bilsin (kalici: hesaptan gelir)
        if (!acc) send(ws, { type: "auth", ok: false });
        break;
      }
      case "join_lobby": {
        if (REQUIRE_LOGIN && !c.authed) { send(ws, { type: "error", message: "Giris gerekli" }); break; }
        dequeue(ws);
        const lobby = rooms.get("lobby");
        if (lobby && lobby.size >= LOBBY_MAX && !lobby.has(ws)) {
          send(ws, { type: "error", message: "Lobi dolu" });
          break;
        }
        joinRoom(ws, "lobby");
        send(ws, { type: "lobby_joined", you: c.id, players: listOf("lobby") });
        break;
      }
      case "join_smp": {                     // SMP: herkes ayni sabit odaya girer; sunucu degisen tum bloklari girene yollar
        if (REQUIRE_LOGIN && !c.authed) { send(ws, { type: "error", message: "Giris gerekli" }); break; }
        dequeue(ws);
        await SMP.whenReady();
        if (SMP.status() !== "ok") { send(ws, { type: "error", message: "SMP yukleniyor, biraz sonra tekrar dene" }); break; }
        if (Number(msg.seed) > 0 && Number(msg.seed) !== SMP.getSeed()) {      // istemci eski seed ile uretiyor: dunyayi bozmasin, Hub'a gonder
          send(ws, { type: "smp_reset", world: true, inv: false, text: "SMP haritası değişti (yeni seed). Hub'a dönüp tekrar gir." });
          break;
        }
        const sm = rooms.get("smp");
        if (sm && sm.size >= SMP_MAX && !sm.has(ws)) {
          send(ws, { type: "error", message: "SMP dolu" });
          break;
        }
        joinRoom(ws, "smp");
        send(ws, { type: "lobby_joined", you: c.id, players: listOf("smp") });
        send(ws, { type: "smp_time", t: smpDayT(), by: "" });       // ortak gun saati
        const myRoom = c.room;
        if (!msg.lazy) SMP.sendAll(ws, send, () => c.room === myRoom && ws.readyState === 1).catch((e) => console.error("SMP gonderilemedi", e.message));   // eski istemci: hepsini it; yeni istemci (lazy) smp_req ile yakin bolgeleri ister
        break;
      }
      case "smp_req": {                      // SMP (lazy): istemci oyuncunun yakinindaki 512x512 bolgeleri ister
        if (c.room !== "smp" || !Array.isArray(msg.r)) break;
        { const nq = Date.now(); if (!c.rq || nq - c.rq.t >= 10000) c.rq = { t: nq, n: 0 }; if (++c.rq.n > 30) break; }
        const list = [];
        for (const e of msg.r.slice(0, 9)) if (Array.isArray(e) && Number.isInteger(e[0]) && Number.isInteger(e[1]) && Math.abs(e[0]) < 2048 && Math.abs(e[1]) < 2048) list.push([e[0], e[1]]);
        if (!list.length) break;
        const rq = c.room;
        SMP.sendRegions(ws, send, () => c.room === rq && ws.readyState === 1, list);
        break;
      }
      case "smp_load": {                     // SMP: hesaba bagli oyuncu verisi (envanter / home / son konum) sunucudan
        if (c.room !== "smp" || !c.authed) break;
        try { const pl = await SMP.getPlayer(c.name); send(ws, { type: "smp_player", d: pl ? pl.d : null, t: pl ? pl.t : 0 }); }
        catch (e) { console.error("SMP oyuncu verisi okunamadi", e.message); }      // cevap yok: istemci zaman asimiyla yerel devam eder, yukleme yapmaz
        break;
      }
      case "smp_chest_get": {                // v234: SMP sandik icerigi + yonu. v250: open=true -> kilit alinir (baskasi aciksa busy)
        if (c.room !== "smp") break;
        { const ng = Date.now(); if (!c.cg || ng - c.cg.t >= 10000) c.cg = { t: ng, n: 0 }; if (++c.cg.n > 600) break; }
        const cx = Number(msg.x), cy = Number(msg.y), cz = Number(msg.z);
        if (![cx, cy, cz].every(Number.isInteger)) break;
        if (msg.open) {
          if (!c.authed || !SMPC.tryLock(cx, cy, cz, ws)) { send(ws, { type: "smp_chest", x: cx, y: cy, z: cz, d: SMPC.get(cx, cy, cz), busy: 1 }); break; }
          send(ws, { type: "smp_chest", x: cx, y: cy, z: cz, d: SMPC.get(cx, cy, cz), lock: 1 });
          break;
        }
        send(ws, { type: "smp_chest", x: cx, y: cy, z: cz, d: SMPC.get(cx, cy, cz) });
        break;
      }
      case "smp_chest_set": {                // v234: sandik kapatilinca / koyulunca tam icerik gelir; sunucu dogrular, saklar, odadakilere yayar
        // v250: ESYA KAYBI DUZELTMESI. Eskiden reddedilen / hiz sinirina takilan paket SESSIZCE dusuyordu: oyuncu esyayi koyup kapatiyor, sunucu
        // kaydetmiyor, sonraki acista sunucudaki ESKI icerik telefondakinin ustune yaziliyordu = esyalar yok. Simdi her paket cevaplanir:
        // ack (kaydedildi) / nack 1 (gecici: tekrar dene) / nack 2 (kalici red). Istemci onay gelene kadar paketi tekrar yollar.
        if (c.room !== "smp" || !c.authed) break;
        const sx = Number(msg.x), sy = Number(msg.y), sz = Number(msg.z);
        if (![sx, sy, sz].every(Number.isInteger)) break;
        const nackC = (code) => send(ws, { type: "smp_chest", x: sx, y: sy, z: sz, d: SMPC.get(sx, sy, sz), nack: code });
        { const ns = Date.now(); if (!c.cs || ns - c.cs.t >= 10000) c.cs = { t: ns, n: 0 }; if (++c.cs.n > 120) { nackC(1); break; } }
        const psc = c.pst;
        if (psc && Array.isArray(psc.p) && Date.now() - psc.t < 5000 && Math.hypot(sx - psc.p[0], sy - psc.p[1], sz - psc.p[2]) > SMP_BLOCK_REACH) { nackC(1); break; }
        const knownB = SMP.getBlock(sx, sy, sz);       // -1 = dogal arazi (koy sandigi); baska bir blok kayitliysa orada sandik YOK
        if (knownB !== -1 && knownB !== SMPC.CHEST_ID) { nackC(2); break; }
        if (SMPC.lockHeldByOther(sx, sy, sz, ws)) { nackC(1); break; }
        const rec = SMPC.set(sx, sy, sz, { i: msg.i, c: msg.c, t: msg.t });
        if (!rec) { nackC(2); break; }
        if (msg.cl) SMPC.unlock(sx, sy, sz, ws);
        send(ws, { type: "smp_chest", x: sx, y: sy, z: sz, d: rec, ack: 1 });
        const roomSet = rooms.get("smp");
        if (roomSet) for (const w of roomSet) if (w !== ws) send(w, { type: "smp_chest", x: sx, y: sy, z: sz, d: rec });
        break;
      }
      case "smp_depo_get": {                 // v251: /depo icerigi. open=true -> kilit alinir (ayni hesap baska cihazda aciksa busy)
        if (c.room !== "smp" || !c.authed) break;
        { const ng = Date.now(); if (!c.dg || ng - c.dg.t >= 10000) c.dg = { t: ng, n: 0 }; if (++c.dg.n > 60) break; }
        const dk = SMPD.keyOf(c.name);
        if (!dk) break;
        if (msg.open) {
          if (!SMPD.tryLock(dk, ws)) { send(ws, { type: "smp_depo", d: SMPD.get(dk), busy: 1 }); break; }
          send(ws, { type: "smp_depo", d: SMPD.get(dk), lock: 1 });
          break;
        }
        send(ws, { type: "smp_depo", d: SMPD.get(dk) });
        break;
      }
      case "smp_depo_set": {                 // v251: depo kaydi. Her paket cevaplanir: ack (kaydedildi) / nack 1 (gecici, tekrar dene) / nack 2 (kalici red)
        if (c.room !== "smp" || !c.authed) break;
        const sk = SMPD.keyOf(c.name);
        if (!sk) break;
        const nackDp = (code) => send(ws, { type: "smp_depo", d: SMPD.get(sk), nack: code });
        { const ns = Date.now(); if (!c.ds || ns - c.ds.t >= 10000) c.ds = { t: ns, n: 0 }; if (++c.ds.n > 120) { nackDp(1); break; } }
        if (SMPD.lockHeldByOther(sk, ws)) { nackDp(1); break; }
        const drec = SMPD.set(sk, { i: msg.i, c: msg.c });
        if (!drec) { nackDp(2); break; }
        if (msg.cl) SMPD.unlock(sk, ws);
        send(ws, { type: "smp_depo", d: drec, ack: 1 });
        break;
      }
      case "smp_furnace_get": {              // v247: SMP ocak icerigi
        if (c.room !== "smp") break;
        { const ng = Date.now(); if (!c.fg || ng - c.fg.t >= 10000) c.fg = { t: ng, n: 0 }; if (++c.fg.n > 300) break; }
        const fx = Number(msg.x), fy = Number(msg.y), fz = Number(msg.z);
        if (![fx, fy, fz].every(Number.isInteger)) break;
        send(ws, { type: "smp_furnace", x: fx, y: fy, z: fz, d: SMPF.get(fx, fy, fz) });
        break;
      }
      case "smp_furnace_set": {              // v247: ocak kapatilinca tam icerik gelir; sunucu dogrular, saklar, odadakilere yayar
        if (c.room !== "smp" || !c.authed) break;
        { const ns = Date.now(); if (!c.fs || ns - c.fs.t >= 10000) c.fs = { t: ns, n: 0 }; if (++c.fs.n > 30) break; }
        const ux = Number(msg.x), uy = Number(msg.y), uz = Number(msg.z);
        if (![ux, uy, uz].every(Number.isInteger)) break;
        const psf = c.pst;
        if (psf && Array.isArray(psf.p) && Date.now() - psf.t < 5000 && Math.hypot(ux - psf.p[0], uy - psf.p[1], uz - psf.p[2]) > SMP_BLOCK_REACH) break;
        const frec = SMPF.set(ux, uy, uz, { i: msg.i, c: msg.c, b: msg.b, bm: msg.bm, k: msg.k });
        if (!frec) break;
        const froom = rooms.get("smp");
        if (froom) for (const w of froom) if (w !== ws) send(w, { type: "smp_furnace", x: ux, y: uy, z: uz, d: frec });
        break;
      }
      case "smp_sleep": {                    // SMP: yatakta uyuyan oyuncu -> sabah olur (herkes icin)
        if (c.room !== "smp" || !c.authed) break;
        const tn = smpDayT();
        if (Math.sin(tn * 2 * Math.PI) > -0.05) break;                // sadece gece uyunur
        const nsl = Date.now(); if (nsl - smpLastSleep < 5000) break; smpLastSleep = nsl;
        smpClock = { base: SMP_MORNING_T, at: nsl };
        smpBroadcastTime(String(c.name || ""));
        break;
      }
      case "smp_save": {
        if (c.room !== "smp" || !c.authed) break;
        const nsv = Date.now(); if (c.ps && nsv - c.ps < 4000) break; c.ps = nsv;
        try { const t = await SMP.setPlayer(c.name, msg.d); if (t) send(ws, { type: "smp_saved", t }); }
        catch (e) { console.error("SMP oyuncu verisi yazilamadi", e.message); }
        break;
      }
      case "leave_lobby":
        if (c.room === "lobby" || c.room === "smp" || (c.room && c.room.startsWith("s-"))) leaveRoom(ws);
        break;
      case "island_query": {                 // v203: ziyaret on kontrolu (sahip adasinda mi, arkadas misin?)
        if (REQUIRE_LOGIN && !c.authed) { send(ws, { type: "island_err", err: "login" }); break; }
        const r = await islandCheck(c, msg.owner);
        if (r.err) send(ws, { type: "island_err", err: r.err });
        else send(ws, { type: "island_ok", owner: r.ownerName });
        break;
      }
      case "join_island": {                  // v203: kendi adana (owner bos) ya da arkadasinin adasina gir
        if (REQUIRE_LOGIN && !c.authed) { send(ws, { type: "error", message: "Giris gerekli" }); break; }
        const r = await islandCheck(c, msg.owner);
        if (r.err) { send(ws, { type: "island_err", err: r.err }); break; }
        dequeue(ws);
        joinRoom(ws, r.room);
        c.islandHost = !!r.own;
        send(ws, { type: "lobby_joined", you: c.id, players: listOf(r.room), island: { owner: r.ownerName, host: !!r.own } });
        if (!r.own && r.hostWs) send(r.hostWs, { type: "island_sync_req", id: c.id });      // sahip, adasinin degisen bloklarini ziyaretciye gonderir
        break;
      }
      case "island_sync": {                  // v203: sahip -> belirli ziyaretci (sunucu hicbir sey saklamaz, sadece iletir)
        if (!c.islandHost || !c.room || !c.room.startsWith("s-")) break;
        const to = Number(msg.to);
        const blocks = Array.isArray(msg.blocks) ? msg.blocks.slice(0, 150).filter((b) => Array.isArray(b) && b.length >= 4).map((b) => [b[0] | 0, b[1] | 0, b[2] | 0, b[3] | 0]) : [];
        for (const w of rooms.get(c.room) || []) {
          const tc = clients.get(w);
          if (tc && tc.id === to && w !== ws) { send(w, { type: "island_sync", blocks, done: !!msg.done }); break; }
        }
        break;
      }
      case "join_arena": {
        if (REQUIRE_LOGIN && !c.authed) { send(ws, { type: "error", message: "Giris gerekli" }); break; }
        dequeue(ws);
        const isCry = msg.kind === "crystal";           // Crystal Arena: ayri oda, harita sunucuda
        const roomName = isCry ? "crystal" : "arena";
        const arena = rooms.get(roomName);
        if (arena && arena.size >= (isCry ? CRYSTAL_MAX : ARENA_MAX) && !arena.has(ws)) {
          send(ws, { type: "error", message: isCry ? "Crystal Arena dolu" : "Arena dolu" });
          break;
        }
        joinRoom(ws, roomName);
        if (isCry) {
          send(ws, { type: "arena_joined", you: c.id, players: listOf("crystal"), crystal: true, reset_in: CRY.resetIn() });
          const myRoom = c.room;
          CRY.sendAll(ws, send, () => c.room === myRoom && ws.readyState === 1);
        } else {
          send(ws, { type: "arena_joined", you: c.id, players: listOf("arena") });
        }
        break;
      }
      case "leave_arena":
        if (c.room === "arena" || c.room === "crystal") leaveRoom(ws);
        break;
      case "find_match": {
        if (REQUIRE_LOGIN && !c.authed) { send(ws, { type: "error", message: "Giris gerekli" }); break; }
        leaveRoom(ws);                       // lobiden cik
        dequeue(ws);
        const game = msg.game === "duels" ? "duels" : (msg.game === "pillars" ? "pillars" : (Number(msg.map) === 4 ? "bedwars_citadel" : (Number(msg.map) === 3 ? "bedwars_frost" : (Number(msg.map) === 2 ? "bedwars_pirate" : (Number(msg.map) === 1 ? "bedwars_siege" : "bedwars")))));   // eski istemci game gondermez -> bedwars
        const queue = queues[game];
        queue.push(ws);
        if (game === "bedwars" || game === "bedwars_siege" || game === "bedwars_pirate" || game === "bedwars_frost" || game === "bedwars_citadel" || game === "pillars") {
          qUpdate(game);
          break;
        }
        if (queue.length >= MATCH_SIZE) {
          const group = queue.splice(0, MATCH_SIZE);
          const code = "d-" + (matchCounter++);
          group.forEach((w) => joinRoom(w, code));
          const players = listOf(code);
          group.forEach((w) => send(w, { type: "match_found", code, game, you: clients.get(w).id, players }));
        } else {
          send(ws, { type: "searching" });
        }
        break;
      }
      case "voice_list":
      case "voice_join":
      case "voice_create":
      case "voice_leave":
        voiceMsg(ws, c, msg);
        break;
      case "ping": {                         // FIX: istemci ping gonderiyor ama cevap yoktu -> oyun ici ms hic olculmuyordu
        send(ws, { type: "pong", t: msg.t });
        const r = Number(msg.rtt);           // istemcinin kendi olctugu gercek gidis-donus (admin > Sunucu bunu gosterir)
        if (Number.isFinite(r) && r > 0 && r < 20000) c.crtt = Math.round(r);
        break;
      }
      case "stats":
        send(ws, statsNow());
        break;
      case "set_outfit": {
        // v183: istemci kiyafetini (sapka/skin/kanat/renkler) bildirir; eslesme ekraninda diger oyunculara gosterilir
        if (msg.o && typeof msg.o === "object" && !Array.isArray(msg.o)) {
          const o = {};
          for (const k of Object.keys(msg.o).slice(0, 12)) o[String(k).slice(0, 16)] = String(msg.o[k]).slice(0, 48);
          c.outfit = o;
          if (queues.bedwars.includes(ws)) qBroadcast("bedwars");
          if (queues.bedwars_siege.includes(ws)) qBroadcast("bedwars_siege");
          if (queues.bedwars_pirate.includes(ws)) qBroadcast("bedwars_pirate");
          if (queues.bedwars_frost.includes(ws)) qBroadcast("bedwars_frost");
          if (queues.bedwars_citadel.includes(ws)) qBroadcast("bedwars_citadel");
          if (queues.pillars.includes(ws)) qBroadcast("pillars");
        }
        break;
      }
      case "cancel_match":
        dequeue(ws);
        break;
      case "leave_room":
        dequeue(ws);
        leaveRoom(ws);
        break;
      case "relay": {
        // SUSTURULMUS oyuncunun sohbet mesaji kimseye gitmez (Lobi / Bed Wars / Duels / Arena hepsi buradan gecer)
        if (c.mute && msg.data && typeof msg.data === "object" && msg.data.kind === "chat") {
          if (c.mute.until > Date.now()) { send(ws, { type: "chat_muted", ...muteMsg(c.mute) }); break; }
          c.mute = null;      // sure doldu
        }
        // OTOMATIK KUFUR FILTRESI (server/kufur.js): 1. kufur = uyari (mesaj gitmez), sonraki = otomatik mute (hafif 30 dk / agir 3 saat)
        if (msg.data && typeof msg.data === "object" && msg.data.kind === "chat") {
          const lvl = KUFUR.check(msg.data.text);
          if (lvl > 0) {
            let r = { action: "warn" };
            if (c.authed) { try { r = await AUTH.kufurStrike(c.name, lvl); } catch (e) { console.error("kufur", e); r = { action: "warn" }; } }
            if (r.action === "warn") send(ws, { type: "chat_warn", text: "⚠ Küfür etmek yasak! Mesajın gönderilmedi. Tekrar küfür edersen susturulacaksın." });
            else if (r.action === "mute") send(ws, { type: "chat_muted", left: r.left, by: "Otomatik Sistem", reason: r.reason });
            else if (r.action === "muted") send(ws, { type: "chat_muted", ...muteMsg(c.mute) });
            if (r.action !== "none") break;
          }
        }
        const set = c.room && rooms.get(c.room);
        if (!set || !msg.data || typeof msg.data !== "object") break;
        // v220: paket hiz siniri (hileli istemci seli): saniyede 400'den fazla relay paketi dusurulur
        { const nowRl = Date.now(); if (!c.rl || nowRl - c.rl.t >= 1000) c.rl = { t: nowRl, n: 0 }; if (++c.rl.n > 400) break; }
        // Yanlis oda korumasi: konum paketindeki dunya turu (wt) mac dunyasi (BedWars 4 / Duels 5 / Pillars 8) ise
        // oyuncu mac odasinda (m-/d-/p-) olmali; degilse (orn. lobi odasinda kalmis) paket kimseye iletilmez.
        if (typeof msg.data.wt === "number" && msg.data.wt >= 0) {
          const inMatchRoom = c.room.startsWith("m-") || c.room.startsWith("d-") || c.room.startsWith("p-");
          const matchWorld = msg.data.wt === 4 || msg.data.wt === 5 || msg.data.wt === 8;
          if (inMatchRoom !== matchWorld) break;
        }
        if (c.room === "crystal") {              // Crystal Arena: harita sunucuda; blok / kristal degisiklikleri dogrulanir ve saklanir, gecersizi kimseye gitmez
          const k = msg.data.kind;
          const nowC = Date.now();
          if (k === "block") {
            if (!CRY.rateOk(c, nowC) || !CRY.reachOk(c, msg.data.x, msg.data.y, msg.data.z, nowC)) break;
            if (!CRY.setBlock(msg.data.x, msg.data.y, msg.data.z, msg.data.id)) break;
          } else if (k === "cr_place") {
            if (!CRY.rateOk(c, nowC) || !CRY.reachOk(c, msg.data.x, msg.data.y, msg.data.z, nowC)) break;
            if (!CRY.placeCrystal(msg.data.x, msg.data.y, msg.data.z)) break;
          } else if (k === "cr_boom") {
            if (!CRY.rateOk(c, nowC)) break;
            if (!CRY.boomCrystal(msg.data.x, msg.data.y, msg.data.z)) break;
          }
        }
        if (c.room === "smp" && msg.data.kind === "block") {      // SMP: degisen blok dogrulanir, kalici kaydedilir; reddedilen blok kimseye iletilmez
          const nowB = Date.now();
          if (!c.bl || nowB - c.bl.t >= 1000) c.bl = { t: nowB, n: 0 };
          if (++c.bl.n > SMP_BLOCKS_PER_SEC) break;                                   // hileli istemci seli
          const ps = c.pst;
          if (ps && Array.isArray(ps.p) && nowB - ps.t < 5000 && Math.hypot(Number(msg.data.x) - ps.p[0], Number(msg.data.y) - ps.p[1], Number(msg.data.z) - ps.p[2]) > SMP_BLOCK_REACH) break;   // cok uzaktan blok (patlamalar icin genis)
          if (!SMP.setBlock(msg.data.x, msg.data.y, msg.data.z, msg.data.id)) break;  // gecersiz kimlik / koordinat / blok siniri dolu
          if (Number(msg.data.id) !== SMPF.FURNACE_ID) SMPF.remove(Number(msg.data.x), Number(msg.data.y), Number(msg.data.z));      // v247: ocak kirildi: icerik kaydi silinir
          if (Number(msg.data.id) !== SMPC.CHEST_ID) SMPC.remove(Number(msg.data.x), Number(msg.data.y), Number(msg.data.z));      // v234: sandik kirildi / yerine baska blok geldi: icerik kaydi silinir
        }
        // SMP: tpa_* ve smp_kill paketleri sunucuda yeniden yazilir: gonderen adi sunucudan (sahte "from"/"victim" olamaz), koordinatlar dogrulanir
        if (c.room === "smp" && (msg.data.kind === "tpa_req" || msg.data.kind === "tpa_ok" || msg.data.kind === "tpa_no")) {
          const ntp = Date.now(); if (!c.tpr || ntp - c.tpr.t >= 10000) c.tpr = { t: ntp, n: 0 }; if (++c.tpr.n > 10) break;
          const d2 = { kind: msg.data.kind, to: String(msg.data.to || "").slice(0, 24), from: String(c.name) };
          if (msg.data.kind === "tpa_ok") {
            const pp = msg.data.p;
            if (!Array.isArray(pp) || pp.length !== 3 || !pp.every((v) => typeof v === "number" && Number.isFinite(v) && Math.abs(v) < 1000000) || pp[1] < -8 || pp[1] > 140) break;
            d2.p = pp;
          }
          msg.data = d2;
        } else if (c.room === "smp" && msg.data.kind === "smp_kill") {
          const nk = Date.now(); if (c.kl && nk - c.kl < 3000) break; c.kl = nk;
          const kn = String(msg.data.killer || "").slice(0, 24).toLowerCase();
          let killer = "";
          if (kn) for (const w2 of set) { const c2 = clients.get(w2); if (c2 && c2.authed && String(c2.name).toLowerCase() === kn) { killer = String(c2.name); break; } }
          msg.data = { kind: "smp_kill", killer, victim: String(c.name) };
        } else if (c.room === "smp" && msg.data.kind === "smp_drop") {
          // SMP: olum dususu. Alanlar sunucuda yeniden yazilir; hiz siniri (olumde ~50 yigin birden gelebilir) asilirsa paket dusurulur
          const nd = Date.now(); if (!c.dr || nd - c.dr.t >= 10000) c.dr = { t: nd, n: 0 }; if (++c.dr.n > 150) break;
          const dd = msg.data;
          const okv = (a, lim) => Array.isArray(a) && a.length === 3 && a.every((v) => typeof v === "number" && Number.isFinite(v) && Math.abs(v) < lim);
          const did = Number(dd.id), dn = Number(dd.n), du = Number(dd.u);
          if (!Number.isInteger(did) || did < 1 || did > 511 || !Number.isInteger(dn) || dn < 1 || dn > 64 || !Number.isInteger(du) || du < 0 || du > 2e9 || !okv(dd.p, 1000000) || !okv(dd.v, 12)) break;
          msg.data = { kind: "smp_drop", u: du, id: did, n: dn, p: dd.p, v: dd.v };
        } else if (c.room === "smp" && msg.data.kind === "smp_take") {
          const nt = Date.now(); if (!c.tk || nt - c.tk.t >= 10000) c.tk = { t: nt, n: 0 }; if (++c.tk.n > 300) break;
          const tu = Number(msg.data.u);
          if (!Number.isInteger(tu) || tu < 0 || tu > 2e9) break;
          msg.data = { kind: "smp_take", u: tu };
        }
        // v219: konum paketinden menzil / dokunulmazlik bilgisi tutulur; duel_hit sunucuda dogrulanir (sayilirsa hedefe, sayilmazsa vurana hit_ack ok:false)
        if (msg.data.kind === "player_state") {
          PVP.onState(c, msg.data, Date.now());
        } else if (msg.data.kind === "duel_hit") {
          PVP.handleDuelHit(ws, c, set, clients, msg.data, Date.now(), send);
          break;
        }
        const out = JSON.stringify({ type: "relay", from: c.id, data: msg.data });
        const isState = msg.data.kind === "player_state";      // konum paketi: sadece SON deger onemli, eskisini yigmaya gerek yok
        for (const w of set) {
          if (w === ws || w.readyState !== 1) continue;
          if (isState && w.bufferedAmount > STATE_BACKLOG_MAX) {   // alicinin hatti tikali: atla (yoksa baglanti acilinca eski paketler toptan gelir = ziplama)
            (w._pend || (w._pend = new Map())).set(c.id, out);      // v221: ama gonderenin SON konumu saklanir, hat bosalinca tek paket gider
            continue;
          }
          if (isState && w._pend) w._pend.delete(c.id);
          w.send(out);
        }
        break;
      }
    }
  };
  ws.on("message", (raw, isBinary) => {
    if (isBinary) { relayVoice(ws, c, raw); return; }   // SESLI SOHBET: ikili paket, JSON'a girmez
    c.chain = c.chain.then(() => onMsg(raw)).catch(() => {});
  });
  ws.on("close", () => {
    SMPC.unlockAll(ws);
    SMPD.unlockAll(ws);
    vLeave(ws);
    dequeue(ws);
    leaveRoom(ws);
    clients.delete(ws);
  });
  ws.on("error", () => {});
});

// Render bosta kalan baglantiyi kapatmasin + olu baglantilari temizle
setInterval(() => {      // her 5 sn ping: hem baglanti canli kalir hem oyuncu pingi (rtt) olculur
  for (const [ws, c] of clients) { c.pingAt = Date.now(); try { ws.ping(); } catch (e) {} }
}, 5000);
setInterval(() => {      // 25 sn boyunca hic pong gelmediyse baglanti olu
  for (const [ws, c] of clients) {
    if (!c.alive) { ws.terminate(); continue; }
    c.alive = false;
  }
}, 25000);

CRY.start((ms) => {      // her 10 dk: harita sifirlandi -> odadaki herkes yeni haritaya gecer
  for (const w of rooms.get("crystal") || []) send(w, { type: "crystal_reset", reset_in: ms });
});
server.listen(PORT, () => console.log("MoMinecraft sunucu hazir, port " + PORT));

// Render yeniden baslatirken (SIGTERM) SMP blok degisikliklerini yaz
for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => { Promise.all([SMP.flush(), AH.flush(), SMPC.flush(), SMPD.flush(), SMPF.flush()]).finally(() => process.exit(0)); setTimeout(() => process.exit(0), 8000).unref(); });
}
