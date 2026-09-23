#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PID_FILE="${ROOT_DIR}/run/galaxy-consumer-api.pid"
LOG_DIR="${ROOT_DIR}/logs"
CONFIG_FILE="${ROOT_DIR}/configs/application.properties"

# 端口的算法必须和 stop.sh / main.go 完全一致，否则「起不来」和「停不掉」
# 会各说各话：一个在看 10002，另一个在看 configs 里的地址。
address="${GALAXY_CONSUMER_API_ADDR:-}"
if [[ -z "${address}" && -f "${CONFIG_FILE}" ]]; then
  address="$(awk -F= '$1 == "server.address" { gsub(/[[:space:]]/, "", $2); print $2; exit }' "${CONFIG_FILE}")"
fi
address="${address:-:10005}"
port="${address##*:}"

if [[ -f "${PID_FILE}" ]] && kill -0 "$(cat "${PID_FILE}")" 2>/dev/null; then
  echo "galaxy-consumer-api is already running (pid $(cat "${PID_FILE}"))"
  exit 0
fi

holder="$(lsof -ti "TCP:${port}" -sTCP:LISTEN 2>/dev/null || true)"
if [[ -n "${holder}" ]]; then
  echo "Port ${port} is already in use by pid(s) ${holder}; galaxy-consumer-api was not started."
  echo "That is usually an older galaxy-consumer-api started outside these scripts: kill ${holder}"
  exit 1
fi

if [[ ! -x "${ROOT_DIR}/bin/galaxy-consumer-api" ]]; then
  "${ROOT_DIR}/build.sh"
fi

mkdir -p "${ROOT_DIR}/run" "${LOG_DIR}"
cd "${ROOT_DIR}"
nohup env GALAXY_CONSUMER_API_ADDR="${address}" ./bin/galaxy-consumer-api >>"${LOG_DIR}/galaxy-consumer-api.log" 2>&1 &
echo $! >"${PID_FILE}"

for _ in {1..20}; do
  if curl -fsS "http://127.0.0.1:${port}/healthz" >/dev/null 2>&1; then
    echo "galaxy-consumer-api started on ${address} (pid $(cat "${PID_FILE}"))"
    exit 0
  fi
  sleep 1
done

echo "galaxy-consumer-api did not become ready; inspect ${LOG_DIR}/galaxy-consumer-api.log"
exit 1
