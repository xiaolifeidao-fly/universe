"use client";

import { Alert, Empty, Modal, Spin, Table, Tabs, Tag } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useCallback, useEffect, useState, type CSSProperties } from "react";
import { useLocale } from "@/i18n/LocaleProvider";
import {
  CodexProviderUsage,
  CodexRequirementTaskUsage,
  CodexTokenUsage,
  fetchCodexRequirementUsage,
  fetchRequirementProgress,
  type CodexRequirementUsage,
  type CodexRequirementUsageGroupKey,
  type DeliveryItemRecord,
  type DeliveryRequirementProgressRecord,
} from "@/api/delivery.api";
import { formatRunDuration, TaskRunDurationValue, useTotalRunDuration } from "./DeliveryRunDuration";

/** 桥接按这两个键分账，面板照样分两行显示。 */
const PROVIDERS = [
  { key: "codex" as const, label: "Codex" },
  { key: "claude" as const, label: "Claude" },
];

/** 需求窗口里每个入口对应的文案键；桥接给的 key 就是这里的键。 */
const CONVERSATION_GROUP_LABELS: Record<CodexRequirementUsageGroupKey, string> = {
  planning: "delivery.usage.group.planning",
  prototype: "delivery.usage.group.prototype",
  review: "delivery.usage.group.review",
  testing: "delivery.usage.group.testing",
  fineTuning: "delivery.usage.group.fineTuning",
};

/** 面板要的是量级，不是精确到个位：上万按 k 显示。 */
export function formatTokens(value: number) {
  const count = Math.max(0, Math.round(value || 0));
  return count >= 10000 ? `${(count / 1000).toFixed(0)}k` : count.toLocaleString("zh-CN");
}

function formatCost(value: number | null | undefined) {
  return typeof value === "number" && value > 0 ? `$${value.toFixed(2)}` : "";
}

/** 任务进度里那一行：只给两家的总量，细分留在需求消耗弹窗里看。 */
export function DeliveryTaskUsageTags({ usage }: { usage?: CodexProviderUsage }) {
  const { t } = useLocale();
  if (!usage || !usage.total.totalTokens) return null;
  return (
    <span className="delivery-usage-tags">
      {usage.codex.totalTokens ? (
        <Tag bordered={false}>Codex {formatTokens(usage.codex.totalTokens)} {t("delivery.usage.tokensSuffix")}</Tag>
      ) : null}
      {usage.claude.totalTokens ? (
        <Tag bordered={false}>Claude {formatTokens(usage.claude.totalTokens)} {t("delivery.usage.tokensSuffix")}</Tag>
      ) : null}
      {typeof usage.total.costUsd === "number" ? (
        <Tag bordered={false} className="delivery-usage-tags__cost">${usage.total.costUsd.toFixed(2)}</Tag>
      ) : null}
    </span>
  );
}

/** 占比条的分母：token 和花费各有各的总量，混用会画出一条骗人的条子。 */
type UsageTotals = { tokens: number; cost: number };

/** 需求会话表和任务表共用的一行形状；两张表列对齐，看起来才是一份账。 */
type UsageRow = {
  key: string;
  label: string;
  /** 这一块开过几条会话；任务行不给。 */
  threads?: number;
  usage: CodexProviderUsage;
};

/**
 * 一条需求花了多少 token。
 *
 * 顶上三格是这条需求的结论（总量、花费、耗时），下面两张表回答「花在哪」：
 * 需求会话按窗口里的入口分块，任务按条。每处都按 Codex / Claude 分开——两家的
 * 计价和额度是分开的，合成一个数就没法回答「这个月哪家花超了」。
 */
