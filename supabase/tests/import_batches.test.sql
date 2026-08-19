-- import_batches.test.sql — 跑法:supabase test db
--
-- 🔴 這份要證明的是三件事,而且每一件都要有【對照】:
--   ① **原子性**:任何一列壞掉 → 三張表全部不留痕跡(含批次本身)。
--      對照 = 全部合法時三張表都寫進去。否則「沒寫進去」可能只是根本沒跑。
--   ② **不繞過 RLS**:RPC 是 security invoker,所以 B 動不了 A 的批次。
--      並且用結構性斷言守住「public 底下不得有白名單外的 security definer 函式」。
--   ③ **撤銷是精準的**:只刪該批次的列,**手動輸入的列(import_batch is null)不得被波及**。
--
-- 🔴 「找不到批次」必須拋錯而不是回 0 —— 回 0 的話,
--    「撤銷成功但那批是空的」與「批次不存在/不是你的」輸出一模一樣。
--
-- ⚠️ 全程在交易內,最後 rollback。

begin;
create extension if not exists pgtap with schema extensions;
select plan(42);

\set uid_a '11111111-1111-1111-1111-111111111111'
\set uid_b '22222222-2222-2222-2222-222222222222'

insert into auth.users (id, email)
values (:'uid_a', 'a@example.test'), (:'uid_b', 'b@example.test');

create or replace function pg_temp.act_as(p_uid text) returns void
language plpgsql as $$
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
end;
$$;

-- ══════════════════════════════════════════════════════════════════════
-- 一、對照組:合法匯入必須真的寫進去
--     (先確立這個,否則下面每一條「沒寫進去」都可能只是沒跑起來)
-- ══════════════════════════════════════════════════════════════════════
select pg_temp.act_as(:'uid_a');

select is((select count(*) from public.import_batches)::int, 0, '基準:A 目前沒有任何批次');

-- 🔴 手動輸入的一列,先放進去。撤銷【絕對不能】碰到它。
insert into public.trades (user_id, ticker, trade_date, seq, side, shares, price, fee, tax, note)
values (:'uid_a', '2454', '2023-12-01', 0, 'buy', 100, 900, 128.25, 0, '手動輸入,不屬於任何批次');

-- ⚠️ JSON 直接內嵌在語句裡,不用 \set —— psql 的 \set 只讀到行尾,
--    多行的 dollar-quote 會被截斷成語法錯誤(而且錯得很難看懂)。
create temporary table t_batch (id uuid);
insert into t_batch
select public.import_paste(5, '{"note":"合成資料"}'::jsonb,
$j$[
  {"ticker":"2330","trade_date":"2024-01-15","seq":"2","side":"buy","shares":"1000","price":"600","fee":"855","tax":"0","note":"純粹爽"},
  {"ticker":"2317","trade_date":"2024-02-01","seq":"3","side":"buy","shares":"2000","price":"100","fee":"285","tax":"0","note":""},
  {"ticker":"2330","trade_date":"2024-03-10","seq":"4","side":"sell","shares":"500","price":"700","fee":"498","tax":"1050","note":"知道錯了"}
]$j$::jsonb,
$j$[
  {"flow_date":"2024-01-02","kind":"deposit","amount":"1000000","ticker":"","note":"匯入自交易紀錄 · DEPOSIT"},
  {"flow_date":"2024-04-01","kind":"deposit","amount":"100000","ticker":"","note":"匯入自交易紀錄 · DEPOSIT"}
]$j$::jsonb);

select isnt((select id from t_batch), null, '合法匯入回傳批次 id');
select is((select count(*) from public.import_batches)::int, 1, '批次寫入 1 列');
select is((select source_row_count from public.import_batches)::int, 5,
          '來源列數存下來 = 5(與寫入筆數 3 + 2 分開存 —— 兩者不等【本身就是對帳結果】)');
select is((select count(*) from public.trades where import_batch = (select id from t_batch))::int, 3,
          '交易 3 筆帶著批次');
select is((select count(*) from public.cash_flows where import_batch = (select id from t_batch))::int, 2,
          '現金流 2 筆帶著批次');
select is((select count(*) from public.trades where import_batch is null)::int, 1,
          '手動輸入那列的 import_batch 仍為 null');
select is((select note from public.trades where ticker = '2317')::text, null,
          '空字串的 note 存成 null(不是空字串)—— nullif 有生效');
select is((select kind from public.cash_flows order by flow_date limit 1)::text, 'deposit',
          '現金流 kind 逐字帶入');

