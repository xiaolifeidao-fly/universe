"use client";

/**
 * 共享设置 —— 提供者的**唯一**配置入口。
 *
 * 开关、额度、座位、模型范围、挂机时段都在这里改，改完下一次心跳（≤15s）
 * 那台机器就换过来了。主人不需要回到那台机器上做任何事。
 *
 * 仍然不能在这里**凭空造**一条贡献：能力是节点探测出来上报的，
 * 「这台机器上有没有 Claude」只有那台机器知道。控制台管的是「要不要、给多少」。
 *
 * 两个状态要分开看，处置方式完全不同：
 *   status=disabled  你自己关掉了      → 打开就行
 *   available=false  本机干不了这件事  → 得去那台机器上修（多半是登录态过期）
 */

import { message } from "antd";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { HourBar } from "@/components/galaxy/charts";
import { PageHeader } from "@/components/shell/GalaxyShell";
import { IconAlert, IconGpu, IconPlus, IconSparkle } from "@/components/ui/icons";
import {
  Btn,
  Card,
  CardHead,
  ChipInput,
  EmptyState,
  Field,
  Loading,
  Note,
  Pill,
  Seg,
  Switch,
} from "@/components/ui/kit";
import { useLocale } from "@/i18n/LocaleProvider";
import { unitLabel } from "@/utils/format";
import { hoursToSchedule, scheduleToHours } from "@/utils/schedule";
import {
  fetchNodes,
  saveContributionLimits,
  setContributionStatus,
  visibleContributions,
  type ContributionView,
  type QuotaGrantInput,
} from "../../api/provider.api";
import { pingBridge, startUpstreamLogin } from "../../api/bridge.api";

/** llm.chat 的常用三维。别的 kind 自己加行。 */
const COMMON_UNITS = ["llm.output_tokens", "llm.input_tokens", "llm.calls", "time.seconds"];

interface Draft {
  modelsAllow: string[];
  modelsDeny: string[];
  seats: number;
  seatConcurrency: number;
  quota: QuotaGrantInput[];
  hours: boolean[];
}

function toDraft(row: ContributionView): Draft {
  return {
    modelsAllow: [...(row.modelsAllow ?? [])],
    modelsDeny: [...(row.modelsDeny ?? [])],
    seats: row.seats || 3,
    seatConcurrency: row.seatConcurrency || 2,
    quota: row.quota.map((item) => ({ unit: item.unit, limit: item.limit, window: item.window || "day" })),
    hours: scheduleToHours(row.schedule),
  };
}

/** 改了几处。摆在保存条上，因为「有没有没保存的东西」比「保存按钮亮不亮」更该被看见。 */
function countChanges(draft: Draft, row: ContributionView): number {
  const base = toDraft(row);
  let changes = 0;
  if (draft.modelsAllow.join() !== base.modelsAllow.join()) changes += 1;
  if (draft.modelsDeny.join() !== base.modelsDeny.join()) changes += 1;
  if (draft.seats !== base.seats) changes += 1;
  if (draft.seatConcurrency !== base.seatConcurrency) changes += 1;
  if (JSON.stringify(draft.quota) !== JSON.stringify(base.quota)) changes += 1;
  if (draft.hours.join() !== base.hours.join()) changes += 1;
  return changes;
}

