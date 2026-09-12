"use client";

/**
 * 收益。三个数字 + 一周趋势 + 逐笔账本 + 提现。
 *
 * 可提现和待结算分开显示不是排版偏好：待结算那部分要过争议期才能提，
 * 合成一个「余额」会让人按下提现之后拿到「可提现积分不足」——
 * 而界面上明明写着他有那么多。
 */

import { message } from "antd";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { WeekBars } from "@/components/galaxy/charts";
import { PageHeader } from "@/components/shell/GalaxyShell";
import { IconDownload, IconWallet } from "@/components/ui/icons";
import { Btn, Card, CardHead, DataTable, Figure, Loading, Note, Pager, Pill, Seg } from "@/components/ui/kit";
import { useLocale } from "@/i18n/LocaleProvider";
import { formatCny, formatDay, formatPoints, formatSignedPoints } from "@/utils/format";
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
const HOLD_DAYS = 7;

/**
 * 筛选只给常用的几种。邀请奖励单列一个：它和自己机器赚的「收益」来路不同，主人会想单独对。
 * ref_clawback（邀请奖励被追回）不单列，出现得少，在「全部」里按类型名认得出来。
 */
const LEDGER_TYPES = ["", "settle", "referral", "payout", "clawback"] as const;

const WEEK_LABELS: Record<string, string[]> = {
  "zh-CN": ["日", "一", "二", "三", "四", "五", "六"],
  "en-US": ["S", "M", "T", "W", "T", "F", "S"],
};

export function EarningsBoard() {
  const { t, locale } = useLocale();
  const router = useRouter();
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
      // 账上是微积分，导出的是积分（1 积分 = ¥1）—— 表格里的数要和界面上看到的对得上。
      // 不走 formatPoints：它带千分位、还会砍到两位小数，表格会把「1,284.5」当文本读。
      String(entry.amount / 1_000_000),
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

  // credits 里每个数都是**微积分**：1,000,000 = 1 积分 = ¥1，和使用端同一个口径。
  // 一律经 formatPoints / formatCny 落地，原样打出来会多六个零。
  const credits = dashboard.credits;
  // credits 是嵌套对象、不经过转换，老服务端不带 referral 时是 undefined。
  const referral = credits.referral ?? 0;

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
              value={formatPoints(credits.available)}
              unit={t("today.credits")}
              aside={
                <span
                  className="gx-mono"
                  style={{ fontSize: 12.5, color: "var(--gx-accent-ink)", background: "var(--gx-accent-soft)", padding: "4px 8px", borderRadius: 6 }}
                >
                  ≈ {formatCny(credits.available)}
                </span>
              }
            />
            <div style={{ display: "flex", flexDirection: "column", gap: 8, fontSize: 12.5, color: "var(--gx-faint)" }}>
              <div style={{ display: "flex", gap: 28 }}>
                <span>
                  {t("earnings.pending")}{" "}
                  <b className="gx-mono" style={{ color: "var(--gx-ink)", fontWeight: 500 }}>{formatPoints(credits.pending)}</b>{" "}
                  {t("earnings.pendingHint", { days: HOLD_DAYS })}
                </span>
                <span>
                  {t("earnings.withdrawn")}{" "}
                  <b className="gx-mono" style={{ color: "var(--gx-ink)", fontWeight: 500 }}>{formatPoints(credits.withdrawn)}</b>
                </span>
              </div>
              {/*
                邀请奖励单起一行，不和待结算、已提现排在一起：那两个是积分眼下在哪，这个是其中有多少
                来自邀请（它本身也记在上面几个数里）—— 并排放会让人以为三个数要加起来。没有就不占这一行。
              */}
              {referral > 0 ? (
                <span>
                  {t("earnings.referral")}{" "}
                  <b className="gx-mono" style={{ color: "var(--gx-ink)", fontWeight: 500 }}>{formatPoints(referral)}</b>
                  {" · "}
                  <button type="button" className="gx-link" onClick={() => router.push("/provider/invite")}>
                    {t("earnings.referralLink")}
                  </button>
                </span>
              ) : null}
            </div>
            <Note>
              <b style={{ fontWeight: 600 }}>{t("earnings.rules")}</b> · {t("earnings.rulesBody", { days: HOLD_DAYS })}
            </Note>
          </Card>

          <Card className="gx-rise gx-rise--1" style={{ padding: "22px 24px", display: "flex", flexDirection: "column", gap: 14 }}>
            <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between" }}>
              <span style={{ fontSize: 14, fontWeight: 600 }}>{t("earnings.week")}</span>
              <span className="gx-card__hint">{t("earnings.weekSummary", { value: formatPoints(credits.week) })}</span>
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
                // 「邀请奖励追回」「Referral clawback」要放得下，88 会被截成省略号。
                width: "120px",
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
                    {formatSignedPoints(row.amount)}
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
        onClose={() => setWithdrawing(false)}
        onDone={() => {
          setWithdrawing(false);
          void load();
        }}
      />
    </>
  );
}
