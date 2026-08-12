-- 20260812000200_phase2_rls.sql
-- RLS —— 「不做跨使用者統計」的技術落實。
--
-- 🔴 威脅模型(要能回答的問題,不是要背的清單):
--    「另一個已登入使用者,用【任何查詢組合】,能不能讀到這一列?」
--    包括:直接 select、加 where user_id = <對方>、join、子查詢、聚合(count/sum)、
--          透過 view、透過 RETURNING、透過外鍵錯誤訊息推斷存在性。
--    答案必須是「不能」,而且理由要是【資料庫強制】,不是「應用層沒有寫那個查詢」。
--
-- 🔴 失效方向必須 fail closed:
--    - RLS 沒開 → 全表外洩。所以最後有一道【結構性斷言】:public 底下任何一張表
--      沒開 RLS 就直接讓 migration 失敗,而不是等哪天有人發現。
--    - policy 寫錯方向(using vs with check)→ 讀得到別人 / 寫得進別人。兩者都要測。
--    - anon 有 grant → 未登入就讀得到。所以明確 revoke。
--
-- ⚠️ 本檔【不覆寫】專案的「新表自動 RLS + 不自動暴露」設定:
--    這裡是逐表【明確啟用】RLS(與專案預設同向、可重複執行),
--    並且只 grant 給 authenticated,anon 一律 revoke。

-- ── 逐表啟用 RLS ───────────────────────────────────────────────────
alter table public.profiles    enable row level security;
alter table public.trades      enable row level security;
alter table public.cash_flows  enable row level security;
alter table public.watchlist   enable row level security;
alter table public.preferences enable row level security;

-- 🔴 連表的擁有者自己也不例外。預設 table owner 會【繞過】RLS,
--    而 migration 建的表擁有者常常就是應用連線用的角色 → 那等於沒開。
alter table public.profiles    force row level security;
alter table public.trades      force row level security;
alter table public.cash_flows  force row level security;
alter table public.watchlist   force row level security;
alter table public.preferences force row level security;

-- ── 權限:anon 一格都不給,authenticated 靠 RLS 限制到自己的列 ───────
-- 🔴 anon 與 PUBLIC 都要 revoke:授權給 PUBLIC 時 anon 一樣會繼承,
--    只 revoke anon 會留下一個「檢查通過但實際有洞」的狀態。
revoke all on public.profiles, public.trades, public.cash_flows,
              public.watchlist, public.preferences
  from anon, public;

grant select, insert, update, delete
  on public.trades, public.cash_flows, public.watchlist
  to authenticated;
grant select, insert, update on public.profiles, public.preferences to authenticated;

-- id 是 identity 欄,不需要序列權限(generated always as identity 由系統維護)。

-- ── Policy:自己的列,讀寫都是 ─────────────────────────────────────
-- 🔴 using 管【讀得到哪些既有列】(select/update/delete 的可見性),
--    with check 管【寫進去的列長什麼樣】(insert/update 後的值)。
--    只寫 using 會讓使用者能【插入 user_id = 別人】的列 —— 自己看不到,但污染對方的資料。
--    兩個都要,而且測試要分開測。

drop policy if exists profiles_own on public.profiles;
create policy profiles_own on public.profiles
  for all to authenticated
  using ((select auth.uid()) = id)
  with check ((select auth.uid()) = id);

drop policy if exists trades_own on public.trades;
create policy trades_own on public.trades
  for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists cash_flows_own on public.cash_flows;
create policy cash_flows_own on public.cash_flows
  for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists watchlist_own on public.watchlist;
create policy watchlist_own on public.watchlist
  for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists preferences_own on public.preferences;
create policy preferences_own on public.preferences
  for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

-- ⚠️ 為什麼寫 `(select auth.uid())` 而不是 `auth.uid()`:
--    包成子查詢會被 Postgres 當成 InitPlan 求值【一次】,而不是逐列呼叫。
--    這是 Supabase 官方的 RLS 效能建議;在 trades 這種會長到數萬列的表上差距明顯。
--    語意完全相同 —— 這是效能寫法,不是安全性取巧。

-- ── 註冊時自動建立 profile ─────────────────────────────────────────
-- security definer 是必要的:觸發時的角色沒有 public.profiles 的寫入權限。
-- 🔴 security definer 的函式一律要釘 search_path,否則呼叫端可劫持物件解析。
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'full_name', ''))
  on conflict (id) do nothing;
  return new;
end;
$$;

-- 🔴 security definer 函式的 EXECUTE 預設是給 PUBLIC 的 —— 那等於開了一扇
--    繞過 RLS 的門(任何人都能以函式擁有者的權限執行它)。只留給觸發器用。
revoke all on function public.handle_new_user() from public, anon, authenticated;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ── 🔴 結構性斷言:public 底下不得有【沒開 RLS】的表 ─────────────────
-- 這一條的價值不在於「這五張表有 RLS」(逐表列舉,下一張新表就漏了),
-- 而在於「這個 schema 裡【不可能】存在沒開 RLS 的表」。
-- 它在 migration 當下就失敗,而不是等到某天有人發現資料外洩。
do $$
declare
  bad text;
begin
  select string_agg(c.relname, ', ' order by c.relname)
    into bad
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relkind = 'r'
    and not c.relrowsecurity;

  if bad is not null then
    raise exception
      'public 底下有未啟用 RLS 的表:% —— 失效方向是【全表外洩】,拒絕套用。'
      '新增表時必須同時 enable + force row level security 並補上 policy。', bad;
  end if;
end;
$$;

-- 同上:開了 RLS 卻【一條 policy 都沒有】= 該表對所有人回空,
-- 那是 fail closed(安全)但功能壞掉,而且很難查 —— 讓它在套用當下就講出來。
do $$
declare
  bad text;
begin
  select string_agg(c.relname, ', ' order by c.relname)
    into bad
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relkind = 'r'
    and c.relrowsecurity
    and not exists (select 1 from pg_policy p where p.polrelid = c.oid);

  if bad is not null then
    raise exception '這些表開了 RLS 但沒有任何 policy(會對所有人回空):%', bad;
  end if;
end;
$$;
