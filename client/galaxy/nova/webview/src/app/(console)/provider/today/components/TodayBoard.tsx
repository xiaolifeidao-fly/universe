"use client";

/**
 * 「今天」。这一页只回答三个问题：现在在不在共享、今天赚了多少、今晚几点开始。
 *
 * 别的都往后放 —— 主人一天里打开 Nova 的绝大多数次数，就是想看这三件事。
 * 额度、能力开关摆在下半屏，是因为它们回答的是「为什么没在赚」，
 * 只有前三个问题答得不对劲时才会往下看。
 */

import { message } from "antd";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { HourBar } from "@/components/galaxy/charts";
import { PageHeader } from "@/components/shell/GalaxyShell";
import { IconAlert, IconBell, IconGpu, IconMoon, IconSparkle } from "@/components/ui/icons";
import { Btn, Card, CardHead, EmptyState, Figure, IconBtn, LinkBtn, Loading, LiveDot, Meter, Note, Pill, Switch } from "@/components/ui/kit";
import { useLocale } from "@/i18n/LocaleProvider";
import {
  formatClock,
  formatCny,
  formatCompact,
  formatInt,
  formatMillis,
  formatSignedInt,
  formatSince,
  formatUnitValue,
  unitLabel,
} from "@/utils/format";
import { describeHours, isSharingNow, minutesLeftInWindow, nextWindowStart, scheduleToHours } from "@/utils/schedule";
import {
  fetchDashboard,
  fetchNodes,
  fetchRecords,
  isNodeOnline,
  setContributionStatus,
  visibleContributions,
  type ContributionView,
  type ExecutionRecord,
  type NodeView,
  type ProviderDashboard,
} from "../../api/provider.api";

/** 服务端一律用微分存钱，这里只做展示折算。 */
const CREDIT_RATE = 100;

