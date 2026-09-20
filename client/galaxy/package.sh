#!/usr/bin/env bash
set -euo pipefail
export LC_ALL=C
export LANG=C
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PRODUCT="${1:-nova}"
case "$PRODUCT" in nova|orbit) ;; *) echo "Usage: $0 [nova|orbit] [--mac --arm64 --x64 | --win --x64]" >&2; exit 1;; esac
shift || true
# Each app packages its own Electron entry and standalone Next.js webview.
# The raw .env is excluded; only public backend connection settings are bundled.
# 不给平台参数就是本机那一份；一个平台的多个架构要在同一条命令里给（见 scripts/desktop.cjs）。
exec node "$SCRIPT_DIR/scripts/desktop.cjs" package "$PRODUCT" "$@"