export function DeliveryRequirementUsageModal({
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
  const { t } = useLocale();
  const [usage, setUsage] = useState<CodexRequirementUsage | null>(null);
  // 耗时来自服务端的需求进度，和 token 不是一个来源：桥接没起时用量读不回来，
  // 但「跑了多久」是服务端记的账，照样要能看。
  const [progress, setProgress] = useState<DeliveryRequirementProgressRecord | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  // 两张表塞进一个卡片里用页签切：一次只看一张，弹窗才压得进一屏。
  const [tab, setTab] = useState("requirement");

  const load = useCallback(async () => {
    if (!programId || !requirementKey) return;
    setLoading(true);
    const [usageResult, progressResult] = await Promise.allSettled([
      fetchCodexRequirementUsage(programId, requirementKey),
      fetchRequirementProgress(programId, requirementKey),
    ]);
    if (usageResult.status === "fulfilled") {
      setUsage(usageResult.value);
      setError("");
    } else {
      const reason = usageResult.reason;
      setError(reason instanceof Error ? reason.message : t("delivery.usage.failed"));
    }
    setProgress(progressResult.status === "fulfilled" ? progressResult.value : null);
    setLoading(false);
  }, [programId, requirementKey, t]);

  useEffect(() => {
    if (open) void load();
    else setTab("requirement");
  }, [open, load]);

  const itemByKey = new Map<string, DeliveryItemRecord>((progress?.items ?? []).map((item) => [item.itemKey, item]));
  // 桥接没起时用量读不回来，耗时却是服务端记的账：这种情况下按进度里的任务铺表，
  // token 那几列留空，至少「跑了多久」还看得到。
  const usageTasks = usage?.tasks ?? (progress?.items ?? []).map((item) => Object.assign(new CodexRequirementTaskUsage(), {
    itemKey: item.itemKey, title: item.title, phase: item.phase, status: item.status,
  }));
  // 跑过但执行器没报用量的任务照样列出来：这一行现在还要回答「花了多久」。
  const tasks = usageTasks.filter(
    (task) => task.usage.total.totalTokens > 0 || (itemByKey.get(task.itemKey)?.totalRunDurationMs ?? 0) > 0,
  );
  const totalRunDuration = useTotalRunDuration(progress?.items ?? [], progress?.totalRunDurationMs ?? 0);
  // 占比条一律以需求总账为分母：两张表里的条子才能横着比。
  const totals: UsageTotals = {
    tokens: usage?.usage.total.totalTokens ?? 0,
    cost: usage?.usage.total.costUsd ?? 0,
  };

  const groupRows: UsageRow[] = (usage?.conversationGroups ?? []).map((group) => ({
    key: group.key,
    label: CONVERSATION_GROUP_LABELS[group.key] ? t(CONVERSATION_GROUP_LABELS[group.key]) : group.key,
    threads: group.threads,
    usage: group.usage,
  }));
  const groupColumns: ColumnsType<UsageRow> = [
    {
      title: t("delivery.usage.groupColumn"),
      key: "group",
      ellipsis: true,
      render: (_, record) => (
        <span className="delivery-usage-name">
          <i className="delivery-usage-dot" aria-hidden="true" />
          <b>{record.label}</b>
          {record.threads ? (
            <em className="delivery-usage-chip">{record.threads} {t("delivery.usage.threadsSuffix")}</em>
          ) : null}
        </span>
      ),
    },
    ...usageColumns<UsageRow>(t, (record) => record.usage, totals),
  ];

  const taskColumns: ColumnsType<CodexRequirementTaskUsage> = [
    { title: t("delivery.usage.taskColumn"), dataIndex: "title", ellipsis: true },
    {
      title: t("delivery.usage.lastRunColumn"),
      key: "lastRun",
      width: 92,
      align: "right",
      className: "delivery-usage-cell-num",
      render: (_, record) => <TaskRunDurationValue item={itemByKey.get(record.itemKey)} field="last" />,
    },
    {
      title: t("delivery.usage.totalRunColumn"),
      key: "totalRun",
      width: 92,
      align: "right",
      className: "delivery-usage-cell-num",
      render: (_, record) => <TaskRunDurationValue item={itemByKey.get(record.itemKey)} field="total" />,
    },
    ...usageColumns<CodexRequirementTaskUsage>(t, (record) => record.usage, totals),
  ];

  /** 表尾的合计只算列出来的任务，跟顶部总账（含需求会话）不是一个口径，所以单列一行。 */
  const taskTotals = sumProviderUsage(tasks.map((task) => task.usage));

  const tabItems = [
    {
      key: "requirement",
      label: t("delivery.usage.tabRequirement"),
      children: usage ? (
        <Table
          className="delivery-usage-table"
          rowKey="key"
          size="small"
          pagination={false}
          columns={groupColumns}
          dataSource={groupRows}
          rowClassName={(record) => (record.usage.total.totalTokens ? "" : "is-empty")}
          summary={() => (
            <Table.Summary>
              <Table.Summary.Row className="delivery-usage-summary-row">
                <Table.Summary.Cell index={0}>{t("delivery.usage.conversationsTotal")}</Table.Summary.Cell>
                <SummaryCells index={1} usage={usage.conversations} totals={totals} />
              </Table.Summary.Row>
            </Table.Summary>
          )}
        />
      ) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("delivery.usage.failed")} />,
    },
    {
      key: "tasks",
      label: t("delivery.usage.tabTasks"),
      children: tasks.length ? (
        <Table
          className="delivery-usage-table"
          rowKey="itemKey"
          size="small"
          pagination={false}
          columns={taskColumns}
          dataSource={tasks}
          summary={() => (
            <Table.Summary>
              <Table.Summary.Row className="delivery-usage-summary-row">
                <Table.Summary.Cell index={0}>{t("delivery.usage.totalColumn")}</Table.Summary.Cell>
                {/* 「本次」是每条任务各自的最近一轮，加起来没有意义，合计这一格留空。 */}
                <Table.Summary.Cell index={1} align="right" className="delivery-usage-cell-num">—</Table.Summary.Cell>
                <Table.Summary.Cell index={2} align="right" className="delivery-usage-cell-num">
                  {totalRunDuration ? formatRunDuration(totalRunDuration) : "—"}
                </Table.Summary.Cell>
                <SummaryCells index={3} usage={taskTotals} totals={totals} />
              </Table.Summary.Row>
            </Table.Summary>
          )}
        />
      ) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("delivery.usage.empty")} />,
    },
  ];

  return (
    <Modal
      open={open}
      onCancel={onClose}
      footer={null}
      width={1040}
      // 高度封了顶，居中比挂在页面上方更稳：屏幕矮的时候不会顶出可视区。
      centered
      className="delivery-usage-modal"
      title={
        <div className="delivery-usage-title">
          <span>{t("delivery.usage.title")}</span>
          <em>{requirementName || requirementKey}</em>
        </div>
      }
      destroyOnClose
    >
      {error ? <Alert type="error" showIcon message={error} style={{ marginBottom: 12 }} /> : null}
      <Spin spinning={loading}>
        {usage || progress ? (
          <div className="delivery-usage-body">
            <section className="delivery-usage-hero">
              <div className="delivery-usage-tile">
                <span className="delivery-usage-tile__label">{t("delivery.usage.heroTotal")}</span>
                <strong className="delivery-usage-tile__value">
                  {usage ? formatTokens(usage.usage.total.totalTokens) : "—"}
                  <small>{t("delivery.usage.tokensSuffix")}</small>
                </strong>
                <span className="delivery-usage-tile__meta">
                  {usage ? (
                    <>
                      <em>{t("delivery.usage.input")} {formatTokens(usage.usage.total.inputTokens)}</em>
                      <em>{t("delivery.usage.output")} {formatTokens(usage.usage.total.outputTokens)}</em>
                    </>
                  ) : <em>{t("delivery.usage.unused")}</em>}
                </span>
              </div>
              <div className="delivery-usage-tile">
                <span className="delivery-usage-tile__label">{t("delivery.usage.heroCost")}</span>
                <strong className="delivery-usage-tile__value">
                  {formatCost(usage?.usage.total.costUsd) || "—"}
                </strong>
                <span className="delivery-usage-tile__meta"><em>{t("delivery.usage.costOwner")}</em></span>
              </div>
              <div className="delivery-usage-tile">
                <span className="delivery-usage-tile__label">{t("delivery.usage.durationTitle")}</span>
                <strong className="delivery-usage-tile__value">
                  {totalRunDuration ? formatRunDuration(totalRunDuration) : "—"}
                </strong>
                <span className="delivery-usage-tile__meta">
                  <em>{t("delivery.progress.duration.runs").replace("{count}", String(progress?.runCount ?? 0))}</em>
                  <em>{t("delivery.usage.durationHint")}</em>
                </span>
              </div>
            </section>

            {usage ? (
              <section className="delivery-usage-card">
                <h4 className="delivery-usage-heading">
                  <span>{t("delivery.usage.byProvider")}</span>
                </h4>
                <div className="delivery-usage-providers">
                  {PROVIDERS.map((provider) => (
                    <ProviderRow
                      key={provider.key}
                      label={provider.label}
                      accent={provider.key}
                      usage={usage.usage[provider.key]}
                      total={totals.tokens}
                    />
                  ))}
                </div>
              </section>
            ) : null}

            {/* 需求和任务是两本账，一次只看一张：页签切换比上下堆两张表省一半高度。 */}
            <section className="delivery-usage-card delivery-usage-card--tabs">
              <Tabs
                className="delivery-usage-tabs"
                activeKey={tab}
                onChange={setTab}
                items={tabItems}
                tabBarExtraContent={{
                  right: (
                    <em className="delivery-usage-muted">
                      {tab === "requirement"
                        ? t("delivery.usage.conversationsHint")
                        : t("delivery.usage.taskCount").replace("{count}", String(tasks.length))}
                    </em>
                  ),
                }}
              />
            </section>
            <p className="delivery-usage-muted delivery-usage-hint">{t("delivery.usage.hint")}</p>
          </div>
        ) : null}
      </Spin>
    </Modal>
  );
}

