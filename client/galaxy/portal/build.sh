#!/usr/bin/env bash
set -euo pipefail

# 门户站的构建：出「要部署到远端服务器」的 Next standalone 包。
# 门户没有桌面壳，所以这里没有 Electron 那一段 —— 和两个端的 build.sh 是同一个入口。
MEMBER="portal"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKSPACE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$WORKSPACE_DIR"
exec node scripts/build-webview.cjs "$MEMBER"
