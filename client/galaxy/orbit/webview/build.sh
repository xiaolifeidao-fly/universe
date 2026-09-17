#!/usr/bin/env bash
set -euo pipefail

# Orbit（使用端）界面的构建：只出「要部署到远端服务器」的 Next standalone 包。
# 不编 Electron 壳、不编 Rust 桥接 —— 那些是工作区 ../../package.sh orbit 的事，
# 一台只跑界面的服务器不该为了发一个前端去装 Rust 工具链。
PRODUCT="orbit"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKSPACE_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"

cd "$WORKSPACE_DIR"
exec node scripts/build-webview.cjs "$PRODUCT"
