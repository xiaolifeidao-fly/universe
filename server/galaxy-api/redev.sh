#!/usr/bin/env bash
# 开发期重启：停 → 编 → 起。
#
# 存在的理由是 start.sh 只在二进制**不存在**时才调 build.sh —— 那对部署是对的
# （发布时编一次，之后反复重启跑的都是同一个产物），但在开发期就成了陷阱：
# 改完代码 ./start.sh，进程时间变了、二进制没变，跑的还是上一版。
#
# 注意它只管得住 start.sh 起的进程（认 run/galaxy-api.pid）。手工 ./bin/galaxy-api
# 起的那个没有 pid 文件，stop.sh 不会擅自 kill 一个不认识的进程，只会把占端口的
# pid 报出来 —— 按它给的 kill 命令收掉一次，之后就都走这个脚本了。
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

"${ROOT_DIR}/stop.sh"
"${ROOT_DIR}/build.sh"
"${ROOT_DIR}/start.sh"
