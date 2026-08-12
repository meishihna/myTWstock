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
select plan(11);

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

select * from finish();
rollback;
