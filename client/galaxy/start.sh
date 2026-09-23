#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PRODUCT="${1:-nova}"
case "$PRODUCT" in nova|orbit) ;; *) echo "Usage: $0 [nova|orbit]" >&2; exit 1;; esac
# Foreground desktop launcher. 界面从远端加载，本机不起 Next ——
# 不给任何环境变量就是打开正式部署（@galaxy/common 的 defaultOrigin，
# 即 https://www.galaxy.rodeo/nova 与 /orbit）。要连别的环境就先导
# GALAXY_<端>_APP_ORIGIN（或 GALAXY_APP_ORIGIN）。
exec node "$SCRIPT_DIR/scripts/desktop.cjs" start "$PRODUCT"
