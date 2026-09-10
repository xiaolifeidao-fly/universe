#!/usr/bin/env bash
set -euo pipefail
export LC_ALL=C
export LANG=C
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PRODUCT="${1:-nova}"
case "$PRODUCT" in nova|orbit) ;; *) echo "Usage: $0 [nova|orbit]" >&2; exit 1;; esac
# Each app packages its own Electron entry and standalone Next.js webview.
# The raw .env is excluded; only public backend connection settings are bundled.
exec node "$SCRIPT_DIR/scripts/desktop.cjs" package "$PRODUCT"
