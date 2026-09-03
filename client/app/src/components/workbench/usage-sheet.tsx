"use client";

import { useCallback, useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { ChevronRight, Clock3, Database, ListChecks, LoaderCircle, Repeat2, RotateCw, Table2 } from "lucide-react";
import { ApiError } from "@/api/client";
import { getRequirementProgress, type DeliveryItem, type RequirementProgress } from "@/api/management.api";
import { fetchRequirementUsage } from "@/api/workbench.api";
import { Sheet } from "@/components/sheet";
import { RequirementSessionPane } from "@/components/workbench/requirement-session-pane";
import { formatRunDuration, useTotalRunDuration } from "@/components/workbench/run-duration";
import type {
  ProviderUsage,
  RequirementUsage,
  RequirementUsageGroup,
  RequirementUsageGroupKey,
  TokenUsage,
} from "@/features/workbench/types";

/** 执行器展示名。桥接按这两个键分账，图上也只有这两条系列。 */
const providerLabels = { codex: "Codex", claude: "Claude" } as const;

type ProviderKey = keyof typeof providerLabels;

const providerKeys = Object.keys(providerLabels) as ProviderKey[];

/** 需求窗口里每个入口的名字，顺序跟桥接给的一致。 */
const groupLabels: Record<RequirementUsageGroupKey, string> = {
  analysis: "需求分析",
  planning: "需求拆解",
  prototype: "需求原型",
  review: "需求 review",
  testing: "需求测试",
  fineTuning: "需求微调",
};

/** 任务多的时候先露出最贵的几条，剩下的收起来——面板是拿来找「贵在哪」的，不是通讯录。 */
const TASK_PREVIEW_COUNT = 6;

/**
 * 一条需求花了多少 token。
 *
 * 这一层只管取数和翻页：消耗本身、点开某一块需求会话之后的正文，共用同一个面板，
 * 看见「review 花了 80k」之后紧接着的问题就是「它到底做了什么」，答案在同一块面板
 * 里翻，不必换个界面重新找这条需求。图怎么画在 {@link UsageDashboard}。
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
            <UsageDashboard usage={usage} progress={progress} refreshing={loading} onOpenGroup={setActiveGroup} />
          ) : null}
        </>
      )}
    </Sheet>
  );
}

/**
 * 消耗仪表盘。
 *
 * 整块面板只有两条系列：Codex 和 Claude。每一根横条都按这两条叠出来，颜色从头到尾
 * 只表示「哪个执行器」，所以看完顶上的图例就不用再看第二遍——两家的计价和额度是分开
 * 的，合成一个数就没法回答「这个月哪家花超了」。
 *
 * 从上往下回答四个问题：一共花了多少（大数 + 分账条）、跑了多久（三张指标卡 + 缓存
 * 命中）、钱花在会话还是任务上（去向）、具体贵在哪一步（两张按量排序的条形图）。
 * 最后收着一张明细表：图上压成量级的位数在那里都有，也给不靠颜色读图的人留一条路。
 */
export function UsageDashboard({
  usage,
  progress,
  refreshing = false,
  onOpenGroup,
}: {
  usage: RequirementUsage;
  progress: RequirementProgress | null;
  /** 回读中。旧的那份压暗留在原地，不闪一版骨架屏：数字跳一下比等一下更难受。 */
  refreshing?: boolean;
  onOpenGroup?: (group: RequirementUsageGroupKey) => void;
}) {
  // 任务列表是否已经全展开，以及明细表是否拉开。
  const [allTasks, setAllTasks] = useState(false);
  const [tableOpen, setTableOpen] = useState(false);

  const items = useMemo(() => progress?.items ?? [], [progress]);
  const itemByKey = useMemo(() => new Map<string, DeliveryItem>(items.map((item) => [item.itemKey, item])), [items]);
  const totalRunDuration = useTotalRunDuration(items, progress?.totalRunDurationMs ?? 0);

  // 跑过但执行器没报用量的任务也留着：这一行现在还要回答「花了多久」。按量从高到低排，
  // 最贵的那条排第一，找它不用滚。
  const tasks = useMemo(() => {
    const runnable = usage.tasks.filter(
      (task) => task.usage.total.totalTokens > 0 || (itemByKey.get(task.itemKey)?.totalRunDurationMs ?? 0) > 0,
    );
    return [...runnable].sort((left, right) => right.usage.total.totalTokens - left.usage.total.totalTokens);
  }, [itemByKey, usage]);

  // 需求会话按量排序，没跑过的那几块自然沉到末尾——它们还得留在列表里，少一行会被当成漏算。
  const groups = useMemo(
    () => [...(usage.conversationGroups ?? [])].sort((left, right) => right.usage.total.totalTokens - left.usage.total.totalTokens),
    [usage],
  );

  const total = usage.usage.total.totalTokens;
  const conversationTokens = usage.conversations.total.totalTokens;
  const taskTokens = Math.max(0, total - conversationTokens);
  const groupScale = groups.reduce((max, group) => Math.max(max, group.usage.total.totalTokens), 0);
  const taskScale = tasks.reduce((max, task) => Math.max(max, task.usage.total.totalTokens), 0);
  const visibleTasks = allTasks ? tasks : tasks.slice(0, TASK_PREVIEW_COUNT);

  return (
    <div className={refreshing ? "usage-sheet is-refreshing" : "usage-sheet"}>
      <UsageHero usage={usage.usage} />

      <div className="usage-metrics">
        <Metric icon={<Clock3 size={17} aria-hidden="true" />} value={totalRunDuration ? formatRunDuration(totalRunDuration) : "—"} label="执行耗时" />
        <Metric icon={<Repeat2 size={17} aria-hidden="true" />} value={progress ? `${progress.runCount}` : "—"} label="执行轮次" />
        <Metric icon={<ListChecks size={17} aria-hidden="true" />} value={`${tasks.length}`} label="跑过任务" />
      </div>

      <CacheMeter usage={usage.usage.total} />

      <section className="usage-block">
        <div className="section-heading"><span>消耗去向</span><span className="muted">会话与任务各占多少</span></div>
        <div className="usage-bars">
          <BarRow
            name="需求会话"
            value={conversationTokens}
            codex={usage.conversations.codex.totalTokens}
            claude={usage.conversations.claude.totalTokens}
            scale={total}
            meta={`占 ${percentLabel(conversationTokens, total)}`}
          />
          <BarRow
            name="任务执行"
            value={taskTokens}
            codex={Math.max(0, usage.usage.codex.totalTokens - usage.conversations.codex.totalTokens)}
            claude={Math.max(0, usage.usage.claude.totalTokens - usage.conversations.claude.totalTokens)}
            scale={total}
            meta={`占 ${percentLabel(taskTokens, total)}`}
          />
        </div>
      </section>

      <section className="usage-block">
        <div className="section-heading">
          <span>需求会话</span>
          <span className="muted">{formatTokens(conversationTokens)} tokens</span>
        </div>
        {groups.length ? (
          // 分块排出来才答得上「这条需求贵在哪一步」；没跑过的块也留一行。
          <div className="usage-bars">
            {groups.map((group) => {
              const label = groupLabels[group.key];
              // 认不出来的块多半来自更新的桥接：数照样列，但别让它点进一个读不了的会话。
              if (!label) return <BarRow key={group.key} name={group.key} {...groupBarProps(group, groupScale)} />;
              return (
                <BarRow
                  key={group.key}
                  name={label}
                  {...groupBarProps(group, groupScale)}
                  onClick={onOpenGroup ? () => onOpenGroup(group.key) : undefined}
                  actionLabel={`查看${label}的会话`}
                />
              );
            })}
          </div>
        ) : (
          // 旧版桥接不给分块，退回到按执行器的两根条，好过整段不显示。
          <div className="usage-bars">
            {providerKeys.map((provider) => (
              <BarRow
                key={provider}
                name={providerLabels[provider]}
                value={usage.conversations[provider].totalTokens}
                codex={provider === "codex" ? usage.conversations.codex.totalTokens : 0}
                claude={provider === "claude" ? usage.conversations.claude.totalTokens : 0}
                scale={conversationTokens}
                meta={`占 ${percentLabel(usage.conversations[provider].totalTokens, conversationTokens)}`}
              />
            ))}
          </div>
        )}
      </section>

      <section className="usage-block">
        <div className="section-heading"><span>任务</span><span className="muted">{formatTokens(taskTokens)} tokens</span></div>
        {tasks.length ? (
          <>
            <div className="usage-bars">
              {visibleTasks.map((task) => (
                <BarRow
                  key={task.itemKey}
                  name={task.title || task.itemKey}
                  value={task.usage.total.totalTokens}
                  codex={task.usage.codex.totalTokens}
                  claude={task.usage.claude.totalTokens}
                  scale={taskScale}
                  meta={[
                    itemByKey.get(task.itemKey)?.totalRunDurationMs ? formatRunDuration(itemByKey.get(task.itemKey)!.totalRunDurationMs) : "",
                    typeof task.usage.total.costUsd === "number" ? `$${task.usage.total.costUsd.toFixed(2)}` : "",
                  ].filter(Boolean).join(" · ")}
                />
              ))}
            </div>
            {tasks.length > TASK_PREVIEW_COUNT ? (
              <button className="usage-more" type="button" onClick={() => setAllTasks((current) => !current)}>
                {allTasks ? "只看最贵的几条" : `展开全部 ${tasks.length} 条`}
              </button>
            ) : null}
          </>
        ) : <p className="muted">这条需求的任务还没有产生消耗。</p>}
      </section>

      <section className="usage-block">
        <button className="usage-more is-table" type="button" onClick={() => setTableOpen((current) => !current)} aria-expanded={tableOpen}>
          <Table2 size={17} aria-hidden="true" />
          {tableOpen ? "收起明细" : "看逐位明细"}
        </button>
        {tableOpen ? <UsageTable usage={usage.usage} /> : null}
      </section>

      <p className="field-help">
        输入含命中缓存的部分，缓存单独标出来（计价通常只有一折）。执行器没报用量的老会话不计入。
      </p>
    </div>
  );
}

/** 面板顶上的那一屏：一个大数说清总量，一根分账条说清两家各占多少。 */
function UsageHero({ usage }: { usage: ProviderUsage }) {
  const total = usage.total.totalTokens;
  const cost = usage.total.costUsd;
  return (
    <section className="usage-hero" aria-label="合计消耗">
      <div className="usage-hero__head">
        <p className="usage-hero__label">合计消耗</p>
        {typeof cost === "number" ? <p className="usage-hero__cost">${cost.toFixed(2)}</p> : null}
      </div>
      <p className="usage-hero__figure">
        <strong>{formatTokensCompact(total)}</strong>
        <span>tokens</span>
      </p>
      <UsageBar
        codex={usage.codex.totalTokens}
        claude={usage.claude.totalTokens}
        scale={total}
        label={`Codex ${formatTokens(usage.codex.totalTokens)}、Claude ${formatTokens(usage.claude.totalTokens)}`}
      />
      {/* 图例带上具体数和占比：颜色只负责认人，读数不该逼人去点开什么。 */}
      <ul className="usage-legend">
        {providerKeys.map((provider) => (
          <li key={provider}>
            <i className={`usage-dot is-${provider}`} aria-hidden="true" />
            <span>{providerLabels[provider]}</span>
            <strong>{formatTokens(usage[provider].totalTokens)}</strong>
            <em>{percentLabel(usage[provider].totalTokens, total)}</em>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** 一张指标卡：图标 + 一个数 + 一句标签。 */
function Metric({ icon, value, label }: { icon: ReactNode; value: string; label: string }) {
  return (
    <div className="usage-metric">
      <span className="usage-metric__icon">{icon}</span>
      <strong>{value}</strong>
      <span className="usage-metric__label">{label}</span>
    </div>
  );
}

/**
 * 缓存命中率。
 *
 * 单独占一条：命中的那部分输入通常只按一折计价，是这张账单上唯一能主动压下来的数，
 * 混在指标卡里会被当成又一个只读的统计量。
 */
function CacheMeter({ usage }: { usage: TokenUsage }) {
  const input = Math.max(0, Math.round(usage.inputTokens || 0));
  const cached = Math.max(0, Math.min(input, Math.round(usage.cachedInputTokens || 0)));
  if (!input) return null;
  const percent = (cached * 100) / input;
  return (
    <section className="usage-cache" aria-label="缓存命中">
      <div className="usage-cache__head">
        <span><Database size={16} aria-hidden="true" />缓存命中</span>
        {/* 命中很少时四舍五入成 0% 会读成「一次没命中」，这一档多给一位小数。 */}
        <strong>{cached && percent < 1 ? percent.toFixed(1) : Math.round(percent)}%</strong>
      </div>
      <span className="usage-cache__track" role="img" aria-label={`输入 ${formatTokens(input)}，命中缓存 ${formatTokens(cached)}`}>
        <i style={{ "--cache-share": `${percent.toFixed(2)}%` } as CSSProperties} />
      </span>
      <p className="usage-cache__note">输入 {formatTokens(input)} 里有 {formatTokens(cached)} 命中缓存</p>
    </section>
  );
}

/**
 * 排行榜里的一行：名字 + 数值在上，横条在下，需要时整行还能点开。
 *
 * 横条按 `scale` 归一化——同一段里所有行共用一个刻度，条的长短才能横着比。
 */
function BarRow({
  name,
  value,
  codex,
  claude,
  scale,
  meta,
  onClick,
  actionLabel,
}: {
  name: string;
  value: number;
  codex: number;
  claude: number;
  scale: number;
  meta?: string;
  onClick?: () => void;
  actionLabel?: string;
}) {
  const content = (
    <>
      <span className="usage-bar-row__head">
        <span className="usage-bar-row__name">{name}</span>
        {value
          ? <strong className="usage-bar-row__value">{formatTokens(value)}</strong>
          : <span className="usage-bar-row__value is-empty">未使用</span>}
        {onClick ? <ChevronRight className="usage-bar-row__go" size={17} aria-hidden="true" /> : null}
      </span>
      <UsageBar codex={codex} claude={claude} scale={scale} label={`${name} ${formatTokens(value)} tokens`} />
      {meta ? <span className="usage-bar-row__meta">{meta}</span> : null}
    </>
  );
  if (!onClick) return <div className="usage-bar-row">{content}</div>;
  return <button className="usage-bar-row" type="button" onClick={onClick} aria-label={actionLabel}>{content}</button>;
}

/**
 * 一根按执行器叠起来的横条。
 *
 * 段与段之间空 2px 露出底色来分隔，不描边——描边等于往图上加不表示数据的墨。
 * 跑得少的那一段留了 3px 的下限，不然 0.3% 会直接消失，让人以为那家没跑过。
 */
function UsageBar({ codex, claude, scale, label }: { codex: number; claude: number; scale: number; label: string }) {
  const denominator = scale > 0 ? scale : 1;
  const codexShare = Math.max(0, codex) / denominator;
  const claudeShare = Math.max(0, claude) / denominator;
  const rest = Math.max(0, 1 - codexShare - claudeShare);
  return (
    <span className="usage-bar" role="img" aria-label={label}>
      {codexShare > 0 ? <i className="usage-bar__seg is-codex" style={{ flexGrow: codexShare }} /> : null}
      {claudeShare > 0 ? <i className="usage-bar__seg is-claude" style={{ flexGrow: claudeShare }} /> : null}
      {rest > 0.001 ? <i className="usage-bar__rest" style={{ flexGrow: rest }} /> : null}
    </span>
  );
}

/**
 * 图上压成量级的位数在这里读。也是不靠颜色认系列时的那条退路。
 *
 * 执行器当列、口径当行，是被手机宽度逼出来的：反过来排要六列，最该看的「合计」和
 * 「费用」正好被挤到屏幕外，得横着划才看得到。竖着排只要三列，一屏放得下。
 */
function UsageTable({ usage }: { usage: ProviderUsage }) {
  const columns = [
    ...providerKeys.map((provider) => ({ key: provider as string, name: providerLabels[provider], usage: usage[provider] })),
    { key: "total", name: "合计", usage: usage.total },
  ];
  const rows: { key: string; name: string; read: (usage: TokenUsage) => string }[] = [
    { key: "input", name: "输入", read: (row) => fullTokens(row.inputTokens) },
    { key: "cached", name: "其中缓存", read: (row) => fullTokens(row.cachedInputTokens) },
    { key: "output", name: "输出", read: (row) => fullTokens(row.outputTokens) },
    { key: "total", name: "合计", read: (row) => fullTokens(row.totalTokens) },
    { key: "cost", name: "费用", read: (row) => (typeof row.costUsd === "number" ? `$${row.costUsd.toFixed(2)}` : "—") },
  ];
  return (
    <div className="usage-table__scroll">
      <table className="usage-table">
        <thead>
          <tr>
            <th scope="col"><span className="visually-hidden">口径</span></th>
            {columns.map((column) => (
              <th scope="col" key={column.key}>
                {column.key === "total" ? null : <i className={`usage-dot is-${column.key}`} aria-hidden="true" />}
                {column.name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key} className={row.key === "total" ? "is-total" : undefined}>
              <th scope="row">{row.name}</th>
              {columns.map((column) => <td key={column.key}>{row.read(column.usage)}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** 一块需求会话摊成条形行要的那几个字段；「几条会话」和费用一起收在副行里。 */
function groupBarProps(group: RequirementUsageGroup, scale: number) {
  const meta = [
    group.threads ? `${group.threads} 条会话` : "",
    typeof group.usage.total.costUsd === "number" ? `$${group.usage.total.costUsd.toFixed(2)}` : "",
  ].filter(Boolean).join(" · ");
  return {
    value: group.usage.total.totalTokens,
    codex: group.usage.codex.totalTokens,
    claude: group.usage.claude.totalTokens,
    scale,
    // 跑过但没报用量，和一次没开过，是两回事，副行里得说清。
    meta: group.usage.total.totalTokens ? meta : group.threads ? `${group.threads} 条会话 · 未计入用量` : "",
  };
}

function percentLabel(part: number, whole: number) {
  if (!whole || part <= 0) return "0%";
  const percent = (part * 100) / whole;
  return percent < 1 ? "<1%" : `${Math.round(percent)}%`;
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

/** 顶上那个大数：百万级再压一档，不然 375 宽下 "1284k" 会顶到边。 */
function formatTokensCompact(value: number) {
  const count = Math.max(0, Math.round(value || 0));
  return count >= 1_000_000 ? `${(count / 1_000_000).toFixed(2)}M` : formatTokens(count);
}

/** 明细表里不压量级：这张表存在的意义就是给出图上读不到的那几位。 */
function fullTokens(value: number) {
  return Math.max(0, Math.round(value || 0)).toLocaleString("zh-CN");
}
