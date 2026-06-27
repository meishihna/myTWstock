/**
 * build-momentum.mjs — 各股「月營收年增/年減」連續streak(供公司卡動態動能標籤)。
 *
 * 由 data/financials_store/*.json 的 monthlyRevenue.yoy(逐月年增%),
 * 從最近一個有效月份往前數「同號連續月數」,輸出帶正負號的 streak:
 *   +3 = 連三月年增、+1 = 當月年增、-2 = 連二月年減、0/缺 = 無資料
 * 前端據此顯示:1→營收年增/年減、N→連N月年增/年減,紅增綠減。
 *
 * 輸出 web/public/data/momentum.json { generatedAt, mom: { [ticker]: streak } }(只存非零)
 * 須在 financials_store 更新後執行;供 build-map-index.mjs 取用。
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

// 從 yoy 陣列尾端(最近月)往前數同號連續月數,回傳帶號 streak
function yoyStreak(yoy) {
  if (!Array.isArray(yoy)) return 0;
  let i = yoy.length - 1;
  while (i >= 0 && !(typeof yoy[i] === "number" && Number.isFinite(yoy[i]))) i--;
  if (i < 0) return 0;
  const sign = yoy[i] > 0 ? 1 : yoy[i] < 0 ? -1 : 0;
  if (sign === 0) return 0;
  let n = 0;
  for (; i >= 0; i--) {
    const v = yoy[i];
    if (typeof v !== "number" || !Number.isFinite(v)) break;
    const s = v > 0 ? 1 : v < 0 ? -1 : 0;
    if (s !== sign) break;
    n++;
  }
  return sign * n;
}

function main() {
  if (!existsSync(STORE)) {
    console.warn("[momentum] financials_store missing, skip:", STORE);
    return;
  }
  const mom = {};
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
    const s = yoyStreak(j?.monthlyRevenue?.yoy);
    if (s !== 0) mom[ticker] = s;
  }

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), mom }), "utf8");
  const up = Object.values(mom).filter((v) => v > 0).length;
  const dn = Object.values(mom).filter((v) => v < 0).length;
  console.log(`[momentum] scanned ${scanned} | 年增 ${up} / 年減 ${dn} ->`, OUT);
}

main();
