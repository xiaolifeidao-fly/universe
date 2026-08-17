#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: build-image.sh [tag] [docker build options...]

Builds server/web-api using server/ as the Docker build context.

Environment:
  IMAGE_NAME  Image repository/name (default: universe-web-api)
  IMAGE_TAG   Image tag when no positional tag is given (default: local)

The optional first positional argument sets the image tag. Remaining Docker
build options such as --platform or --no-cache are passed through. --build-arg
is intentionally rejected: runtime secrets must be supplied when the container
starts, not recorded in an image build.
EOF
}

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE_NAME="${IMAGE_NAME:-universe-web-api}"
IMAGE_TAG="${IMAGE_TAG:-local}"

cd "$ROOT_DIR"

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  usage
  exit 0
fi

if [[ $# -gt 0 && "${1}" != -* ]]; then
  IMAGE_TAG="$1"
  shift
fi

for argument in "$@"; do
  case "$argument" in
    --build-arg | --build-arg=*)
      echo "--build-arg is not supported; inject runtime secrets with docker run -e or your deployment platform." >&2
      exit 2
      ;;
  esac
done

if ! command -v docker >/dev/null 2>&1; then
  echo "docker CLI is required to build ${IMAGE_NAME}:${IMAGE_TAG}" >&2
  exit 127
fi

if ! docker info >/dev/null 2>&1; then
  echo "Docker daemon is not available; start Docker and try again." >&2
  exit 1
fi

exec docker build \
  -f web-api/Dockerfile \
  -t "${IMAGE_NAME}:${IMAGE_TAG}" \
  "$@" \
  .
