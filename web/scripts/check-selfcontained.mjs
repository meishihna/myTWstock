/**
 * check-selfcontained.mjs — 自足性守門
 *
 * 抓的是這個失效模式:【本機有檔、repo 沒檔】。
 * build 讀得到 → 本機一切正常 → 掃描器過、build 過 → 只有線上壞掉,而且是【靜默】壞掉
 * (資料讀不到就退回 fallback 或空值,不會拋錯)。
 *
 * 實際發生過:`.gitignore` 忽略了 `web/public/data/financials/`,整批官方財務遷移在線上是
 * no-op —— screener 的 roe 空白數悄悄退回 303。本機、CI、掃描器三道全部通過。
 *
 * 做法:
 *   1. 掃「build 真的會讀」的資料根目錄
 *   2. 從 build-*.mjs 的【原始碼】推導 build 產物白名單(不 hardcode —— hardcode 會在
 *      新增 build 腳本時默默失效,正是這道檢查要防的東西)
 *   3. 每個檔跑 `git check-ignore`(批次,走 stdin)
 *   4. 【被忽略 且 不是 build 產物】→ 大聲失敗並列出檔名與命中的 .gitignore 規則
 *
 * 自我驗證:`node scripts/check-selfcontained.mjs --self-test`
 *   注入一個「已知會被讀、且必須進 repo」的檔當假想違規 → 必須抓到 → 才算這支工具是活的。
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.join(__dirname, "..");
const REPO = path.join(WEB, "..");

/**
 * build 真的會讀的資料根目錄。
 * 只列「內容進 repo 才有意義」的;純本機快取(data/mops_cache 等)刻意不列 —— 它們本來就該被忽略。
 */
const SCAN_ROOTS = [
  "data/financials_store",
  "data/enrichment_store",
  "Pilot_Reports",
  "themes",
  "web/public/data",
  "web/public/scripts",
  "web/docs",
];

/** 掃描時略過的目錄名(任何層級) */
const SKIP_DIRS = new Set([".git", "node_modules", "__pycache__", ".astro", "dist"]);

/**
 * 從 build 腳本原始碼推導產物白名單。
 *
 * 只認【被寫出】的檔名,不認單純出現在 `path.join(...)` 裡的檔名 ——
 * 後者會把「被 build 腳本讀取、但由別人(如 Python + CI)產生並提交」的檔誤列為產物,
 * 之後那個檔若被 .gitignore 掉,這道檢查就抓不到了(實例:`valuation-index.json`
 * 由 `scripts/build_valuation_snapshot.py` 產生並提交,JS 端只是讀它)。
 *
 * 比對用【basename】而非完整路徑:完整路徑要重現 `__dirname`/`WEB`/`REPO_ROOT` 等
 * 變數運算,等於自己寫一個小直譯器 —— 那類「工具自己解析」是本專案踩過最多次的坑。
 *
 * 推導不出任何產物 → 視為【檢查失敗】(量不到 = 失敗,不可靜默跳過)。
 */
