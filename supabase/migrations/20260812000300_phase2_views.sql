-- 20260812000300_phase2_views.sql
-- 持倉 / 已實現損益 / 現金餘額:一律是 view,不是表。
--
-- 🔴🔴 security_invoker —— 這是本檔最重要的一行,漏了就等於整套 RLS 沒裝。
--    Postgres 的 view 預設以【建立者(view owner)】的權限求值,
--    而 view owner 通常是 migration 角色 → 底層表的 RLS 【被繞過】,
--    任何登入使用者都能透過 view 讀到【全體使用者】的持倉。
--    這是 Supabase 上最典型的資料外洩形狀:表的 RLS 測起來全綠,但 view 是開的。
--    `security_invoker = true` 讓 view 以【查詢者】的身分求值,RLS 才會生效。
--    ⚠️ 需要 PostgreSQL 15+(Supabase 現行版本符合)。
--    ⚠️ 測試檔有一條專門驗這件事:B 透過 view 必須讀不到 A 的持倉。
--
-- 🔴【DB 只存數、不算數】的沿用:下面全部是【精確 numeric 運算,不做任何捨入】。
--    唯一的例外是除法(平均成本),那是 Postgres numeric 的固有行為,
--    應用層不得再用不同規則重新捨入一次,否則兩端永遠對不齊。

-- ── FIFO 的基礎:把每一筆交易換算成「累積股數區間」────────────────────
-- 🔴 為什麼可以不用逐筆狀態機(這是與藍圖 6-1 的差異,理由寫在 supabase/README.md):
--    FIFO 的本質是「先買的先被賣掉」。把買入依時序排成一條數線
--    [0, s1) [s1, s1+s2) …,賣出也排成同一條數線,
--    則「第 k 筆買入有沒有被沖銷」只看它的區間有沒有落在【累積賣出量】之內。
--    這是純集合運算,沒有迴圈、沒有可變狀態,因此可以是 view,也容易測。
create or replace view public.v_trade_lots
with (security_invoker = true) as
select
  t.id,
  t.user_id,
  t.ticker,
  t.trade_date,
  t.seq,
  t.side,
  t.shares,
  t.price,
  t.fee,
  t.tax,
  -- 同側累積:本筆【之前】已累積的股數 → 本筆佔用的區間起點
  coalesce(sum(t.shares) over (
    partition by t.user_id, t.ticker, t.side
    order by t.trade_date, t.seq, t.id
    rows between unbounded preceding and 1 preceding), 0) as lot_start,
  sum(t.shares) over (
    partition by t.user_id, t.ticker, t.side
    order by t.trade_date, t.seq, t.id
    rows between unbounded preceding and current row)     as lot_end
from public.trades t;

comment on view public.v_trade_lots is
  'FIFO 的數線表示:每筆交易在同側(買/賣)累積股數上佔用的區間 [lot_start, lot_end)。持倉與配對都由這個區間推。';

-- ── 每檔的總賣出量(FIFO 的沖銷水位)────────────────────────────────
create or replace view public.v_ticker_sold
with (security_invoker = true) as
select user_id, ticker, sum(shares) as sold_shares
from public.trades
where side = 'sell'
group by user_id, ticker;

-- ── 剩餘批次:FIFO 沖銷後還沒被賣掉的部分 ───────────────────────────
create or replace view public.v_open_lots
with (security_invoker = true) as
select
  b.id            as buy_id,
  b.user_id,
  b.ticker,
  b.trade_date    as buy_date,
  b.seq,
  b.price         as buy_price,
  b.shares        as buy_shares,
  b.fee           as buy_fee,
  -- 沖銷水位以上的部分才是剩餘;整筆被吃掉時為 0
  greatest(0, b.lot_end - greatest(b.lot_start, coalesce(s.sold_shares, 0))) as open_shares,
  -- 每股成本 = (成交價 × 股數 + 買入手續費) ÷ 股數;買入手續費【計入成本】
  (b.price * b.shares + b.fee) / b.shares as cost_per_share
from public.v_trade_lots b
left join public.v_ticker_sold s
  on s.user_id = b.user_id and s.ticker = b.ticker
where b.side = 'buy';

comment on view public.v_open_lots is
  '每一筆買入在 FIFO 沖銷後的剩餘股數。open_shares = 0 表示整筆已賣完(保留列以便追溯,不過濾)。';

-- ── 持倉:剩餘部位加權平均(與券商對帳單同口徑)──────────────────────
create or replace view public.v_holdings
with (security_invoker = true) as
select
  o.user_id,
  o.ticker,
  sum(o.open_shares)                                       as shares,
  sum(o.open_shares * o.cost_per_share)                    as cost_basis,
  case when sum(o.open_shares) > 0
       then sum(o.open_shares * o.cost_per_share) / sum(o.open_shares)
  end                                                      as avg_cost,
  min(o.buy_date) filter (where o.open_shares > 0)         as oldest_open_date,
  count(*) filter (where o.open_shares > 0)                as open_lot_count
from public.v_open_lots o
group by o.user_id, o.ticker
having sum(o.open_shares) > 0;

comment on view public.v_holdings is
  '現有持倉。avg_cost = 剩餘批次的加權平均成本(含買入手續費),對齊券商對帳單;已實現損益走 v_realized_lots 的 FIFO 配對。兩者是同一份 trades 的兩種讀法,不是兩份真相。';

