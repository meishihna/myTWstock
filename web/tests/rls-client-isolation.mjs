#!/usr/bin/env node
/**
 * RLS 隔離驗證台 —— 走【前端真正會走的那條路徑】(supabase-js + PostgREST)
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 為什麼需要這一支:`supabase/tests/rls_isolation.test.sql` 已經在 SQL 層驗過 29 項,
 * 但那是 pgTAP 直接連 Postgres。前端走的是 **supabase-js → PostgREST → Postgres**,
 * 中間多了 JWT 解析、角色切換、REST 查詢翻譯。那一段沒被涵蓋。
 * 「SQL 層安全」推不出「前端拿不到」—— 中間任何一層弄錯身分都會破功。
 *
 * 🔴 對照組是這支腳本的核心,不是附屬品:
 *    **「讀不到」可能是查詢寫錯了**,不是隔離有效。所以每一條攻擊查詢都要證明
 *    它在【應該讀得到的時候】真的讀得到 —— 否則 0 列只證明查詢沒回東西。
 *
 * 🔴 只跑本機。腳本會硬性檢查 URL 是 127.0.0.1/localhost,否則拒絕執行 ——
 *    這支會建立與刪除使用者,絕不能誤指向正式專案。
 * ══════════════════════════════════════════════════════════════════════════
 *
 * 用法(需先 `npx supabase start`):
 *   node tests/rls-client-isolation.mjs
 *
 * 退出碼:0 = 隔離成立且對照組有鑑別力,1 = 任一項不符
 */
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * 取得本機堆疊的連線資訊。
 * ⚠️ Windows 上用 execFileSync 直接叫 `npx.cmd`,Node 24 會回 EINVAL(.cmd 需要 shell)。
 *    改用 execSync + shell,並以 REPO 為 cwd(supabase/ 在 repo 根)。
 */
function localConfig() {
  const raw = execSync("npx --yes supabase@latest status -o json", {
    encoding: "utf8",
    maxBuffer: 1 << 24,
    cwd: REPO,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const j = JSON.parse(raw);
  return { url: j.API_URL, anon: j.ANON_KEY, service: j.SERVICE_ROLE_KEY };
}

const { url, anon, service } = localConfig();

// 🔴 安全閘:這支會建立/刪除使用者,只准指向本機
if (!/^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(url)) {
  console.error(`❌ 拒絕執行:URL 不是本機(${url})。本腳本會建立與刪除使用者,不得指向正式專案。`);
  process.exit(2);
}

const admin = createClient(url, service, { auth: { persistSession: false, autoRefreshToken: false } });
const asAnon = () => createClient(url, anon, { auth: { persistSession: false, autoRefreshToken: false } });
/** 以某使用者的 access token 建 client —— 這就是瀏覽器登入後的形狀 */
const asUser = (token) =>
  createClient(url, anon, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });

let pass = 0;
const fails = [];
const check = (ok, name, detail = "") => {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fails.push(`${name}${detail ? " —— " + detail : ""}`); console.log(`  ✗ ${name}${detail ? "  " + detail : ""}`); }
};

/* ── 建立兩個測試使用者,用【magic link】取得 session ───────────────────── */
/** 不用密碼登入:正式站不做密碼,測試就該走同一條路徑(magic link → verifyOtp) */
async function makeUser(email) {
  const { data: created, error: e1 } = await admin.auth.admin.createUser({
    email,
    email_confirm: true,
  });
  if (e1) throw new Error(`建立使用者失敗 ${email}: ${e1.message}`);
  const { data: link, error: e2 } = await admin.auth.admin.generateLink({ type: "magiclink", email });
  if (e2) throw new Error(`產生 magic link 失敗 ${email}: ${e2.message}`);
  const sb = asAnon();
  const { data: sess, error: e3 } = await sb.auth.verifyOtp({
    type: "email",
    token_hash: link.properties.hashed_token,
  });
  if (e3) throw new Error(`verifyOtp 失敗 ${email}: ${e3.message}`);
  return { id: created.user.id, email, token: sess.session.access_token };
}

const stamp = Date.now();
const A = await makeUser(`rls-a-${stamp}@example.test`);
const B = await makeUser(`rls-b-${stamp}@example.test`);
console.log(`測試使用者:A=${A.id.slice(0, 8)}…  B=${B.id.slice(0, 8)}…\n`);

