-- fifo_positions.test.sql — 跑法:supabase test db
--
-- 🔴 測試向量是【手算出來的定值】,不是拿實作跑一遍再把結果寫進來。
--    後者(golden output)在實作一開始就錯的時候會一起錯、而且永遠全綠。
--    下面每一個期望值都附了算式,可以逐項複核。

begin;
create extension if not exists pgtap with schema extensions;
select plan(16);

\set uid '33333333-3333-3333-3333-333333333333'
insert into auth.users (id, email) values (:'uid', 'fifo@example.test');

select set_config('role', 'authenticated', true);
select set_config('request.jwt.claims',
  json_build_object('sub', :'uid', 'role', 'authenticated')::text, true);

-- ── 案例 1:2330 —— 兩買一賣,賣出跨越第二個批次 ─────────────────────
--   買① 1,000 @ 100,手續費 142.50   (= 1000×100×0.1425%)
--   買② 1,000 @ 110,手續費 156.75   (= 1000×110×0.1425%)
--   賣  1,500 @ 120,手續費 256.50,證交稅 540.00
--                                    (= 1500×120×0.1425% / ×0.3%)
insert into public.trades (user_id, ticker, trade_date, seq, side, shares, price, fee, tax)
values (:'uid', '2330', '2026-01-05', 0, 'buy',  1000, 100, 142.50, 0),
       (:'uid', '2330', '2026-02-10', 0, 'buy',  1000, 110, 156.75, 0),
       (:'uid', '2330', '2026-03-15', 0, 'sell', 1500, 120, 256.50, 540.00);

-- 剩餘 = 2,000 買 − 1,500 賣 = 500 股,且【必須是買②的】(FIFO:先買的先賣)
select is((select shares from public.v_holdings where ticker = '2330'),
          500::numeric, '2330 剩餘 500 股(2,000 買 − 1,500 賣)');

-- 買②每股成本 = (110×1000 + 156.75) / 1000 = 110.15675
select is((select round(avg_cost, 5) from public.v_holdings where ticker = '2330'),
          110.15675::numeric,
          '剩餘部位加權均價 = 110.15675(買②每股成本,含買入手續費)—— 不是兩筆買入的均價 105');

-- cost_basis = 500 × 110.15675 = 55,078.375
select is((select round(cost_basis, 4) from public.v_holdings where ticker = '2330'),
          55078.3750::numeric, '2330 成本基礎 = 55,078.375');

select is((select open_lot_count from public.v_holdings where ticker = '2330'),
          1::bigint, '只剩 1 個未平倉批次(買①已整筆沖銷)');

select is((select oldest_open_date from public.v_holdings where ticker = '2330'),
          '2026-02-10'::date, '最舊未平倉批次是買②(買①已被 FIFO 沖銷掉)');

-- 配對明細:1,500 股的賣出應拆成兩列(1,000 對買①、500 對買②)
select is((select count(*)::int from public.v_realized_lots where ticker = '2330'), 2,
          '一筆賣出跨兩個買入批次 → 產生 2 列配對明細');

select is((select matched_shares from public.v_realized_lots
            where ticker = '2330' and buy_price = 100),
          1000::numeric, '買①配到 1,000 股(整筆吃掉)');
select is((select matched_shares from public.v_realized_lots
            where ticker = '2330' and buy_price = 110),
          500::numeric, '買②配到 500 股(部分沖銷)');

-- 買① 淨損益 = 1000×(120−100) − 142.50 − 256.50×(1000/1500) − 540×(1000/1500)
--            = 20000 − 142.50 − 171.00 − 360.00 = 19,326.50
select is((select round(realized_pnl, 4) from public.v_realized_lots
            where ticker = '2330' and buy_price = 100),
          19326.5000::numeric, '買①配對淨損益 = 19,326.50(賣出費稅依配到股數比例分攤)');

-- 買② 淨損益 = 500×(120−110) − 156.75×(500/1000) − 256.50×(500/1500) − 540×(500/1500)
--            = 5000 − 78.375 − 85.50 − 180.00 = 4,656.125
select is((select round(realized_pnl, 4) from public.v_realized_lots
            where ticker = '2330' and buy_price = 110),
          4656.1250::numeric, '買②配對淨損益 = 4,656.125(買入手續費也按沖銷比例分攤)');

select is((select round(sum(realized_pnl), 4) from public.v_realized_lots where ticker = '2330'),
          23982.6250::numeric, '2330 已實現損益合計 = 23,982.625');

-- ── 案例 2:零股 + 同日多筆(seq 決定 FIFO 順序)──────────────────────
--   同一天買 15 股 @ 200(seq 0)、買 5 股 @ 300(seq 1),隔日賣 15 股 @ 400。
--   FIFO 必須先吃 seq 0 那筆 → 剩下 5 股 @ 300。
insert into public.trades (user_id, ticker, trade_date, seq, side, shares, price, fee, tax)
values (:'uid', '6488', '2026-02-01', 0, 'buy',  15, 200, 0, 0),
       (:'uid', '6488', '2026-02-01', 1, 'buy',   5, 300, 0, 0),
       (:'uid', '6488', '2026-02-02', 0, 'sell', 15, 400, 0, 0);

select is((select shares from public.v_holdings where ticker = '6488'),
          5::numeric, '零股:剩餘 5 股(20 買 − 15 賣)');
select is((select avg_cost from public.v_holdings where ticker = '6488'),
          300::numeric,
          '同日多筆時 seq 決定先後:先吃 seq 0 的 15 股 @200 → 剩 seq 1 的 5 股 @300');
select is((select round(sum(realized_pnl), 2) from public.v_realized_lots where ticker = '6488'),
          3000.00::numeric, '零股已實現 = 15×(400−200) = 3,000');

-- ── 案例 3:賣超必須被指名,不可表現成「持倉 0」──────────────────────
--   只登了賣出 100 股卻沒有對應買入(漏登/代號打錯)。
insert into public.trades (user_id, ticker, trade_date, seq, side, shares, price, fee, tax)
values (:'uid', '1101', '2026-03-01', 0, 'sell', 100, 50, 0, 0);

select is((select count(*)::int from public.v_holdings where ticker = '1101'), 0,
          '賣超的代號不會出現在持倉(having shares > 0)');
select is((select oversold_shares from public.v_position_anomalies where ticker = '1101'),
          100::numeric,
          '🔴 但它必須出現在 v_position_anomalies —— 靜默的零是最難查的錯');

select * from finish();
rollback;