-- ── 賣超偵測:賣出量 > 買入量 ────────────────────────────────────────
-- 🔴 沒有這一條,資料錯誤(漏登買入、代號打錯)會表現成「持倉 0」——
--    看起來完全正常,而使用者以為自己賣光了。**靜默的零是最難查的錯。**
create or replace view public.v_position_anomalies
with (security_invoker = true) as
select
  coalesce(b.user_id, s.user_id)                       as user_id,
  coalesce(b.ticker, s.ticker)                         as ticker,
  coalesce(b.bought, 0)                                as bought_shares,
  coalesce(s.sold_shares, 0)                           as sold_shares,
  coalesce(s.sold_shares, 0) - coalesce(b.bought, 0)   as oversold_shares
from (select user_id, ticker, sum(shares) as bought
        from public.trades where side = 'buy' group by user_id, ticker) b
full join public.v_ticker_sold s
  on s.user_id = b.user_id and s.ticker = b.ticker
where coalesce(s.sold_shares, 0) > coalesce(b.bought, 0);

comment on view public.v_position_anomalies is
  '賣出量超過買入量的代號 —— 幾乎必然是資料錯誤(漏登買入/代號打錯)。前端應顯示為警告,不可靜默當成持倉 0。';

-- ── 已實現損益:FIFO 逐筆配對明細 ───────────────────────────────────
-- 買入區間與賣出區間【重疊的長度】就是這一對配到的股數。
-- 這正是 FIFO 的定義,而且是集合運算 —— 不需要逐筆狀態機。
create or replace view public.v_realized_lots
with (security_invoker = true) as
select
  b.user_id,
  b.ticker,
  b.id                as buy_id,
  s.id                as sell_id,
  b.trade_date        as buy_date,
  s.trade_date        as sell_date,
  b.price             as buy_price,
  s.price             as sell_price,
  least(b.lot_end, s.lot_end) - greatest(b.lot_start, s.lot_start) as matched_shares,
  -- 費用依【配到的股數比例】分攤到這一對
  b.fee * (least(b.lot_end, s.lot_end) - greatest(b.lot_start, s.lot_start)) / b.shares as buy_fee_alloc,
  s.fee * (least(b.lot_end, s.lot_end) - greatest(b.lot_start, s.lot_start)) / s.shares as sell_fee_alloc,
  s.tax * (least(b.lot_end, s.lot_end) - greatest(b.lot_start, s.lot_start)) / s.shares as sell_tax_alloc,
  -- 淨已實現損益 = 賣出淨收 − 買入含費成本
  (least(b.lot_end, s.lot_end) - greatest(b.lot_start, s.lot_start)) * (s.price - b.price)
    - b.fee * (least(b.lot_end, s.lot_end) - greatest(b.lot_start, s.lot_start)) / b.shares
    - s.fee * (least(b.lot_end, s.lot_end) - greatest(b.lot_start, s.lot_start)) / s.shares
    - s.tax * (least(b.lot_end, s.lot_end) - greatest(b.lot_start, s.lot_start)) / s.shares
      as realized_pnl
from public.v_trade_lots b
join public.v_trade_lots s
  on  s.user_id = b.user_id
  and s.ticker  = b.ticker
  and b.side = 'buy' and s.side = 'sell'
  -- 區間重疊(半開區間:相鄰不算重疊)
  and least(b.lot_end, s.lot_end) > greatest(b.lot_start, s.lot_start);

comment on view public.v_realized_lots is
  '已實現損益的逐筆配對明細:每一列 = 一筆買入與一筆賣出配到的股數與淨損益。買入手續費計入成本、賣出手續費與證交稅自賣出價扣除,部分賣出時依配到股數比例分攤。';

-- ── 現金餘額 ────────────────────────────────────────────────────────
create or replace view public.v_cash_balance
with (security_invoker = true) as
select user_id, sum(amount) as balance, max(flow_date) as last_flow_date
from public.cash_flows
group by user_id;

-- ── 權限:view 也只給 authenticated,anon 一格都不給 ──────────────────
revoke all on public.v_trade_lots, public.v_ticker_sold, public.v_open_lots,
              public.v_holdings, public.v_position_anomalies,
              public.v_realized_lots, public.v_cash_balance
  from anon;

grant select on public.v_trade_lots, public.v_ticker_sold, public.v_open_lots,
                public.v_holdings, public.v_position_anomalies,
                public.v_realized_lots, public.v_cash_balance
  to authenticated;

-- ── 🔴 結構性斷言:public 底下的 view 一律要 security_invoker ──────────
-- 與 RLS 那條同一個形狀:不是「這幾個 view 設了」,而是
-- 「這個 schema 裡【不可能】存在會繞過 RLS 的 view」。
do $$
declare
  bad text;
begin
  select string_agg(c.relname, ', ' order by c.relname)
    into bad
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relkind = 'v'
    and coalesce(
          (select option_value from pg_options_to_table(c.reloptions)
            where option_name = 'security_invoker'), 'false') <> 'true';

  if bad is not null then
    raise exception
      'public 底下有未設定 security_invoker 的 view:% —— '
      'view 預設以建立者權限求值會【繞過底層表的 RLS】,等於整套隔離失效。拒絕套用。', bad;
  end if;
end;
$$;
