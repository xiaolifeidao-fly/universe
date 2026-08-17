# syntax=docker/dockerfile:1.7

FROM --platform=$BUILDPLATFORM golang:1.21-alpine AS builder

WORKDIR /src

# Preserve the relative paths used by web-api's local module replacements so
# dependency resolution works with GOWORK disabled inside the build container.
COPY common/go.mod common/go.sum ./common/
COPY contract/go.mod ./contract/
COPY delivery-api/go.mod delivery-api/go.sum ./delivery-api/
COPY service/go.mod service/go.sum ./service/
COPY web-api/go.mod web-api/go.sum ./web-api/

RUN --mount=type=cache,target=/go/pkg/mod \
    cd /src/web-api && GOWORK=off go mod download

COPY common ./common
COPY contract ./contract
COPY delivery-api ./delivery-api
COPY service ./service
COPY web-api ./web-api

ARG TARGETOS
ARG TARGETARCH
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    cd /src/web-api && \
    CGO_ENABLED=0 GOOS="$TARGETOS" GOARCH="$TARGETARCH" GOWORK=off \
    go build -trimpath -ldflags='-s -w' -o /out/web-api .

FROM alpine:3.20 AS runtime

RUN apk add --no-cache ca-certificates curl tzdata && \
    addgroup -S webapi && \
    adduser -S -G webapi -h /app -s /sbin/nologin webapi && \
    mkdir -p /app/configs && \
    chown -R webapi:webapi /app

WORKDIR /app

COPY --from=builder --chown=webapi:webapi /out/web-api /app/web-api
COPY --chown=webapi:webapi web-api/docker-entrypoint.sh /usr/local/bin/docker-entrypoint

USER webapi

ENV WEB_API_ADDR=:10001 \
    TZ=UTC

EXPOSE 10001

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
    CMD curl --fail --silent --show-error http://127.0.0.1:10001/healthz || exit 1

ENTRYPOINT ["/usr/local/bin/docker-entrypoint"]
