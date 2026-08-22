-- 20260822000100_rename_cash_flow_total.sql
-- `v_cash_balance` → `v_cash_flow_total`(欄位 `balance` → `flow_total`)
--
-- ══════════════════════════════════════════════════════════════════════
-- 🔴 為什麼改名:舊名字在說假話,而且是【慢性】的那種。
--
-- 這個檢視做的事只有一件:`sum(amount) from cash_flows group by user_id`。
-- 它**不含交易造成的現金變動**(買進付出、賣出收回),
-- 所以它【不是現金餘額】。實際的現金水位是:
--
--     現金水位 = 本檢視的合計 + 交易淨現金流
--
-- 交易那一半由瀏覽器算(見 `web/src/lib/equity.ts`)。那個切分是刻意保留的 ——
-- 左邊(已實現/未實現)全部來自 SQL 檢視、右邊的現金由 TS 算,
-- 於是「合計損益 == 淨值 − 總存入」這條恆等式順便成了跨層交叉檢查。**那是淨賺。**
-- 要改的只有名字。
--
-- ⚠️ 舊名字不會產生錯誤結果 —— 它讓未來的人做出【錯誤推論】。
--    尤其它是跨帳號隔離自測 15 條探針裡的一條:名字會讓人以為
--    「真正的現金餘額」已經被隔離驗證過了。
--
-- 🔴 也**不叫** `v_external_cash_flow_total`(第一版提案的名字)——
--    本檢視把 `dividend` / `fee` / `other` 也加了進去,而那些是【內部】現金流,
--    不是存入。叫 external 會讓下一個人拿它當 TWR 的外部資金流分母,
--    而 TWR 的正確性完全建立在那個分母只含 deposit/withdraw 上。
--    **那會產生錯誤結果,比錯誤推論更糟。**
--    分類的權威在 `equity.ts` 的 `EXTERNAL_KINDS` / `INTERNAL_KINDS`,不在這裡。
--
-- 名字選最無聊的那個:它就是「`cash_flows` 這張表的合計」。
--
-- ⚠️ 部署順序:**不需要協調。** 呼叫端的交叉檢查已改成自己吞例外、
--    失敗時出聲但不擋渲染(`trades.astro`)。所以先套 migration 或先推程式碼都可以,
--    最壞情況只是那一格交叉檢查暫時「跑不起來」——而它會把這件事印出來。
-- ══════════════════════════════════════════════════════════════════════

create or replace view public.v_cash_flow_total
with (security_invoker = true) as
select
  user_id,
  sum(amount)     as flow_total,
  max(flow_date)  as last_flow_date
from public.cash_flows
group by user_id;

comment on view public.v_cash_flow_total is
  'cash_flows 這張表的逐使用者合計。🔴 不是現金餘額 —— 不含交易造成的現金變動。'
  '現金水位 = 本檢視 + 交易淨現金流(見 web/src/lib/equity.ts)。'
  '也不是「外部資金流」:dividend/fee/other 也計入本合計,而那些不算存入。';

revoke all on public.v_cash_flow_total from anon, public;
grant select on public.v_cash_flow_total to authenticated;

-- 舊檢視移除。留著它等於留著那句假話,而「暫時保留以免破壞」在這裡不成立:
-- 呼叫端已經不依賴它,而且它的失敗路徑已經是非致命的。
drop view if exists public.v_cash_balance;

-- ── 🔴 結構性斷言(與 20260812000300 同一條,在此重跑)───────────────
-- 新增/替換 view 的 migration 都要自己帶這一條:
-- 少了 security_invoker 的 view 會【繞過底層表的 RLS】,等於整套隔離失效。
-- 斷言的是「這個 schema 裡不可能存在這種 view」,不是「我這次記得加了」。
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
      'view 預設以建立者權限求值會繞過底層表的 RLS,等於整套隔離失效。拒絕套用。', bad;
  end if;
end;
$$;

-- ── 🔴 斷言:舊名字不得還在 ─────────────────────────────────────────
-- `drop view if exists` 不會告訴你它到底有沒有刪掉東西。
-- 這一條讓「以為刪了但其實沒刪」變成套用時的紅燈,而不是日後的困惑。
do $$
begin
  if exists (
    select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relname = 'v_cash_balance'
  ) then
    raise exception 'v_cash_balance 還在 —— 改名沒有完成,兩個名字並存比只有舊名字更糟';
  end if;
end;
$$;
