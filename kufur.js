"use strict";
// OTOMATIK KUFUR FILTRESI. check(text) -> 0 (temiz) / 1 (hafif kufur) / 2 (agir kufur)
// Kelime listesi: server/kufur.json (istedigin zaman ekle / cikar, sunucuyu yeniden baslat)
const fs = require("fs");
const path = require("path");

const TR = { "ı": "i", "ş": "s", "ğ": "g", "ü": "u", "ö": "o", "ç": "c", "â": "a", "î": "i", "û": "u" };
const LEET = { "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "@": "a", "$": "s", "!": "i", "|": "i" };

// metni sadelestir: kucuk harf, Turkce karakter -> latin, leet (4=a, 0=o...) -> harf, tekrar eden harf teke iner
function base(s) {
  s = String(s || "").replace(/İ/g, "i").replace(/I/g, "ı").toLowerCase();
  let o = "";
  for (const ch of s) o += TR[ch] || LEET[ch] || ch;
  return o;
}
const collapse = (s) => s.replace(/([a-z])\1+/g, "$1");

let EXACT = new Map();      // kelime -> seviye (tam eslesme)
let PREFIX = [];            // [kok, seviye] (ekli halleri de yakalar)
let SQUASH = [];            // [kelime, seviye] (bosluk / noktalama kaldirilinca icinde gecerse)

function load() {
  let d = { agir: [], hafif: [] };
  try { d = JSON.parse(fs.readFileSync(path.join(__dirname, "kufur.json"), "utf8")); } catch (e) { console.error("kufur.json okunamadi", e.message); }
  EXACT = new Map(); PREFIX = []; SQUASH = [];
  const add = (list, lvl) => {
    for (let w of Array.isArray(list) ? list : []) {
      w = String(w || "").trim();
      if (!w) continue;
      const forceExact = w.endsWith("=");
      w = collapse(base(w.replace(/=$/, "")).replace(/[^a-z]/g, ""));
      if (!w) continue;
      if (forceExact || w.length <= 3) { EXACT.set(w, Math.max(lvl, EXACT.get(w) || 0)); continue; }
      PREFIX.push([w, lvl]);
      if (w.length >= 6) SQUASH.push([w, lvl]);
    }
  };
  add(d.hafif, 1);
  add(d.agir, 2);          // agir en son: ayni kelime iki listedeyse agir kazanir
}
load();

function check(text) {
  const b = collapse(base(text));
  if (!b) return 0;
  let lvl = 0;
  // 1) kelime kelime (a.m.k / a m k gibi tek harfli diziler birlestirilir)
  const raw = b.split(/[^a-z]+/).filter(Boolean);
  const toks = [];
  for (let i = 0; i < raw.length;) {
    if (raw[i].length === 1) {
      let j = i; let run = "";
      while (j < raw.length && raw[j].length === 1) { run += raw[j]; j++; }
      if (run.length >= 3) toks.push(collapse(run)); else for (let k = i; k < j; k++) toks.push(raw[k]);
      i = j;
    } else { toks.push(raw[i]); i++; }
  }
  for (const t of toks) {
    const e = EXACT.get(t);
    if (e) lvl = Math.max(lvl, e);
    for (const [stem, l] of PREFIX) if (l > lvl && t.startsWith(stem)) lvl = l;
  }
  // 2) bosluk / noktalama kaldirilmis hali (oro spu, ami na koyim) - sadece uzun kelimeler
  const sq = b.replace(/[^a-z]/g, "");
  for (const [w, l] of SQUASH) if (l > lvl && sq.includes(w)) lvl = l;
  return lvl;
}

module.exports = { check, reload: load };
