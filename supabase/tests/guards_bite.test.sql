-- guards_bite.test.sql — 跑法:supabase test db
--
-- 🔴 結構性斷言如果沒被證明「會咬」,它就只是裝飾。
--    這份故意製造三種違規,每一種都必須同時讓
--      (a) 測試形式的斷言(count > 0)
--      (b) migration 形式的斷言(do $$ … raise exception)
--    紅燈。兩種形式都要測 —— 它們是不同的程式碼路徑,壞掉的方式也不同。
--
-- ⚠️ 全程在交易內建立/刪除臨時物件,最後 rollback,不留痕跡。

begin;
create extension if not exists pgtap with schema extensions;
select plan(16);

-- ── 三條結構性查詢(與 migration / rls_isolation 內的完全一致)────────
create or replace function pg_temp.n_no_rls() returns int language sql as $$
  select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity;
$$;

create or replace function pg_temp.n_rls_no_policy() returns int language sql as $$
  select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity
     and not exists (select 1 from pg_policy p where p.polrelid = c.oid);
$$;

create or replace function pg_temp.n_bad_view() returns int language sql as $$
  select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'v'
     and coalesce((select option_value from pg_options_to_table(c.reloptions)
                    where option_name = 'security_invoker'), 'false') <> 'true';
$$;

-- migration 內的守門(逐字搬過來,證明的是【那段程式碼】會 raise)
\set guard_rls 'do $$ declare bad text; begin select string_agg(c.relname, \', \') into bad from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = \'public\' and c.relkind = \'r\' and not c.relrowsecurity; if bad is not null then raise exception \'public 底下有未啟用 RLS 的表:%\', bad; end if; end; $$;'
\set guard_pol 'do $$ declare bad text; begin select string_agg(c.relname, \', \') into bad from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = \'public\' and c.relkind = \'r\' and c.relrowsecurity and not exists (select 1 from pg_policy p where p.polrelid = c.oid); if bad is not null then raise exception \'開了 RLS 卻沒有 policy:%\', bad; end if; end; $$;'
\set guard_view 'do $$ declare bad text; begin select string_agg(c.relname, \', \') into bad from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = \'public\' and c.relkind = \'v\' and coalesce((select option_value from pg_options_to_table(c.reloptions) where option_name = \'security_invoker\'), \'false\') <> \'true\'; if bad is not null then raise exception \'view 未設 security_invoker:%\', bad; end if; end; $$;'

-- ── 基準:注入前必須是乾淨的 ────────────────────────────────────────
-- (若基準就不是 0,下面的「注入後 > 0」就沒有鑑別力 —— 那是空跑)
select is(pg_temp.n_no_rls(), 0, '基準:目前沒有缺 RLS 的表');
select is(pg_temp.n_rls_no_policy(), 0, '基準:目前沒有「開了 RLS 卻沒 policy」的表');
select is(pg_temp.n_bad_view(), 0, '基準:目前沒有缺 security_invoker 的 view');
select lives_ok(:'guard_rls', '基準:migration 的 RLS 守門在乾淨 schema 上不會誤報');

-- ── 注入 ①:一張沒開 RLS 的表 ───────────────────────────────────────
create table public._inject_no_rls (id int);

select ok(pg_temp.n_no_rls() > 0,
          '🔴 注入「沒開 RLS 的表」→ 結構性查詢必須看到它');
select throws_ok(:'guard_rls', 'P0001', null,
          '🔴 注入「沒開 RLS 的表」→ migration 的守門必須 raise(否則會被套用上線)');

drop table public._inject_no_rls;
select is(pg_temp.n_no_rls(), 0, '移除注入後回到乾淨(證明剛才的紅燈確實來自注入)');

-- ── 注入 ②:開了 RLS 但沒有任何 policy ──────────────────────────────
create table public._inject_rls_no_policy (id int);
alter table public._inject_rls_no_policy enable row level security;

