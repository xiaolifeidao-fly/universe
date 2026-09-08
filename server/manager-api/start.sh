#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PID_FILE="${ROOT_DIR}/run/manager-api.pid"
LOG_DIR="${ROOT_DIR}/logs"
CONFIG_FILE="${ROOT_DIR}/configs/application.properties"

# 端口的算法必须和 stop.sh / main.go 完全一致，否则「起不来」和「停不掉」
# 会各说各话：一个在看 10003，另一个在看 configs 里的地址。
address="${MANAGER_API_ADDR:-}"
if [[ -z "${address}" && -f "${CONFIG_FILE}" ]]; then
  address="$(awk -F= '$1 == "server.address" { gsub(/[[:space:]]/, "", $2); print $2; exit }' "${CONFIG_FILE}")"
fi
address="${address:-:10003}"
port="${address##*:}"

if [[ -f "${PID_FILE}" ]] && kill -0 "$(cat "${PID_FILE}")" 2>/dev/null; then
  echo "manager-api is already running (pid $(cat "${PID_FILE}"))"
  exit 0
fi

holder="$(lsof -ti "TCP:${port}" -sTCP:LISTEN 2>/dev/null || true)"
if [[ -n "${holder}" ]]; then
  echo "Port ${port} is already in use by pid(s) ${holder}; manager-api was not started."
  echo "That is usually an older manager-api started outside these scripts: kill ${holder}"
  exit 1
fi

if [[ ! -x "${ROOT_DIR}/bin/manager-api" ]]; then
  "${ROOT_DIR}/build.sh"
fi

mkdir -p "${ROOT_DIR}/run" "${LOG_DIR}"
cd "${ROOT_DIR}"
nohup env MANAGER_API_ADDR="${address}" ./bin/manager-api >>"${LOG_DIR}/manager-api.log" 2>&1 &
echo $! >"${PID_FILE}"

for _ in {1..20}; do
  if curl -fsS "http://127.0.0.1:${port}/healthz" >/dev/null 2>&1; then
    echo "manager-api started on ${address} (pid $(cat "${PID_FILE}"))"
    exit 0
  fi
  sleep 1
done

echo "manager-api did not become ready; inspect ${LOG_DIR}/manager-api.log"
exit 1