-- 🔴 數字保真:字面值不經過 IEEE754。
--    12345678901234.5678 若中途變成 double 會成為 …4.568,這一條就會紅。
--    (瀏覽器端的另一半由 tests/import-parse.mjs 的「raw 逐字保留」覆蓋。)
select public.import_paste(1, '{}'::jsonb,
  $j$[{"ticker":"9999","trade_date":"2024-06-01","seq":"1","side":"buy","shares":"1","price":"12345678901234.5678","fee":"0","tax":"0","note":null}]$j$::jsonb,
  '[]'::jsonb);
select is((select price from public.trades where ticker = '9999')::text, '12345678901234.5678',
          '🔴 18 位有效數字逐字落地 —— 字面值沒有經過雙精度');

-- ══════════════════════════════════════════════════════════════════════
-- 二、🔴 原子性
-- ══════════════════════════════════════════════════════════════════════
select is((select count(*) from public.trades)::int, 5, '注入前:A 共 5 筆交易(1 手動 + 3 批次 + 1 保真測試)');
select is((select count(*) from public.import_batches)::int, 2, '注入前:A 共 2 個批次');

-- 壞代號在【第二列】—— 前一列合法,所以「第一列有沒有留下來」才是原子性的關鍵
select throws_ok(
  $$select public.import_paste(2, '{}'::jsonb,
      '[{"ticker":"2330","trade_date":"2024-07-01","seq":"1","side":"buy","shares":"1","price":"1","fee":"0","tax":"0","note":null},
        {"ticker":"BADTICKER","trade_date":"2024-07-02","seq":"2","side":"buy","shares":"1","price":"1","fee":"0","tax":"0","note":null}]'::jsonb,
      '[]'::jsonb)$$,
  '23514', null,
  '🔴 壞代號 → check 約束擋下,整個呼叫拋錯');
select is((select count(*) from public.trades)::int, 5,
          '🔴 原子性:壞列之前的【合法列】也沒有留下來');
select is((select count(*) from public.import_batches)::int, 2,
          '🔴 原子性:批次本身也回滾了(否則會留下一個空批次)');

-- 跨表:交易全合法,現金流的 kind 不合法 → 交易也不能留
select throws_ok(
  $$select public.import_paste(2, '{}'::jsonb,
      '[{"ticker":"2330","trade_date":"2024-08-01","seq":"1","side":"buy","shares":"1","price":"1","fee":"0","tax":"0","note":null}]'::jsonb,
      '[{"flow_date":"2024-08-02","kind":"NOT_A_KIND","amount":"1","ticker":"","note":null}]'::jsonb)$$,
  '23514', null,
  '🔴 現金流的 kind 不在白名單 → 拋錯');
select is((select count(*) from public.trades)::int, 5,
          '🔴 跨表原子性:現金流失敗時,已寫入的交易一併回滾');

-- 日期格式錯誤(cast 失敗)同樣要整批回滾
select throws_ok(
  $$select public.import_paste(1, '{}'::jsonb,
      '[{"ticker":"2330","trade_date":"not-a-date","seq":"1","side":"buy","shares":"1","price":"1","fee":"0","tax":"0","note":null}]'::jsonb,
      '[]'::jsonb)$$,
  null, null,
  '無法轉型的日期 → 拋錯(不是存成 null)');
select is((select count(*) from public.trades)::int, 5, '日期失敗後也沒有殘留');

-- ══════════════════════════════════════════════════════════════════════
-- 三、🔴 隔離:RPC 是 security invoker,不是別人的後門
-- ══════════════════════════════════════════════════════════════════════
select pg_temp.act_as(:'uid_b');

select is((select count(*) from public.import_batches)::int, 0,
          '🔴 B 看不到 A 的任何批次');
select is((select count(*) from public.trades where import_batch is not null)::int, 0,
          '🔴 B 透過 import_batch 欄位也撈不到 A 的交易');

-- B 拿著 A 的批次 id 去撤銷 → 必須拋錯,且 A 的資料完好
select throws_ok(
  format($$select public.undo_import(%L::uuid)$$, (select id from t_batch)),
  'P0001', null,
  '🔴 B 撤銷 A 的批次 → 拋錯(不是靜靜回 0)');

select pg_temp.act_as(:'uid_a');
select is((select count(*) from public.trades where import_batch = (select id from t_batch))::int, 3,
          '🔴 B 撤銷失敗後,A 的 3 筆交易一列不少');

