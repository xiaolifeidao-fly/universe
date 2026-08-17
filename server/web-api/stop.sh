#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PID_FILE="${ROOT_DIR}/run/web-api.pid"
CONFIG_FILE="${ROOT_DIR}/configs/application.properties"

# 端口的算法必须和 start.sh / main.go 完全一致，否则「停不掉」和「起不来」
# 会各说各话：一个在看 10001，另一个在看 8691。
address="${WEB_API_ADDR:-}"
if [[ -z "${address}" && -f "${CONFIG_FILE}" ]]; then
  address="$(awk -F= '$1 == "server.address" { gsub(/[[:space:]]/, "", $2); print $2; exit }' "${CONFIG_FILE}")"
fi
address="${address:-:10001}"
port="${address##*:}"

if [[ ! -f "${PID_FILE}" ]]; then
  echo "web-api is not managed by this script (no ${PID_FILE})."
  # 常见情况：进程是 go run 或手工起的。这里不擅自 kill 一个不认识的进程，
  # 只把占端口的 pid 报出来 —— 否则下一次 start.sh 只会说「端口被占」，
  # 你还得自己 lsof 一遍。
  holder="$(lsof -ti "TCP:${port}" -sTCP:LISTEN 2>/dev/null || true)"
  if [[ -n "${holder}" ]]; then
    echo "Port ${port} is held by pid(s): ${holder}"
    echo "If that is your web-api, stop it with: kill ${holder}"
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
  echo "web-api did not stop cleanly (pid ${pid}); escalate with: kill -9 ${pid}"
  exit 1
fi

rm -f "${PID_FILE}"
echo "web-api stopped"