function deriveArtifactBasenames() {
  const dirs = [path.join(WEB, "scripts")];
  const out = new Set();
  const files = [];
  for (const d of dirs) {
    if (!fs.existsSync(d)) continue;
    for (const f of fs.readdirSync(d)) {
      if (/\.(mjs|ts|js)$/.test(f)) files.push(path.join(d, f));
    }
  }
  const IDENT = "[A-Za-z_$][\\w$]*";
  for (const f of files) {
    const src = fs.readFileSync(f, "utf8");

    // ① 變數 → 它的 path.join(...) 裡的字面檔名
    const varToName = new Map();
    const declRe = new RegExp(
      `(?:const|let|var)\\s+(${IDENT})\\s*=\\s*path\\.join\\(([^)]*)\\)`,
      "gs"
    );
    let d;
    while ((d = declRe.exec(src))) {
      const n = /["'`]([\w.-]+\.(?:json|xml|txt))["'`]/.exec(d[2]);
      if (n) varToName.set(d[1], n[1]);
    }

    // ② 寫出點:writeFileSync(X, …) / renameSync(tmp, X) / createWriteStream(X)
    //    再加一條:寫出常被包成 helper(本 repo 就有 `writeJsonAtomicWithRetry(OUT_FILE, …)`、
    //    `writeJsonFile(OUT, …)`),只認 fs API 會漏掉真產物 → 額外認 write/save/emit/dump/output
    //    開頭的呼叫。名稱樣式刻意收緊,避免把讀取端(load/read/get)誤列為產物。
    //    X 可以是變數,也可以是就地的 path.join(…, "x.json")
    const sinks = [
      new RegExp(`writeFileSync\\(\\s*(${IDENT})\\b`, "g"),
      new RegExp(`createWriteStream\\(\\s*(${IDENT})\\b`, "g"),
      new RegExp(`renameSync\\([^,]+,\\s*(${IDENT})\\b`, "g"),
      new RegExp(`\\b(?:write|save|emit|dump|output)${IDENT}?\\s*\\(\\s*(${IDENT})\\b`, "gi"),
    ];
    for (const re of sinks) {
      let m;
      while ((m = re.exec(src))) {
        const name = varToName.get(m[1]);
        if (name) out.add(name);
      }
    }
    const inlineRe =
      /(?:writeFileSync|createWriteStream)\(\s*path\.join\(([^)]*)\)/gs;
    let m;
    while ((m = inlineRe.exec(src))) {
      const n = /["'`]([\w.-]+\.(?:json|xml|txt))["'`]/.exec(m[1]);
      if (n) out.add(n[1]);
    }
  }
  return { basenames: out, scriptCount: files.length };
}

/** 遞迴列出根目錄下所有檔案(repo 相對、POSIX 分隔;git 只吃 /) */
function listFiles(rootRel) {
  const abs = path.join(REPO, rootRel);
  if (!fs.existsSync(abs)) return [];
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        walk(path.join(dir, e.name));
      } else if (e.isFile()) {
        out.push(path.relative(REPO, path.join(dir, e.name)).split(path.sep).join("/"));
      }
    }
  };
  walk(abs);
  return out;
}

/**
 * 批次問 git:哪些路徑被忽略、被哪條規則忽略。
 * 回傳 Map<path, rule>;未被忽略者不入表。
 *
 * `git check-ignore --stdin -v -n` 對【每一個】輸入路徑都輸出一行:
 *   命中   → `<.gitignore檔>:<行號>:<規則>\t<path>`
 *   未命中 → `::\t<path>`
 * 退出碼 1 代表「一個都沒命中」,【不是錯誤】,不可當失敗處理。
 *
 * ⚠️ git 預設【略過已追蹤的檔】—— 這正是我們要的語意,不要加 `--no-index`:
 *   已追蹤 + 命中規則 → 檔案【仍然在 repo 裡】(ignore 規則對已追蹤檔完全無效)→ 不是問題
 *   未追蹤 + 命中規則 → 檔案【永遠進不了 repo】→ 就是要抓的東西
 * 當初 financials/ 那次正是後者(新產生、未追蹤、被規則擋住)。
 * (寫這支時我用「替已追蹤的 monthly-revenue.json 加規則」做注入測試,沒被抓到 ——
 *  一度以為工具壞了,查證後是【測試設計錯】:那個情境本來就不是問題。留此註記免得再繞一次。)
 */
function gitIgnored(paths) {
  if (!paths.length) return new Map();
  let stdout;
  try {
    stdout = execFileSync("git", ["check-ignore", "--stdin", "-v", "-n"], {
      cwd: REPO,
      input: paths.join("\n"),
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
    });
  } catch (e) {
    // 退出碼 1 = 沒有任何路徑被忽略(正常情況),仍會把結果印在 stdout
    if (e && e.status === 1 && typeof e.stdout === "string") stdout = e.stdout;
    else throw e;
  }
  const map = new Map();
  for (const line of stdout.split("\n")) {
    if (!line) continue;
    const tab = line.indexOf("\t");
    if (tab < 0) continue;
    const src = line.slice(0, tab);
    const p = line.slice(tab + 1).trim();
    if (src === "::") continue; // 未被忽略
    map.set(p, src);
  }
  return map;
}