-- B 自己匯入時,列會掛在 B 名下(不可能寫成 A 的 user_id)
select pg_temp.act_as(:'uid_b');
select public.import_paste(1, '{}'::jsonb,
  '[{"ticker":"2603","trade_date":"2024-09-01","seq":"1","side":"buy","shares":"1000","price":"50","fee":"71","tax":"0","note":null}]'::jsonb,
  '[]'::jsonb);
select is((select count(*) from public.trades)::int, 1, 'B 匯入的列掛在 B 名下');
select pg_temp.act_as(:'uid_a');
select is((select count(*) from public.trades)::int, 5, 'A 看不到 B 剛匯入的那列');

-- ══════════════════════════════════════════════════════════════════════
-- 四、撤銷
-- ══════════════════════════════════════════════════════════════════════
select is(
  (select public.undo_import((select id from t_batch)))::jsonb,
  '{"batch": 1, "trades": 3, "cash_flows": 2}'::jsonb,
  '🔴 撤銷回傳【實際刪除筆數】——「撤銷成功」與「撤銷了 3 + 2 筆」是兩件事');

select is((select count(*) from public.trades where import_batch = (select id from t_batch))::int, 0,
          '該批交易已清空');
select is((select count(*) from public.cash_flows)::int, 0, '該批現金流已清空');
select is((select count(*) from public.import_batches where id = (select id from t_batch))::int, 0,
          '批次列本身也刪掉');

-- 🔴 最重要的一條:撤銷不得波及手動輸入的列
select is((select count(*) from public.trades where import_batch is null)::int, 1,
          '🔴 撤銷【不碰】手動輸入的列(import_batch is null)');
select is((select note from public.trades where ticker = '2454')::text, '手動輸入,不屬於任何批次',
          '手動那列內容完好(比對內容,不只比對筆數)');

-- 找不到批次 → 拋錯,而且什麼都不刪
select throws_ok(
  $$select public.undo_import('00000000-0000-0000-0000-000000000000'::uuid)$$,
  'P0001', null,
  '🔴 撤銷不存在的批次 → 拋錯,不是回 0/0/0');
select is((select count(*) from public.trades)::int, 2,
          '🔴 撤銷失敗時一列都沒刪(2 = 手動 1 + 保真測試 1)');

-- cascade:直接刪批次列也會帶走子列(撤銷 RPC 之外的保險絲)
select is((select count(*) from public.trades where import_batch is not null)::int, 1,
          '保真測試那筆仍掛在它自己的批次上');
delete from public.import_batches;
select is((select count(*) from public.trades where import_batch is not null)::int, 0,
          'on delete cascade:直接刪批次 → 子列一併消失');
select is((select count(*) from public.trades)::int, 1,
          'cascade 之後,手動輸入那列依然還在');

-- ══════════════════════════════════════════════════════════════════════
-- 五、權限與結構性斷言
-- ══════════════════════════════════════════════════════════════════════
reset role;

select ok(not has_function_privilege('anon', 'public.import_paste(int, jsonb, jsonb, jsonb, text)', 'EXECUTE'),
          'anon 不得執行 import_paste');
select ok(has_function_privilege('authenticated', 'public.import_paste(int, jsonb, jsonb, jsonb, text)', 'EXECUTE'),
          '對照:authenticated 可以執行(否則上一條的「不得」可能只是函式不存在)');
select ok(not has_table_privilege('anon', 'public.import_batches', 'SELECT'),
          'anon 對 import_batches 沒有 SELECT');

-- 🔴 「不得有白名單外的 security definer 函式」這條斷言必須會咬
\set guard_secdef 'do $$ declare bad text; begin select string_agg(p.proname, \', \') into bad from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace where n.nspname = \'public\' and p.prosecdef and p.proname not in (\'handle_new_user\'); if bad is not null then raise exception \'未經白名單的 security definer 函式:%\', bad; end if; end; $$;'

select lives_ok(:'guard_secdef', '對照:乾淨 schema 上不誤報(否則下一條的紅燈沒有意義)');

create function public._inject_secdef() returns int language sql security definer as $$ select 1 $$;
select throws_ok(:'guard_secdef', 'P0001', null,
          '🔴 注入一支 security definer 函式 → 斷言必須 raise(definer 會繞過 RLS)');
drop function public._inject_secdef();
select lives_ok(:'guard_secdef', '移除注入後回到乾淨 —— 證明剛才的紅燈確實來自注入');

select finish();
rollback;