const a = asUser(A.token);
const b = asUser(B.token);

/* ── 各自寫入自己的資料(順帶證明 with check 允許自己的列)──────────────── */
async function seed(cli, uid, ticker) {
  const rows = [
    { user_id: uid, ticker, trade_date: "2024-01-02", seq: 1, side: "buy", shares: 1000, price: 100, fee: 142.5, tax: 0 },
    { user_id: uid, ticker, trade_date: "2024-02-02", seq: 1, side: "buy", shares: 1000, price: 110, fee: 156.75, tax: 0 },
    { user_id: uid, ticker, trade_date: "2024-03-02", seq: 1, side: "sell", shares: 1500, price: 120, fee: 256.5, tax: 540 },
  ];
  const r1 = await cli.from("trades").insert(rows);
  const r2 = await cli.from("cash_flows").insert({ user_id: uid, flow_date: "2024-01-01", kind: "deposit", amount: 500000 });
  const r3 = await cli.from("watchlist").insert({ user_id: uid, ticker });
  const r4 = await cli.from("preferences").insert({ user_id: uid });
  return [r1, r2, r3, r4].filter((r) => r.error).map((r) => r.error.message);
}
console.log("── 種資料(順帶驗 with check 允許寫自己的列)──");
const errA = await seed(a, A.id, "2330");
const errB = await seed(b, B.id, "2317");
check(errA.length === 0, "A 可寫入自己的列", errA.join(" | "));
check(errB.length === 0, "B 可寫入自己的列", errB.join(" | "));

const VIEWS = ["v_trade_lots", "v_ticker_sold", "v_open_lots", "v_holdings", "v_position_anomalies", "v_realized_lots", "v_cash_flow_total"];
/** profiles 以 auth.users.id 為主鍵,沒有 user_id 欄 —— 擁有者欄位逐表指定,不可假設同名 */
const TABLES = [
  { name: "trades", owner: "user_id" },
  { name: "cash_flows", owner: "user_id" },
  { name: "watchlist", owner: "user_id" },
  { name: "preferences", owner: "user_id" },
  { name: "profiles", owner: "id" },
];

/* ── 4a 攻擊面:A 用各種方式讀 B ─────────────────────────────────────────── */
console.log("\n── 4a 以 A 的 token 嘗試讀取 B(全部必須 0 列)──");
for (const { name, owner } of TABLES) {
  const { data, error } = await a.from(name).select("*").eq(owner, B.id);
  check(!error && (data?.length ?? 0) === 0, `${name}:明確指定 ${owner} = B`, error?.message ?? `回 ${data?.length} 列`);
}
for (const v of VIEWS) {
  const { data, error } = await a.from(v).select("*").eq("user_id", B.id);
  check(!error && (data?.length ?? 0) === 0, `view ${v}:指定 user_id = B`, error?.message ?? `回 ${data?.length} 列`);
}
{
  const { data } = await a.from("trades").select("*");
  check((data ?? []).every((r) => r.user_id === A.id), "無條件 select:只看得到自己的列", `共 ${data?.length} 列`);
}
{
  const { count } = await a.from("trades").select("*", { count: "exact", head: true });
  check(count === 3, "聚合 count 只涵蓋自己(期望 3)", `實際 ${count}`);
}
{
  const { data } = await a.from("watchlist").select("ticker, trades:trades(ticker)").limit(50);
  check(!data || JSON.stringify(data).indexOf("2317") < 0, "join/嵌入查詢不會帶出 B 的代號");
}
{
  const { error } = await a.from("trades").insert({ user_id: B.id, ticker: "2454", trade_date: "2024-05-05", side: "buy", shares: 1, price: 1 });
  check(Boolean(error), "寫入一列 user_id = B → 必須被拒", error ? "" : "竟然成功");
}
{
  const { data: mine } = await a.from("trades").select("id").limit(1);
  const { error } = await a.from("trades").update({ user_id: B.id }).eq("id", mine[0].id);
  check(Boolean(error), "把自己的列改成 user_id = B → 必須被拒", error ? "" : "竟然成功");
}
{
  const { data } = await a.from("trades").delete().eq("user_id", B.id).select();
  check((data?.length ?? 0) === 0, "刪除 B 的列 → 影響 0 列", `影響 ${data?.length} 列`);
  const { count } = await b.from("trades").select("*", { count: "exact", head: true });
  check(count === 3, "B 的列仍在(證明上一條不是把資料刪掉了)", `實際 ${count}`);
}

