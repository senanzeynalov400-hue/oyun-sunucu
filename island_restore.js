// Discord'dan indirdigin ada yedegini (ada-yedek-*.json) sunucu depolamasina geri yukler.
// Kullanim (Render shell ya da kendi bilgisayarinda, ayni DATABASE_URL / DATA_DIR ile):  node server/island_restore.js ada-yedek-123.json
const fs = require("fs");
const ISL = require("./islands");
(async () => {
  const f = process.argv[2];
  if (!f) { console.log("Kullanim: node server/island_restore.js <ada-yedek.json>"); process.exit(1); }
  const j = JSON.parse(fs.readFileSync(f, "utf8"));
  let n = 0;
  for (const it of j.islands || []) {
    if (!it.k || !it.d) continue;
    const old = await ISL.get(it.k);
    if (old && old.t >= Number(it.t)) continue;            // sunucudaki daha yeniyse dokunma
    await ISL.put(ISL.keyOf(it.k), Buffer.from(it.d, "base64"), Number(it.t) || 0);
    n++;
  }
  console.log("Geri yuklenen ada: " + n);
  process.exit(0);
})();
