#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PID_FILE="${ROOT_DIR}/run/app-api.pid"
LOG_DIR="${ROOT_DIR}/logs"
CONFIG_FILE="${ROOT_DIR}/configs/application.properties"

# 端口的算法必须和 stop.sh / main.go 完全一致，否则「起不来」和「停不掉」
# 会各说各话：一个在看 10002，另一个在看 configs 里的地址。
address="${APP_API_ADDR:-}"
if [[ -z "${address}" && -f "${CONFIG_FILE}" ]]; then
  address="$(awk -F= '$1 == "server.address" { gsub(/[[:space:]]/, "", $2); print $2; exit }' "${CONFIG_FILE}")"
fi
address="${address:-:10002}"
port="${address##*:}"

if [[ -f "${PID_FILE}" ]] && kill -0 "$(cat "${PID_FILE}")" 2>/dev/null; then
  echo "app-api is already running (pid $(cat "${PID_FILE}"))"
  exit 0
fi

holder="$(lsof -ti "TCP:${port}" -sTCP:LISTEN 2>/dev/null || true)"
if [[ -n "${holder}" ]]; then
  echo "Port ${port} is already in use by pid(s) ${holder}; app-api was not started."
  echo "That is usually an older app-api started outside these scripts: kill ${holder}"
  exit 1
fi

if [[ ! -x "${ROOT_DIR}/bin/app-api" ]]; then
  "${ROOT_DIR}/build.sh"
fi

mkdir -p "${ROOT_DIR}/run" "${LOG_DIR}"
cd "${ROOT_DIR}"
nohup env APP_API_ADDR="${address}" ./bin/app-api >>"${LOG_DIR}/app-api.log" 2>&1 &
echo $! >"${PID_FILE}"

for _ in {1..20}; do
  if curl -fsS "http://127.0.0.1:${port}/healthz" >/dev/null 2>&1; then
    echo "app-api started on ${address} (pid $(cat "${PID_FILE}"))"
    exit 0
  fi
  sleep 1
done

echo "app-api did not become ready; inspect ${LOG_DIR}/app-api.log"
exit 1
