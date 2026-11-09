// Discord'dan indirdigin ada yedegini (ada-yedek-*.json) sunucu depolamasina geri yukler.
// v214: yedek dosyasindaki ada seviyesi + Dinar cuzdanlari da geri gelir (v2 yedekleri; eski v1 yedeginde cuzdan yoksa seviye / Dinar adadan hesaplanir).
// Kullanim (Render shell ya da kendi bilgisayarinda, ayni DATABASE_URL / DATA_DIR ile):  node server/island_restore.js ada-yedek-123.json
// Not: tum veriyi (hesaplar + adalar + cuzdan) tek seferde geri yuklemek icin admin sayfasi > Yedek > "Yedegi sunucuya yukle" daha kolaydir.
const fs = require("fs");
const ISL = require("./islands");
(async () => {
  const f = process.argv[2];
  if (!f) { console.log("Kullanim: node server/island_restore.js <ada-yedek.json>"); process.exit(1); }
  const j = JSON.parse(fs.readFileSync(f, "utf8"));
  let n = 0;
  const restored = [];
  for (const it of j.islands || []) {
    if (!it.k || !it.d) continue;
    const old = await ISL.get(it.k);
    if (old && old.t >= Number(it.t)) continue;            // sunucudaki daha yeniyse dokunma
    await ISL.put(ISL.keyOf(it.k), Buffer.from(it.d, "base64"), Number(it.t) || 0);
    restored.push(ISL.keyOf(it.k));
    n++;
  }
  // cuzdanlar: sunucuda zaten cuzdani olan hesaba dokunulmaz (overwrite=false)
  const r = await ISL.importAll({ islands: [], wallets: j.wallets || [] }, false);
  for (const k of restored) { try { await ISL.ensureWallet(k); } catch (e) {} }   // cuzdani olmayana adadan olustur
  console.log("Geri yuklenen ada: " + n + ", cuzdan: " + r.wallets);
  process.exit(0);
})();
