#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PID_FILE="${ROOT_DIR}/run/galaxy-api.pid"
CONFIG_FILE="${ROOT_DIR}/configs/application.properties"

address="${GALAXY_API_ADDR:-}"
if [[ -z "${address}" && -f "${CONFIG_FILE}" ]]; then
  address="$(awk -F= '$1 == "server.address" { gsub(/[[:space:]]/, "", $2); print $2; exit }' "${CONFIG_FILE}")"
fi
address="${address:-:10004}"
port="${address##*:}"

if [[ ! -f "${PID_FILE}" ]]; then
  echo "galaxy-api is not managed by this script (no ${PID_FILE})."
  # 常见情况：进程是 go run 或手工起的。这里不擅自 kill 一个不认识的进程，
  # 只把占端口的 pid 报出来 —— 否则下一次 start.sh 只会说「端口被占」。
  holder="$(lsof -ti "TCP:${port}" -sTCP:LISTEN 2>/dev/null || true)"
  if [[ -n "${holder}" ]]; then
    echo "Port ${port} is held by pid(s): ${holder}"
    echo "If that is your galaxy-api, stop it with: kill ${holder}"
  fi
  exit 0
fi

pid="$(cat "${PID_FILE}")"
# SIGTERM 之后要等多久。进程收到信号会先停止领新活、等在途请求跑完再退出，
# 所以这里等的是「它把手上的活干完」，不是「它反应过来」。
# 控制台没有长连接，在途请求都是秒级的，等一分钟绰绰有余。
# 急着重启就设小一点：没跑完的连接会被强制关掉，代价是那些请求当场失败。
wait_seconds="${GALAXY_STOP_WAIT_SECONDS:-60}"

if kill -0 "${pid}" 2>/dev/null; then
  kill "${pid}"
  echo "sent SIGTERM to galaxy-api (pid ${pid}); waiting up to ${wait_seconds}s for in-flight requests"
  for _ in $(seq 1 "${wait_seconds}"); do
    if ! kill -0 "${pid}" 2>/dev/null; then
      break
    fi
    sleep 1
  done
fi

if kill -0 "${pid}" 2>/dev/null; then
  echo "galaxy-api did not stop cleanly (pid ${pid}); escalate with: kill -9 ${pid}"
  exit 1
fi

rm -f "${PID_FILE}"
echo "galaxy-api stopped"
