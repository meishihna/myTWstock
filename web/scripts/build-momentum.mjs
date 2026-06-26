/**
 * build-momentum.mjs — 掃 data/financials_store/*.json,算「連三月營收年增」。
 *
 * 規則:monthlyRevenue.yoy 末 3 個月皆 > 0 → mom3up=true(真實衍生,無估算)。
 * 輸出 web/public/data/momentum.json { generatedAt, mom3: { [ticker]: true } }
 * (只存符合者以縮小檔案;供 build-map-index.mjs 標記公司卡「連三月年增」標籤。)
 *
 * 須在 financials_store 更新後執行;與其他 build 步驟順序無關。
 */
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.join(__dirname, "..");
const REPO = path.join(WEB, "..");
const STORE = path.join(REPO, "data", "financials_store");
const OUT_DIR = path.join(WEB, "public", "data");
const OUT = path.join(OUT_DIR, "momentum.json");

function main() {
  if (!existsSync(STORE)) {
    console.warn("[momentum] financials_store missing, skip:", STORE);
    return;
  }
  const mom3 = {};
  let scanned = 0;
  for (const f of readdirSync(STORE)) {
    if (!/^\d{4}\.json$/.test(f)) continue;
    scanned++;
    const ticker = f.replace(/\.json$/, "");
    let j;
    try {
      j = JSON.parse(readFileSync(path.join(STORE, f), "utf8"));
    } catch {
      continue;
    }
    const yoy = j?.monthlyRevenue?.yoy;
    if (!Array.isArray(yoy) || yoy.length < 3) continue;
    const last3 = yoy.slice(-3);
    if (last3.every((v) => typeof v === "number" && Number.isFinite(v) && v > 0)) {
      mom3[ticker] = true;
    }
  }

  mkdirSync(OUT_DIR, { recursive: true });
  const payload = JSON.stringify({ generatedAt: new Date().toISOString(), mom3 });
  writeFileSync(OUT, payload, "utf8");
  console.log(`[momentum] scanned ${scanned} | 連三月年增 ${Object.keys(mom3).length} 檔 ->`, OUT);
}

main();
