# 開啟 TWstock 專案網頁:
#   若 dev server(localhost:4321)未啟動,先在背景啟動 npm run dev,
#   等待就緒後開預設瀏覽器。供桌面捷徑點擊使用。
$ErrorActionPreference = "SilentlyContinue"
$repo = Split-Path -Parent $PSScriptRoot
$url = "http://localhost:4321"

function Test-Up {
  try {
    return ((Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 2).StatusCode -eq 200)
  } catch {
    return $false
  }
}

if (-not (Test-Up)) {
  # 啟動 dev server(新視窗、最小化;關閉該視窗即停止伺服器)
  Start-Process -FilePath "powershell.exe" `
    -ArgumentList @("-NoProfile", "-NoExit", "-Command", "Set-Location '$repo\web'; npm run dev") `
    -WindowStyle Minimized
  # 等待就緒(最多約 90 秒,首次含 predev 建索引)
  for ($i = 0; $i -lt 90; $i++) {
    Start-Sleep -Seconds 1
    if (Test-Up) { break }
  }
}

Start-Process $url
