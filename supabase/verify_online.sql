-- verify_online.sql — 【只讀 + 斷言】套用到線上之後跑這一支。
--
-- 🔴 為什麼非跑不可:測試環境成功【不能推論到正式環境】。
--    pg 版本、既有 schema、角色權限、專案層設定(自動 RLS / 自動暴露)都可能不同,
--    而本機的 56 項全過只證明「在本機那個 pg 上成立」。
--
-- ⚠️ 這支【不修改任何東西】:只有 select 與 do $$ … raise。可以反覆跑。
--    任何一條斷言不成立就拋出 → 立刻知道線上與預期不符,而不是等哪天資料外洩。
--
-- 跑法(link 完成後):
--   npx --yes supabase@latest db push        # 套用 migrations(其中已內建同樣的斷言)
--   然後把本檔內容送到線上 DB 執行(見 README 的「套用前的檢查清單」)

\echo '=== 1. 實際物件數量 ==='

select 'tables' as kind, count(*) as n
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and c.relkind = 'r'
union all
select 'views', count(*)
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and c.relkind = 'v'
union all
select 'policies', count(*)
  from pg_policy p join pg_class c on c.oid = p.polrelid
  join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public'
union all
select 'functions', count(*)
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public'
order by 1;

\echo ''
\echo '=== 2. 逐表:RLS / force / policy 數 ==='

select c.relname                                     as table_name,
       c.relrowsecurity                              as rls,
       c.relforcerowsecurity                         as forced,
       (select count(*) from pg_policy p where p.polrelid = c.oid) as policies
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and c.relkind = 'r'
 order by c.relname;

\echo ''
\echo '=== 3. 逐檢視:security_invoker ==='

select c.relname as view_name,
       coalesce((select option_value from pg_options_to_table(c.reloptions)
                  where option_name = 'security_invoker'), 'false') as security_invoker
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and c.relkind = 'v'
 order by c.relname;

\echo ''
\echo '=== 4. anon / PUBLIC 的授權(必須為空)==='

select grantee, table_name, privilege_type
  from information_schema.role_table_grants
 where table_schema = 'public' and grantee in ('anon', 'PUBLIC')
 order by grantee, table_name, privilege_type;

\echo ''
\echo '=== 5. 結構性斷言(任何一條不成立就拋出)==='

do $$
declare bad text;
begin
  -- ① 沒開 RLS 的表 = 全表外洩
  select string_agg(c.relname, ', ' order by c.relname) into bad
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity;
  if bad is not null then
    raise exception '線上有未啟用 RLS 的表:%', bad;
  end if;

  -- ② 沒 force = 表擁有者繞過 RLS
  select string_agg(c.relname, ', ' order by c.relname) into bad
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'r' and not c.relforcerowsecurity;
  if bad is not null then
    raise exception '線上有未 force RLS 的表(擁有者會繞過):%', bad;
  end if;

  -- ③ 開了 RLS 卻沒 policy = 對所有人回空
  select string_agg(c.relname, ', ' order by c.relname) into bad
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity
     and not exists (select 1 from pg_policy p where p.polrelid = c.oid);
  if bad is not null then
    raise exception '線上有「開了 RLS 卻沒 policy」的表:%', bad;
  end if;

  -- ④ view 沒設 security_invoker = 繞過底層 RLS(表的 RLS 會測起來全綠)
  select string_agg(c.relname, ', ' order by c.relname) into bad
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'v'
     and coalesce((select option_value from pg_options_to_table(c.reloptions)
                    where option_name = 'security_invoker'), 'false') <> 'true';
  if bad is not null then
    raise exception '線上有未設 security_invoker 的 view:%', bad;
  end if;

  -- ⑤ anon / PUBLIC 不得有任何表級授權
  select string_agg(distinct grantee || ':' || table_name, ', ') into bad
    from information_schema.role_table_grants
   where table_schema = 'public' and grantee in ('anon', 'PUBLIC');
  if bad is not null then
    raise exception '線上 anon/PUBLIC 有表級授權:%', bad;
  end if;

  -- ⑥ anon 不得能執行任何 security definer 函式
  select string_agg(p.proname, ', ' order by p.proname) into bad
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.prosecdef
     and has_function_privilege('anon', p.oid, 'EXECUTE');
  if bad is not null then
    raise exception 'anon 可執行 security definer 函式(繞過 RLS 的門):%', bad;
  end if;

  raise notice '✅ 六條結構性斷言全部成立';
end;
$$;

\echo ''
\echo '=== 6. 空資料庫確認(Phase 2 尚未有使用者)==='

select 'trades' as t, count(*) from public.trades
union all select 'cash_flows', count(*) from public.cash_flows
union all select 'profiles',   count(*) from public.profiles
union all select 'watchlist',  count(*) from public.watchlist
order by 1;
