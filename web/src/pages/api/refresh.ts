/**
 * POST /api/refresh — 觸發 GitHub Actions「refresh-snapshots」workflow,
 * 重新產生市場快照(三大法人/資券/強勢股/今日題材)並由 CI commit+push → Vercel 部署。
 * 不含 AI 每日簡報(那需 Claude;見 daily-news-digest 排程任務)。
 *
 * 需 Vercel 環境變數 GITHUB_DISPATCH_TOKEN(fine-grained PAT,對本 repo 有 Actions 讀寫權)。
 * 內建 30 分鐘冷卻 + 進行中偵測,避免公開頁面被濫點。
 */
export const prerender = false;

const REPO = "meishihna/twstock-web";
const WORKFLOW = "refresh-snapshots.yml";
const MIN_GAP_MS = 30 * 60 * 1000;

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

export async function POST(): Promise<Response> {
  const token = process.env.GITHUB_DISPATCH_TOKEN;
  if (!token) {
    return json(
      { ok: false, reason: "not_configured", message: "更新功能尚未設定(請在 Vercel 設 GITHUB_DISPATCH_TOKEN)。" },
      503,
    );
  }

  const base = `https://api.github.com/repos/${REPO}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "twstock-refresh",
  };

  // 冷卻 / 進行中檢查(查最近一次 run)
  try {
    const r = await fetch(`${base}/actions/workflows/${WORKFLOW}/runs?per_page=1`, { headers });
    if (r.ok) {
      const run = (await r.json())?.workflow_runs?.[0];
      if (run) {
        if (run.status === "in_progress" || run.status === "queued") {
          return json({ ok: false, reason: "running", message: "更新進行中,請稍候(約 10 分鐘)。" }, 429);
        }
        const age = Date.now() - new Date(run.created_at).getTime();
        if (age < MIN_GAP_MS) {
          const mins = Math.max(1, Math.ceil((MIN_GAP_MS - age) / 60000));
          return json({ ok: false, reason: "cooldown", message: `剛更新過,請 ${mins} 分鐘後再試。` }, 429);
        }
      }
    }
  } catch {
    /* 檢查失敗就略過,直接嘗試觸發 */
  }

  const dr = await fetch(`${base}/actions/workflows/${WORKFLOW}/dispatches`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ ref: "main" }),
  });
  if (dr.status === 204) {
    return json({ ok: true, message: "已觸發更新,約 10 分鐘後重新整理頁面即可看到最新資料。" });
  }
  const detail = await dr.text().catch(() => "");
  return json(
    { ok: false, reason: "dispatch_failed", message: `觸發失敗(HTTP ${dr.status})。`, detail: detail.slice(0, 200) },
    502,
  );
}
