-- verify_online.sql — 【只讀】套用到線上之後跑這一支,拿實際數字 + 違規清單。
--
-- 🔴 為什麼非跑不可:測試環境成功【不能推論到正式環境】。
--    pg 版本、既有 schema、角色權限、專案層設定(自動 RLS / 自動暴露)都可能不同,
--    而本機的 56 項全過只證明「在本機那個 pg 上成立」。
--
-- 驗收判準:**回傳結果中 section = 'VIOLATION' 的列數必須為 0。**
--
-- ⚠️ 責任分工:
--    · fail closed(套用當下就拒絕)由 migration 內的 `do … raise exception` 負責 ——
--      `supabase db push` 成功本身就代表那六條斷言在線上成立。
--    · 本檔只負責【拿到實際數字】與【把違規列出來】,不負責中止流程。
--
-- ⚠️ 【單一語句、純 SQL】—— 這是刻意的,踩過兩次才對:
--    1. 第一版用 `\echo`:那是 psql 專屬語法,Management API 與 Dashboard SQL Editor
--       都會直接語法錯誤。
--    2. 第二版是「DO 區塊 + SELECT」兩個語句:`supabase db query` 走 prepared statement,
--       回 `cannot insert multiple commands into a prepared statement`。
--    現在是一個 select,三種環境都吃:
--       supabase db query --linked -f supabase/verify_online.sql
--       Supabase Dashboard → SQL Editor(貼上全文)
--       psql -f
--    (兩個問題都是先在本機跑才發現的 —— 要在線上跑的腳本不能是沒驗過的。)

with
-- ── 六條結構性違規(任何一列出現就是問題)────────────────────────────
v_no_rls as (
  select 'VIOLATION' as section, '① 未啟用 RLS 的表(全表外洩)' as item, c.relname as value
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity
),
v_no_force as (
  select 'VIOLATION', '② 未 force RLS 的表(擁有者繞過)', c.relname
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'r' and not c.relforcerowsecurity
),
v_no_policy as (
  select 'VIOLATION', '③ 開了 RLS 卻沒 policy(對所有人回空)', c.relname
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity
     and not exists (select 1 from pg_policy p where p.polrelid = c.oid)
),
v_bad_view as (
  select 'VIOLATION', '④ 未設 security_invoker 的 view(繞過底層 RLS)', c.relname
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'v'
     and coalesce((select option_value from pg_options_to_table(c.reloptions)
                    where option_name = 'security_invoker'), 'false') <> 'true'
),
v_grant as (
  select distinct 'VIOLATION', '⑤ anon/PUBLIC 有表級授權', grantee || ':' || table_name
    from information_schema.role_table_grants
   where table_schema = 'public' and grantee in ('anon', 'PUBLIC')
),
v_secdef as (
  -- ⚠️ 排除【回傳 event_trigger】的函式:PostgreSQL 不允許直接呼叫這種函式,
  --    EXECUTE 權限不可利用。線上的專案層機制 rls_auto_enable(新表自動 RLS)正是這一類,
  --    它不是我們的東西、也不該被我們 revoke。
  --    🔴 放寬是用【性質】(回傳型別)不是【名字】——名字白名單會祝福掉錯的東西。
  --    guards_bite.test.sql 有三條測試證明這個放寬沒有變成失明。
  select 'VIOLATION', '⑥ anon 可執行的 security definer 函式(可直接呼叫者)', p.proname
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.prosecdef
     and p.prorettype <> 'pg_catalog.event_trigger'::regtype
     and has_function_privilege('anon', p.oid, 'EXECUTE')
),
-- ── 實際數字 ────────────────────────────────────────────────────────
c_counts as (
  select 'count' as section, 'tables' as item, count(*)::text as value
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'r'
  union all
  select 'count', 'views', count(*)::text
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'v'
  union all
  select 'count', 'policies', count(*)::text
    from pg_policy p join pg_class c on c.oid = p.polrelid
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public'
  union all
  select 'count', 'functions', count(*)::text
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
  union all
  select 'count', 'grants_to_anon_or_public', count(*)::text
    from information_schema.role_table_grants
   where table_schema = 'public' and grantee in ('anon', 'PUBLIC')
  union all
  select 'count', 'secdef_callable_by_anon', count(*)::text
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.prosecdef
     and p.prorettype <> 'pg_catalog.event_trigger'::regtype
     and has_function_privilege('anon', p.oid, 'EXECUTE')
  union all
  select 'count', 'secdef_evtrig_fn(不可直接呼叫,不計入違規)', count(*)::text
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.prosecdef
     and p.prorettype = 'pg_catalog.event_trigger'::regtype
),
c_tables as (
  select 'table', c.relname,
         'rls=' || c.relrowsecurity || ' force=' || c.relforcerowsecurity ||
         ' policies=' || (select count(*) from pg_policy p where p.polrelid = c.oid)
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'r'
),
c_views as (
  select 'view', c.relname,
         'security_invoker=' ||
         coalesce((select option_value from pg_options_to_table(c.reloptions)
                    where option_name = 'security_invoker'), 'false')
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'v'
),
c_rows as (
  select 'rows', 'trades',      count(*)::text from public.trades
  union all select 'rows', 'cash_flows',  count(*)::text from public.cash_flows
  union all select 'rows', 'profiles',    count(*)::text from public.profiles
  union all select 'rows', 'watchlist',   count(*)::text from public.watchlist
  union all select 'rows', 'preferences', count(*)::text from public.preferences
),
all_rows as (
  select * from v_no_rls   union all select * from v_no_force
  union all select * from v_no_policy union all select * from v_bad_view
  union all select * from v_grant  union all select * from v_secdef
  union all select * from c_counts union all select * from c_tables
  union all select * from c_views  union all select * from c_rows
)
select case section when 'VIOLATION' then 0 when 'count' then 1
                   when 'table' then 2 when 'view' then 3 else 4 end as ord,
       section, item, value
  from all_rows
 order by ord, item;
