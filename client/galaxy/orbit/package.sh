#!/usr/bin/env bash
set -euo pipefail
export LC_ALL=C
export LANG=C

# Orbit（使用端）桌面客户端的打包：只出**安装包**，落在 release/orbit/。
#
# 不顺带构建界面那份 standalone —— 安装包里没有 Next 服务，壳只负责 loadURL
# 远端地址，界面是另一条发版线（orbit/webview/package.sh 打 tar.gz 上服务器）。
# 少跑这一步还避开一件事：界面的构建会重写 orbit/webview/.next，本机常驻着
# next dev 的话那个开发服务器会当场开始报 ChunkLoadError。
# 两样都要就在工作区跑 ../package.sh orbit（等价于 npm run package:orbit）。
PRODUCT="orbit"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKSPACE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# 不给参数就是本机那一份（macOS 上 dmg + zip）。要出别的平台/架构就往后加，
# 参数原样转给 electron-builder：
#
#   ./package.sh --mac --arm64 --x64     Intel 与 Apple 芯片两份
#   ./package.sh --win --x64             Windows 安装包
#
# **一个平台的几个架构必须在同一条命令里出**：electron-builder 每跑一次就重写一遍
# 那个平台的 latest-*.yml，分两次跑的话后一次会把前一次的架构从清单里挤掉，
# 于是另一半用户永远收不到更新（清单里没有他那一片，客户端只会说「已经是最新」）。
#
# 这个包默认连哪个控制台由 APP_ORIGIN 冻结进去，不给就是 @galaxy/common 的
# defaultOrigin（正式环境）；发测试包时给它：
#
#   APP_ORIGIN=https://test.galaxy.example ./package.sh
cd "$WORKSPACE_DIR"
exec node scripts/desktop.cjs package "$PRODUCT" --no-webview "$@"
