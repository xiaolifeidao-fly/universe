"use client";

/**
 * 「今天」。这一页只回答三个问题：现在在不在共享、今天赚了多少、今晚几点开始。
 *
 * 别的都往后放 —— 主人一天里打开 Nova 的绝大多数次数，就是想看这三件事。
 * 额度、能力开关摆在下半屏，是因为它们回答的是「为什么没在赚」，
 * 只有前三个问题答得不对劲时才会往下看。
 *
 * 名下不止一台机器时（这台电脑之外，还有机房里用接入密钥注册的服务器），能力按机器分组，
 * 顺序和「共享设置」一样：这台电脑在前。每台都可能有一条「Claude 订阅」，平铺在一起
 * 分不清开关拨的是哪一台。只有一台时还是平铺，不为它多摆一行机器名。
 * 散户就只有这台电脑一台（见 visibleNodes），所以这一页对散户永远是平铺的。
 */

import { message } from "antd";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { HourBar } from "@/components/galaxy/charts";
import { PageHeader } from "@/components/shell/GalaxyShell";
import { IconAlert, IconBell, IconGpu, IconMonitor, IconMoon, IconSparkle } from "@/components/ui/icons";
import { Btn, Card, CardHead, EmptyState, Figure, IconBtn, LinkBtn, Loading, LiveDot, Meter, Note, Pill, Switch } from "@/components/ui/kit";
import { useLocale } from "@/i18n/LocaleProvider";
import { isStudio } from "@/utils/auth";
import {
  formatClock,
  formatCny,
  formatCompact,
  formatMillis,
  formatPoints,
  formatRelative,
  formatSignedPoints,
  formatSince,
  formatUnitValue,
  unitLabel,
} from "@/utils/format";
import { describeHours, isSharingNow, minutesLeftInWindow, nextWindowStart, scheduleToHours } from "@/utils/schedule";
import { pingBridge } from "../../api/bridge.api";
import {
  fetchDashboard,
  fetchNodes,
  fetchRecords,
  isNodeOnline,
  nodeDisplayName,
  orderMachines,
  setContributionStatus,
  visibleContributions,
  visibleNodes,
  type ContributionView,
  type ExecutionRecord,
  type NodeView,
  type ProviderDashboard,
} from "../../api/provider.api";
import { useCurrentAccount } from "../../useAccount";

/**
 * 额度条的列宽。
 *
 * auto-fit 而不是写死三列：三条并排时每格只剩 130px 上下，英文的
 * 「Output tokens  1.21M / 2.0M」放不下。放不下就折成两行，比挤在一行里
 * 互相盖住强 —— 后者在中文下看不出来，只有切到英文才暴露。
 */