export function ShareSettings() {
  const { t } = useLocale();
  const router = useRouter();
  const [rows, setRows] = useState<ContributionView[]>([]);
  const [selected, setSelected] = useState("");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  // 本机 bridge 的 nodeId。「去授权」只对这台机器的贡献有意义 ——
  // 贡献可能属于别的机器，浏览器够不到那台的 bridge。
  const [localNodeId, setLocalNodeId] = useState("");

  const load = useCallback(async () => {
    try {
      const nodes = await fetchNodes();
      const flattened = nodes.flatMap((node) => visibleContributions(node.contributions));
      setRows(flattened);
      setSelected((current) => (flattened.some((item) => item.cid === current) ? current : (flattened[0]?.cid ?? "")));
    } catch (error) {
      message.error((error as Error).message || t("common.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    void pingBridge().then((ping) => setLocalNodeId(ping?.nodeId ?? ""));
  }, []);

  const current = useMemo(() => rows.find((row) => row.cid === selected) ?? null, [rows, selected]);

  // 切换贡献时把草稿换成那一条的当前值。改到一半切走的编辑就丢了 ——
  // 留着它更糟：回来时看到的是另一条贡献的数字，按保存会写到错的地方。
  useEffect(() => {
    setDraft(current ? toDraft(current) : null);
  }, [current]);

  const changes = current && draft ? countChanges(draft, current) : 0;

  const toggle = async (row: ContributionView, on: boolean) => {
    setBusy(true);
    try {
      await setContributionStatus(row.nodeId, row.cid, on ? "active" : "disabled");
      await load();
    } catch (error) {
      // 「还有人绑在上面」是服务端拒的，原文比任何前端兜底话术都准。
      message.error((error as Error).message || t("common.actionFailed"));
    } finally {
      setBusy(false);
    }
  };

  const authorize = async (row: ContributionView) => {
    setBusy(true);
    try {
      const result = await startUpstreamLogin(row.cid);
      if (result.alreadyAuthorized) message.info(t("share.authAlready"));
      else if (result.launched) message.success(t("share.authLaunched"));
      else message.warning(t("share.authManual", { command: result.command }));
    } catch (error) {
      message.error((error as Error).message || t("common.actionFailed"));
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    if (!current || !draft) return;
    setBusy(true);
    try {
      await saveContributionLimits({
        nodeId: current.nodeId,
        cid: current.cid,
        modelsAllow: draft.modelsAllow,
        modelsDeny: draft.modelsDeny,
        seats: draft.seats,
        seatConcurrency: draft.seatConcurrency,
        quota: draft.quota.filter((item) => item.unit && item.limit > 0),
        schedule: hoursToSchedule(draft.hours, Intl.DateTimeFormat().resolvedOptions().timeZone),
      });
      message.success(t("common.saved"));
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
        <PageHeader title={t("share.title")} meta={t("share.subtitle")} />
        <div className="gx-body">
          <Loading />
        </div>
      </>
    );
  }

  if (rows.length === 0) {
    return (
      <>
        <PageHeader title={t("share.title")} meta={t("share.subtitle")} />
        <div className="gx-body">
          <Card>
            <EmptyState
              title={t("share.emptyTitle")}
              hint={t("share.emptyHint")}
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

  return (
    <>
      <PageHeader title={t("share.title")} meta={t("share.subtitle")} />
      <div className="gx-body">
        <Card className="gx-rise">
          <CardHead title={t("share.detected")} hint={t("share.syncHint")} />
          <div style={{ padding: "0 18px 16px" }}>
            {rows.map((row) => (
              <div
                key={`${row.nodeId}:${row.cid}`}
                style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 0", borderTop: "1px solid var(--gx-line)" }}
              >
                <span
                  style={{
                    width: 34,
                    height: 34,
                    borderRadius: 9,
                    display: "grid",
                    placeItems: "center",
                    background: row.status === "active" ? "var(--gx-accent-soft)" : "var(--gx-muted)",
                    color: row.status === "active" ? "var(--gx-accent)" : "var(--gx-faint)",
                  }}
                >
                  <IconSparkle size={18} />
                </span>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ display: "block", fontSize: 13.5, fontWeight: 600 }}>{row.cid}</span>
                  {/* 不可用时副行换成原因。「llm.chat · codex_chatgpt」谁都猜得到，
                      「登录态过期了，去敲这条命令」才是这一刻要说的话。 */}
                  <span
                    className={row.available ? "gx-mono" : undefined}
                    style={{
                      display: "block",
                      fontSize: 11.5,
                      color: row.available ? "var(--gx-faint)" : "var(--gx-warn-ink)",
                      marginTop: 2,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {row.available ? `${row.kind} · ${row.provider}` : row.unavailableReason || t("share.unavailable")}
                  </span>
                </span>
                {row.seatsBound > 0 ? <Pill tone="accent">{t("share.bound", { value: row.seatsBound })}</Pill> : null}
                {row.available ? (
                  <>
                    <Pill tone={row.status === "active" ? "ok" : "default"}>
                      {row.status === "active" ? t("share.on") : t("share.off")}
                    </Pill>
                    <Switch
                      checked={row.status === "active"}
                      disabled={busy || (row.status === "active" && row.seatsBound > 0)}
                      label={t("share.enable")}
                      onChange={(next) => void toggle(row, next)}
                    />
                  </>
                ) : (
                  <>
                    <IconAlert size={16} style={{ color: "var(--gx-warn)" }} />
                    {localNodeId && localNodeId === row.nodeId ? (
                      <Btn tone="soft" small loading={busy} onClick={() => void authorize(row)}>
                        {t("share.authorize")}
                      </Btn>
                    ) : null}
                  </>
                )}
              </div>
            ))}
            <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 0", borderTop: "1px solid var(--gx-line)", opacity: 0.55 }}>
              <span style={{ width: 34, height: 34, borderRadius: 9, display: "grid", placeItems: "center", background: "var(--gx-muted)", color: "var(--gx-faint)" }}>
                <IconGpu size={18} />
              </span>
              <span style={{ flex: 1, fontSize: 13.5, fontWeight: 600 }}>{t("today.gpu")}</span>
              <Pill>{t("today.soon")}</Pill>
            </div>
            <div style={{ marginTop: 12 }}>
              <Note>{t("share.detectedHint")}</Note>
            </div>
          </div>
        </Card>

        {current && draft ? (
          <Card className="gx-rise gx-rise--1">
            <CardHead
              title={current.cid}
              hint={current.unavailableReason || undefined}
              action={
                rows.length > 1 ? (
                  <Seg
                    value={selected}
                    onChange={setSelected}
                    options={rows.map((row) => ({ value: row.cid, label: row.cid }))}
                  />
                ) : null
              }
            />
            <div style={{ padding: "0 22px 20px", display: "flex", flexDirection: "column", gap: 22 }}>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between" }}>
                  <span style={{ fontSize: 13, fontWeight: 600 }}>{t("share.models")}</span>
                  <span className="gx-card__hint">{t("share.modelsHint")}</span>
                </div>
                <span className="gx-label">{t("share.modelsAllow")}</span>
                <ChipInput
                  values={draft.modelsAllow}
                  suggestions={current.availableModels ?? []}
                  placeholder={t("share.modelsPlaceholder")}
                  onChange={(next) => setDraft({ ...draft, modelsAllow: next })}
                />
                <span className="gx-label" style={{ marginTop: 6 }}>
                  {t("share.modelsDeny")}
                </span>
                <ChipInput
                  values={draft.modelsDeny}
                  struck
                  suggestions={current.availableModels ?? []}
                  placeholder="claude-opus-*"
                  onChange={(next) => setDraft({ ...draft, modelsDeny: next })}
                />
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 18 }}>
                <Field label={t("share.seats")} hint={t("share.seatsHint", { value: draft.seats })}>
                  <input
                    className="gx-input gx-input--mono"
                    type="number"
                    min={1}
                    max={10}
                    value={draft.seats}
                    onChange={(event) => setDraft({ ...draft, seats: Number(event.target.value) || 1 })}
                  />
                </Field>
                <Field label={t("share.concurrency")} hint={t("share.concurrencyHint", { value: draft.seatConcurrency })}>
                  <input
                    className="gx-input gx-input--mono"
                    type="number"
                    min={1}
                    max={16}
                    value={draft.seatConcurrency}
                    onChange={(event) => setDraft({ ...draft, seatConcurrency: Number(event.target.value) || 1 })}
                  />
                </Field>
              </div>

              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between" }}>
                  <span style={{ fontSize: 13, fontWeight: 600 }}>{t("share.quota")}</span>
                  <span className="gx-card__hint">{t("share.quotaHint")}</span>
                </div>
                {draft.quota.map((item, index) => (
                  <div key={`${item.unit}-${index}`} style={{ display: "grid", gridTemplateColumns: "1.2fr 1fr 90px 36px", gap: 10, alignItems: "center" }}>
                    <select
                      className="gx-input"
                      value={item.unit}
                      onChange={(event) => {
                        const quota = [...draft.quota];
                        quota[index] = { ...item, unit: event.target.value };
                        setDraft({ ...draft, quota });
                      }}
                    >
                      {Array.from(new Set([item.unit, ...COMMON_UNITS])).filter(Boolean).map((unit) => (
                        <option key={unit} value={unit}>
                          {unitLabel(unit)}（{unit}）
                        </option>
                      ))}
                    </select>
                    <input
                      className="gx-input gx-input--mono"
                      type="number"
                      min={1}
                      value={item.limit}
                      onChange={(event) => {
                        const quota = [...draft.quota];
                        quota[index] = { ...item, limit: Number(event.target.value) || 0 };
                        setDraft({ ...draft, quota });
                      }}
                    />
                    <select
                      className="gx-input"
                      value={item.window}
                      onChange={(event) => {
                        const quota = [...draft.quota];
                        quota[index] = { ...item, window: event.target.value };
                        setDraft({ ...draft, quota });
                      }}
                    >
                      {["day", "week", "month", "total"].map((window) => (
                        <option key={window} value={window}>
                          {window}
                        </option>
                      ))}
                    </select>
                    <Btn
                      tone="ghost"
                      small
                      aria-label="remove"
                      onClick={() => setDraft({ ...draft, quota: draft.quota.filter((_, at) => at !== index) })}
                    >
                      ×
                    </Btn>
                  </div>
                ))}
                <Btn
                  tone="ghost"
                  small
                  icon={<IconPlus size={14} />}
                  onClick={() => setDraft({ ...draft, quota: [...draft.quota, { unit: COMMON_UNITS[0], limit: 1_000_000, window: "day" }] })}
                >
                  {t("share.quotaAdd")}
                </Btn>
              </div>

              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between" }}>
                  <span style={{ fontSize: 13, fontWeight: 600 }}>{t("share.window")}</span>
                  <span className="gx-card__hint">
                    {Intl.DateTimeFormat().resolvedOptions().timeZone} · {t("share.windowHint")}
                  </span>
                </div>
                <HourBar
                  hours={draft.hours}
                  onToggle={(hour) => {
                    const hours = [...draft.hours];
                    hours[hour] = !hours[hour];
                    setDraft({ ...draft, hours });
                  }}
                />
              </div>
            </div>

            <div className="gx-row__foot">
              <span>{changes > 0 ? t("share.dirty", { value: changes }) : ""}</span>
              <span style={{ display: "flex", gap: 8 }}>
                <Btn tone="ghost" small disabled={changes === 0 || busy} onClick={() => setDraft(toDraft(current))}>
                  {t("common.discard")}
                </Btn>
                <Btn tone="accent" small loading={busy} disabled={changes === 0} onClick={() => void save()}>
                  {t("share.submit")}
                </Btn>
              </span>
            </div>
          </Card>
        ) : null}
      </div>
    </>
  );
}
