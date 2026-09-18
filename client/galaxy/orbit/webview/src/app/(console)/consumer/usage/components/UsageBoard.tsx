"use client";

/**
 * 使用记录。
 *
 * 默认是**逐笔**而不是汇总：打开这一页的人多半是在问「那一次为什么扣了这么多」，
 * 而不是「这个月一共花了多少」——后者页头那排数字已经回答了。
 *
 * 会话、任务、申诉折在同一页的次级页签里。它们不配拥有各自的一级入口
 * （多数人一次都不会点开），但也不能因此消失 —— 申诉是花了钱之后唯一的出口。
 */

import { message } from "antd";
import { useCallback, useEffect, useMemo, useState } from "react";
import { PageHeader } from "@/components/shell/GalaxyShell";
import { IconDownload, IconRefresh, IconSearch } from "@/components/ui/icons";
import { Card, DataTable, IconBtn, Kpi, Loading, Pager, Pill, Seg, Tabs } from "@/components/ui/kit";
import { useLocale } from "@/i18n/LocaleProvider";
import { DERIVED_TOKEN_UNITS, formatCny, formatCompact, formatDateTime, formatInt, formatMillis } from "@/utils/format";
import {
  fetchDashboard,
  fetchKeys,
  fetchUsageRecords,
  type ConsumerDashboard,
  type ConsumerKeyView,
  type UsageRecord,
  type UsageRecordPage,
} from "../../api/consumer.api";
import { BillSummary } from "./BillSummary";
import { DisputeList } from "./DisputeList";
import { JobList } from "./JobList";
import { RecordDetail } from "./RecordDetail";
import { SessionList } from "./SessionList";

const PAGE_SIZE = 15;

/**
 * 一格 token 数。没有就是一条短横，不是 0。
 *
 * 缓存那两列绝大多数行都是空的（上游没报缓存、或者这个模型压根不缓存）。
 * 满屏的 0 会把真正有数的那几行盖掉，而「0」和「这次没有这项」在对账时
 * 也不是一回事 —— 前者是上游报了 0，后者是根本没报。
 */
function TokenCell({ value }: { value: number }) {
  if (value <= 0) return <span className="gx-mono gx-muted">-</span>;
  return <span className="gx-mono gx-soft">{formatCompact(value)}</span>;
}
const DAYS = ["today", "7d", "30d", "all"] as const;
type Tab = "records" | "bill" | "sessions" | "jobs" | "disputes";

