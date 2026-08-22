-- rls_isolation.test.sql — 跑法:supabase test db
--
-- 🔴 這份不是「policy 有沒有寫」的檢查,是【威脅模型的可執行版本】:
--    兩個真的使用者、互相用各種查詢組合去撈對方的資料,必須全部撈不到。
--    包含最容易被漏掉的那條:**透過 view**(view 預設繞過底層 RLS)。
--
-- 🔴 還有三條【結構性】斷言 —— 它們守的不是這五張表,而是
--    「這個 schema 裡【不可能】出現沒開 RLS 的表 / 沒有 policy 的表 /
--      沒設 security_invoker 的 view」。逐表列舉的檢查,下一張新表就漏了。

begin;
create extension if not exists pgtap with schema extensions;
select plan(29);

-- ── 準備:兩個使用者 ────────────────────────────────────────────────
\set uid_a '11111111-1111-1111-1111-111111111111'
\set uid_b '22222222-2222-2222-2222-222222222222'

insert into auth.users (id, email)
values (:'uid_a', 'a@example.test'), (:'uid_b', 'b@example.test');

-- 種資料【以使用者自己的身分】寫入 —— 順便就驗到了 insert 的 with check。
create or replace function pg_temp.act_as(p_uid text) returns void
language plpgsql as $$
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
end;
$$;

select pg_temp.act_as(:'uid_a');
insert into public.trades (user_id, ticker, trade_date, seq, side, shares, price, fee, tax)
values (:'uid_a', '2330', '2026-01-05', 0, 'buy',  1000, 100, 142.5, 0),
       (:'uid_a', '2330', '2026-02-10', 0, 'buy',  1000, 110, 156.75, 0),
       (:'uid_a', '2330', '2026-03-15', 0, 'sell', 1500, 120, 256.5, 540);
insert into public.cash_flows (user_id, flow_date, kind, amount)
values (:'uid_a', '2026-01-02', 'deposit', 500000);
insert into public.watchlist (user_id, ticker) values (:'uid_a', '2454');

select pg_temp.act_as(:'uid_b');
insert into public.trades (user_id, ticker, trade_date, seq, side, shares, price, fee, tax)
values (:'uid_b', '2454', '2026-01-08', 0, 'buy', 2000, 900, 2565, 0),
       (:'uid_b', '2454', '2026-04-01', 0, 'buy',  500, 950,  676.875, 0);
insert into public.cash_flows (user_id, flow_date, kind, amount)
values (:'uid_b', '2026-01-03', 'deposit', 3000000);

-- ── A 的視角 ────────────────────────────────────────────────────────
select pg_temp.act_as(:'uid_a');

select is((select count(*) from public.trades)::int, 3,
          'A 看到自己的 3 筆交易');
select is((select count(*) from public.trades where user_id = :'uid_b'::uuid)::int, 0,
          'A 明確指定 B 的 user_id 也撈不到任何一列');
select is((select count(distinct user_id) from public.trades)::int, 1,
          '聚合查詢只看得到一個 user_id —— 跨使用者統計在結構上不可能');
select is((select coalesce(sum(shares), 0) from public.trades)::numeric, 3500::numeric,
          'sum() 只加總得到自己的列(B 的 2,500 股沒有被算進去)');
select is((select count(*) from public.cash_flows)::int, 1,
          'A 的 cash_flows 只有自己那筆');
select is((select count(*) from public.watchlist)::int, 1,
          'A 的 watchlist 只有自己那筆');
select is((select count(*) from public.profiles)::int, 1,
          'A 只看得到自己的 profile(註冊觸發器建的)');

-- 子查詢 / join 也不能繞過
select is((select count(*) from public.trades t
            where exists (select 1 from public.profiles p where p.id = t.user_id))::int, 3,
          '用 join/子查詢串 profiles 也只看得到自己的列');

-- ── 🔴 view 的隔離(最容易漏的一條)────────────────────────────────
select is((select count(*) from public.v_holdings)::int, 1,
          'A 透過 v_holdings 只看到自己的持倉');
select is((select count(*) from public.v_holdings where ticker = '2454')::int, 0,
          '🔴 A 透過 view 撈不到 B 的 2454 持倉(view 若沒設 security_invoker,這裡會是 1)');
select is((select count(*) from public.v_realized_lots)::int, 2,
          'A 透過 v_realized_lots 只看到自己的配對明細');
select is((select count(*) from public.v_cash_flow_total)::int, 1,
          'A 透過 v_cash_flow_total 只看到自己的現金流合計');
select is((select count(*) from public.v_trade_lots)::int, 3,
          'A 透過中介 view v_trade_lots 也只看到自己的列');

