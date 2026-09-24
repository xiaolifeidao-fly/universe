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

import { message, Modal } from "antd";
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
  formatInt,
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
import { confirmForceClose, isClosing, switchContributions } from "../../contributionClose";
import {
  fetchDashboard,
  fetchNodes,
  fetchRecords,
  isNodeOnline,
  nodeDisplayName,
  orderMachines,
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

/**
 * 一条记录的 token 流向：新增输入 → 输出，命中缓存的另算。
 *
 * 「输入」只算这次真正新读进去的内容 —— 命中缓存的那部分被上游按几分之一计价，
 * 混进同一个数字里，主人会以为自己的机器白跑了一大堆活。所以缓存单独跟在后面，
 * 没有就不显示（大多数行都没有，摆一个 0 只是噪声）。
 *
 * 这一页是概览，一行只放得下一个补充数字，所以只摆缓存读。缓存写入整个不露出
 * （和模型页、账单、记录页一致）：上游真按 TTL 分档报这一项的只有 Anthropic，
 * 摆出来会让一多半行常年是 0。悬停能看到输入 / 输出 / 缓存读三个数的明细。
 */
function TokenFlow({ record }: { record: ExecutionRecord }) {
  const { t } = useLocale();
  const input = record.usage["llm.input_tokens"] ?? 0;
  const output = record.usage["llm.output_tokens"] ?? 0;
  // 缓存写入不露出（和模型页、账单一致）：只有 Claude 一族真在按 TTL 分档计费，
  // 摆出来会让一多半记录常年是 0。量照常在 record.usage 里，只是不显示。
  const cacheRead = record.usage["llm.cache_read_tokens"] ?? 0;
  const detail = [
    `${t("records.col.in")} ${formatInt(input)}`,
    `${t("records.col.out")} ${formatInt(output)}`,
    `${t("records.col.cacheRead")} ${formatInt(cacheRead)}`,
  ].join(" · ");
  return (
    <span className="gx-mono" style={{ color: "var(--gx-soft)", overflow: "hidden", textOverflow: "ellipsis" }} title={detail}>
      {formatCompact(input)} → {formatCompact(output)}
      {cacheRead > 0 ? (
        <span style={{ color: "var(--gx-faint)" }}> · {t("today.cached", { value: formatCompact(cacheRead) })}</span>
      ) : null}
    </span>
  );
}

function TokenSummary({ usage }: { usage: Record<string, number> }) {
  const { t } = useLocale();
  const input = usage["llm.input_tokens"] ?? 0;
  const output = usage["llm.output_tokens"] ?? 0;
  const cacheRead = usage["llm.cache_read_tokens"] ?? 0;
  const cacheWrite = usage["llm.cache_write_tokens"] ?? 0;
  const total = usage["llm.total_tokens"] ?? input + output + cacheRead + cacheWrite;
  const items = [
    [t("today.tokens.input"), input],
    [t("today.tokens.output"), output],
    [t("today.tokens.cache"), cacheRead + cacheWrite],
    [t("today.tokens.total"), total],
  ] as const;
  return (
    <Card className="gx-rise gx-rise--2" style={{ padding: "16px 20px" }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12, marginBottom: 12 }}>
        <span style={{ fontSize: 14, fontWeight: 600 }}>{t("today.tokens.title")}</span>
        <span style={{ fontSize: 12, color: "var(--gx-faint)" }}>{t("today.tokens.hint")}</span>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 12 }}>
        {items.map(([label, value]) => (
          <div key={label} style={{ minWidth: 0 }}>
            <div style={{ fontSize: 12, color: "var(--gx-faint)", marginBottom: 4 }}>{label}</div>
            <div className="gx-mono" style={{ fontSize: 20, color: "var(--gx-ink)", fontWeight: 600 }}>{formatCompact(value)}</div>
          </div>
        ))}
      </div>
    </Card>
  );
}