const QUOTA_COLUMNS = "repeat(auto-fit, minmax(170px, 1fr))";

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function TodayBoard() {
  const { t, locale } = useLocale();
  const router = useRouter();
  const [dashboard, setDashboard] = useState<ProviderDashboard | null>(null);
  const [nodes, setNodes] = useState<NodeView[]>([]);
  const [records, setRecords] = useState<ExecutionRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  // 本机 bridge 报的自己：哪台排第一、哪台标「这台电脑」、两张概括卡同等情况下先挑谁，
  // 散户还靠它认出「只该显示的那一台」。纯浏览器里是 null —— 浏览器不是任何一台机器，
  // 那就没有哪台是「这台电脑」，也就无从只留一台。
  const [local, setLocal] = useState<{ nodeId: string } | null>(null);
  // 散户只有这台电脑：机房那一排服务器是工作室才有的东西。
  const studio = isStudio(useCurrentAccount());

  const load = useCallback(async () => {
    try {
      const [summary, nodeList, recent] = await Promise.all([fetchDashboard(), fetchNodes(), fetchRecords("", 5)]);
      setDashboard(summary);
      setNodes(nodeList);
      setRecords(recent);
    } catch (error) {
      message.error((error as Error).message || t("common.loadFailed"));
    }
  }, [t]);

  // 20 秒一拉。贡献的在线/额度状态由心跳每 15 秒推一次，前端比数据本身
  // 更新得还勤没有意义，也不值得为此多开一条长连接。
  useEffect(() => {
    let alive = true;
    const self = pingBridge().then((ping) => (ping ? { nodeId: ping.nodeId ?? "" } : null));
    void self.then((value) => {
      if (alive) setLocal(value);
    });
    // 第一屏等本机 bridge 报出自己是哪台再画（和共享设置一样）：分两步到的话，机器先按名字排、
    // 再把这台电脑跳到最上面，额度卡也跟着换一台。等不过 1.5 秒就先画，IPC 卡住不能挡住整页。
    void Promise.all([load(), Promise.race([self, delay(1500)])]).finally(() => {
      if (alive) setLoading(false);
    });
    const timer = setInterval(() => void load(), 20_000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [load]);

  const localNodeId = local?.nodeId ?? "";
  const machines = useMemo(() => orderMachines(visibleNodes(nodes, studio, local), localNodeId), [nodes, studio, local, localNodeId]);
  const contributions = useMemo(
    () => machines.flatMap((node) => visibleContributions(node.contributions)),
    [machines],
  );
  const online = machines.some(isNodeOnline);
  // 「正在共享」得落在同一台机器上：在线的机器上开着的能力。在线和开着分开算的话，
  // 一台在线但全关了、另一台开着却离线，拼起来就成了「正在共享」，其实哪台都没在接单。
  const sharingRows = machines
    .filter(isNodeOnline)
    .flatMap((node) => visibleContributions(node.contributions))
    .filter((item) => item.status === "active");
  const summary = useMemo(() => pickSummary(machines), [machines]);
  const primary = summary?.row ?? null;
  const hours = useMemo(() => scheduleToHours(primary?.schedule), [primary]);
  const grouped = machines.length > 1;
  const now = new Date();

  /** 总开关：一次改掉全部贡献。主人按它是想「现在别接单了」，不是想逐条挑。 */
  const toggleAll = async (on: boolean) => {
    if (contributions.length === 0) return;
    setBusy(true);
    try {
      await Promise.all(
        contributions.map((item) => setContributionStatus(item.nodeId, item.cid, on ? "active" : "paused")),
      );
      await load();
    } catch (error) {
      message.error((error as Error).message || t("common.actionFailed"));
    } finally {
      setBusy(false);
    }
  };

  const toggleOne = async (item: ContributionView, on: boolean) => {
    setBusy(true);
    try {
      await setContributionStatus(item.nodeId, item.cid, on ? "active" : "paused");
      await load();
    } catch (error) {
      message.error((error as Error).message || t("common.actionFailed"));
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return (
      <>
        <PageHeader title={t("today.title")} />
        <div className="gx-body">
          <Loading />
        </div>
      </>
    );
  }

  if (!dashboard || dashboard.nodes === 0 || machines.length === 0) {
    return (
      <>
        <PageHeader title={t("today.title")} meta={formatToday(locale)} />
        <div className="gx-body">
          <Card>
            <EmptyState
              title={t("today.emptyTitle")}
              hint={t("today.emptyHint")}
              action={
                <Btn tone="accent" onClick={() => router.push("/provider/pair")}>
                  {t("today.emptyAction")}
                </Btn>
              }
            />
          </Card>
        </div>
      </>
    );
  }

  const sharing = sharingRows.length > 0;
  const minutesLeft = minutesLeftInWindow(hours, now);
  const nextStart = nextWindowStart(hours, now);
  // 两张概括卡的出处。一台机器时不写：只可能是它。
  const source =
    grouped && summary ? <SummarySource node={summary.node} row={summary.row} local={summary.node.nodeId === localNodeId} /> : null;

  return (
    <>
      <PageHeader
        title={t("today.title")}
        meta={formatToday(locale)}
        actions={
          <>
            <span
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                height: 36,
                padding: "0 6px 0 14px",
                borderRadius: 999,
                border: "1px solid var(--gx-line)",
                background: "var(--gx-surface)",
                fontSize: 12.5,
                color: "var(--gx-soft)",
              }}
            >
              {t("today.masterSwitch")}
              <Switch
                checked={sharing}
                disabled={busy || contributions.length === 0}
                label={t("today.masterSwitch")}
                onChange={(next) => void toggleAll(next)}
              />
            </span>
            <IconBtn label={t("today.recentAll")} onClick={() => router.push("/provider/records")}>
              <IconBell size={18} />
            </IconBtn>
          </>
        }
      />
      <div className="gx-body gx-body--fixed">
        <div style={{ display: "grid", gridTemplateColumns: "1.15fr 1fr", gap: 14 }}>
          <Card className="gx-rise" style={{ padding: "22px 24px", display: "flex", flexDirection: "column", gap: 18 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
              <Pill tone={sharing ? "ok" : "default"}>
                <LiveDot on={sharing} />
                {sharing
                  ? `${t("today.sharing")} · ${describeProviders(sharingRows, t)}`
                  : online
                    ? t("today.paused")
                    : t("today.offline")}
              </Pill>
              {dashboard.sharingSince && sharing ? (
                <span className="gx-mono" style={{ fontSize: 11, color: "var(--gx-faint)" }}>
                  {t("today.streak", { value: formatSince(dashboard.sharingSince, locale) })}
                </span>
              ) : null}
            </div>
            <div>
              <div className="gx-label">{t("today.earned")}</div>
              <div style={{ marginTop: 6 }}>
                {/* credits 里的数都是微积分（1,000,000 = 1 积分 = ¥1），显示前必须换算。 */}
                <Figure
                  value={formatPoints(dashboard.credits.today)}
                  unit={t("today.credits")}
                  aside={
                    <span
                      className="gx-mono"
                      style={{
                        fontSize: 12.5,
                        color: "var(--gx-accent-ink)",
                        background: "var(--gx-accent-soft)",
                        padding: "4px 8px",
                        borderRadius: 6,
                      }}
                    >
                      ≈ {formatCny(dashboard.credits.today)}
                    </span>
                  }
                />
              </div>
            </div>
            <div style={{ display: "flex", gap: 28, fontSize: 12.5, color: "var(--gx-faint)" }}>
              <span>
                {t("today.week")} <b className="gx-mono" style={{ color: "var(--gx-ink)", fontWeight: 500 }}>{formatPoints(dashboard.credits.week)}</b>
              </span>
              <span>
                {t("today.month")} <b className="gx-mono" style={{ color: "var(--gx-ink)", fontWeight: 500 }}>{formatPoints(dashboard.credits.month)}</b>
              </span>
              <span>
                {t("today.total")} <b className="gx-mono" style={{ color: "var(--gx-ink)", fontWeight: 500 }}>{formatPoints(dashboard.credits.total)}</b>
              </span>
            </div>
          </Card>

          {/* minWidth 0：fr 列默认会被不换行的内容撑宽（出处那一行、机器名、不可用原因），窗口窄到 960 时
              右边的卡就被挤出页面、直接裁掉。放开之后长字自己截断。 */}
          <Card className="gx-rise gx-rise--1" style={{ padding: "22px 24px", display: "flex", flexDirection: "column", gap: 14, minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 14, fontWeight: 600 }}>{t("today.window")}</div>
                {source}
                <div style={{ fontSize: 12, color: "var(--gx-faint)", marginTop: 2 }}>
                  {describeHours(hours) || t("today.windowAllDay")}
                </div>
              </div>
              <LinkBtn onClick={() => router.push("/provider/share")}>{t("today.windowAdjust")}</LinkBtn>
            </div>
            <HourBar
              hours={hours}
              now={now.getHours() + now.getMinutes() / 60}
              nowLabel={`${t("common.today")} ${formatClock(now.toISOString())}`}
            />
            <div style={{ fontSize: 12, color: "var(--gx-faint)", display: "flex", alignItems: "center", gap: 8 }}>
              <IconMoon size={14} />
              {isSharingNow(hours, now) && minutesLeft > 0
                ? t("today.windowLeft", { value: formatMinutes(minutesLeft, locale) })
                : nextStart
                  ? t("today.windowNext", { value: nextStart })
                  : t("today.windowAllDay")}
            </div>
          </Card>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1.15fr 1fr", gap: 14, flex: 1, minHeight: 0 }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 14, minHeight: 0, minWidth: 0 }}>
            <Card className="gx-rise gx-rise--2" style={{ padding: "18px 24px 20px", display: "flex", flexDirection: "column", gap: 14 }}>
              <div>
                <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12 }}>
                  <span style={{ fontSize: 14, fontWeight: 600 }}>{t("today.quota")}</span>
                  <span style={{ fontSize: 12, color: "var(--gx-faint)" }}>{t("today.quotaHint")}</span>
                </div>
                {source}
              </div>
              {primary && primary.quota.length > 0 ? (
                <div style={{ display: "grid", gridTemplateColumns: QUOTA_COLUMNS, gap: "14px 20px" }}>
                  {primary.quota.slice(0, 3).map((item) => (
                    <div className="gx-quota" key={item.unit}>
                      <div className="gx-quota__label">
                        <span>{unitLabel(item.unit, t)}</span>
                        <span className="gx-mono" style={{ color: "var(--gx-ink)", fontWeight: 500 }}>
                          {formatUnitValue(item.unit, item.used)}{" "}
                          <span style={{ color: "var(--gx-faint)", fontWeight: 400 }}>
                            / {formatUnitValue(item.unit, item.limit)}
                          </span>
                        </span>
                      </div>
                      <Meter used={item.used} limit={item.limit} warned={item.warned} />
                    </div>
                  ))}
                </div>
              ) : (
                <span style={{ fontSize: 12.5, color: "var(--gx-faint)" }}>{t("today.quotaEmpty")}</span>
              )}
            </Card>

            <Card className="gx-rise gx-rise--3" style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", overflow: "hidden" }}>
              <CardHead
                title={t("today.recent")}
                action={
                  <LinkBtn arrow onClick={() => router.push("/provider/records")}>
                    {t("today.recentAll")}
                  </LinkBtn>
                }
              />
              <div className="gx-th" style={{ gridTemplateColumns: "50px 1.3fr 1fr 56px 52px", fontSize: 12 }}>
                <span>{t("today.col.time")}</span>
                <span>{t("today.col.model")}</span>
                <span>{t("today.col.io")}</span>
                <span>{t("today.col.cost")}</span>
                <span style={{ textAlign: "right" }}>{t("today.col.credit")}</span>
              </div>
              <div className="gx-rows">
                {records.length === 0 ? (
                  <div className="gx-empty">{t("records.empty")}</div>
                ) : (
                  records.map((record) => (
                    <div key={record.unitId} className="gx-row" style={{ gridTemplateColumns: "50px 1.3fr 1fr 56px 52px", fontSize: 12 }}>
                      <span className="gx-mono" style={{ color: "var(--gx-faint)" }}>{formatClock(record.startedAt)}</span>
                      <span className="gx-mono" style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{record.model || record.kind}</span>
                      <span className="gx-mono" style={{ color: "var(--gx-soft)" }}>
                        {formatCompact(record.usage["llm.input_tokens"] ?? 0)} → {formatCompact(record.usage["llm.output_tokens"] ?? 0)}
                      </span>
                      <span className="gx-mono" style={{ color: "var(--gx-soft)" }}>{durationOf(record)}</span>
                      <span
                        className="gx-mono"
                        style={{ textAlign: "right", color: record.credits > 0 ? "var(--gx-accent-ink)" : "var(--gx-faint)", fontWeight: record.credits > 0 ? 500 : 400 }}
                      >
                        {record.credits > 0 ? formatSignedPoints(record.credits) : t("records.state.failed")}
                      </span>
                    </div>
                  ))
                )}
              </div>
            </Card>
          </div>

          {/* minHeight 0 加上中间那段自己滚：机器一多，列表就比这张卡高。这一页是 gx-body--fixed，
              撑出去的部分会被直接裁掉，而不是出滚动条。minWidth 0 同上面时段卡。 */}
          <Card className="gx-rise gx-rise--2" style={{ padding: "18px 20px", display: "flex", flexDirection: "column", minHeight: 0, minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 6 }}>
              <span style={{ fontSize: 14, fontWeight: 600 }}>{grouped ? t("today.machines") : t("today.capability")}</span>
              {grouped ? (
                <span style={{ fontSize: 12, color: "var(--gx-faint)" }}>
                  {t("today.machinesOnline", { online: machines.filter(isNodeOnline).length, total: machines.length })}
                </span>
              ) : (
                <span className="gx-mono" style={{ fontSize: 11, color: "var(--gx-faint)" }}>
                  bridge {machines.find(isNodeOnline)?.bridgeVersion || "-"}
                </span>
              )}
            </div>
            {/* 和底下提示框隔开一点：滚到一半的那行贴着提示框的底色切断，看着像两块叠在一起。 */}
            <div className="gx-scroll" style={{ flex: 1, minHeight: 0, marginBottom: 10, overflowY: "auto" }}>
              {grouped
                ? machines.map((node) => (
                    <MachineGroup
                      key={node.nodeId}
                      node={node}
                      local={node.nodeId === localNodeId}
                      busy={busy}
                      onToggle={(item, on) => void toggleOne(item, on)}
                    />
                  ))
                : contributions.map((item) => (
                    <CapabilityRow
                      key={`${item.nodeId}:${item.cid}`}
                      contribution={item}
                      busy={busy}
                      onToggle={(on) => void toggleOne(item, on)}
                    />
                  ))}
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                  padding: "12px 0",
                  borderTop: "1px solid var(--gx-line)",
                  opacity: 0.55,
                }}
              >
                <span style={{ width: 34, height: 34, borderRadius: 9, display: "grid", placeItems: "center", background: "var(--gx-muted)", color: "var(--gx-faint)" }}>
                  <IconGpu size={18} />
                </span>
                <span style={{ flex: 1 }}>
                  {/* 分组时不说「本机」：这一行不属于上面任何一台。 */}
                  <span style={{ display: "block", fontSize: 13.5, fontWeight: 600 }}>{grouped ? t("share.gpu") : t("today.gpu")}</span>
                  <span className="gx-mono" style={{ display: "block", fontSize: 11, color: "var(--gx-faint)", marginTop: 2 }}>
                    {t("today.soon")}
                  </span>
                </span>
              </div>
            </div>
            <Note>{t("today.capabilityHint")}</Note>
          </Card>
        </div>
      </div>
    </>
  );
}

