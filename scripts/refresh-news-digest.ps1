# 每日簡報自動更新(keyless)：
#   1) 跑新聞快照(本地 NLP,免 API 金鑰、免 dev server)
#   2) 由 Claude Code 無頭模式讀快照、生成繁中簡報,寫入 web/public/data/news-digest.json
# 用你登入的 Claude Code(Enterprise),全程不需 ANTHROPIC_API_KEY。
# 供 Windows 工作排程器每日呼叫;也可手動 pwsh -File scripts/refresh-news-digest.ps1 測試。

$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
# 工作排程器的 PATH 較精簡:補上 claude CLI 所在(~\.local\bin)
$env:PATH = (Join-Path $env:USERPROFILE ".local\bin") + ";" + $env:PATH
$logDir = Join-Path $repo "logs"
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Force $logDir | Out-Null }
$log = Join-Path $logDir "news-digest.log"
function Log($m) { Add-Content -Path $log -Value ("{0}  {1}" -f (Get-Date -Format o), $m) }

Log "=== refresh-news-digest start ==="

# 1) 產生快照(deterministic,本地)
Push-Location (Join-Path $repo "web")
try {
  Log "step1: build-news-snapshot"
  & npx --yes tsx scripts/build-news-snapshot.ts 2>&1 | ForEach-Object { Add-Content -Path $log -Value $_ }
} finally { Pop-Location }

# 2) 由 Claude Code 無頭生成簡報(scoped 工具白名單,非全域 bypass)
$prompt = '讀取 web/news-snapshot.json,依照 .claude/skills/news-digest/SKILL.md 的 Step 3-5,生成繁體中文每日簡報並嚴格依該 SKILL 的 schema 寫入 web/public/data/news-digest.json(digest.headline、marketTone、bullets、sectorsHot、sectorsWeak,以及 clusters[] 命名);只依快照內容,勿杜撰數字或事件;完成後用一行回報。'
Push-Location $repo
try {
  Log "step2: claude -p (headless, allowedTools=Read Write (無 Bash,降低注入風險))"
  & claude -p $prompt --allowedTools "Read" "Write" 2>&1 |
    ForEach-Object { Add-Content -Path $log -Value $_ }
} finally { Pop-Location }

$digest = Join-Path $repo "web\public\data\news-digest.json"
if (Test-Path $digest) {
  Log ("=== done; digest mtime: {0} ===" -f (Get-Item $digest).LastWriteTime)
} else {
  Log "=== WARNING: news-digest.json not found after run ==="
}