/** 把若干行加成一行合计；表尾那一行和明细行走同一套渲染，形状就得一样。 */
function sumProviderUsage(usages: CodexProviderUsage[]): CodexProviderUsage {
  const sum = Object.assign(new CodexProviderUsage(), {
    codex: new CodexTokenUsage(),
    claude: new CodexTokenUsage(),
    total: new CodexTokenUsage(),
  });
  let cost = 0;
  for (const usage of usages) {
    sum.codex.totalTokens += usage.codex.totalTokens;
    sum.claude.totalTokens += usage.claude.totalTokens;
    sum.total.outputTokens += usage.total.outputTokens;
    sum.total.totalTokens += usage.total.totalTokens;
    cost += usage.total.costUsd ?? 0;
  }
  // 一家都没报价时留 null：0 会被当成「真的没花钱」。
  sum.total.costUsd = cost > 0 ? cost : null;
  return sum;
}

/** 需求会话表和任务表右半边共用的五列，列宽也一样——两张表要能上下对着看。 */
function usageColumns<T>(
  t: (key: string) => string,
  pick: (record: T) => CodexProviderUsage,
  totals: UsageTotals,
): ColumnsType<T> {
  return [
    {
      title: "Codex",
      key: "codex",
      width: 96,
      align: "right",
      className: "delivery-usage-cell-num",
      render: (_, record) => (pick(record).codex.totalTokens ? formatTokens(pick(record).codex.totalTokens) : "—"),
    },
    {
      title: "Claude",
      key: "claude",
      width: 96,
      align: "right",
      className: "delivery-usage-cell-num",
      render: (_, record) => (pick(record).claude.totalTokens ? formatTokens(pick(record).claude.totalTokens) : "—"),
    },
    {
      title: t("delivery.usage.outputColumn"),
      key: "output",
      width: 92,
      align: "right",
      className: "delivery-usage-cell-num",
      render: (_, record) => (pick(record).total.outputTokens ? formatTokens(pick(record).total.outputTokens) : "—"),
    },
    {
      title: t("delivery.usage.totalColumn"),
      key: "total",
      width: 124,
      align: "right",
      className: "delivery-usage-cell-num",
      // 只跑过、执行器没报用量的那些也会列出来；它们的 token 和花费留白，
      // 写成 0 会被当成「真的一个 token 都没用」。
      render: (_, record) => <ShareCell text={formatTokens(pick(record).total.totalTokens)} value={pick(record).total.totalTokens} total={totals.tokens} />,
    },
    {
      title: t("delivery.usage.costColumn"),
      key: "cost",
      width: 112,
      align: "right",
      className: "delivery-usage-cell-num",
      render: (_, record) => (
        <ShareCell accent="cost" text={formatCost(pick(record).total.costUsd)} value={pick(record).total.costUsd ?? 0} total={totals.cost} />
      ),
    },
  ];
}