/**
 * 「今日额度」「共享时段」两张卡概括的是哪一条贡献。
 *
 * 两张卡只摆得下一条的额度和时段，机器一多就得挑。按这一页头一个问题「现在在不在赚」挑：
 *   1. 在线机器上开着的 —— 此刻真在接单，它的额度到顶、时段结束，才是今天几点停；
 *   2. 开着、但机器离线的 —— 连回来就按它的额度和时段接单；
 *   3. 一条都没开 —— 取第一条，至少看得见额度和时段配成了什么样。
 * 同一档里按机器顺序取，这台电脑在最前。只有一台机器时，这就是 active[0] ?? contributions[0]。
 *
 * 多台机器时挑中的是哪台的哪一条，写在两张卡的标题下（SummarySource）：挑可以，不能悄悄挑。
 */
function pickSummary(machines: NodeView[]): { node: NodeView; row: ContributionView } | null {
  const rows = machines.flatMap((node) => visibleContributions(node.contributions).map((row) => ({ node, row })));
  const active = rows.filter(({ row }) => row.status === "active");
  return active.find(({ node }) => isNodeOnline(node)) ?? active[0] ?? rows[0] ?? null;
}

/**
 * 概括卡标题下那一行「这台电脑 · Codex 订阅」。悬停说挑法，免得主人以为别的机器没设额度。
 *
 * 单独占一行，不挤在标题右边：Nova 窗口最窄 960，英文下标题、这一行、额度卡的提示三样
 * 并排放不下，挤在一起时被截掉的偏偏是这一行。
 */
