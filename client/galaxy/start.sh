#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PRODUCT="${1:-nova}"
case "$PRODUCT" in nova|orbit) ;; *) echo "Usage: $0 [nova|orbit]" >&2; exit 1;; esac
# Foreground desktop launcher. Build the selected webview first with npm run build:<product>.
exec node "$SCRIPT_DIR/scripts/desktop.cjs" start "$PRODUCT"
