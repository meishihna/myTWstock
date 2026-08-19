-- 20260819000100_import_batches.sql
-- 可撤銷的整批匯入 —— 貼上 → 預覽 → 確認 → 寫入 → 可整批撤銷。
--
-- 🔴 這支 migration 要成立的三件事,缺一都不算「可信任的匯入」:
--   ① **原子性**:一次匯入寫三張表(批次 + trades + cash_flows)。
--      PostgREST 一次 insert 只是一個 statement → 三次呼叫就是三個交易。
--      「寫壞了再刪掉」不是原子性,是善後 —— 網路中斷在第二步時,
--      使用者會得到一半的持股而且不知道少了什麼。所以走 RPC,一個交易。
--   ② **不繞過 RLS**:RPC 一律 `security invoker`。
--      🔴 若寫成 `security definer`,這個函式就成了全站唯一一個能寫別人資料的入口,
--      上一輪線上驗到的跨帳號隔離會從「資料庫強制」退化成「函式裡沒寫錯」。
--      **`security definer` 在本檔是禁止的,不是不建議。**
--   ③ **可撤銷**:每一列都帶 `import_batch`,撤銷 = 依批次刪除,同樣一個交易。
--
-- 🔴 數字一律以【字串】傳入再由 Postgres 轉 numeric。
--    瀏覽器端把儲存格解析成 JS `number` 就進了 IEEE754;既然費用是【逐字匯入不重算】,
--    那個字面值就不該在半路變成 double。原始字串直送,十進位轉換交給資料庫。
--    (同一條鐵律的延伸:DB 只存數、不算數;而 JS 不該替 DB 先算一次。)

-- ── 批次 ───────────────────────────────────────────────────────────
create table if not exists public.import_batches (
  id               uuid        primary key default gen_random_uuid(),
  user_id          uuid        not null references auth.users (id) on delete cascade,
  source           text        not null default 'paste' check (source in ('paste')),
  source_row_count int         not null check (source_row_count >= 0),
  stats            jsonb       not null default '{}'::jsonb,
  note             text,
  created_at       timestamptz not null default now()
);

comment on table public.import_batches is
  '一次貼上匯入的批次。存在的理由是【可撤銷】與【事後可對帳】,不是紀錄用途。';
comment on column public.import_batches.source_row_count is
  '來源實際列數(不含表頭)。與寫入筆數分開存:兩者不相等本身就是對帳結果的一部分 —— DEPOSIT 列會進 cash_flows 而不是 trades,所以「41 列 → 39 筆交易 + 2 筆現金流」是正確的,「41 列 → 41 筆交易」才是錯的。';
comment on column public.import_batches.stats is
  '匯入當下的對帳數字(來源列數/交易/現金流/Σ Cash_Impact 等)。快照的用途是【日後能發現不一致】,不是拿來當真相 —— 真相永遠是 trades + cash_flows 本身。';

create index if not exists import_batches_user_created_idx
  on public.import_batches (user_id, created_at desc);

-- ── 兩張資料表掛上批次 ─────────────────────────────────────────────
-- nullable:手動輸入的列沒有批次,那是正常狀態,不是缺資料。
-- on delete cascade:刪批次 = 撤銷整批。這是本欄存在的目的。
alter table public.trades
  add column if not exists import_batch uuid
  references public.import_batches (id) on delete cascade;

alter table public.cash_flows
  add column if not exists import_batch uuid
  references public.import_batches (id) on delete cascade;

comment on column public.trades.import_batch is
  '來自哪一次匯入;手動輸入為 null。null 不是缺資料,是「這列不是匯入來的」。';

create index if not exists trades_import_batch_idx     on public.trades (import_batch) where import_batch is not null;
create index if not exists cash_flows_import_batch_idx on public.cash_flows (import_batch) where import_batch is not null;

-- ── RLS(不加這段,20260812000200 的結構性斷言會讓 migration 失敗)──
alter table public.import_batches enable row level security;
alter table public.import_batches force  row level security;

revoke all on public.import_batches from anon, public;
grant select, insert, delete on public.import_batches to authenticated;
-- 不給 update:批次是既成事實。要改就撤銷重匯,不要就地編輯一個「紀錄」。

drop policy if exists import_batches_own on public.import_batches;
create policy import_batches_own on public.import_batches
  for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

-- ── 匯入:一個交易寫完三張表 ───────────────────────────────────────
create or replace function public.import_paste(
  p_source_row_count int,
  p_stats            jsonb,
  p_trades           jsonb,
  p_cash_flows       jsonb,
  p_note             text default null
) returns uuid
language plpgsql
security invoker              -- 🔴 不是 definer。見檔頭 ②。
set search_path = ''
as $$
declare
  v_uid   uuid := (select auth.uid());
  v_batch uuid;