/* ── 未登入 / 偽造 / 過期 / 竄改 token ──────────────────────────────────── */
console.log("\n── 未登入與非法 token(不同的程式路徑,分開測)──");
{
  const { data, error } = await asAnon().from("trades").select("*");
  check(Boolean(error) || (data?.length ?? 0) === 0, "anon(無 session)讀 trades → 拒絕或 0 列", error?.message ?? `回 ${data?.length} 列`);
}
const b64u = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const parts = A.token.split(".");
const payload = JSON.parse(Buffer.from(parts[1], "base64").toString("utf8"));
{
  const expired = [parts[0], b64u({ ...payload, exp: Math.floor(Date.now() / 1000) - 3600 }), parts[2]].join(".");
  const { data, error } = await asUser(expired).from("trades").select("*");
  check(Boolean(error) || (data?.length ?? 0) === 0, "過期 token → 拒絕", error?.message ?? `回 ${data?.length} 列`);
}
{
  const tampered = [parts[0], parts[1], "AAAA" + parts[2].slice(4)].join(".");
  const { data, error } = await asUser(tampered).from("trades").select("*");
  check(Boolean(error) || (data?.length ?? 0) === 0, "簽章被改的 token → 拒絕", error?.message ?? `回 ${data?.length} 列`);
}
{
  // 拿 A 的 token 但把 payload 的 sub 改成 B —— 簽章因此失效,必須被拒
  const swapped = [parts[0], b64u({ ...payload, sub: B.id }), parts[2]].join(".");
  const { data, error } = await asUser(swapped).from("trades").select("*");
  const leaked = (data ?? []).some((r) => r.user_id === B.id);
  check((Boolean(error) || (data?.length ?? 0) === 0) && !leaked, "payload 的 sub 被改成 B → 拒絕(且未回 B 的列)", error?.message ?? `回 ${data?.length} 列`);
}

/* ── 4b 對照組:證明上面那些 0 列有鑑別力 ──────────────────────────────── */
console.log("\n── 4b 對照組(沒有這段,上面的 0 列不證明隔離有效)──");
for (const { name, owner } of TABLES) {
  const { data, error } = await b.from(name).select("*").eq(owner, B.id);
  check(!error && (data?.length ?? 0) > 0, `同一條查詢改用 B 的 token → 讀得到(${name})`, error?.message ?? "0 列");
}
{
  const { data, error } = await b.from("v_holdings").select("*").eq("user_id", B.id);
  check(!error && (data?.length ?? 0) > 0, "同一條 view 查詢改用 B 的 token → 讀得到(v_holdings)", error?.message ?? "0 列");
}

/* ── 加測 ②:刪帳號必須真的刪資料(CASCADE)──────────────────────────── */
console.log("\n── 刪帳號 → 資料必須跟著消失(對使用者的隱私承諾,不是實作細節)──");
{
  /**
   * 🔴 清點【必須】繞開 PostgREST,這不是繞路而是唯一可行的路:
   *    migration 的 `revoke all … from public` 讓 **service_role 對這些表也沒有權限**
   *    (實測 `permission denied for table profiles`;下方有明文斷言守著這個性質)。
   *    所以「用 service_role 數列」在這個 schema 上不可能成立。
   *    改用 docker 內的 psql 以 postgres 超級使用者直連 —— 只有本機測試環境有這條路,
   *    正式站沒有,也不需要有。
   *
   * 🔴 而且清點【查不到就是失敗】,不可當成 0:
   *    第一版寫 `count ?? 0 === 0`,查詢出錯時 count 是 null → 「CASCADE 已消失」
   *    會假通過。那正是這週一路在抓的「量不到 = 沒問題」。
   */
  const container = execSync("docker ps --format \"{{.Names}}\"", { encoding: "utf8" })
    .split("\n").map((s) => s.trim()).find((n) => /^supabase_db_/.test(n));
  if (!container) throw new Error("找不到 supabase_db_* 容器,無法清點 CASCADE");
  const countRows = (table, owner, uid) => {
    const out = execSync(
      `docker exec ${container} psql -U postgres -At -c "select count(*) from public.${table} where ${owner} = '${uid}';"`,
      { encoding: "utf8" }
    ).trim();
    const n = Number(out);
    if (!Number.isFinite(n)) throw new Error(`清點 ${table} 失敗,psql 回:${out}`);
    return n;
  };

  const before = Object.fromEntries(TABLES.map(({ name, owner }) => [name, countRows(name, owner, A.id)]));
  check(Object.values(before).every((n) => n > 0), "刪除前 A 在五張表都有列(基準)", JSON.stringify(before));

  const { error: delErr } = await admin.auth.admin.deleteUser(A.id);
  check(!delErr, "刪除使用者 A(GoTrue admin API)", delErr?.message);

  for (const { name, owner } of TABLES) {
    const n = countRows(name, owner, A.id);
    check(n === 0, `CASCADE:${name} 中 A 的列已消失`, `殘留 ${n} 列`);
  }
  const bStill = countRows("trades", "user_id", B.id);
  check(bStill > 0, "B 的資料不受 A 被刪影響(證明不是整表清空)", `B 剩 ${bStill} 列`);
}

