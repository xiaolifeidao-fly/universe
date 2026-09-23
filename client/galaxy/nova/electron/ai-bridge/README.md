# ai-bridge

Nova 桌面桥接的**薄壳**，362 行。它只做三件事：

1. 入参校验（zod）—— IPC 边界上的错误在这一层就说清楚，不进原生模块；
2. 把变更串行化 —— 并发的 start / stop / pair 不该互相插队；
3. 首次启动时把 `config.example.yaml` 铺到用户配置目录。

**实现全部在 [`../ai-bridge-native`](../ai-bridge-native)（Rust）**：配置解析、鉴权、
并发闸门、上游凭据、relay 透传、共享算力池运行循环。那边的 README 讲系统本身
——访问控制、端点、共享池的边界、已知限制。

```
src/desktop/
├── worker.ts    Electron UtilityProcess 的私有通道入口
├── service.ts   薄壳本体
├── paths.ts     默认配置路径（XDG；Nova 会用 AI_BRIDGE_CONFIG 指到自己的 userData）
└── scopes.ts    ScopeSchema，只用来挡 IPC 入参
```

## 开发

```bash
npm run build --workspace @galaxy/ai-bridge-native   # 先出 .node，本包按包名解析它
npm run typecheck
npm test        # 桌面生命周期 + IPC 契约形状
npm run build
```

## 历史

2026-09 之前这里是一整棵 TypeScript 实现（约 10800 行）外加一个独立 CLI
（`main.js start` + LaunchAgent/systemd 部署）。整体迁到 Rust 之后那些代码已删除；
无头节点现在由 Nova 常驻承担，不再有 CLI 入口。要翻旧实现去 git 历史。