-- ── 寫入方向:with check ────────────────────────────────────────────
select throws_ok(
  format($$insert into public.trades (user_id, ticker, trade_date, side, shares, price)
           values (%L, '1101', '2026-05-01', 'buy', 100, 50)$$, :'uid_b'),
  '42501', null,
  'A 不能插入 user_id = B 的列(否則可污染對方資料,而且自己看不見)');

select throws_ok(
  format($$update public.trades set user_id = %L where ticker = '2330'$$, :'uid_b'),
  '42501', null,
  'A 不能把自己的列改成 B 的(with check 擋下)');

-- ⚠️ 改資料的 CTE 只能掛在【最外層】的 SELECT;寫成 FROM 裡的子查詢是無效語法。
with deleted as (
  delete from public.trades where user_id = :'uid_b'::uuid returning 1
)
select is((select count(*)::int from deleted), 0,
          'A 刪除 B 的列影響 0 列(using 讓那些列根本不可見)');

-- ── B 的視角:對稱驗證 ──────────────────────────────────────────────
select pg_temp.act_as(:'uid_b');

select is((select count(*) from public.trades)::int, 2,
          'B 看到自己的 2 筆交易');
select is((select count(*) from public.trades where ticker = '2330')::int, 0,
          'B 撈不到 A 的 2330');
select is((select count(*) from public.v_holdings where ticker = '2330')::int, 0,
          '🔴 B 透過 view 撈不到 A 的 2330 持倉');
select is((select coalesce(sum(flow_total), 0) from public.v_cash_flow_total)::numeric, 3000000::numeric,
          'B 的現金餘額不含 A 的 500,000');
select is((select count(*) from public.trades where id in
             (select id from public.trades))::int, 2,
          'B 用自我子查詢也擴大不了可見範圍');

-- ── 未登入(anon)────────────────────────────────────────────────────
reset role;
select set_config('request.jwt.claims', null, true);
set local role anon;

select throws_ok($$select count(*) from public.trades$$, '42501', null,
                 'anon 對 trades 連 SELECT 權限都沒有(不是「回 0 列」,是直接拒絕)');
select throws_ok($$select count(*) from public.v_holdings$$, '42501', null,
                 'anon 對 v_holdings 也沒有 SELECT 權限');

reset role;

-- ── 🔴 結構性斷言:守的是 schema,不是這幾張表 ────────────────────────
select is(
  (select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity),
  0, '🔴 public 底下沒有任何一張表少了 RLS(新增表漏開 = 全表外洩)');

select is(
  (select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r' and not c.relforcerowsecurity),
  0, '🔴 public 底下每張表都 force RLS(表擁有者預設會繞過 RLS)');

select is(
  (select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity
      and not exists (select 1 from pg_policy p where p.polrelid = c.oid)),
  0, 'public 底下沒有「開了 RLS 卻沒有任何 policy」的表(會對所有人回空)');

select is(
  (select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'v'
      and coalesce((select option_value from pg_options_to_table(c.reloptions)
                     where option_name = 'security_invoker'), 'false') <> 'true'),
  0, '🔴 public 底下每個 view 都設了 security_invoker(否則 view 會繞過底層 RLS)');

-- ⚠️ 只查 grantee = 'anon' 會漏掉授權給 PUBLIC 的情況 —— anon 一樣會繼承,
--    那時這條檢查會【在有洞的情況下通過】。兩者都要查。
select is(
  (select count(*)::int
     from information_schema.role_table_grants
    where table_schema = 'public' and grantee in ('anon', 'PUBLIC')),
  0, '🔴 public 底下對 anon 或 PUBLIC 都沒有任何授權(未登入者一格都讀不到)');

-- 函式也一樣:預設 EXECUTE 是給 PUBLIC 的,security definer 函式若沒 revoke
-- 等於開了一扇繞過 RLS 的門。handle_new_user 是 security definer,必須擋住。
--
-- ⚠️ 排除【回傳 event_trigger】的函式:那種函式 PostgreSQL 不允許直接呼叫,
--    EXECUTE 權限不可利用。線上的專案層機制 `rls_auto_enable`(新表自動 RLS)
--    正是這一類,而它不是我們的東西、也不該被我們 revoke。
--    🔴 這個放寬是用【性質】(回傳型別)而不是【名字】—— 名字白名單會祝福掉錯的東西。
--    guards_bite.test.sql 有三條測試證明:(a) event_trigger 函式真的叫不動、
--    (b) 舊判準會誤報、(c) 新判準對【可直接呼叫】的 security definer 函式仍然會抓。
select is(
  (select count(*)::int
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prosecdef
      and p.prorettype <> 'pg_catalog.event_trigger'::regtype
      and has_function_privilege('anon', p.oid, 'EXECUTE')),
  0, '🔴 anon 不能執行任何【可直接呼叫的】security definer 函式(繞過 RLS 的門)');

select * from finish();
rollback;
