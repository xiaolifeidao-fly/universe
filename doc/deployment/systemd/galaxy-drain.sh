#!/usr/bin/env bash
#
# 把一台 Hub 摘出轮转 / 放回轮转，配合服务自己的优雅退出用。
#
#   ./galaxy-drain.sh out     hub-1     摘出轮转（新请求不再进来，在途的继续送完）
#   ./galaxy-drain.sh in      hub-1     放回轮转
#   ./galaxy-drain.sh restart hub-1     摘出 → 停 → 起 → 放回，一次发版
#
# 「摘」摘的是**轮转入口**（upstream galaxy_hub 里这台的 server 行），
# **不动** /instance/<名> 那条定向路由 —— 在途单元的 streamURL 指向的就是这台，
# 节点还要回来把剩下的字节推完。把定向路由一起摘掉等于亲手掐断自己要保的那些请求。
#
# 前提：nginx 的 upstream 里每台的 server 行末尾带一个标识注释，例如
#
#     upstream galaxy_hub {
#         server 127.0.0.1:10006;   # hub-1
#         server 10.0.0.12:10006;   # hub-2
#     }
#
# 单实例部署用不上这个脚本：没有别的机器接管，摘出去就是停服。
# 那种情况直接 systemctl stop 即可 —— 优雅退出仍然保证在途请求跑完再退，
# 只是停机窗口里的新请求没人接。
set -euo pipefail

action="${1:-}"
tag="${2:-}"
conf="${GALAXY_NGINX_CONF:-/etc/nginx/conf.d/www.galaxy.rodeo.conf}"
service="${GALAXY_SERVICE:-galaxy-hub-api}"
settle="${GALAXY_DRAIN_SETTLE_SECONDS:-5}"

if [[ -z "${action}" || -z "${tag}" ]]; then
  sed -n '2,12p' "$0" >&2
  exit 2
fi
if [[ ! -w "${conf}" ]]; then
  echo "改不了 ${conf}（不存在或没有写权限），用 sudo 跑，或用 GALAXY_NGINX_CONF 指到正确的文件" >&2
  exit 1
fi
if ! grep -qE "^[[:space:]]*server[[:space:]]+[^;]+;[[:space:]]*#[[:space:]]*${tag}[[:space:]]*$" "${conf}"; then
  echo "${conf} 里找不到标着 # ${tag} 的 server 行；给每台的 server 行加上标识注释再来" >&2
  exit 1
fi

reload() {
  # 先验再 reload。配置写坏时 nginx -t 会明说哪一行，而 reload 失败只会留下
  # 一个「还在用旧配置」的假象 —— 你以为摘掉了，其实流量照进。
  nginx -t
  nginx -s reload
}

mark_down() {
  sed -i -E "s|^([[:space:]]*server[[:space:]]+[^;]+)(;[[:space:]]*#[[:space:]]*${tag}[[:space:]]*)$|\1 down\2|" "${conf}"
}
mark_up() {
  sed -i -E "s|^([[:space:]]*server[[:space:]]+[^;]+)[[:space:]]+down(;[[:space:]]*#[[:space:]]*${tag}[[:space:]]*)$|\1\2|" "${conf}"
}

case "${action}" in
  out)
    mark_down && reload
    echo "已把 ${tag} 摘出轮转，等 ${settle}s 让在途连接落定"
    sleep "${settle}"
    ;;
  in)
    mark_up && reload
    echo "已把 ${tag} 放回轮转"
    ;;
  restart)
    mark_down && reload
    echo "已把 ${tag} 摘出轮转，等 ${settle}s 让在途连接落定"
    sleep "${settle}"
    # stop 会一直等到在途请求跑完（见各服务的 stop.sh / TimeoutStopSec）。
    systemctl stop "${service}"
    systemctl start "${service}"
    # 起来之后等就绪再放回，别把流量倒给一个还在加载配置的进程。
    for _ in $(seq 1 30); do
      if curl -fsS "http://127.0.0.1:10006/readyz" >/dev/null 2>&1; then break; fi
      sleep 1
    done
    mark_up && reload
    echo "${tag} 已重启并放回轮转"
    ;;
  *)
    echo "未知动作 ${action}，只认 out / in / restart" >&2
    exit 2
    ;;
esac
