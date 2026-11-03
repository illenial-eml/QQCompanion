# QQCompanion 一键安装（Windows PowerShell 5.1 / 7+）
#
#   在 PowerShell 里粘贴这一行：
#   irm https://raw.githubusercontent.com/illenial-eml/QQCompanion/main/install.ps1 | iex
#
# 或者先下载看清楚再跑：
#   irm https://raw.githubusercontent.com/illenial-eml/QQCompanion/main/install.ps1 -OutFile install.ps1
#   .\install.ps1
#
# 可选参数：
#   -Dir <路径>      装到哪（默认 $HOME\QQCompanion）
#   -Repo <url>      换一个仓库地址
#   -Branch <分支>   默认 main
#   -NoTest          跳过自检
#
# 本文件是纯 ASCII + 中文注释，Windows PowerShell 5.1 也能正确执行（已按 UTF-8 保存）。

param(
  [string]$Dir = (Join-Path $HOME 'QQCompanion'),
  [string]$Repo = 'https://github.com/illenial-eml/QQCompanion.git',
  [string]$Branch = 'main',
  [switch]$NoTest
)

$ErrorActionPreference = 'Stop'
$MinNodeMajor = 22

function Write-Ok   { param($m) Write-Host "  [OK] $m" -ForegroundColor Green }
function Write-Warn { param($m) Write-Host "  [!!] $m" -ForegroundColor Yellow }
function Write-Bad  { param($m) Write-Host "  [XX] $m" -ForegroundColor Red }
function Write-Step { param($m) Write-Host "`n$m" -ForegroundColor Cyan }

Write-Host 'QQCompanion installer' -ForegroundColor White
Write-Host "  platform : $([Environment]::OSVersion.VersionString)"

# ---------- 1. 环境 ----------
Write-Step '1/5  Checking environment'

$git = Get-Command git -ErrorAction SilentlyContinue
if (-not $git) {
  Write-Bad 'git not found. Install it: https://git-scm.com/download/win (or winget install Git.Git)'
  exit 1
}
Write-Ok "git $(& git --version)"

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Write-Bad 'node not found. Install Node.js 22+ : winget install OpenJS.NodeJS.LTS'
  exit 1
}
$nodeVer = (& node -v)
$nodeMajor = [int]($nodeVer.TrimStart('v').Split('.')[0])
if ($nodeMajor -lt $MinNodeMajor) {
  Write-Bad "Node.js $nodeVer is too old, need >= $MinNodeMajor"
  exit 1
}
Write-Ok "Node.js $nodeVer"

# ---------- 2. 取代码 ----------
Write-Step '2/5  Getting the code'
if (Test-Path (Join-Path $Dir '.git')) {
  Write-Ok "already cloned: $Dir"
  Push-Location $Dir
  try {
    & git fetch --depth 1 origin $Branch 2>$null | Out-Null
    & git checkout -q $Branch 2>$null | Out-Null
    & git reset --hard -q "origin/$Branch" 2>$null | Out-Null
    Write-Ok "updated to latest $Branch"
  } catch {
    Write-Warn "update failed, keep current files"
  } finally { Pop-Location }
} elseif (Test-Path $Dir) {
  Write-Bad "target exists but is not a git repo: $Dir (choose another: -Dir D:\QQCompanion)"
  exit 1
} else {
  & git clone --depth 1 --branch $Branch $Repo $Dir
  if ($LASTEXITCODE -ne 0) { Write-Bad "clone failed: $Repo"; exit 1 }
  Write-Ok "cloned to $Dir"
}

Push-Location $Dir
try {
  # ---------- 3. 配置 ----------
  Write-Step '3/5  Config'
  if (Test-Path 'config.json') {
    Write-Ok 'config.json exists, not overwriting'
  } else {
    Copy-Item 'config.example.json' 'config.json'
    Write-Ok 'created config.json from config.example.json'
    Write-Host '       fill in: brain.apiKey / onebot.url / onebot.accessToken' -ForegroundColor DarkGray
  }
  foreach ($d in @('data', 'data\memory', 'data\groups')) {
    if (-not (Test-Path $d)) { New-Item -ItemType Directory -Path $d -Force | Out-Null }
  }
  Write-Ok 'data/ ready'

  # ---------- 4. 自检 ----------
  Write-Step '4/5  Self-check'
  if ($NoTest) {
    Write-Warn 'skipped (-NoTest)'
  } else {
    & node tools/install.js --no-test | Out-Null
    if ($LASTEXITCODE -eq 0) { Write-Ok 'installer check passed' } else { Write-Warn 'installer check had warnings' }

    & node tools/run-tests.js
    if ($LASTEXITCODE -eq 0) { Write-Ok 'all tests passed' } else { Write-Warn 'some tests failed, see output above' }
  }

  # ---------- 5. 完成 ----------
  Write-Step '5/5  Done'
  Write-Ok "installed at: $Dir"
  Write-Host ''
  Write-Host 'Next steps:' -ForegroundColor White
  Write-Host "  1) edit config   notepad `"$Dir\config.json`""
  Write-Host '        brain.apiKey        your LLM API key (e.g. DeepSeek sk-...)'
  Write-Host '        onebot.url          OneBot endpoint, default ws://127.0.0.1:3001'
  Write-Host '        onebot.accessToken  token set in NapCat (leave empty if none)'
  Write-Host "  2) check endpoint   cd `"$Dir`"; node src/onebot-main.js --check"
  Write-Host "  3) start            cd `"$Dir`"; node src/onebot-main.js"
  Write-Host ''
  Write-Host '  re-check anytime: node tools/install.js --check' -ForegroundColor DarkGray
} finally {
  Pop-Location
}
