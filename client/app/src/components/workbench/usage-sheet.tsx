"use client";

import { useCallback, useEffect, useState } from "react";
import { ChevronRight, Coins, LoaderCircle, RotateCw } from "lucide-react";
import { ApiError } from "@/api/client";
import { getRequirementProgress, type DeliveryItem, type RequirementProgress } from "@/api/management.api";
import { fetchRequirementUsage } from "@/api/workbench.api";
import { Sheet } from "@/components/sheet";
import { RequirementSessionPane } from "@/components/workbench/requirement-session-pane";
import { formatRunDuration, TaskRunDuration, useTotalRunDuration } from "@/components/workbench/run-duration";
import type {
  ProviderUsage,
  RequirementUsage,
  RequirementUsageGroup,
  RequirementUsageGroupKey,
  TokenUsage,
} from "@/features/workbench/types";

/** 执行器展示名。桥接按这两个键分账，面板照样分两行显示。 */
const providerLabels = { codex: "Codex", claude: "Claude" } as const;

/** 需求窗口里每个入口的名字，顺序跟桥接给的一致。 */
const groupLabels: Record<RequirementUsageGroupKey, string> = {
  analysis: "需求分析",
  planning: "需求拆解",
  prototype: "需求原型",
  review: "需求 review",
  testing: "需求测试",
  fineTuning: "需求微调",
};

/**
 * 一条需求花了多少 token。
 *
 * 分三段看：总账、需求侧会话、每条任务。每段都按 Codex / Claude 分开——两家的
 * 计价和额度是分开的，合成一个数就没法回答「这个月哪家花超了」。
 *
 * 需求会话那几行还能点开：看见「review 花了 80k」之后紧接着的问题就是「它到底做了
 * 什么」，答案在同一块面板里翻，不必换个界面重新找这条需求。
 */
export function UsageSheet({
  open,
  programId,
  requirementKey,
  requirementName,
  onClose,
}: {
  open: boolean;
  programId: number;
  requirementKey: string;
  requirementName?: string;
  onClose: () => void;
}) {
  const [usage, setUsage] = useState<RequirementUsage | null>(null);
  // 耗时和 token 不是一个来源：token 由执行器报，耗时是服务端按运行实例的起止记的账。
  const [progress, setProgress] = useState<RequirementProgress | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  // 点开哪一块需求会话；为空时面板显示的是消耗本身。
  const [activeGroup, setActiveGroup] = useState<RequirementUsageGroupKey | null>(null);

  const load = useCallback(async () => {
    if (!programId || !requirementKey) return;
    setLoading(true);
    const [usageResult, progressResult] = await Promise.allSettled([
      fetchRequirementUsage(programId, requirementKey),
      getRequirementProgress(programId, requirementKey),
    ]);
    if (usageResult.status === "fulfilled") {
      setUsage(usageResult.value);
      setError("");
    } else {
      const reason = usageResult.reason;
      setError(reason instanceof ApiError ? reason.message : "无法读取消耗数据。");
    }
    setProgress(progressResult.status === "fulfilled" ? progressResult.value : null);
    setLoading(false);
  }, [programId, requirementKey]);

  useEffect(() => {
    if (!open) return;
    // 重新打开面板先回到消耗本身：上次翻到哪条会话，跟这次要看的多半不是一回事。
    setActiveGroup(null);
    void load();
  }, [open, load]);

  const itemByKey = new Map<string, DeliveryItem>((progress?.items ?? []).map((item) => [item.itemKey, item]));
  const totalRunDuration = useTotalRunDuration(progress?.items ?? [], progress?.totalRunDurationMs ?? 0);
  // 跑过但执行器没报用量的任务也列出来：这一行现在还要回答「花了多久」。
  const tasks = (usage?.tasks ?? []).filter(
    (task) => task.usage.total.totalTokens > 0 || (itemByKey.get(task.itemKey)?.totalRunDurationMs ?? 0) > 0,
  );

  return (
    <Sheet
      open={open}
      title={activeGroup ? groupLabels[activeGroup] : "需求消耗"}
      subtitle={requirementName || requirementKey}
      onClose={onClose}
      actions={activeGroup ? undefined : (
        <button className="icon-button" type="button" onClick={() => void load()} aria-label="刷新" disabled={loading}>
          {loading ? <LoaderCircle size={20} className="spin-icon" /> : <RotateCw size={20} />}
        </button>
      )}
    >
      {activeGroup ? (
        <RequirementSessionPane
          programId={programId}
          requirementKey={requirementKey}
          group={activeGroup}
          label={groupLabels[activeGroup]}
          onBack={() => setActiveGroup(null)}
        />
      ) : (
        <>
          {error ? <p className="form-message is-error">{error}</p> : null}
          {!usage && loading ? <p className="muted">正在汇总这条需求的消耗…</p> : null}
          {usage ? (
            <div className="usage-sheet">
              <section className="usage-block">
                <div className="section-heading"><span>合计</span><span className="muted">{formatTokens(usage.usage.total.totalTokens)} tokens</span></div>
                <ProviderRows usage={usage.usage} />
              </section>

              {progress ? (
                <section className="usage-block">
                  <div className="section-heading"><span>执行耗时</span><span className="muted">只算任务执行，需求会话不计入</span></div>
                  <div className="usage-rows">
                    <div className="usage-row">
                      <strong className="usage-row__name">全部任务累计耗时</strong>
                      <span className="usage-row__nums">
                        <em>{totalRunDuration ? formatRunDuration(totalRunDuration) : "—"}</em>
                        <i>已执行 {progress.runCount} 轮</i>
                      </span>
                    </div>
                  </div>
                </section>
              ) : null}

              <section className="usage-block">
                <div className="section-heading">
                  <span>需求会话</span>
                  <span className="muted">{formatTokens(usage.conversations.total.totalTokens)} tokens</span>
                </div>
                {usage.conversationGroups?.length ? (
                  // 分块列出来才答得上「这条需求贵在哪一步」；没跑过的块也留一行，少一行会被当成漏算。
                  <div className="usage-rows">
                    {usage.conversationGroups.map((group) => {
                      const label = groupLabels[group.key];
                      // 认不出来的块多半来自更新的桥接：数照样列，但别让它点进一个读不了的会话。
                      if (!label) {
                        return (
                          <div className="usage-row" key={group.key}>
                            <span className="usage-row__name">{group.key}</span>
                            <GroupUsageNumbers group={group} />
                          </div>
                        );
                      }
                      return (
                        <button
                          className="usage-row"
                          type="button"
                          key={group.key}
                          onClick={() => setActiveGroup(group.key)}
                          aria-label={`查看${label}的会话`}
                        >
                          <span className="usage-row__name">{label}</span>
                          <GroupUsageNumbers group={group} />
                          <ChevronRight className="usage-row__go" size={17} aria-hidden="true" />
                        </button>
                      );
                    })}
                  </div>
                ) : (
                  // 旧版桥接不给分块，退回到一整笔需求会话，好过整段不显示。
                  <ProviderRows usage={usage.conversations} />
                )}
              </section>

              <section className="usage-block">
                <div className="section-heading"><span>任务</span><span className="muted">{tasks.length} 条跑过</span></div>
                {tasks.length ? (
                  <ul className="usage-task-list">
                    {tasks.map((task) => (
                      <li key={task.itemKey}>
                        <strong>{task.title}</strong>
                        <TaskUsageLine usage={task.usage} />
                        <TaskRunDuration item={itemByKey.get(task.itemKey)} />
                      </li>
                    ))}
                  </ul>
                ) : <p className="muted">这条需求的任务还没有产生消耗。</p>}
              </section>

              <p className="field-help">
                输入含命中缓存的部分，缓存单独标出来（计价通常只有一折）。执行器没报用量的老会话不计入。
              </p>
            </div>
          ) : null}
        </>
      )}
    </Sheet>
  );
}