function SummarySource({ node, row, local }: { node: NodeView; row: ContributionView; local: boolean }) {
  const { t } = useLocale();
  const label = `${local ? t("account.thisComputer") : nodeDisplayName(node)} · ${providerTitle(row.provider, t)}`;
  return (
    // 窄窗口下这一行会被截断，悬停先给全文，再说挑法。
    <div title={`${label}\n${t("today.summaryRule")}`} style={{ display: "flex", alignItems: "center", gap: 5, marginTop: 3, fontSize: 12, color: "var(--gx-faint)" }}>
      <IconMonitor size={13} style={{ flex: "0 0 auto" }} />
      <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{label}</span>
    </div>
  );
}

/**
 * 能力列表里的一台机器：标题行，下面是它的能力。只在不止一台机器时出现。
 *
 * 标题行右边只说这台最该被看见的那句：封禁了、离线多久了；在线才写 bridge 版本 ——
 * 离线机器的版本号没人关心，它什么时候掉的线才是要看的。
 * 离线机器的开关照样能拨：状态存在平台上，它连回来就按新的来。
 */
function MachineGroup({
  node,
  local,
  busy,
  onToggle,
}: {
  node: NodeView;
  local: boolean;
  busy: boolean;
  onToggle: (contribution: ContributionView, on: boolean) => void;
}) {
  const { t } = useLocale();
  const rows = visibleContributions(node.contributions);
  const online = isNodeOnline(node);
  const name = nodeDisplayName(node);
  const state = node.banned
    ? t("share.machineBanned")
    : online
      ? `bridge ${node.bridgeVersion || "-"}`
      : node.lastBeatAt
        ? t("share.machineSeen", { value: formatRelative(node.lastBeatAt) })
        : t("share.machineNeverSeen");
  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "12px 0 2px", borderTop: "1px solid var(--gx-line)" }}>
        <span className={`gx-state${node.banned ? " is-err" : online ? " is-on" : ""}`} style={{ marginTop: 0 }} />
        {/* 机器名常是 xxx-MacBook-Pro.local 这种长串，窄了会被截，悬停给全名和节点 ID。 */}
        <span
          title={node.displayName ? `${node.displayName} · ${node.nodeId}` : node.nodeId}
          style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 12.5, fontWeight: 600 }}
        >
          {name}
        </span>
        {local ? <span className="gx-pill gx-pill--sm">{t("account.thisComputer")}</span> : null}
        <span
          className={online ? "gx-mono" : undefined}
          style={{
            flex: "0 0 auto",
            marginLeft: "auto",
            paddingLeft: 8,
            fontSize: 11,
            whiteSpace: "nowrap",
            color: node.banned ? "var(--gx-danger)" : "var(--gx-faint)",
          }}
        >
          {state}
        </span>
      </div>
      {rows.length === 0 ? (
        <div style={{ padding: "4px 0 12px 15px", fontSize: 12, color: "var(--gx-faint)" }}>{t("share.machineNoCapability")}</div>
      ) : (
        rows.map((row, index) => (
          <CapabilityRow
            key={row.cid}
            contribution={row}
            machine={name}
            divider={index > 0}
            busy={busy}
            onToggle={(on) => onToggle(row, on)}
          />
        ))
      )}
    </div>
  );
}

