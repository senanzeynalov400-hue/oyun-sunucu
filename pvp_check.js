"use strict";
// v220: PVP vurusu SUNUCUDA dogrulanir ve KARARI sunucu verir (Bedrock tarzi: her tiklama geri tepme verir, hasar 0.5 sn'de bir).
//  * hasar: istemcinin yolladigi dmg'ye GUVENILMEZ; saldirganin elindeki esyadan (player_state "hi") sunucu tablosuyla hesaplanir
//  * dokunulmazlik: SUNUCU saatiyle olculur (istemci "ts" damgasi artik kullanilmaz: hile ile atlanamaz)
//  * pencere icindeki tiklama: hasar vermez ama geri tepme verir (dm:false) -> hizli tiklayan rakibi havada tutar
//  * saldirgan hiz siniri (CPS), oda turu, olu/izleyici saldirgan, ayni takim (Bed Wars), menzil
//  * geri tepme yonu: sunucudaki konumlardan hesaplanir; istemcinin dir'i sadece makul ise (ayni yarim kure) kullanilir
//  * sprint bonusu (sdir): saldirgan gercekten kosuyorsa
// Sayilan vurus hedefe iletilir ("srv":true), her vurus icin VURANA hit_ack doner (ok, dm).
const IFRAME_MS = 500;       // hasar penceresi (MC: 10 tick). Pencere icindeki vurus sadece geri tepme verir
const MIN_GAP_MS = 45;       // ayni saldirgandan iki vurus arasi en az (~22 CPS ustu reddedilir)
const MAX_PER_SEC = 22;
const MAX_RANGE = 7.5;       // istemci menzili 3.5-4.2 blok; konum paketi gecikmesi + geri tepme kaymasi payi
const FRESH_MS = 1500;
const FIST = 2.0;
const HELD_GRACE_MS = 700;   // esya degistirir degistirmez vurunca eski/yeni esyanin buyugu gecerli (paket gecikmesi)
const MAX_DMG = 20;         // v223: 1.9 kritik baltasi (9 x 1.5) 12'yi gecer

// blocks.gd attack_damage() ile ayni (esya id -> hasar). Esya id'leri enum sirasindan okunmustur.
const WEAPON_DMG = {
  36: 5.0, 93: 7.0, 95: 9.0, 150: 10.0, 33: 4.0, 32: 3.0, 34: 3.0, 35: 2.5,
  126: 6.0, 125: 5.0, 128: 4.5, 127: 3.5, 132: 7.0, 131: 6.0, 134: 5.5, 133: 4.0,
  136: 5.0, 135: 4.0, 138: 3.5, 137: 3.0, 92: 6.0, 129: 2.5,
};
// v223: 1.9 PVP: baltalar kilictan cok vurur (blocks.gd attack_damage ile ayni): tahta 7, tas 9, demir 9, elmas 9
WEAPON_DMG[33] = 7.0; WEAPON_DMG[136] = 9.0; WEAPON_DMG[126] = 9.0; WEAPON_DMG[132] = 9.0;
// saldiri hizi (blocks.gd attack_speed ile ayni): bekleme = 1/hiz sn
const WEAPON_SPEED = {
  36: 1.6, 92: 1.6, 93: 1.6, 95: 1.0, 150: 1.0, 33: 0.8, 136: 0.8, 126: 0.9, 132: 1.0,
  32: 1.2, 135: 1.2, 125: 1.2, 131: 1.2, 34: 1.0, 138: 1.0, 128: 1.0, 134: 1.0,
  35: 1.0, 137: 2.0, 127: 3.0, 133: 4.0,
};
const SPEED_FIST = 4.0;
function speedOf(id) { return WEAPON_SPEED[id] !== undefined ? WEAPON_SPEED[id] : SPEED_FIST; }
function dmgOf(id) { return WEAPON_DMG[id] !== undefined ? WEAPON_DMG[id] : FIST; }