export function UsageBoard() {
  const { t } = useLocale();
  const [tab, setTab] = useState<Tab>("records");
  const [dashboard, setDashboard] = useState<ConsumerDashboard | null>(null);
  const [keys, setKeys] = useState<ConsumerKeyView[]>([]);
  const [result, setResult] = useState<UsageRecordPage | null>(null);
  const [page, setPage] = useState(1);
  const [day, setDay] = useState<(typeof DAYS)[number]>("today");
  const [keyId, setKeyId] = useState("");
  const [keyword, setKeyword] = useState("");
  const [detail, setDetail] = useState<UsageRecord | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const [summary, keyList, records] = await Promise.all([
        fetchDashboard(),
        fetchKeys(),
        fetchUsageRecords({
          day,
          keyId: keyId || undefined,
          offset: (page - 1) * PAGE_SIZE,
          limit: PAGE_SIZE,
        }),
      ]);
      setDashboard(summary);
      setKeys(keyList);
      setResult(records);
    } catch (error) {
      message.error((error as Error).message || t("common.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [day, keyId, page, t]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * 请求号的搜索只过滤当前这一页。
   *
   * 这个框的真实用途是「手里有一个 X-Galaxy-Request-Id，看看它在不在最近这些里」；
   * 做成全量检索要在 unit 表上加前缀索引，等真有人按不到再说。
   */
  const rows = useMemo(() => {
    const list = result?.records ?? [];
    const query = keyword.trim().toLowerCase();
    return query ? list.filter((row) => row.unitId.toLowerCase().includes(query)) : list;
  }, [keyword, result]);

  const alias = new Map(keys.map((key) => [key.keyId, key.alias || key.keyId]));
  // 同密钥卡片：只看输出 token，那才是计费口径。
  const balance = dashboard?.balance?.["llm.output_tokens"] ?? 0;

  const exportCsv = () => {
    // input 是**未命中缓存的新增输入**，缓存命中与写入各自一列 —— 三个数互不重叠，
    // 加起来才是这次请求读进模型的全部输入。导出的表拿去对账时这点必须写清楚。
    const header = ["time", "key", "model", "input", "output", "cacheRead", "cacheWrite", "durationMs", "cost", "state", "unitId"];
    const lines = rows.map((row) => [
      row.startedAt ?? "",
      alias.get(row.keyId) ?? row.keyId,
      row.model,
      String(row.usage["llm.input_tokens"] ?? 0),
      String(row.usage["llm.output_tokens"] ?? 0),
      String(row.usage["llm.cache_read_tokens"] ?? 0),
      String(row.usage["llm.cache_write_tokens"] ?? 0),
      String(row.durationMs),
      String(row.cost),
      row.state,
      row.unitId,
    ]);
    const csv = [header, ...lines].map((row) => row.map((cell) => `"${cell.replace(/"/g, '""')}"`).join(",")).join("\n");
    const url = URL.createObjectURL(new Blob([`﻿${csv}`], { type: "text/csv;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `galaxy-usage-${new Date().toISOString().slice(0, 10)}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  return (
    <>
      <PageHeader
        title={t("usage.title")}
        meta={t("usage.subtitle")}
        actions={
          <IconBtn label={t("common.refresh")} onClick={() => void load()}>
            <IconRefresh size={17} />
          </IconBtn>
        }
      />
      <div className="gx-body gx-body--fixed">
        <div className="gx-kpi gx-rise" style={{ gridTemplateColumns: "repeat(4, minmax(0, 1fr))" }}>
          <Kpi
            label={t("usage.spent", { days: dashboard?.days ?? 10 })}
            value={formatCny(dashboard?.spentMicros ?? 0)}
            hint={t("usage.spentHint", { tokens: formatCompact(usedTokens(dashboard)) })}
          />
          <Kpi
            label={t("usage.calls")}
            value={formatInt(dashboard?.today.calls ?? 0)}
            hint={t("usage.callsHint", {
              ok: formatInt((dashboard?.today.calls ?? 0) - (dashboard?.today.failed ?? 0)),
              failed: formatInt(dashboard?.today.failed ?? 0),
            })}
          />
          <Kpi
            label={t("usage.firstByte")}
            value={formatMillis(dashboard?.avgFirstByteMs ?? 0)}
            hint={t("usage.firstByteHint")}
          />
          <Kpi label={t("usage.left")} value={formatCompact(balance)} hint={t("usage.leftHint", { keys: dashboard?.keys ?? 0 })} />
        </div>

        <div className="gx-rise gx-rise--1" style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <Tabs
            value={tab}
            onChange={setTab}
            options={[
              { value: "records" as const, label: t("usage.tab.records") },
              { value: "bill" as const, label: t("usage.tab.bill") },
              { value: "sessions" as const, label: t("usage.tab.sessions") },
              { value: "jobs" as const, label: t("usage.tab.jobs") },
              { value: "disputes" as const, label: t("usage.tab.disputes") },
            ]}
          />
        </div>

        {tab === "records" ? (
          <Card className="gx-rise gx-rise--2" style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "14px 16px 10px", flexWrap: "wrap" }}>
              <span style={{ position: "relative", display: "inline-flex", alignItems: "center" }}>
                <IconSearch size={15} style={{ position: "absolute", left: 12, color: "var(--gx-faint)" }} />
                <input
                  className="gx-input gx-input--mono"
                  style={{ height: 32, width: 210, paddingLeft: 34, fontSize: 12.5 }}
                  placeholder={t("usage.search")}
                  value={keyword}
                  onChange={(event) => setKeyword(event.target.value)}
                />
              </span>
              <select
                className="gx-input"
                style={{ height: 32, width: 168, fontSize: 12.5 }}
                value={keyId}
                onChange={(event) => {
                  setKeyId(event.target.value);
                  setPage(1);
                }}
              >
                <option value="">{t("usage.allKeys")}</option>
                {keys.map((key) => (
                  <option key={key.keyId} value={key.keyId}>
                    {key.alias || key.keyId}
                  </option>
                ))}
              </select>
              <Seg
                value={day}
                onChange={(next) => {
                  setDay(next);
                  setPage(1);
                }}
                options={DAYS.map((value) => ({
                  value,
                  label: t(value === "today" ? "common.today" : value === "7d" ? "common.days7" : value === "30d" ? "common.days30" : "common.all"),
                }))}
              />
              <span style={{ flex: 1 }} />
              <button type="button" className="gx-link" onClick={exportCsv}>
                <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                  <IconDownload size={14} />
                  {t("usage.export")}
                </span>
              </button>
            </div>

            {loading ? (
              <Loading />
            ) : (
              <DataTable
                // 列宽预算：固定列 746px + 9 个 12px 间距 + 左右各 16px 内边距 = 886px，
                // 模型列（1fr）拿剩下的。缓存读/写这两列是后加的，为了不把模型名挤没，
                // 密钥列和几个数字列各收了一点。再要加列先重算这笔账。
                columns={[
                  {
                    key: "time",
                    title: t("usage.col.time"),
                    width: "112px",
                    render: (row: UsageRecord) => <span className="gx-mono gx-muted">{formatDateTime(row.startedAt)}</span>,
                  },
                  {
                    key: "key",
                    title: t("usage.col.key"),
                    width: "106px",
                    render: (row: UsageRecord) => <span className="gx-soft">{alias.get(row.keyId) ?? row.keyId}</span>,
                  },
                  {
                    key: "model",
                    title: t("usage.col.model"),
                    width: "1fr",
                    render: (row: UsageRecord) => <span className="gx-mono">{row.model || row.kind}</span>,
                  },
                  {
                    key: "in",
                    title: t("usage.col.in"),
                    width: "66px",
                    align: "right",
                    render: (row: UsageRecord) => <span className="gx-mono gx-soft">{formatCompact(row.usage["llm.input_tokens"] ?? 0)}</span>,
                  },
                  {
                    key: "out",
                    title: t("usage.col.out"),
                    width: "66px",
                    align: "right",
                    render: (row: UsageRecord) => <span className="gx-mono gx-soft">{formatCompact(row.usage["llm.output_tokens"] ?? 0)}</span>,
                  },
                  {
                    key: "cacheRead",
                    title: t("usage.col.cacheRead"),
                    width: "66px",
                    align: "right",
                    render: (row: UsageRecord) => <TokenCell value={row.usage["llm.cache_read_tokens"] ?? 0} />,
                  },
                  {
                    key: "cacheWrite",
                    title: t("usage.col.cacheWrite"),
                    width: "66px",
                    align: "right",
                    render: (row: UsageRecord) => <TokenCell value={row.usage["llm.cache_write_tokens"] ?? 0} />,
                  },
                  {
                    key: "took",
                    title: t("usage.col.cost"),
                    width: "64px",
                    align: "right",
                    render: (row: UsageRecord) => <span className="gx-mono gx-soft">{formatMillis(row.durationMs)}</span>,
                  },
                  {
                    key: "charge",
                    title: t("usage.col.charge"),
                    width: "88px",
                    align: "right",
                    render: (row: UsageRecord) => (
                      <span className="gx-mono" style={{ fontWeight: row.cost > 0 ? 500 : 400, color: row.cost > 0 ? "var(--gx-ink)" : "var(--gx-faint)" }}>
                        {row.cost > 0 ? `−${formatCny(row.cost)}` : "0"}
                      </span>
                    ),
                  },
                  {
                    key: "state",
                    title: t("usage.col.state"),
                    width: "112px",
                    render: (row: UsageRecord) =>
                      row.state === "completed" ? (
                        <Pill tone="ok">{t("usage.state.completed")}</Pill>
                      ) : row.state === "failed" ? (
                        <Pill tone="warn">{t("usage.state.failed")}</Pill>
                      ) : (
                        <Pill>{t("usage.state.running")}</Pill>
                      ),
                  },
                ]}
                rows={rows}
                rowKey={(row) => row.unitId}
                onRowClick={setDetail}
                empty={t("usage.empty")}
                foot={
                  result && result.total > 0 ? (
                    <Pager
                      page={page}
                      pageSize={PAGE_SIZE}
                      total={result.total}
                      onChange={setPage}
                      summary={`${t("usage.summary", {
                        from: (page - 1) * PAGE_SIZE + 1,
                        to: Math.min(page * PAGE_SIZE, result.total),
                        total: result.total,
                      })} · ${t("usage.rowHint")}`}
                    />
                  ) : null
                }
              />
            )}
          </Card>
        ) : null}

        {tab === "bill" ? <BillSummary keys={keys} /> : null}
        {tab === "sessions" ? <SessionList keys={keys} /> : null}
        {tab === "jobs" ? <JobList keys={keys} /> : null}
        {tab === "disputes" ? <DisputeList /> : null}
      </div>

      <RecordDetail record={detail} alias={alias} onClose={() => setDetail(null)} onFiled={() => void load()} />
    </>
  );
}

function usedTokens(dashboard: ConsumerDashboard | null): number {
  if (!dashboard) return 0;
  return Object.entries(dashboard.today.usage ?? {})
    .filter(([unit]) => unit.endsWith("_tokens") && !DERIVED_TOKEN_UNITS.has(unit))
    .reduce((sum, [, value]) => sum + value, 0);
}