export function TodayBoard() {
  const { t, locale } = useLocale();
  const router = useRouter();
  const [dashboard, setDashboard] = useState<ProviderDashboard | null>(null);
  const [nodes, setNodes] = useState<NodeView[]>([]);
  const [records, setRecords] = useState<ExecutionRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [modal, modalHolder] = Modal.useModal();
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

  /**
   * 开关若干条贡献。
   *
   * 关闭时手上还有请求在跑的，服务端会先停止接新单、等跑完自动关 ——
   * 主人点这一下就结束了，界面不再追问，只告诉他还剩多少、以及可以不等。
   */
  const switchRows = async (rows: ContributionView[], on: boolean) => {
    if (rows.length === 0) return;
    setBusy(true);
    try {
      await switchContributions({ rows, on, offStatus: "paused", t, reload: load });
    } catch (error) {
      message.error((error as Error).message || t("common.actionFailed"));
    } finally {
      setBusy(false);
    }
  };

  /** 总开关：一次改掉全部贡献。主人按它是想「现在别接单了」，不是想逐条挑。 */
  const toggleAll = (on: boolean) => void switchRows(contributions, on);

  const toggleOne = (item: ContributionView, on: boolean) => void switchRows([item], on);

  /** 「正在收尾」那条上的「立即关闭」：掐断在跑的请求，扣信誉分，问过才做。 */
  const forceClose = (item: ContributionView) =>
    void confirmForceClose({
      rows: [item],
      inflight: item.inflight,
      offStatus: "paused",
      t,
      modal,
      reload: load,
    });

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

            <TokenSummary usage={dashboard.today.usage} />

            <Card className="gx-rise gx-rise--3" style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", overflow: "hidden" }}>
              <CardHead
                title={t("today.recent")}
                action={
                  <LinkBtn arrow onClick={() => router.push("/provider/records")}>
                    {t("today.recentAll")}
                  </LinkBtn>
                }
              />
              <div className="gx-th" style={{ gridTemplateColumns: "50px 1.05fr 1.45fr 56px 52px", fontSize: 12 }}>
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
                    <div key={record.unitId} className="gx-row" style={{ gridTemplateColumns: "50px 1.05fr 1.45fr 56px 52px", fontSize: 12 }}>
                      <span className="gx-mono" style={{ color: "var(--gx-faint)" }}>{formatClock(record.startedAt)}</span>
                      <span className="gx-mono" style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{record.model || record.kind}</span>
                      <TokenFlow record={record} />
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
                      onToggle={toggleOne}
                      onForce={forceClose}
                    />
                  ))
                : contributions.map((item) => (
                    <CapabilityRow
                      key={`${item.nodeId}:${item.cid}`}
                      contribution={item}
                      busy={busy}
                      onToggle={(on) => toggleOne(item, on)}
                      onForce={() => forceClose(item)}
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
      {modalHolder}
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
  onForce,
}: {
  node: NodeView;
  local: boolean;
  busy: boolean;
  onToggle: (contribution: ContributionView, on: boolean) => void;
  onForce: (contribution: ContributionView) => void;
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
            onForce={() => onForce(row)}
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
  onForce,
}: {
  contribution: ContributionView;
  /** 分组时传所属机器名：开关的读屏标签和悬停提示要带上它，不然几台上的「Claude 订阅」念出来一模一样。 */
  machine?: string;
  /** 分组里的第一条不画上边线，那条线画在机器标题行上了。 */
  divider?: boolean;
  busy: boolean;
  onToggle: (on: boolean) => void;
  /** 「正在收尾」时的「立即关闭」。掐断在跑的请求要扣信誉分，所以它自己会先确认。 */
  onForce: () => void;
}) {
  const { t } = useLocale();
  // 正在收尾的那条画成**关着**：主人的意图就是关，服务端也已经不给它派新单了。
  // 画成开着的话，主人会以为刚才那下没点上，然后一遍遍地点 —— 而每一下都只是
  // 重复同一个意图。开关旁边那行字负责说清楚「还在跑，跑完自动关」。
  const closing = isClosing(contribution);
  const on = contribution.status === "active" && !closing;
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
            : closing
              ? t("close.closingRow", { value: contribution.inflight })
              : // 开着、但上游余量到了主人划的线：这时候一单也派不进来，副行必须说出来。
                // 照常显示「3 × 2」的话，这一页就成了「界面共享中、实际一直 no_capacity」
                // 那类最难查的状态，而它其实是主人自己设的，一句话就能说清。
                on && contribution.upstreamBlock
                ? t("today.upstreamHold", { left: contribution.upstreamBlock.left.toFixed(0) })
                : on
                  ? `${contribution.provider} · ${contribution.seats} × ${contribution.seatConcurrency}`
                  : `${contribution.provider} · ${t("today.notShared")}`}
        </span>
      </span>
      {closing ? <LinkBtn onClick={onForce}>{t("close.forceNow")}</LinkBtn> : null}
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
