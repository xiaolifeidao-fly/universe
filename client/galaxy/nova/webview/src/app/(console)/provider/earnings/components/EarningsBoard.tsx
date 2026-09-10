"use client";

/**
 * 收益。三个数字 + 一周趋势 + 逐笔账本 + 提现。
 *
 * 可提现和待结算分开显示不是排版偏好：待结算那部分要过争议期才能提，
 * 合成一个「余额」会让人按下提现之后拿到「可提现积分不足」——
 * 而界面上明明写着他有那么多。
 */

import { message } from "antd";
import { useCallback, useEffect, useState } from "react";
import { WeekBars } from "@/components/galaxy/charts";
import { PageHeader } from "@/components/shell/GalaxyShell";
import { IconDownload, IconWallet } from "@/components/ui/icons";
import { Btn, Card, CardHead, DataTable, Figure, Loading, Note, Pager, Pill, Seg } from "@/components/ui/kit";
import { useLocale } from "@/i18n/LocaleProvider";
import { formatCny, formatDay, formatInt, formatSignedInt } from "@/utils/format";
import {
  fetchDashboard,
  fetchLedger,
  fetchPayouts,
  type CreditLedgerEntry,
  type PayoutView,
  type ProviderDashboard,
} from "../../api/provider.api";
import { WithdrawModal } from "./WithdrawModal";

const PAGE_SIZE = 12;
/** 只用于展示折算。真正的兑换比在服务端（galaxy.payout_rate），下单金额也由它算。 */
const CREDIT_RATE = 100;
const HOLD_DAYS = 7;

const LEDGER_TYPES = ["", "settle", "payout", "clawback"] as const;

const WEEK_LABELS: Record<string, string[]> = {
  "zh-CN": ["日", "一", "二", "三", "四", "五", "六"],
  "en-US": ["S", "M", "T", "W", "T", "F", "S"],
};

