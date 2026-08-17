#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

cd "${ROOT_DIR}"
mkdir -p bin
GOWORK=off go build -o bin/web-api .

echo "Built ${ROOT_DIR}/bin/web-api"
