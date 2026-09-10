#!/usr/bin/env bash
# 独立 CLI 安装：编译 → 初始化配置/admin token → 后台启动。
# scripts/install.sh         relay 模式
# scripts/install.sh --pool  共享池模式：配对后安装系统服务
# Nova 桌面应用由 Electron 管理生命周期，不调用此脚本。
set -euo pipefail
bridge_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
pool_mode=0
for a in "$@"; do
  case "$a" in
    --pool) pool_mode=1 ;;
    *) echo "未知参数：$a；用法：scripts/install.sh [--pool]" >&2; exit 1 ;;
  esac
done

cd "$bridge_root"
command -v node >/dev/null || { echo "需要 Node.js >= 20" >&2; exit 1; }
npm ci --no-audit --no-fund
npm run build
# init 已经跑过就跳过：它会重新生成 admin token，覆盖掉用户已经发出去的那把。
if [[ -f "$(node dist/main.js config path 2>/dev/null || true)" ]]; then
  echo "配置已存在，跳过 init"
else
  node dist/main.js init
fi

# supervise 把节点交给系统自带的 supervisor（launchd / systemd --user / 计划任务）。
# 装不上就退回 nohup，并且说清楚代价 —— 装不上不该让整条安装流程失败。
supervise() {
  if bash "$bridge_root/scripts/service.sh" install; then
    return 0
  fi
  echo "交给系统托管失败，改用后台进程：注销或关机后需要手工再起一次。" >&2
  bash "$bridge_root/scripts/start.sh"
}

if [[ $pool_mode == 1 ]]; then
  echo
  echo "接下来在浏览器里完成配对。"
  # 不再 exec：配对完还得把节点常驻起来，exec 掉这个 shell 就没人干这件事了。
  # 以前这里 exec，于是贡献者配对完什么都没启动，控制台上永远是「离线」。
  node dist/main.js pool setup

  # 配对成功才装服务。向导 15 分钟无操作也会自己退，那时候还没配对，
  # 装一个连不上 Hub 的常驻进程只会在日志里刷错误。
  # 用 pool status 判断而不是猜 node-token.json 的路径 —— tokenFile 是可配的。
  if node dist/main.js pool status >/dev/null 2>&1; then
    echo
    echo "配对完成，把节点交给系统托管（挂了自动拉起、登录自启）……"
    supervise
  else
    echo
    echo "还没配对完。配对之后跑这条把节点常驻起来："
    echo "  bash $bridge_root/scripts/service.sh install"
  fi
  exit 0
fi


supervise
echo
echo "下一步：用 \`ai-bridge token add --alias <名字>\` 给每个调用方发 token；"
echo "Claude Code 侧：ANTHROPIC_BASE_URL=http://127.0.0.1:8787 ANTHROPIC_AUTH_TOKEN=<token> claude"
echo "Codex 侧：在 ~/.codex/config.toml 加 model_providers（见 README.md 的客户端连接说明）"
