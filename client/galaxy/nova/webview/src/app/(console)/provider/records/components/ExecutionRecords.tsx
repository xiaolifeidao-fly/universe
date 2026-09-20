"use client";

/**
 * 「谁在你的机器上跑了什么」。
 *
 * 这里刻意看不到使用者是谁、也看不到请求内容 —— 那是协议对消费者的承诺（C-12）。
 * 主人需要知道的是：哪台机器跑的、跑了什么模型、烧了多少额度、成没成功、给了多少积分。
 *
 * 筛选与分页都在服务端做。前端筛的话，「今日调用 316」和翻页翻出来的行数
 * 会对不上：limit 先生效、过滤后生效，一页能被筛得几乎为空。
 */

import { message } from "antd";
import { useCallback, useEffect, useMemo, useState } from "react";
import { PageHeader } from "@/components/shell/GalaxyShell";
import { IconRefresh, IconSearch } from "@/components/ui/icons";
import { Card, DataTable, IconBtn, Kpi, Loading, Note, Pager, Pill, Seg } from "@/components/ui/kit";
import { useLocale } from "@/i18n/LocaleProvider";
import { formatCompact, formatDateTime, formatDelta, formatInt, formatMillis, formatSignedPoints } from "@/utils/format";
import {
  fetchDashboard,
  fetchNodes,
  fetchRecordPage,
  visibleContributions,
  type ExecutionRecord,
  type ProviderDashboard,
  type ProviderRecordPage,
} from "../../api/provider.api";

const PAGE_SIZE = 15;

/**
 * 一格 token 数。没有就是一条短横，不是 0。
 *
 * 推理这列大多数行都是空的（不是推理模型、或者上游没报这一项）。满屏的 0 会把
 * 真正有数的那几行盖过去，而且「上游报了 0」和「上游根本没报这一项」在对账时
 * 不是一回事。
 */
function TokenCell({ value }: { value: number }) {
  if (value <= 0) return <span className="gx-mono gx-muted">-</span>;
  return <span className="gx-mono gx-soft">{formatCompact(value)}</span>;
}
const DAYS = ["today", "yesterday", "7d", "all"] as const;