function fresh(st, now) {
  return !!st && Array.isArray(st.p) && st.p.length >= 3 && st.p.every(Number.isFinite) && now - st.t < FRESH_MS;
}

// konum paketi geldiginde cagrilir (server.js): elde tutulan esya gecmisini ve durumu saklar
function onState(c, data, now) {
  const p = Array.isArray(data.p) && data.p.length >= 3 && data.p.every(Number.isFinite) ? data.p.slice(0, 3) : null;
  const hi = Number.isFinite(data.hi) ? data.hi | 0 : 0;
  const prev = c.pst;
  const held = (prev && prev.held ? prev.held : []).filter((h) => now - h.t < HELD_GRACE_MS);
  if (!held.length || held[held.length - 1].id !== hi) held.push({ id: hi, t: now });
  c.pst = {
    p: p || (prev ? prev.p : null), t: p ? now : (prev ? prev.t : 0),
    inv: !!data.inv, sp: !!data.sp, spec: !!data.spec,
    pv: Number.isFinite(data.pv) ? data.pv | 0 : 0,      // istemci PVP protokol surumu (v222+: hasarsiz geri tepme vurusunu anlar)
    hp: Number.isFinite(data.hp) ? data.hp : 20, held,
  };
}

function heldInfo(att, now) {
  const h = att.pst && att.pst.held;
  let best = null;
  if (h) for (const e of h) if (now - e.t < HELD_GRACE_MS) {
    const d = dmgOf(e.id);
    if (!best || d > best.dmg) best = { dmg: d, speed: speedOf(e.id) };
  }
  return best || { dmg: FIST, speed: SPEED_FIST };
}

function unit2(a) {
  if (!Array.isArray(a) || a.length < 2) return null;
  const x = Number(a[0]), y = Number(a[1]);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  const l = Math.hypot(x, y);
  return l > 0.0001 ? [x / l, y / l] : null;
}