/* ── service_role 對這些表【沒有表級權限】是刻意保留的性質 ───────────────── */
{
  /**
   * 這不是設計時寫下的規則,是 `revoke all … from public` 的副作用 ——
   * 但它是個好性質:**service_role key 外洩也讀不到這些表**,
   * 而我們的架構本來就不用 service_role(前端直連 + RLS)。
   *
   * 🔴 副作用不會自己活下來:哪天有人寫一句 grant 就悄悄沒了。
   *    所以把它變成明文斷言。重訪條件見 supabase/README.md ——
   *    若日後需要後端管理操作,必須【逐項顯式 grant 並記錄理由】,不可整批放開。
   *
   * 用 has_table_privilege 直接問資料庫,不從 PostgREST 的錯誤訊息反推:
   * REST 回 permission denied 的原因可能不只一種,問權限本身才精確。
   */
  const container = execSync("docker ps --format \"{{.Names}}\"", { encoding: "utf8" })
    .split("\n").map((s) => s.trim()).find((n) => /^supabase_db_/.test(n));
  const objs = [...TABLES.map((t) => t.name), ...VIEWS];
  const sql = objs
    .map((o) => `select '${o}' as obj, has_table_privilege('service_role','public.${o}','SELECT') as sel`)
    .join(" union all ");
  const out = execSync(`docker exec ${container} psql -U postgres -At -c "${sql};"`, { encoding: "utf8" });
  const rows = out.trim().split("\n").map((l) => l.split("|"));
  check(rows.length === objs.length, `權限查詢涵蓋全部 ${objs.length} 個物件`, `實際 ${rows.length}`);
  const granted = rows.filter(([, sel]) => sel === "t").map(([o]) => o);
  check(granted.length === 0, "service_role 對五張表與七個檢視皆無 SELECT 權限", granted.join(", "));
  // 對照:authenticated 必須有 —— 否則「全都沒有權限」也會讓上一條通過
  const sql2 = objs
    .map((o) => `select '${o}' as obj, has_table_privilege('authenticated','public.${o}','SELECT') as sel`)
    .join(" union all ");
  const out2 = execSync(`docker exec ${container} psql -U postgres -At -c "${sql2};"`, { encoding: "utf8" });
  const missing = out2.trim().split("\n").map((l) => l.split("|")).filter(([, s]) => s !== "t").map(([o]) => o);
  check(missing.length === 0, "對照:authenticated 對同一組物件【有】SELECT 權限", `缺 ${missing.join(", ")}`);
}

/* ── 收尾:清掉 B ──────────────────────────────────────────────────────── */
await admin.auth.admin.deleteUser(B.id).catch(() => {});

console.log(`\n通過 ${pass} 項;失敗 ${fails.length} 項`);
if (fails.length) {
  for (const f of fails) console.error("  ❌ " + f);
  process.exit(1);
}
console.log("✅ RLS 隔離在 supabase-js 路徑上成立,且對照組證明查詢本身有效");
