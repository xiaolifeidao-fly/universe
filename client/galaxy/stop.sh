#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PRODUCT="${1:-nova}"
case "$PRODUCT" in nova|orbit) ;; *) echo "Usage: $0 [nova|orbit]" >&2; exit 1;; esac
PID_FILE="$SCRIPT_DIR/run/$PRODUCT.pid"
if [[ ! -f "$PID_FILE" ]]; then
  echo "$PRODUCT has no managed launcher. Close its desktop window if running as an installed app."
  exit 0
fi
pid="$(cat "$PID_FILE")"
case "$pid" in ''|*[!0-9]*) echo "Invalid launcher pid" >&2; exit 1;; esac
command_line="$(ps -p "$pid" -o command= 2>/dev/null || true)"
case "$command_line" in
  *scripts/desktop.cjs*" $PRODUCT") kill "$pid"; echo "$PRODUCT launcher stopped";;
  *) echo "No matching launcher process; removing stale pid file"; rm -f "$PID_FILE";;
esac