function check(att, vic, ws, data, now, roomName) {
  if (!vic) return { ok: false, why: "gone" };
  const r = roomName || "";
  const pvpRoom = r === "arena" || r === "crystal" || r === "smp" || r.startsWith("m-") || r.startsWith("d-") || r.startsWith("p-");
  if (!pvpRoom) return { ok: false, why: "room" };
  if (att.pst && (att.pst.spec || att.pst.hp <= 0)) return { ok: false, why: "att" };
  if (r.startsWith("m-") && att.team && vic.team && att.team === vic.team) return { ok: false, why: "team" };
  // saldirgan hiz siniri
  att.hitLog = (att.hitLog || []).filter((t) => now - t < 1000);
  if (att.hitLog.length && now - att.hitLog[att.hitLog.length - 1] < MIN_GAP_MS) return { ok: false, why: "rate" };
  if (att.hitLog.length >= MAX_PER_SEC) return { ok: false, why: "rate" };
  if (fresh(vic.pst, now) && vic.pst.inv) return { ok: false, why: "inv" };
  let sdirv = null;      // sunucunun hesapladigi yatay yon (saldirgan -> hedef)
  if (fresh(att.pst, now) && fresh(vic.pst, now)) {
    const dx = vic.pst.p[0] - att.pst.p[0], dz = vic.pst.p[2] - att.pst.p[2];
    const d = Math.hypot(dx, vic.pst.p[1] - att.pst.p[1], dz);
    if (d > MAX_RANGE) return { ok: false, why: "range" };
    const hl = Math.hypot(dx, dz);
    if (hl > 0.05) sdirv = [dx / hl, dz / hl];
  }
  att.hitLog.push(now);
  // geri tepme yonu
  let dir = unit2(data.dir);
  if (sdirv && (!dir || dir[0] * sdirv[0] + dir[1] * sdirv[1] < 0.3)) dir = sdirv;
  if (!dir) dir = [0, 1];
  let sdir = unit2(data.sdir);
  if (sdir && !(att.pst && att.pst.sp && fresh(att.pst, now))) sdir = null;
  if (sdir && sdir[0] * dir[0] + sdir[1] * dir[1] < 0) sdir = null;
  // v223: 1.9 saldiri bekleme (SUNUCU hesaplar): son vurustan beri gecen sureye gore hasar 0.2..1.0; her vurus bekleme sayacini sifirlar
  const info = heldInfo(att, now);
  const fullMs = 1000 / info.speed;
  const sinceMs = att.lastAtkAt ? now - att.lastAtkAt + 50 : 1e9;      // +50 ms: ag titremesi payi
  att.lastAtkAt = now;
  const scale = Math.min(1, Math.max(0, (sinceMs + 25) / fullMs));
  // kritik: bekleme dolu (>0.848), kosmuyor; dusme durumunu istemci bildirir (data.cr)
  const crit = data.cr === true && scale > 0.848 && !(att.pst && att.pst.sp);
  if (scale <= 0.9) sdir = null;      // kosu geri tepmesi sadece dolu vurusta
  const cap = Math.min(info.dmg * (0.2 + scale * scale * 0.8) * (crit ? 1.5 : 1), MAX_DMG);
  const cd = Number(data.dmg);
  const want = Math.min(Number.isFinite(cd) && cd > 0 ? cd : cap, cap);
  // 1.9 / Java dokunulmazlik: pencere (0.5 sn) icinde sadece ONCEKINDEN BUYUK hasar, aradaki FARK kadar vurur; digerleri sayilmaz (geri tepme de yok)
  const inWin = vic.lastDmgAt && now - vic.lastDmgAt < IFRAME_MS;
  let dm = true, dmg = want;
  if (inWin) {
    if (want > (vic.lastDmgVal || 0) + 0.01) { dmg = want - (vic.lastDmgVal || 0); vic.lastDmgVal = want; }
    else return { ok: false, why: "iframe" };
  } else {
    vic.lastDmgAt = now; vic.lastDmgVal = want;
  }
  return { ok: true, dm, dmg, dir, sdir: sdir || [0, 0] };
}

// ws: saldirganin soketi, att: onun client kaydi, set: odadaki soketler, clients: ws -> client kaydi, send(ws, obj): sunucu yardimcisi
function handleDuelHit(ws, att, set, clients, data, now, send) {
  const to = Number(data.to);
  const sq = Number(data.sq) | 0;
  let vws = null, vic = null;
  for (const w of set) {
    const cc = clients.get(w);
    if (cc && cc.id === to && w !== ws) { vws = w; vic = cc; break; }
  }
  const r = check(att, vic, ws, data, now, att.room);
  if (!r.ok) {
    send(ws, { type: "relay", from: to, data: { kind: "hit_ack", to: att.id, sq, ok: false, why: r.why } });
    return r;
  }
  // Eski istemci (pv < 222) hasarsiz geri tepme vurusunu bilmez: dmg 0'i 1 hasara cevirip her tiklamada can duserdi.
  // Bu yuzden pencere icindeki vurus ona iletilmez; vurana "sayilmadi" denir (sahte sekme silinir).
  if (!r.dm && !(vic.pst && vic.pst.pv >= 222)) {
    send(ws, { type: "relay", from: to, data: { kind: "hit_ack", to: att.id, sq, ok: false, why: "old" } });
    return { ok: false, why: "old" };
  }
  send(ws, { type: "relay", from: to, data: { kind: "hit_ack", to: att.id, sq, ok: true, dm: r.dm } });
  const out = { kind: "duel_hit", to, dmg: r.dmg, dm: r.dm, dir: r.dir, sdir: r.sdir, sq, srv: true };
  if (vws.readyState === 1) vws.send(JSON.stringify({ type: "relay", from: att.id, data: out }));
  return r;
}

module.exports = { check, handleDuelHit, onState, IFRAME_MS, MAX_RANGE, WEAPON_DMG };