export function ExecutionRecords() {
  const { t } = useLocale();
  const [page, setPage] = useState(1);
  const [day, setDay] = useState<(typeof DAYS)[number]>("today");
  const [model, setModel] = useState("");
  const [cid, setCid] = useState("");
  const [keyword, setKeyword] = useState("");
  const [result, setResult] = useState<ProviderRecordPage | null>(null);
  const [dashboard, setDashboard] = useState<ProviderDashboard | null>(null);
  const [contributions, setContributions] = useState<string[]>([]);
  /** 今日输出 token 的上限，用来把「1.21M」换算成「占上限 60%」。 */
  const [outputLimit, setOutputLimit] = useState(0);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const [records, summary, nodes] = await Promise.all([
        fetchRecordPage({
          day,
          model: model || undefined,
          cid: cid || undefined,
          offset: (page - 1) * PAGE_SIZE,
          limit: PAGE_SIZE,
        }),
        fetchDashboard(),
        fetchNodes(),
      ]);
      setResult(records);
      setDashboard(summary);
      const rows = nodes.flatMap((node) => visibleContributions(node.contributions));
      setContributions(Array.from(new Set(rows.map((item) => item.cid))));
      // 多条贡献各有各的上限，头上那个数字是它们的和 —— 和「输出 tokens」那个
      // 合计口径一致，否则 1.21M 会被拿去除以其中一条的上限。
      setOutputLimit(
        rows.reduce(
          (sum, item) => sum + (item.quota.find((quota) => quota.unit === "llm.output_tokens")?.limit ?? 0),
          0,
        ),
      );
    } catch (error) {
      message.error((error as Error).message || t("common.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [cid, day, model, page, t]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * unitId 的搜索只过滤当前这一页。
   *
   * 做成服务端搜索要在 zt_galaxy_unit 上加一个前缀索引，而这个框的真实用途是
   * 「刚从别的地方抄来一个 unitId，看看它在不在最近这些里」——够用了。
   * 提示语说的是「搜 unitId」，没有承诺全量检索。
   */
  const rows = useMemo(() => {
    const list = result?.records ?? [];
    const query = keyword.trim().toLowerCase();
    return query ? list.filter((row) => row.unitId.toLowerCase().includes(query)) : list;
  }, [keyword, result]);

  const stats = result?.stats;
  const outputToday = dashboard?.today.usage["llm.output_tokens"] ?? 0;

  return (
    <>
      <PageHeader
        title={t("records.title")}
        meta={t("records.subtitle")}
        actions={
          <IconBtn label={t("common.refresh")} onClick={() => void load()}>
            <IconRefresh size={17} />
          </IconBtn>
        }
      />
      <div className="gx-body gx-body--fixed">
        <div className="gx-kpi gx-rise" style={{ gridTemplateColumns: "repeat(4, minmax(0, 1fr))" }}>
          <Kpi
            label={t("records.calls")}
            value={formatInt(dashboard?.today.calls ?? 0)}
            hint={
              dashboard && dashboard.yesterday.calls > 0
                ? t("records.callsDelta", { value: formatDelta(dashboard.today.calls, dashboard.yesterday.calls) })
                : undefined
            }
          />
          <Kpi
            label={t("records.output")}
            value={formatCompact(outputToday)}
            hint={outputLimit > 0 ? t("records.outputHint", { value: `${Math.round((outputToday / outputLimit) * 100)}%` }) : undefined}
          />
          <Kpi
            label={t("records.latency")}
            value={formatMillis(dashboard?.today.avgDurationMs ?? 0)}
            hint={t("records.latencyHint")}
          />
          <Kpi label={t("records.failed")} value={formatInt(dashboard?.today.failed ?? 0)} hint={t("records.failedHint")} />
        </div>

        <Card className="gx-rise gx-rise--1" style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "14px 16px 10px", flexWrap: "wrap" }}>
            <span style={{ position: "relative", display: "inline-flex", alignItems: "center" }}>
              <IconSearch size={15} style={{ position: "absolute", left: 12, color: "var(--gx-faint)" }} />
              <input
                className="gx-input gx-input--mono"
                style={{ height: 32, width: 200, paddingLeft: 34, fontSize: 12.5 }}
                placeholder={t("records.search")}
                value={keyword}
                onChange={(event) => setKeyword(event.target.value)}
              />
            </span>
            <Seg
              value={day}
              onChange={(next) => {
                setDay(next);
                setPage(1);
              }}
              options={DAYS.map((value) => ({
                value,
                label: t(
                  value === "today" ? "common.today" : value === "yesterday" ? "common.yesterday" : value === "7d" ? "common.days7" : "common.all",
                ),
              }))}
            />
            <select
              className="gx-input"
              style={{ height: 32, width: 178, fontSize: 12.5 }}
              value={model}
              onChange={(event) => {
                setModel(event.target.value);
                setPage(1);
              }}
            >
              <option value="">{t("records.allModels")}</option>
              {(result?.models ?? []).map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </select>
            {contributions.length > 1 ? (
              <select
                className="gx-input"
                style={{ height: 32, width: 170, fontSize: 12.5 }}
                value={cid}
                onChange={(event) => {
                  setCid(event.target.value);
                  setPage(1);
                }}
              >
                <option value="">{t("records.allContributions")}</option>
                {contributions.map((item) => (
                  <option key={item} value={item}>
                    {item}
                  </option>
                ))}
              </select>
            ) : null}
            <span style={{ flex: 1 }} />
            <span className="gx-card__hint">{t("records.anonymous")}</span>
          </div>

          {loading ? (
            <Loading />
          ) : (
            <DataTable
              // 列宽预算：固定列加起来 844px，再加 10 个 12px 的间距和左右各 16px 的内边距，
              // 一共 996px —— 模型列（1fr）拿的是容器减掉这些之后剩下的。再要加列先把
              // 这笔账重算一遍。
              //
              // 缓存写那一列不展示：上游报这一项的只有 Anthropic，而且 2026-09-18 之后
              // 它被拆成了 5m / 1h 两个计价桶，合计那一个不再单独记。给主人看一列
              // 常年空着的数字不如不给。要恢复的话数据在 row.usage 的
              // llm.cache_write_5m_tokens / llm.cache_write_1h_tokens 里。
              columns={[
                {
                  key: "time",
                  title: t("records.col.time"),
                  width: "112px",
                  render: (row: ExecutionRecord) => <span className="gx-mono gx-muted">{formatDateTime(row.startedAt)}</span>,
                },
                {
                  key: "unit",
                  title: t("records.col.unit"),
                  // 显示的是 shorten() 之后的定长串（u_06GB4V5…T8），宽度按它定就够。
                  width: "112px",
                  render: (row: ExecutionRecord) => <span className="gx-mono gx-soft">{shorten(row.unitId)}</span>,
                },
                {
                  key: "node",
                  title: t("records.col.node"),
                  width: "124px",
                  // 机器名常是 xxx-MacBook-Pro.local 这种长串，格子里放不下会被截断，悬停看全名和节点 id。
                  render: (row: ExecutionRecord) => (
                    <span title={row.nodeName ? `${row.nodeName} · ${row.nodeId}` : row.nodeId}>{row.nodeName || row.nodeId || "-"}</span>
                  ),
                },
                {
                  key: "model",
                  title: t("records.col.model"),
                  width: "1fr",
                  render: (row: ExecutionRecord) => <span className="gx-mono">{row.model || row.kind}</span>,
                },
                {
                  key: "in",
                  title: t("records.col.in"),
                  width: "68px",
                  align: "right",
                  render: (row: ExecutionRecord) => <span className="gx-mono gx-soft">{formatCompact(row.usage["llm.input_tokens"] ?? 0)}</span>,
                },
                {
                  key: "out",
                  title: t("records.col.out"),
                  width: "68px",
                  align: "right",
                  render: (row: ExecutionRecord) => <span className="gx-mono gx-soft">{formatCompact(row.usage["llm.output_tokens"] ?? 0)}</span>,
                },
                {
                  // 推理紧挨着输出：它是输出里的一部分，不是又一个桶。
                  // 推理模型上这一列动辄是输出的九成，不摆出来的话「输出 32」和
                  // 「输出 29000」在这张表里看起来是同一件事。
                  key: "reasoning",
                  title: t("records.col.reasoning"),
                  width: "68px",
                  align: "right",
                  render: (row: ExecutionRecord) => <TokenCell value={row.usage["llm.reasoning_tokens"] ?? 0} />,
                },
                {
                  // 缓存读挨着新增输入的道理和推理挨着输出一样：「新增」这个词
                  // 只有和缓存命中的那部分摆在一起才说得通。放在推理之后是为了
                  // 不把输出与它的子集拆开，列序跟使用端那张表保持一致。
                  key: "cacheRead",
                  title: t("records.col.cacheRead"),
                  width: "68px",
                  align: "right",
                  render: (row: ExecutionRecord) => <TokenCell value={row.usage["llm.cache_read_tokens"] ?? 0} />,
                },
                {
                  key: "took",
                  title: t("records.col.cost"),
                  width: "64px",
                  align: "right",
                  render: (row: ExecutionRecord) => <span className="gx-mono gx-soft">{durationOf(row)}</span>,
                },
                {
                  key: "state",
                  title: t("records.col.state"),
                  width: "88px",
                  render: (row: ExecutionRecord) =>
                    row.state === "completed" ? (
                      <Pill tone="ok">{t("records.state.completed")}</Pill>
                    ) : row.state === "failed" ? (
                      <Pill tone="warn">{row.errorCode || t("records.state.failed")}</Pill>
                    ) : (
                      <Pill>{t("records.state.running")}</Pill>
                    ),
                },
                {
                  key: "credit",
                  title: t("today.col.credit"),
                  width: "72px",
                  align: "right",
                  render: (row: ExecutionRecord) => (
                    <span className="gx-mono" style={{ color: row.credits > 0 ? "var(--gx-accent-ink)" : "var(--gx-faint)", fontWeight: row.credits > 0 ? 500 : 400 }}>
                      {/* 账本里的积分是微积分，一次调用往往不足 1 积分，按积分写才看得出来。 */}
                      {row.credits > 0 ? formatSignedPoints(row.credits) : "0"}
                    </span>
                  ),
                },
              ]}
              rows={rows}
              rowKey={(row) => row.unitId}
              empty={t("records.empty")}
              foot={
                result && result.total > 0 ? (
                  <Pager
                    page={page}
                    pageSize={PAGE_SIZE}
                    total={result.total}
                    onChange={setPage}
                    summary={t("records.summary", {
                      from: (page - 1) * PAGE_SIZE + 1,
                      to: Math.min(page * PAGE_SIZE, result.total),
                      total: result.total,
                    })}
                  />
                ) : null
              }
            />
          )}
        </Card>

        {stats && stats.calls > 0 ? (
          <Note>
            {t("records.calls")} {formatInt(stats.calls)} · {t("today.col.credit")} {formatSignedPoints(stats.credits)} ·{" "}
            {t("records.failed")} {formatInt(stats.failed)}
          </Note>
        ) : null}
      </div>
    </>
  );
}

function shorten(unitId: string): string {
  return unitId.length > 14 ? `${unitId.slice(0, 9)}…${unitId.slice(-2)}` : unitId;
}

function durationOf(record: ExecutionRecord): string {
  if (!record.startedAt || !record.finishedAt) return "-";
  return formatMillis(new Date(record.finishedAt).getTime() - new Date(record.startedAt).getTime());
}