export function EarningsBoard() {
  const { t, locale } = useLocale();
  const [dashboard, setDashboard] = useState<ProviderDashboard | null>(null);
  const [entries, setEntries] = useState<CreditLedgerEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [payouts, setPayouts] = useState<PayoutView[]>([]);
  const [type, setType] = useState<(typeof LEDGER_TYPES)[number]>("");
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [withdrawing, setWithdrawing] = useState(false);

  const load = useCallback(async () => {
    try {
      const [summary, ledger, payoutList] = await Promise.all([
        fetchDashboard(),
        fetchLedger({ type: type || undefined, offset: (page - 1) * PAGE_SIZE, limit: PAGE_SIZE }),
        fetchPayouts(5),
      ]);
      setDashboard(summary);
      setEntries(ledger.entries ?? []);
      setTotal(ledger.total);
      setPayouts(payoutList);
    } catch (error) {
      message.error((error as Error).message || t("common.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [page, t, type]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * 导出的是**当前筛选条件下这一页**之外的全部？不是 —— 就是当前这一页。
   * 账本可能上万条，一次拉全等于让浏览器替服务端做分页；要全量导出应该是
   * 服务端出文件，那件事等真有人要再做。
   */
  const exportCsv = () => {
    const header = ["date", "type", "credits", "unit", "unitId", "cid"];
    const lines = entries.map((entry) => [
      entry.createdAt,
      entry.type,
      String(entry.amount),
      entry.unit,
      entry.unitId,
      entry.cid,
    ]);
    const csv = [header, ...lines].map((row) => row.map((cell) => `"${(cell ?? "").replace(/"/g, '""')}"`).join(",")).join("\n");
    const url = URL.createObjectURL(new Blob([`﻿${csv}`], { type: "text/csv;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `galaxy-credits-${new Date().toISOString().slice(0, 10)}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  if (loading || !dashboard) {
    return (
      <>
        <PageHeader title={t("earnings.title")} meta={t("earnings.subtitle")} />
        <div className="gx-body">
          <Loading />
        </div>
      </>
    );
  }

  const credits = dashboard.credits;

  return (
    <>
      <PageHeader
        title={t("earnings.title")}
        meta={t("earnings.subtitle")}
        actions={
          <Btn tone="accent" icon={<IconWallet size={16} />} disabled={credits.available <= 0} onClick={() => setWithdrawing(true)}>
            {t("earnings.withdraw")}
          </Btn>
        }
      />
      <div className="gx-body">
        <div style={{ display: "grid", gridTemplateColumns: "1.15fr 1fr", gap: 14 }}>
          <Card className="gx-rise" style={{ padding: "22px 24px", display: "flex", flexDirection: "column", gap: 16 }}>
            <div className="gx-label">{t("earnings.available")}</div>
            <Figure
              value={formatInt(credits.available)}
              unit={t("today.credits")}
              aside={
                <span
                  className="gx-mono"
                  style={{ fontSize: 12.5, color: "var(--gx-accent-ink)", background: "var(--gx-accent-soft)", padding: "4px 8px", borderRadius: 6 }}
                >
                  ≈ {formatCny((credits.available / CREDIT_RATE) * 1_000_000)}
                </span>
              }
            />
            <div style={{ display: "flex", gap: 28, fontSize: 12.5, color: "var(--gx-faint)" }}>
              <span>
                {t("earnings.pending")}{" "}
                <b className="gx-mono" style={{ color: "var(--gx-ink)", fontWeight: 500 }}>{formatInt(credits.pending)}</b>{" "}
                {t("earnings.pendingHint", { days: HOLD_DAYS })}
              </span>
              <span>
                {t("earnings.withdrawn")}{" "}
                <b className="gx-mono" style={{ color: "var(--gx-ink)", fontWeight: 500 }}>{formatInt(credits.withdrawn)}</b>
              </span>
            </div>
            <Note>
              <b style={{ fontWeight: 600 }}>{t("earnings.rules")}</b> · {t("earnings.rulesBody", { rate: CREDIT_RATE, days: HOLD_DAYS })}
            </Note>
          </Card>

          <Card className="gx-rise gx-rise--1" style={{ padding: "22px 24px", display: "flex", flexDirection: "column", gap: 14 }}>
            <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between" }}>
              <span style={{ fontSize: 14, fontWeight: 600 }}>{t("earnings.week")}</span>
              <span className="gx-card__hint">{t("earnings.weekSummary", { value: formatInt(credits.week) })}</span>
            </div>
            <WeekBars
              points={dashboard.trend ?? []}
              labels={(dashboard.trend ?? []).map((point) => WEEK_LABELS[locale][new Date(point.date).getDay()] ?? "")}
            />
          </Card>
        </div>

        {payouts.length > 0 ? (
          <Card className="gx-rise gx-rise--1">
            <CardHead title={t("withdraw.title")} />
            <div style={{ padding: "0 18px 14px", display: "flex", flexDirection: "column" }}>
              {payouts.map((payout) => (
                <div
                  key={payout.payoutId}
                  style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 0", borderTop: "1px solid var(--gx-line)", fontSize: 13 }}
                >
                  <span className="gx-mono" style={{ color: "var(--gx-faint)", width: 56 }}>{formatDay(payout.createdTime)}</span>
                  <span style={{ flex: 1 }}>
                    {t(`withdraw.method.${payout.method}`)} · <span className="gx-mono">{payout.account}</span>
                  </span>
                  <span className="gx-mono">{formatCny(payout.amount)}</span>
                  <Pill tone={payout.status === "paid" ? "ok" : payout.status === "rejected" ? "err" : "warn"}>
                    {t(`withdraw.status.${payout.status}`)}
                  </Pill>
                </div>
              ))}
            </div>
          </Card>
        ) : null}

        <Card className="gx-rise gx-rise--2" style={{ display: "flex", flexDirection: "column", minHeight: 320 }}>
          <CardHead
            title={t("earnings.ledger")}
            action={
              <span style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <Seg
                  value={type}
                  onChange={(next) => {
                    setType(next);
                    setPage(1);
                  }}
                  options={LEDGER_TYPES.map((value) => ({
                    value,
                    label: t(value ? `earnings.type.${value}` : "earnings.type.all"),
                  }))}
                />
                <Btn tone="ghost" small icon={<IconDownload size={14} />} onClick={exportCsv}>
                  {t("earnings.export")}
                </Btn>
              </span>
            }
          />
          <DataTable
            columns={[
              {
                key: "date",
                title: t("earnings.col.date"),
                width: "70px",
                render: (row: CreditLedgerEntry) => <span className="gx-mono gx-muted">{formatDay(row.createdAt)}</span>,
              },
              {
                key: "type",
                title: t("earnings.col.type"),
                width: "88px",
                render: (row: CreditLedgerEntry) => t(`earnings.type.${row.type}`),
              },
              {
                key: "detail",
                title: t("earnings.col.detail"),
                width: "1fr",
                render: (row: CreditLedgerEntry) => (
                  <span className="gx-mono gx-soft" style={{ fontSize: 12 }}>
                    {row.unitId || row.cid || "—"}
                  </span>
                ),
              },
              {
                key: "amount",
                title: t("earnings.col.credit"),
                width: "110px",
                align: "right",
                render: (row: CreditLedgerEntry) => (
                  <span className="gx-mono" style={{ color: row.amount >= 0 ? "var(--gx-accent-ink)" : "var(--gx-soft)", fontWeight: 500 }}>
                    {formatSignedInt(row.amount)}
                  </span>
                ),
              },
            ]}
            rows={entries}
            rowKey={(row) => `${row.unitId}:${row.type}:${row.createdAt}`}
            empty={t("earnings.ledgerEmpty")}
            foot={
              total > 0 ? (
                <Pager
                  page={page}
                  pageSize={PAGE_SIZE}
                  total={total}
                  onChange={setPage}
                  summary={t("earnings.summary", {
                    from: (page - 1) * PAGE_SIZE + 1,
                    to: Math.min(page * PAGE_SIZE, total),
                    total,
                  })}
                />
              ) : null
            }
          />
        </Card>
      </div>

      <WithdrawModal
        open={withdrawing}
        available={credits.available}
        pending={credits.pending}
        rate={CREDIT_RATE}
        onClose={() => setWithdrawing(false)}
        onDone={() => {
          setWithdrawing(false);
          void load();
        }}
      />
    </>
  );
}