/** Codex / Claude 各一行，没跑过的那家也留着，避免让人以为漏算了。 */
function ProviderRows({ usage }: { usage: ProviderUsage }) {
  return (
    <div className="usage-rows">
      {(Object.keys(providerLabels) as (keyof typeof providerLabels)[]).map((provider) => (
        <div className="usage-row" key={provider}>
          <span className="usage-row__name"><Coins size={16} aria-hidden="true" />{providerLabels[provider]}</span>
          <UsageNumbers usage={usage[provider]} />
        </div>
      ))}
    </div>
  );
}

/** 一块需求会话：两家的量各给一个数，加上开过几条会话。 */
function GroupUsageNumbers({ group }: { group: RequirementUsageGroup }) {
  if (!group.usage.total.totalTokens) {
    return <span className="usage-row__nums muted">{group.threads ? `${group.threads} 条会话 · 未计入用量` : "未使用"}</span>;
  }
  return (
    <span className="usage-row__nums">
      {group.usage.codex.totalTokens ? <em>Codex {formatTokens(group.usage.codex.totalTokens)}</em> : null}
      {group.usage.claude.totalTokens ? <em>Claude {formatTokens(group.usage.claude.totalTokens)}</em> : null}
      <i>{group.threads} 条会话</i>
      {typeof group.usage.total.costUsd === "number" ? <i>${group.usage.total.costUsd.toFixed(2)}</i> : null}
    </span>
  );
}

function UsageNumbers({ usage }: { usage: TokenUsage }) {
  if (!usage.totalTokens) return <span className="usage-row__nums muted">未使用</span>;
  return (
    <span className="usage-row__nums">
      <em>入 {formatTokens(usage.inputTokens)}</em>
      {usage.cachedInputTokens ? <i>缓存 {formatTokens(usage.cachedInputTokens)}</i> : null}
      <em>出 {formatTokens(usage.outputTokens)}</em>
      {typeof usage.costUsd === "number" ? <i>${usage.costUsd.toFixed(2)}</i> : null}
    </span>
  );
}

/** 任务行只给两家的总量，细分放在需求那两段里看。 */
export function TaskUsageLine({ usage }: { usage: ProviderUsage }) {
  if (!usage.total.totalTokens) return null;
  return (
    <span className="usage-row__nums">
      {usage.codex.totalTokens ? <em>Codex {formatTokens(usage.codex.totalTokens)}</em> : null}
      {usage.claude.totalTokens ? <em>Claude {formatTokens(usage.claude.totalTokens)}</em> : null}
      {typeof usage.total.costUsd === "number" ? <i>${usage.total.costUsd.toFixed(2)}</i> : null}
    </span>
  );
}

/** 面板要的是量级，不是精确到个位：上万按 k 显示。 */
export function formatTokens(value: number) {
  const count = Math.max(0, Math.round(value || 0));
  return count >= 10000 ? `${(count / 1000).toFixed(0)}k` : count.toLocaleString("zh-CN");
}
