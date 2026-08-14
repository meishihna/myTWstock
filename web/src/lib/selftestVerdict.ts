/**
 * 隔離自測的【判準】—— 抽成純函式,才測得到
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 🔴 為什麼要抽出來:判準寫在頁面的 script 裡時,只能靠「跑一次真實情境」驗證,
 *    而真實情境不一定涵蓋所有組合(線上首跑就沒有涵蓋到「攻擊 0 + 對照 0」)。
 *    抽成純函式後可以逐一注入每種組合,不需要資料庫。
 *
 * 🔴 這個判準修正過一次(2026-08-14)。舊版:
 *      攻擊全部 0 列 且【對照組至少一項讀得到】→ 宣告通過
 *    洞在於:某物件若【攻擊 0 列、對照也 0 列】,
 *    「隔離有效」與「隔離完全沒開」的輸出**一模一樣**
 *    —— 那是在正確與錯誤假設下都會通過的檢查,也就是不是檢查。
 *    線上首跑實際撞到:cash_flows / watchlist / preferences 三項對照皆 0,頁面仍印 ✅。
 * ══════════════════════════════════════════════════════════════════════════
 */

export type ProbeVerdict = "pass" | "fail" | "unknown";

export type ProbeInput = {
  name: string;
  /** 讀 peer 的列數;查詢出錯時為 null */
  attackRows: number | null;
  /** 讀自己的列數(同一張表/檢視);查詢出錯時為 null */
  controlRows: number | null;
  /** 無法判定時要告訴使用者補什麼資料 */
  need?: string;
};

/**
 * 逐項配對的判定:
 *   攻擊 > 0 列            → fail(讀到別人的資料)
 *   攻擊 0 列 + 對照 ≥1 列 → pass(有鑑別力且通過)
 *   攻擊 0 列 + 對照 0 列  → unknown(**不是通過**)
 *   任一側查詢出錯          → unknown(量不到 = 不能算通過)
 */
export function judgeProbe(p: ProbeInput): ProbeVerdict {
  if (p.attackRows == null || p.controlRows == null) return "unknown";
  if (p.attackRows > 0) return "fail";
  return p.controlRows > 0 ? "pass" : "unknown";
}

export type Summary = {
  verdict: "pass" | "fail" | "partial";
  passed: number;
  failed: string[];
  unknown: string[];
  total: number;
};

/** 全部逐項通過才算通過;有任一失敗即 fail;其餘為 partial(部分成立) */
export function summarize(probes: ProbeInput[]): Summary {
  const withV = probes.map((p) => ({ p, v: judgeProbe(p) }));
  const failed = withV.filter((x) => x.v === "fail").map((x) => x.p.name);
  const unknown = withV.filter((x) => x.v === "unknown").map((x) => x.p.name);
  const passed = withV.filter((x) => x.v === "pass").length;
  return {
    verdict: failed.length ? "fail" : unknown.length ? "partial" : "pass",
    passed,
    failed,
    unknown,
    total: probes.length,
  };
}
