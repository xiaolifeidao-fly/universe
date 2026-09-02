#!/usr/bin/env bash
set -euo pipefail

APP_NAME="delivery-app"
PORT="${PORT:-7895}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PID_FILE="${SCRIPT_DIR}/run/${APP_NAME}.pid"

if [[ ! -f "${PID_FILE}" ]]; then
  echo "${APP_NAME} is not managed by this script (no ${PID_FILE})."
  # 进程可能是 npm run dev 或手工起的：不擅自 kill 陌生进程，只把占端口的 pid 报出来。
  holder="$(lsof -ti "TCP:${PORT}" -sTCP:LISTEN 2>/dev/null || true)"
  if [[ -n "${holder}" ]]; then
    echo "Port ${PORT} is held by pid(s): ${holder}"
    echo "If that is your ${APP_NAME}, stop it with: kill ${holder}"
  fi
  exit 0
fi

pid="$(cat "${PID_FILE}")"
if kill -0 "${pid}" 2>/dev/null; then
  kill "${pid}"
  for _ in {1..10}; do
    if ! kill -0 "${pid}" 2>/dev/null; then
      break
    fi
    sleep 1
  done
fi

if kill -0 "${pid}" 2>/dev/null; then
  echo "${APP_NAME} did not stop cleanly (pid ${pid}); escalate with: kill -9 ${pid}"
  exit 1
fi

rm -f "${PID_FILE}"
echo "${APP_NAME} stopped"
