#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PRODUCT="${1:-nova}"
case "$PRODUCT" in nova|orbit) ;; *) echo "Usage: $0 [nova|orbit]" >&2; exit 1;; esac
# Foreground desktop launcher. 界面从远端加载，本机不起 Next ——
# 跑之前先确认 GALAXY_<端>_APP_ORIGIN（或打包时冻结的 APP_ORIGIN）指向已部署的控制台。
exec node "$SCRIPT_DIR/scripts/desktop.cjs" start "$PRODUCT"