export function TodayBoard() {
  const { t, locale } = useLocale();
  const router = useRouter();
  const [dashboard, setDashboard] = useState<ProviderDashboard | null>(null);
  const [nodes, setNodes] = useState<NodeView[]>([]);
  const [records, setRecords] = useState<ExecutionRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [summary, nodeList, recent] = await Promise.all([fetchDashboard(), fetchNodes(), fetchRecords("", 5)]);
      setDashboard(summary);
      setNodes(nodeList);
      setRecords(recent);
    } catch (error) {
      message.error((error as Error).message || t("common.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  // 20 秒一拉。贡献的在线/额度状态由心跳每 15 秒推一次，前端比数据本身
  // 更新得还勤没有意义，也不值得为此多开一条长连接。
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 20_000);
    return () => clearInterval(timer);
  }, [load]);

  const contributions = useMemo(
    () => nodes.flatMap((node) => visibleContributions(node.contributions)),
    [nodes],
  );
  const online = nodes.some(isNodeOnline);
  const active = contributions.filter((item) => item.status === "active");
  const primary = active[0] ?? contributions[0] ?? null;
  const hours = useMemo(() => scheduleToHours(primary?.schedule), [primary]);
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

  if (!dashboard || dashboard.nodes === 0) {
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

  const sharing = online && active.length > 0;
  const minutesLeft = minutesLeftInWindow(hours, now);
  const nextStart = nextWindowStart(hours, now);

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
                  ? `${t("today.sharing")} · ${describeProviders(active)}`
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
                <Figure
                  value={formatInt(dashboard.credits.today)}
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
                      ≈ {formatCny((dashboard.credits.today / CREDIT_RATE) * 1_000_000)}
                    </span>
                  }
                />
              </div>
            </div>
            <div style={{ display: "flex", gap: 28, fontSize: 12.5, color: "var(--gx-faint)" }}>
              <span>
                {t("today.week")} <b className="gx-mono" style={{ color: "var(--gx-ink)", fontWeight: 500 }}>{formatInt(dashboard.credits.week)}</b>
              </span>
              <span>
                {t("today.month")} <b className="gx-mono" style={{ color: "var(--gx-ink)", fontWeight: 500 }}>{formatInt(dashboard.credits.month)}</b>
              </span>
              <span>
                {t("today.total")} <b className="gx-mono" style={{ color: "var(--gx-ink)", fontWeight: 500 }}>{formatInt(dashboard.credits.total)}</b>
              </span>
            </div>
          </Card>

          <Card className="gx-rise gx-rise--1" style={{ padding: "22px 24px", display: "flex", flexDirection: "column", gap: 14 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
              <div>
                <div style={{ fontSize: 14, fontWeight: 600 }}>{t("today.window")}</div>
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
          <div style={{ display: "flex", flexDirection: "column", gap: 14, minHeight: 0 }}>
            <Card className="gx-rise gx-rise--2" style={{ padding: "18px 24px 20px", display: "flex", flexDirection: "column", gap: 14 }}>
              <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12 }}>
                <span style={{ fontSize: 14, fontWeight: 600 }}>{t("today.quota")}</span>
                <span style={{ fontSize: 12, color: "var(--gx-faint)" }}>{t("today.quotaHint")}</span>
              </div>
              {primary && primary.quota.length > 0 ? (
                <div style={{ display: "grid", gridTemplateColumns: `repeat(${Math.min(3, primary.quota.length)}, minmax(0, 1fr))`, gap: 20 }}>
                  {primary.quota.slice(0, 3).map((item) => (
                    <div className="gx-quota" key={item.unit}>
                      <div className="gx-quota__label">
                        <span>{unitLabel(item.unit)}</span>
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
                        {record.credits > 0 ? formatSignedInt(record.credits) : t("records.state.failed")}
                      </span>
                    </div>
                  ))
                )}
              </div>
            </Card>
          </div>

          <Card className="gx-rise gx-rise--2" style={{ padding: "18px 20px", display: "flex", flexDirection: "column" }}>
            <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 6 }}>
              <span style={{ fontSize: 14, fontWeight: 600 }}>{t("today.capability")}</span>
              <span className="gx-mono" style={{ fontSize: 11, color: "var(--gx-faint)" }}>
                bridge {nodes.find(isNodeOnline)?.bridgeVersion || "-"}
              </span>
            </div>
            {contributions.map((item) => (
              <CapabilityRow
                key={`${item.nodeId}:${item.cid}`}
                contribution={item}
                busy={busy}
                onToggle={async (on) => {
                  setBusy(true);
                  try {
                    await setContributionStatus(item.nodeId, item.cid, on ? "active" : "paused");
                    await load();
                  } catch (error) {
                    message.error((error as Error).message || t("common.actionFailed"));
                  } finally {
                    setBusy(false);
                  }
                }}
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
                <span style={{ display: "block", fontSize: 13.5, fontWeight: 600 }}>{t("today.gpu")}</span>
                <span className="gx-mono" style={{ display: "block", fontSize: 11, color: "var(--gx-faint)", marginTop: 2 }}>
                  {t("today.soon")}
                </span>
              </span>
            </div>
            <div style={{ flex: 1 }} />
            <Note>{t("today.capabilityHint")}</Note>
          </Card>
        </div>
      </div>
    </>
  );
}

/**
 * 一条本机能力。
 *
 * 「你自己关掉了」和「这台机器现在干不了」是两件事，处置方式完全不同 ——
 * 前者点开关就行，后者要去那台机器上修（多半是登录态过期）。所以不可用的
 * 那条把原因原样显示出来，而不是把开关灰掉了事。
 */
function CapabilityRow({
  contribution,
  busy,
  onToggle,
}: {
  contribution: ContributionView;
  busy: boolean;
  onToggle: (on: boolean) => void;
}) {
  const { t } = useLocale();
  const on = contribution.status === "active";
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 0", borderTop: "1px solid var(--gx-line)" }}>
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
        <span style={{ display: "block", fontSize: 13.5, fontWeight: 600 }}>{providerTitle(contribution.provider)}</span>
        <span className="gx-mono" style={{ display: "block", fontSize: 11, color: "var(--gx-faint)", marginTop: 2, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          {!contribution.available
            ? contribution.unavailableReason || t("share.unavailable")
            : on
              ? `${contribution.provider} · ${contribution.seats} × ${contribution.seatConcurrency}`
              : `${contribution.provider} · ${t("today.notShared")}`}
        </span>
      </span>
      {contribution.available ? (
        <Switch checked={on} disabled={busy} label={providerTitle(contribution.provider)} onChange={onToggle} />
      ) : (
        <IconAlert size={16} style={{ color: "var(--gx-warn)" }} />
      )}
    </div>
  );
}

const PROVIDER_TITLES: Record<string, string> = {
  claude_oauth: "Claude 订阅",
  codex_chatgpt: "Codex 订阅",
  codex_oauth: "Codex 订阅",
};

function providerTitle(provider: string): string {
  return PROVIDER_TITLES[provider] ?? provider;
}

function describeProviders(rows: ContributionView[]): string {
  const names = Array.from(new Set(rows.map((row) => providerTitle(row.provider))));
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
