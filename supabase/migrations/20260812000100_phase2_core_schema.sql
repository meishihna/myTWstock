-- 20260812000100_phase2_core_schema.sql
-- Phase 2 核心資料模型:trades + cash_flows 是唯一真相,持倉/損益一律推算。
--
-- 🔴 設計紅線(來自藍圖,勿在此重新發明):
--   1. 不存持倉快照、不存損益快照、【不存任何跨使用者彙總表】
--      —— 讓「不做跨使用者統計」在【結構上不可能】,而不只是承諾。
--   2. 每一張表都掛 user_id 並 on delete cascade → 刪帳號一個 CASCADE 清乾淨。
--   3. 金額一律 numeric(精確十進位),**不用 float**。
--
-- 🔴【DB 只存數、不算數】沿用引擎端同一條鐵律:本檔與 views 只做【精確 numeric 運算】,
--    一律【不捨入】。所有捨入(顯示、對帳單比對)都留給應用層。
--    理由:SQL 與 JS/Python 的捨入語意不同(banker's rounding、浮點加總順序),
--    在資料層捨入會產生「看起來正常的垃圾」,而且兩端永遠對不齊。
--
-- ⚠️ 本檔【不啟用】任何專案層設定,也不覆寫「新表自動 RLS / 不自動暴露」——
--    RLS 在 20260812000200 明確逐表啟用(明確啟用不等於覆寫;它與專案預設同向)。

-- ── profiles:auth.users 的應用層延伸 ────────────────────────────────
create table if not exists public.profiles (
  id            uuid primary key references auth.users (id) on delete cascade,
  display_name  text,
  base_currency text        not null default 'TWD' check (base_currency = 'TWD'),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

comment on table public.profiles is
  '使用者設定檔。base_currency 目前鎖 TWD —— 多幣別不在 Phase 2 範圍,用 check 讓越界大聲失敗而不是默默存進去。';

-- ── trades:唯一真相 ────────────────────────────────────────────────
create table if not exists public.trades (
  id         bigint generated always as identity primary key,
  user_id    uuid          not null references auth.users (id) on delete cascade,
  ticker     text          not null check (ticker ~ '^[0-9]{4}[0-9A-Z]?$'),
  trade_date date          not null,
  seq        int           not null default 0,
  side       text          not null check (side in ('buy', 'sell')),
  shares     numeric(18,4) not null check (shares > 0),
  price      numeric(18,4) not null check (price >= 0),
  fee        numeric(18,2) not null default 0 check (fee >= 0),
  tax        numeric(18,2) not null default 0 check (tax >= 0),
  note       text,
  created_at timestamptz   not null default now(),
  updated_at timestamptz   not null default now()
);

comment on column public.trades.ticker is
  '台股代號。四碼為主,允許第五碼英數(ETF/特別股/權證等,如 00878、2891A)—— 只用 ^\d{4}$ 會把合法代號擋在門外。';
comment on column public.trades.seq is
  '同一天多筆交易的 FIFO 排序依據。FIFO 的「先進」必須全序,只有日期會產生平手 → 平手時配對結果不唯一,那是靜默的不確定性。';
comment on column public.trades.shares is
  '股數。整股/零股同一欄:零股就是小數或 <1000 的股數,不另立欄位也不另立表。';
comment on column public.trades.tax is
  '證交稅。買進為 0、賣出才有 —— 但【不在此強制】:官方稅率有當沖減半等情形,寫死會擋掉合法資料。稅率預設值見 tw_default_tax()。';

create index if not exists trades_user_ticker_order_idx
  on public.trades (user_id, ticker, trade_date, seq, id);
create index if not exists trades_user_date_idx
  on public.trades (user_id, trade_date);

-- ── cash_flows:現金進出(股息、入金、出金…)────────────────────────
create table if not exists public.cash_flows (
  id         bigint generated always as identity primary key,
  user_id    uuid          not null references auth.users (id) on delete cascade,
  flow_date  date          not null,
  kind       text          not null check (kind in ('deposit', 'withdraw', 'dividend', 'fee', 'other')),
  amount     numeric(18,2) not null,
  ticker     text          check (ticker ~ '^[0-9]{4}[0-9A-Z]?$'),
  note       text,
  created_at timestamptz   not null default now()
);

comment on column public.cash_flows.amount is
  '正 = 流入、負 = 流出。不用另一個 direction 欄:兩個欄位表達一件事必然會不同步。';

create index if not exists cash_flows_user_date_idx
  on public.cash_flows (user_id, flow_date);

-- ── watchlist / preferences ────────────────────────────────────────
create table if not exists public.watchlist (
  user_id  uuid        not null references auth.users (id) on delete cascade,
  ticker   text        not null check (ticker ~ '^[0-9]{4}[0-9A-Z]?$'),
  added_at timestamptz not null default now(),
  note     text,
  primary key (user_id, ticker)
);

create table if not exists public.preferences (
  user_id    uuid        primary key references auth.users (id) on delete cascade,
  data       jsonb       not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- ── updated_at 自動維護 ────────────────────────────────────────────
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

comment on function public.touch_updated_at is
  'set search_path = '''' 是刻意的:函式若沿用呼叫端的 search_path,使用者可建立同名物件劫持函式內的解析(search_path 注入)。所有物件在函式內一律寫全名。';

drop trigger if exists trades_touch_updated_at on public.trades;
create trigger trades_touch_updated_at
  before update on public.trades
  for each row execute function public.touch_updated_at();

drop trigger if exists profiles_touch_updated_at on public.profiles;
create trigger profiles_touch_updated_at
  before update on public.profiles
  for each row execute function public.touch_updated_at();

drop trigger if exists preferences_touch_updated_at on public.preferences;
create trigger preferences_touch_updated_at
  before update on public.preferences
  for each row execute function public.touch_updated_at();

-- ── 台股費用/稅的【預設值】函式(不強制,只供應用層取用)────────────
-- 與回測引擎同口徑:手續費 0.1425%(買賣各一次)、證交稅 0.3%(僅賣出)。
-- 🔴 只提供「預設值」而不寫成 check 或 trigger:券商折扣、當沖減半、ETF 稅率
--    都會讓實際值不同 —— 把它變成強制條件會擋掉合法資料。
--    ⚠️ 同時【不捨入】:回傳精確 numeric,捨入規則(無條件捨去到元、最低 20 元手續費等)
--       屬於券商規則,由應用層套用並負責與對帳單一致。
create or replace function public.tw_default_fee(p_shares numeric, p_price numeric)
returns numeric
language sql
immutable
security invoker
set search_path = ''
as $$ select p_shares * p_price * 0.001425 $$;

create or replace function public.tw_default_tax(p_side text, p_shares numeric, p_price numeric)
returns numeric
language sql
immutable
security invoker
set search_path = ''
as $$ select case when p_side = 'sell' then p_shares * p_price * 0.003 else 0 end $$;

comment on function public.tw_default_fee is
  '手續費預設值 0.1425%(買賣各收一次)。不捨入、不套最低收費 —— 那是券商規則,屬應用層。';
comment on function public.tw_default_tax is
  '證交稅預設值 0.3%,僅賣出。當沖減半 / ETF 稅率不同 → 故意不強制。';