/** git 在不在、能不能用 check-ignore(Vercel 等 shallow / 無 .git 環境會沒有) */
function gitAvailable() {
  try {
    execFileSync("git", ["rev-parse", "--git-dir"], { cwd: REPO, stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

function run({ injectPath = null, quiet = false } = {}) {
  const { basenames, scriptCount } = deriveArtifactBasenames();
  if (basenames.size === 0) {
    console.error(
      `❌ 自足性檢查失敗:掃了 ${scriptCount} 支 build 腳本卻推導出 0 個產物 —— ` +
        `推導邏輯已失效(量不到 = 失敗,不可當作「沒有違規」)。`
    );
    return { ok: false, violations: [], fatal: true };
  }

  let all = [];
  const perRoot = new Map();
  for (const r of SCAN_ROOTS) {
    const fs_ = listFiles(r);
    perRoot.set(r, fs_.length);
    all = all.concat(fs_);
  }
  if (injectPath) all.push(injectPath);

  const ignored = gitIgnored(all);
  const violations = [];
  for (const [p, rule] of ignored) {
    const base = path.posix.basename(p);
    if (basenames.has(base)) continue; // build 產物,被忽略是刻意的
    violations.push({ path: p, rule });
  }

  if (!quiet) {
    console.log(
      `[selfcontained] 掃描 ${all.length} 個檔 · build 產物白名單 ${basenames.size} 筆(由 ${scriptCount} 支腳本推導)`
    );
    for (const [r, n] of perRoot) console.log(`  ${String(n).padStart(6)}  ${r}`);
    if (process.argv.includes("--list")) {
      console.log(`  白名單:${[...basenames].sort().join(", ")}`);
    }
  }
  return { ok: violations.length === 0, violations, fatal: false };
}

function report(violations) {
  console.error(
    `\n❌ 自足性檢查失敗:${violations.length} 個檔案在本機存在、但【不會進 repo】。\n` +
      `   build 在本機讀得到、線上讀不到 → 會靜默退回空值或 fallback,不會拋錯。\n`
  );
  const byRule = new Map();
  for (const v of violations) {
    if (!byRule.has(v.rule)) byRule.set(v.rule, []);
    byRule.get(v.rule).push(v.path);
  }
  for (const [rule, paths] of byRule) {
    console.error(`  規則 ${rule}`);
    for (const p of paths.slice(0, 20)) console.error(`      ${p}`);
    if (paths.length > 20) console.error(`      …其餘 ${paths.length - 20} 個`);
  }
  console.error(
    `\n   修法:把該規則從 .gitignore 移除並提交這些檔,` +
      `或確認它真的是 build 產物(由 build-*.mjs 寫出)。\n`
  );
}

// ── 自我驗證:注入一個「必須進 repo 卻被忽略」的假想違規,一定要抓到 ──
if (process.argv.includes("--self-test")) {
  if (!gitAvailable()) {
    console.error("❌ 自我驗證需要 git,此環境不可用");
    process.exit(1);
  }
  // 用一條【確定存在】的忽略規則底下的假路徑當誘餌(.gitignore 第 1 行 __pycache__/)
  const bait = "scripts/__pycache__/__selftest_bait__.json";
  const base = run({ quiet: true });
  const withBait = run({ injectPath: bait, quiet: true });
  const caught = withBait.violations.some((v) => v.path === bait);
  console.log(`[self-test] 誘餌 = ${bait}`);
  console.log(`[self-test] 未注入時違規數 = ${base.violations.length}`);
  console.log(`[self-test] 注入後是否抓到 = ${caught ? "是" : "否"}`);
  if (!caught) {
    console.error("❌ 自我驗證失敗:注入了已知違規卻沒抓到 —— 這支工具是死的,不可信任其「0」");
    process.exit(1);
  }
  console.log("✅ 自我驗證通過(注入→抓到)");
  process.exit(0);
}

// ── 正常執行 ──
/**
 * 這道檢查【本質上是開發機的檢查】。
 * 部署/CI 端的檔案全部是從 repo 取出來的 —— 「本機有、repo 沒有」的檔在那裡根本不會存在,
 * 掃了也必然是 0。在 Vercel 上跑只有壞處:萬一產物推導漏判就會擋掉正式部署。
 * 所以在 Vercel 明確跳過並說明理由(不是靜默跳過)。
 */
if (process.env.VERCEL) {
  console.log(
    "[selfcontained] 在 Vercel 上跳過:部署端的檔案必然來自 repo," +
      "「本機有、repo 沒有」在此環境不可能出現 → 應在開發機(predev/prebuild)與 CI 檢查。"
  );
  process.exit(0);
}
if (!gitAvailable()) {
  // 無 .git 的環境(如部分 CI/部署快照)代表檔案本來就是從 repo 取出的,沒有「本機有、repo 沒有」
  // 這回事可查 —— 但仍要大聲說明本次【沒有實際檢查】,不假裝通過。
  console.warn(
    "⚠️ [selfcontained] 此環境沒有可用的 git → 本次【未執行】自足性檢查。\n" +
      "   (無 .git 表示檔案來自 repo 取出的快照,本地端的檢查應在開發機與 CI 上進行。)"
  );
  process.exit(0);
}

const r = run();
if (r.fatal) process.exit(1);
if (!r.ok) {
  report(r.violations);
  process.exit(1);
}
console.log("✅ [selfcontained] 0 個檔案會被 repo 遺漏");