/** 表尾合计右半边的五格，和 usageColumns 一一对应。 */
function SummaryCells({ index, usage, totals }: { index: number; usage: CodexProviderUsage; totals: UsageTotals }) {
  return (
    <>
      <Table.Summary.Cell index={index} align="right" className="delivery-usage-cell-num">
        {usage.codex.totalTokens ? formatTokens(usage.codex.totalTokens) : "—"}
      </Table.Summary.Cell>
      <Table.Summary.Cell index={index + 1} align="right" className="delivery-usage-cell-num">
        {usage.claude.totalTokens ? formatTokens(usage.claude.totalTokens) : "—"}
      </Table.Summary.Cell>
      <Table.Summary.Cell index={index + 2} align="right" className="delivery-usage-cell-num">
        {usage.total.outputTokens ? formatTokens(usage.total.outputTokens) : "—"}
      </Table.Summary.Cell>
      <Table.Summary.Cell index={index + 3} align="right" className="delivery-usage-cell-num">
        <ShareCell text={formatTokens(usage.total.totalTokens)} value={usage.total.totalTokens} total={totals.tokens} />
      </Table.Summary.Cell>
      <Table.Summary.Cell index={index + 4} align="right" className="delivery-usage-cell-num">
        <ShareCell accent="cost" text={formatCost(usage.total.costUsd)} value={usage.total.costUsd ?? 0} total={totals.cost} />
      </Table.Summary.Cell>
    </>
  );
}

