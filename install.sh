#!/usr/bin/env bash
# QQCompanion 一键安装（macOS / Linux / WSL）
#
#   curl -fsSL https://raw.githubusercontent.com/illenial-eml/QQCompanion/main/install.sh | bash
#
# 或者先下载再跑（能看清内容）：
#   curl -fsSLO https://raw.githubusercontent.com/illenial-eml/QQCompanion/main/install.sh
#   bash install.sh
#
# 可选环境变量：
#   QC_DIR=~/QQCompanion   装到哪（默认 ~/QQCompanion）
#   QC_REPO=<git-url>      换一个仓库地址
#   QC_BRANCH=main         换分支
#   QC_NO_TEST=1           跳过自检
set -euo pipefail

REPO_URL="${QC_REPO:-https://github.com/illenial-eml/QQCompanion.git}"
TARGET="${QC_DIR:-$HOME/QQCompanion}"
BRANCH="${QC_BRANCH:-main}"
MIN_NODE=22

c_reset=$'\033[0m'; c_bold=$'\033[1m'; c_dim=$'\033[2m'
c_green=$'\033[32m'; c_yellow=$'\033[33m'; c_red=$'\033[31m'; c_cyan=$'\033[36m'
ok()   { printf '%s✓%s %s\n' "$c_green" "$c_reset" "$1"; }
warn() { printf '%s!%s %s\n' "$c_yellow" "$c_reset" "$1"; }
die()  { printf '%s✗%s %s\n' "$c_red" "$c_reset" "$1" >&2; exit 1; }
step() { printf '\n%s%s%s%s\n' "$c_bold" "$c_cyan" "$1" "$c_reset"; }

printf '%sQQCompanion 安装向导%s %s(%s)%s\n' "$c_bold" "$c_reset" "$c_dim" "$(uname -s 2>/dev/null || echo unknown)" "$c_reset"

# ---------- 1. 环境 ----------
step '1/5  检查环境'

command -v git >/dev/null 2>&1 || die '没装 git。Debian/Ubuntu: sudo apt install -y git ；macOS: xcode-select --install'

if command -v node >/dev/null 2>&1; then
  NODE_V=$(node -v | sed 's/^v//')
  NODE_MAJOR=${NODE_V%%.*}
  if [ "$NODE_MAJOR" -ge "$MIN_NODE" ] 2>/dev/null; then
    ok "Node.js v$NODE_V"
  else
    die "Node.js v$NODE_V 太旧，需要 ≥ $MIN_NODE。升级：nvm install 22 && nvm use 22"
  fi
else
  die '没装 Node.js。Debian/Ubuntu: curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt install -y nodejs ；macOS: brew install node'
fi

command -v npm >/dev/null 2>&1 && ok "npm $(npm -v)" || warn '没有 npm（本项目零依赖，不影响）'

# ---------- 2. 取代码 ----------
step '2/5  获取代码'
if [ -d "$TARGET/.git" ]; then
  ok "目录已存在：$TARGET"
  ( cd "$TARGET" && git fetch --depth 1 origin "$BRANCH" >/dev/null 2>&1 \
    && git checkout -q "$BRANCH" \
    && git reset --hard -q "origin/$BRANCH" ) && ok "已更新到最新 $BRANCH" || warn '更新失败，继续用现有代码'
elif [ -e "$TARGET" ]; then
  die "目标目录已存在但不是 git 仓库：$TARGET（换个位置：QC_DIR=~/新目录 bash install.sh）"
else
  ok "克隆到 $TARGET"
  git clone --depth 1 --branch "$BRANCH" "$REPO_URL" "$TARGET" || die "克隆失败：$REPO_URL（检查网络/代理）"
fi

cd "$TARGET"

# ---------- 3. 配置 ----------
step '3/5  生成配置'
if [ -f config.json ]; then
  ok 'config.json 已存在，不会覆盖'
else
  cp config.example.json config.json
  ok '已从 config.example.json 生成 config.json'
  printf '%s   还需要填：brain.apiKey / onebot.url / onebot.accessToken%s\n' "$c_dim" "$c_reset"
fi
mkdir -p data/memory data/groups
ok 'data/ 等运行目录就绪'

# ---------- 4. 自检 ----------
step '4/5  自检'
if [ "${QC_NO_TEST:-0}" = "1" ]; then
  warn '已按 QC_NO_TEST=1 跳过'
else
  if node tools/install.js --no-test >/dev/null 2>&1; then ok '安装向导自检通过'; else warn '安装向导自检有告警（不影响继续）'; fi
  if node tools/run-tests.js; then ok '测试全部通过'; else warn '测试有失败项，先别急着启动'; fi
fi

# ---------- 5. 完成 ----------
step '5/5  完成'
ok "代码位置：$TARGET"
cat <<EOF

${c_bold}接下来三步：${c_reset}
  1) 编辑配置      \$EDITOR "$TARGET/config.json"
        brain.apiKey        大模型 API key（如 DeepSeek sk-...）
        onebot.url          OneBot 协议端，默认 ws://127.0.0.1:3001
        onebot.accessToken  NapCat 里设的 token（没设留空）
  2) 确认协议端通    cd "$TARGET" && node src/onebot-main.js --check
  3) 启动            cd "$TARGET" && node src/onebot-main.js

${c_dim}重新检查环境随时执行：node tools/install.js --check${c_reset}
EOF
