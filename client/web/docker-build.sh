#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IMAGE_TAG="${1:-${IMAGE_TAG:-universe-client-web:local}}"

docker build \
  --tag "$IMAGE_TAG" \
  --file "$SCRIPT_DIR/Dockerfile" \
  "$SCRIPT_DIR"