begin
  if v_uid is null then
    raise exception '未登入,拒絕匯入' using errcode = '28000';
  end if;

  insert into public.import_batches (user_id, source, source_row_count, stats, note)
  values (v_uid, 'paste', p_source_row_count, coalesce(p_stats, '{}'::jsonb), p_note)
  returning id into v_batch;

  -- 🔴 全部欄位以 text 收再 cast:數字不經過 JS 的 double,日期不經過時區。
  insert into public.trades
    (user_id, ticker, trade_date, seq, side, shares, price, fee, tax, note, import_batch)
  select
    v_uid, x.ticker, x.trade_date::date, x.seq::int, x.side,
    x.shares::numeric, x.price::numeric, x.fee::numeric, x.tax::numeric,
    nullif(x.note, ''), v_batch
  from pg_catalog.jsonb_to_recordset(coalesce(p_trades, '[]'::jsonb)) as x(
    ticker text, trade_date text, seq text, side text,
    shares text, price text, fee text, tax text, note text
  );

  insert into public.cash_flows
    (user_id, flow_date, kind, amount, ticker, note, import_batch)
  select
    v_uid, x.flow_date::date, x.kind, x.amount::numeric,
    nullif(x.ticker, ''), nullif(x.note, ''), v_batch
  from pg_catalog.jsonb_to_recordset(coalesce(p_cash_flows, '[]'::jsonb)) as x(
    flow_date text, kind text, amount text, ticker text, note text
  );

  return v_batch;
end;
$$;

comment on function public.import_paste(int, jsonb, jsonb, jsonb, text) is
  '一次交易內寫入批次 + trades + cash_flows。security invoker,所以 RLS 照常生效:寫進別人的 user_id 會被 policy 擋下,而不是靠這個函式自己小心。';

-- ── 撤銷:同樣一個交易 ─────────────────────────────────────────────
create or replace function public.undo_import(p_batch uuid)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_t   int;
  v_c   int;
  v_b   int;
begin
  if v_uid is null then
    raise exception '未登入,拒絕撤銷' using errcode = '28000';
  end if;

  -- user_id 條件是刻意重複的:RLS 已經擋住別人的列,但寫出來才看得見意圖。
  delete from public.trades     where import_batch = p_batch and user_id = v_uid;
  get diagnostics v_t = row_count;
  delete from public.cash_flows where import_batch = p_batch and user_id = v_uid;
  get diagnostics v_c = row_count;
  delete from public.import_batches where id = p_batch and user_id = v_uid;
  get diagnostics v_b = row_count;

  -- 🔴 找不到批次必須【拋錯】而不是回 0/0/0。
  --    回 0 的話,「撤銷成功但那批本來就是空的」與「批次不存在/不是你的」
  --    輸出一模一樣 —— 又一個在正確與錯誤假設下都會通過的檢查。
  --    拋錯同時讓上面兩個 delete 一起回滾。
  if v_b = 0 then
    raise exception '找不到這批匯入,或它不屬於你:%', p_batch;
  end if;

  return pg_catalog.jsonb_build_object('trades', v_t, 'cash_flows', v_c, 'batch', v_b);
end;
$$;

comment on function public.undo_import(uuid) is
  '整批撤銷,回傳實際刪除筆數。回傳筆數是給呼叫端【核對】用的 —— 「撤銷成功」與「撤銷了 41 筆」是兩件事。';

-- 🔴 函式的 EXECUTE 預設給 PUBLIC。這兩支雖然是 invoker(不會提權),
--    但仍應只留給 authenticated —— 未登入者呼叫只會拿到「未登入」例外,
--    沒有理由讓那個入口對 anon 開著。
revoke all on function public.import_paste(int, jsonb, jsonb, jsonb, text) from public, anon;
revoke all on function public.undo_import(uuid)                            from public, anon;
grant execute on function public.import_paste(int, jsonb, jsonb, jsonb, text) to authenticated;
grant execute on function public.undo_import(uuid)                            to authenticated;

-- ── 結構性斷言:不得有【呼叫得到】的 security definer 函式 ──────────
-- 逐支列舉會在下一支函式出現時漏掉,所以斷言的是【整個 public schema】。
--
-- 🔴 判準用【性質】,不用【名字】。
--    第一版寫成 `proname not in ('handle_new_user')` —— 那是名字白名單,
--    而 `verify_online.sql` 的第 ⑥ 條早就寫下這條教訓:
--    **名字白名單會祝福掉錯的東西**(任何人只要把函式取成那個名字就通過了)。
--
--    真正該問的是:**這支 definer 函式,呼叫端叫得動嗎?**
--    叫不動的 definer 函式沒有攻擊面 —— `handle_new_user` 正是這一類
--    (EXECUTE 已從 public / anon / authenticated 全數 revoke,只留給觸發器)。
--    所以判準 = `prosecdef` 且 `anon` 或 `authenticated` 有 EXECUTE。
--
--    ⚠️ 同時排除【回傳 event_trigger】的函式:PostgreSQL 不允許直接呼叫這一類,
--       線上專案層的 rls_auto_enable(新表自動 RLS)就是,它不是我們的東西。
--       (與 verify_online.sql 第 ⑥ 條同一個放寬理由。)
do $$
declare
  bad text;
begin
  select pg_catalog.string_agg(p.proname, ', ' order by p.proname)
    into bad
  from pg_catalog.pg_proc p
  join pg_catalog.pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.prosecdef
    and p.prorettype <> 'pg_catalog.event_trigger'::regtype
    and (pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE')
      or pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE'));

  if bad is not null then
    raise exception
      'public 底下有【呼叫得到】的 security definer 函式:% —— '
      'definer 以擁有者權限執行,會繞過 RLS。'
      '若確實需要 definer,請把 EXECUTE 從 anon/authenticated revoke 掉(只留給觸發器),'
      '而不是把它加進某個名單。', bad;
  end if;
end;
$$;