select ok(pg_temp.n_rls_no_policy() > 0,
          '注入「開 RLS 但沒 policy」→ 結構性查詢必須看到它(該表會對所有人回空)');
select throws_ok(:'guard_pol', 'P0001', null,
          '注入「開 RLS 但沒 policy」→ migration 的守門必須 raise');

drop table public._inject_rls_no_policy;

-- ── 注入 ③:一個沒設 security_invoker 的 view ───────────────────────
-- 這是最重要的一條:這種 view 會【繞過底層表的 RLS】,而表的 RLS 測起來全綠。
create view public._inject_bad_view as select 1 as x;

select ok(pg_temp.n_bad_view() > 0,
          '🔴 注入「沒設 security_invoker 的 view」→ 結構性查詢必須看到它');
select throws_ok(:'guard_view', 'P0001', null,
          '🔴 注入「沒設 security_invoker 的 view」→ migration 的守門必須 raise');

drop view public._inject_bad_view;

-- ── 🔴 判準的放寬必須被證明「沒有把真的洞一起放過」────────────────────
-- 背景:線上比本機多一個函式 `rls_auto_enable` —— 那是【專案層的「新表自動 RLS」機制】,
--   security definer、ACL 是預設(PUBLIC 可執行),所以「anon 可執行 security definer 函式」
--   這條斷言在線上會紅。
--   它的回傳型別是 `event_trigger`,而 PostgreSQL【不允許直接呼叫】這種函式 ——
--   所以那個 EXECUTE 權限實際上不可利用。
--
-- 🔴 但「我知道 Postgres 這樣設計」不是證據。放寬判準要做三件事,缺一不可:
--    (a) 證明那個性質為真(anon 真的呼叫不動 event_trigger 函式)
--    (b) 用【性質】放寬,不是用【名字】放寬(名字白名單會祝福掉錯的東西)
--    (c) 證明放寬後,真的洞(可直接呼叫的 security definer 函式)【仍然】會被抓

create function public._inject_evtrig() returns event_trigger
  language plpgsql security definer as $$ begin end; $$;
create function public._inject_callable() returns int
  language sql security definer as $$ select 1 $$;
-- 兩者的 EXECUTE 都是預設(PUBLIC 可執行),不額外 grant —— 與線上那個函式同條件。

-- (a) 性質:event_trigger 函式無法被直接呼叫,連 postgres 也不行
select throws_ok($$select public._inject_evtrig()$$, null, null,
  '🔴 event_trigger 函式無法被直接呼叫 —— 這是放寬判準的【唯一】理由');
-- 對照:可直接呼叫的那個確實叫得動(證明上一條不是因為函式壞掉)
select lives_ok($$select public._inject_callable()$$,
  '對照:普通 security definer 函式叫得動(上一條的失敗來自型別,不是函式本身)');

-- (b)(c) 舊判準:兩個都會被抓 —— 所以它會在線上誤報
select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prosecdef
      and has_function_privilege('anon', p.oid, 'EXECUTE')
      and p.proname like '\_inject\_%'),
  2, '舊判準會同時抓到兩個(所以它在線上對 rls_auto_enable 誤報)');

-- 新判準:排除【回傳 event_trigger】的,但可直接呼叫的那個必須【仍然被抓】
select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prosecdef
      and has_function_privilege('anon', p.oid, 'EXECUTE')
      and p.prorettype <> 'pg_catalog.event_trigger'::regtype
      and p.proname like '\_inject\_%'),
  1, '🔴 新判準只放過 event_trigger 那個;可直接呼叫的【仍然被抓】(放寬沒有變成失明)');

select is(
  (select string_agg(p.proname, ',') from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prosecdef
      and has_function_privilege('anon', p.oid, 'EXECUTE')
      and p.prorettype <> 'pg_catalog.event_trigger'::regtype
      and p.proname like '\_inject\_%'),
  '_inject_callable', '被抓到的正是那個可直接呼叫的(指名,不只是數量對)');

drop function public._inject_evtrig();
drop function public._inject_callable();

select * from finish();
rollback;
