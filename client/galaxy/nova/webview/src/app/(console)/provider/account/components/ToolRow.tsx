"use client";

/**
 * 「本机工具」里的一格：名字 · 版本 · 这会儿该给它什么。
 *
 * 两处都用它：这台电脑（问本机 bridge 拿的 ToolStatus）和别的机器（机器自报、
 * 跟着心跳回来的 NodeTool）。两边的形状是对齐的 —— 同一份 Rust 结构序列化出来的，
 * 一份直接走 IPC，一份绕了 Hub 一圈。共用一个组件，界面上的说法也就不会分叉。
 *
 * 装着的时候这一格变成进度。阶段（查依赖 / 下载 / 写入本机）是从 npm 的输出里
 * **认出来**的，百分比是按取了几个包估的 —— npm 根本不报百分比，所以旁边还写着一个
 * 真的秒数：卡住的时候，不动的秒数比不动的进度条更说明问题。
 *
 * 远端那台多一个 pending：指令已经发出去、机器还没来领的那十几秒。不画它的话，
 * 点完按钮到机器下一次心跳之间什么都不会变，看起来就像没点上。
 *
 * 装挂了不自动重来，也不把那条记录一抹了事：原因留在这儿（鼠标停上去是原话和
 * 那条命令，实在不行照着去终端跑一遍），旁边给一个「重试」。
 */

import { Btn } from "@/components/ui/kit";
import { formatMillis } from "@/utils/format";

/** 两端共用的形状。本机的 ToolStatus 与远端的 NodeTool 都满足它。 */
export interface ToolRowItem {
  name: string;
  current: string;
  latest: string;
  upgradable: boolean;
  installed: boolean;
  job?: ToolRowJob;
}

export interface ToolRowJob {
  action: "install" | "upgrade";
  state: "pending" | "running" | "succeeded" | "failed";
  phase: string;
  percent: number;
  detail: string;
  elapsedMs: number;
  command: string;
}

/** 还在路上：等机器领（远端）或者正在装。 */
export function isToolJobBusy(job: ToolRowJob | undefined): boolean {
  return job?.state === "pending" || job?.state === "running";
}

export function ToolRow({
  tool,
  busy,
  onRun,
  t,
}: {
  tool: ToolRowItem;
  busy: boolean;
  /** 装、升、失败后重试都是同一件事，所以只有一个回调。 */
  onRun: () => void;
  t: (key: string, vars?: Record<string, string | number>) => string;
}) {
  const job = tool.job;
  const running = isToolJobBusy(job);
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12.5 }}>
      <b style={{ fontWeight: 600 }}>{tool.name}</b>
      <span className="gx-mono gx-muted">{tool.installed ? tool.current : t("bridge.toolsMissing")}</span>
      {running && job ? (
        <>
          <span className="gx-pill gx-pill--sm">
            {t(job.action === "install" ? "bridge.toolsInstalling" : "bridge.toolsUpgrading")}
          </span>
          {/* 进度条只表示「还在动」，所以不给它数字以外的强调色，宽度也压到一行放得下。 */}
          <span className="gx-meter" style={{ display: "block", width: 64, flex: "0 0 auto" }}>
            <span className="gx-meter__fill" style={{ display: "block", width: `${job.percent}%` }} />
          </span>
          <span className="gx-mono" style={{ fontSize: 11, color: "var(--gx-faint)" }} title={job.detail || undefined}>
            {job.percent}% · {t(`bridge.toolsPhase.${job.phase}`)}
            {job.elapsedMs > 0 ? ` · ${formatMillis(job.elapsedMs)}` : ""}
          </span>
        </>
      ) : job?.state === "failed" ? (
        <>
          <span className="gx-pill gx-pill--sm gx-pill--err" title={[job.detail, job.command].filter(Boolean).join("\n\n")}>
            {t("bridge.toolsFailed")}
          </span>
          <Btn tone="soft" small loading={busy} onClick={onRun}>
            {t("bridge.toolsRetry")}
          </Btn>
        </>
      ) : tool.upgradable ? (
        <Btn tone="soft" small loading={busy} onClick={onRun}>
          {t("bridge.toolsUpgrade")} {tool.latest}
        </Btn>
      ) : !tool.installed ? (
        // 没装的工具以前只写一句「未安装」，装它得自己开终端、还得先 ssh 上那台机器 ——
        // 而这台机器接不接得了单，正取决于它装没装。
        <Btn tone="soft" small loading={busy} onClick={onRun}>
          {t("bridge.toolsInstall")}
        </Btn>
      ) : tool.latest ? (
        <span className="gx-pill gx-pill--sm gx-pill--ok">{t("bridge.toolsLatest")}</span>
      ) : null}
    </span>
  );
}