/**
 * 一条能力。
 *
 * 「你自己关掉了」和「这台机器现在干不了」是两件事，处置方式完全不同 ——
 * 前者点开关就行，后者要去那台机器上修（多半是登录态过期）。所以不可用的
 * 那条把原因原样显示出来，而不是把开关灰掉了事。
 */
function CapabilityRow({
  contribution,
  machine,
  divider = true,
  busy,
  onToggle,
}: {
  contribution: ContributionView;
  /** 分组时传所属机器名：开关的读屏标签和悬停提示要带上它，不然几台上的「Claude 订阅」念出来一模一样。 */
  machine?: string;
  /** 分组里的第一条不画上边线，那条线画在机器标题行上了。 */
  divider?: boolean;
  busy: boolean;
  onToggle: (on: boolean) => void;
}) {
  const { t } = useLocale();
  const on = contribution.status === "active";
  const title = providerTitle(contribution.provider, t);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 0", borderTop: divider ? "1px solid var(--gx-line)" : undefined }}>
      <span
        style={{
          width: 34,
          height: 34,
          borderRadius: 9,
          display: "grid",
          placeItems: "center",
          background: on ? "var(--gx-accent-soft)" : "var(--gx-muted)",
          color: on ? "var(--gx-accent)" : "var(--gx-faint)",
        }}
      >
        <IconSparkle size={18} />
      </span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: "block", fontSize: 13.5, fontWeight: 600 }}>{title}</span>
        <span className="gx-mono" style={{ display: "block", fontSize: 11, color: "var(--gx-faint)", marginTop: 2, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          {!contribution.available
            ? contribution.unavailableReason || t("share.unavailable")
            : on
              ? `${contribution.provider} · ${contribution.seats} × ${contribution.seatConcurrency}`
              : `${contribution.provider} · ${t("today.notShared")}`}
        </span>
      </span>
      {contribution.available ? (
        <Switch checked={on} disabled={busy} label={machine ? `${title} · ${machine}` : title} onChange={onToggle} />
      ) : (
        <IconAlert size={16} style={{ color: "var(--gx-warn)" }} />
      )}
    </div>
  );
}

/**
 * 上游能力的人话名。字典里没有的原样显示 provider id ——
 * 新接一个上游只是还没有译名，不该在界面上变成空白。
 */
function providerTitle(provider: string, t: (key: string) => string): string {
  const key = `capability.${provider}`;
  const label = t(key);
  return label === key ? provider : label;
}

function describeProviders(rows: ContributionView[], t: (key: string) => string): string {
  const names = Array.from(new Set(rows.map((row) => providerTitle(row.provider, t))));
  return names.join(" · ");
}

function durationOf(record: ExecutionRecord): string {
  if (!record.startedAt || !record.finishedAt) return "-";
  return formatMillis(new Date(record.finishedAt).getTime() - new Date(record.startedAt).getTime());
}

function formatMinutes(minutes: number, locale: "zh-CN" | "en-US"): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (locale === "en-US") return hours > 0 ? `${hours}h ${rest}m` : `${rest}m`;
  return hours > 0 ? `${hours} 小时 ${rest} 分` : `${rest} 分钟`;
}

function formatToday(locale: "zh-CN" | "en-US"): string {
  const now = new Date();
  return now.toLocaleDateString(locale, { month: "long", day: "numeric", weekday: "long" });
}
