#!/bin/sh
set -eu

required_value() {
    variable_name="$1"
    variable_value="$2"
    if [ -z "$variable_value" ]; then
        echo "$variable_name is required" >&2
        exit 1
    fi
    printf '%s' "$variable_value"
}

reject_newlines() {
    variable_name="$1"
    variable_value="$2"
    newline='
'
    carriage_return="$(printf '\r')"

    case "$variable_value" in
        *"$newline"* | *"$carriage_return"*)
            echo "$variable_name must not contain newlines" >&2
            exit 1
            ;;
    esac
}

sqlconn="$(required_value WEB_API_SQLCONN "${WEB_API_SQLCONN:-}")"
token_secret="$(required_value WEB_API_AUTH_TOKEN_SECRET "${WEB_API_AUTH_TOKEN_SECRET:-}")"
token_ttl_seconds="${WEB_API_AUTH_TOKEN_TTL_SECONDS:-604800}"
listen_address="${WEB_API_ADDR:-:10001}"
business_kodes_remote_url="${WEB_API_BUSINESS_KODES_REMOTE_URL:-}"
business_kodes_model="${WEB_API_BUSINESS_KODES_MODEL:-}"
business_kodes_reasoning_effort="${WEB_API_BUSINESS_KODES_REASONING_EFFORT:-medium}"
business_kodes_timeout_seconds="${WEB_API_BUSINESS_KODES_TIMEOUT_SECONDS:-60}"

case "$token_ttl_seconds" in
    0 | 0[0-9]* | *[!0-9]* | '')
        echo "WEB_API_AUTH_TOKEN_TTL_SECONDS must be a positive integer" >&2
        exit 1
        ;;
esac

case "$business_kodes_timeout_seconds" in
    0 | 0[0-9]* | *[!0-9]* | '')
        echo "WEB_API_BUSINESS_KODES_TIMEOUT_SECONDS must be a positive integer" >&2
        exit 1
        ;;
esac

reject_newlines WEB_API_SQLCONN "$sqlconn"
reject_newlines WEB_API_AUTH_TOKEN_SECRET "$token_secret"
reject_newlines WEB_API_AUTH_TOKEN_TTL_SECONDS "$token_ttl_seconds"
reject_newlines WEB_API_ADDR "$listen_address"
reject_newlines WEB_API_BUSINESS_KODES_REMOTE_URL "$business_kodes_remote_url"
reject_newlines WEB_API_BUSINESS_KODES_MODEL "$business_kodes_model"
reject_newlines WEB_API_BUSINESS_KODES_REASONING_EFFORT "$business_kodes_reasoning_effort"
reject_newlines WEB_API_BUSINESS_KODES_TIMEOUT_SECONDS "$business_kodes_timeout_seconds"

umask 077
config_file="$(mktemp /app/configs/application.properties.XXXXXX)"
trap 'rm -f "$config_file"' EXIT

{
    printf '%s\n' '# Generated at container startup. Do not add this file to an image.'
    printf '%s\n' "server.address=${listen_address}"
    printf '%s\n' "sqlconn=${sqlconn}"
    printf '%s\n' 'log.dir=/tmp'
    printf '%s\n' "auth.token_ttl_seconds=${token_ttl_seconds}"
    printf '%s\n' "auth.token_secret=${token_secret}"
    printf '%s\n' "business.kodes.remote_url=${business_kodes_remote_url}"
    printf '%s\n' "business.kodes.model=${business_kodes_model}"
    printf '%s\n' "business.kodes.reasoning_effort=${business_kodes_reasoning_effort}"
    printf '%s\n' "business.kodes.timeout_seconds=${business_kodes_timeout_seconds}"
} >"$config_file"

mv "$config_file" /app/configs/application.properties
trap - EXIT

exec /app/web-api "$@"