/**
 * 数字底下压一条占比微条，一眼看出这一行在整条需求里占多少。
 *
 * token 和花费各按各的总量算：Codex 不计价，两者的分布本来就不一样，
 * 共用一个分母会画出一条对不上账的条子。
 */
function ShareCell({
  text,
  value,
  total,
  accent = "tokens",
}: {
  text: string;
  value: number;
  total: number;
  accent?: "tokens" | "cost";
}) {
  if (!text || !value) return <span className="delivery-usage-muted">—</span>;
  const share = total > 0 ? Math.min(1, value / total) : 0;
  return (
    <span className="delivery-usage-total">
      <em>
        {text}
        <b className="delivery-usage-share">{Math.round(share * 100)}%</b>
      </em>
      <i
        className={`delivery-usage-total__bar is-${accent}`}
        style={{ "--share": `${(share * 100).toFixed(1)}%` } as CSSProperties}
      />
    </span>
  );
}

/** 执行器分账：一条占比横条 + 入 / 缓存 / 出 / 花费。没跑过的那家也留着，免得让人以为漏算了。 */
function ProviderRow({
  label,
  accent,
  usage,
  total,
}: {
  label: string;
  accent: string;
  usage: CodexTokenUsage;
  total: number;
}) {
  const { t } = useLocale();
  const share = total > 0 ? usage.totalTokens / total : 0;
  return (
    <div className={`delivery-usage-provider${usage.totalTokens ? "" : " is-empty"}`}>
      <span className="delivery-usage-provider__name">
        <i className={`delivery-usage-dot is-${accent}`} aria-hidden="true" />
        {label}
      </span>
      <span className="delivery-usage-provider__bar">
        <i className={`delivery-usage-bar is-${accent}`}>
          <b style={{ width: `${(share * 100).toFixed(1)}%` }} />
        </i>
        <em className="manager-mono">{usage.totalTokens ? `${Math.round(share * 100)}%` : "—"}</em>
      </span>
      {usage.totalTokens ? (
        <span className="delivery-usage-nums manager-mono">
          <em>{t("delivery.usage.input")} {formatTokens(usage.inputTokens)}</em>
          {usage.cachedInputTokens ? <i>{t("delivery.usage.cached")} {formatTokens(usage.cachedInputTokens)}</i> : null}
          <em>{t("delivery.usage.output")} {formatTokens(usage.outputTokens)}</em>
          {typeof usage.costUsd === "number" ? <i>${usage.costUsd.toFixed(2)}</i> : null}
        </span>
      ) : (
        <span className="delivery-usage-muted">{t("delivery.usage.unused")}</span>
      )}
    </div>
  );
}
