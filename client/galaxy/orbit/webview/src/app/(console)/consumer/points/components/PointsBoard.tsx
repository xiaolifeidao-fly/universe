"use client";

/**
 * 余额（积分）与分享。
 *
 * 积分只有两个来路：平台运营充值（线下付款之后），和分享返现。去处只有一个：
 * 调模型 —— 每次请求按单价扣一笔，扣的就是这里的余额。所以这一页回答三件事：
 * 还剩多少、从哪来到哪去了（明细）、怎么多拿一点（分享）。
 *
 * 分享链接就是本控制台的注册页带上邀请码。通过它注册的人，之后**每充一笔值**，
 * 按比例把返现记给邀请人；比例由平台定，页上写的就是此刻生效的那个。
 */

import { message } from "antd";
import { useCallback, useEffect, useState } from "react";
import { PageHeader } from "@/components/shell/GalaxyShell";
import { IconRefresh } from "@/components/ui/icons";
import { Card, CardHead, CopyBtn, DataTable, IconBtn, Kpi, Loading, Note, Pager, Pill, Seg, Tabs } from "@/components/ui/kit";
import { useLocale } from "@/i18n/LocaleProvider";
import { formatBps, formatCny, formatDateTime, formatPoints } from "@/utils/format";
import {
  fetchInvitees,
  fetchPoints,
  fetchPointsLedger,
  fetchReferral,
  type InviteePage,
  type PointsLedgerEntry,
  type PointsLedgerPage,
  type PointsSummary,
  type PointsType,
  type ReferralOverview,
} from "../../api/consumer.api";

const PAGE_SIZE = 20;

export function PointsBoard() {
  const { t } = useLocale();
  const [tab, setTab] = useState<"ledger" | "invitees">("ledger");
  const [summary, setSummary] = useState<PointsSummary | null>(null);
  const [referral, setReferral] = useState<ReferralOverview | null>(null);
  const [ledger, setLedger] = useState<PointsLedgerPage | null>(null);
  const [ledgerType, setLedgerType] = useState<PointsType | "">("");
  const [ledgerPage, setLedgerPage] = useState(1);
  const [invitees, setInvitees] = useState<InviteePage | null>(null);
  const [inviteePage, setInviteePage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState("");
  // 链接要用这个控制台对外的地址，服务端渲染时拿不到，挂载后再定。
  const [origin, setOrigin] = useState("");

  const loadHead = useCallback(async () => {
    const [summaryResult, referralResult] = await Promise.all([fetchPoints(), fetchReferral()]);
    setSummary(summaryResult);
    setReferral(referralResult);
  }, []);

  const loadLedger = useCallback(async () => {
    setLedger(await fetchPointsLedger({ type: ledgerType, offset: (ledgerPage - 1) * PAGE_SIZE, limit: PAGE_SIZE }));
  }, [ledgerPage, ledgerType]);

  const loadInvitees = useCallback(async () => {
    setInvitees(await fetchInvitees((inviteePage - 1) * PAGE_SIZE, PAGE_SIZE));
  }, [inviteePage]);

  const load = useCallback(async () => {
    try {
      await Promise.all([loadHead(), loadLedger(), loadInvitees()]);
    } catch (error) {
      message.error((error as Error).message || t("common.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [loadHead, loadLedger, loadInvitees, t]);

  useEffect(() => {
    setOrigin(window.location.origin);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const inviteLink = referral?.inviteCode && origin ? `${origin}/register?invite=${encodeURIComponent(referral.inviteCode)}` : "";

  const header = (
    <PageHeader
      title={t("points.title")}
      meta={t("points.subtitle")}
      actions={
        <>
          <Tabs
            value={tab}
            onChange={setTab}
            options={[
              { value: "ledger" as const, label: t("points.tab.ledger") },
              { value: "invitees" as const, label: t("points.tab.invitees", { count: referral?.invitees ?? 0 }) },
            ]}
          />
          <IconBtn label={t("common.refresh")} onClick={() => void load()}>
            <IconRefresh size={17} />
          </IconBtn>
        </>
      }
    />
  );

  if (loading) {
    return (
      <>
        {header}
        <div className="gx-body">
          <Loading />
        </div>
      </>
    );
  }

  return (
    <>
      {header}
      <div className="gx-body">
        <div className="gx-kpi gx-rise" style={{ gridTemplateColumns: "repeat(4, minmax(0, 1fr))" }}>
          <Kpi label={t("points.kpi.balance")} value={formatPoints(summary?.balance ?? 0)} hint={t("points.kpi.balanceHint")} />
          <Kpi label={t("points.kpi.recharged")} value={formatPoints(summary?.recharged ?? 0)} />
          <Kpi label={t("points.kpi.used")} value={formatPoints(summary?.used ?? 0)} hint={t("points.kpi.usedHint")} />
          <Kpi label={t("points.kpi.referral")} value={formatPoints(summary?.referral ?? 0)} />
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)", gap: 14 }}>
          <Card className="gx-rise gx-rise--1">
            <CardHead title={t("points.share.title")} hint={t("points.share.hint")} />
            <div style={{ padding: "0 18px 18px", display: "flex", flexDirection: "column", gap: 14 }}>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <span className="gx-label">{t("points.share.link")}</span>
                <div className="gx-secret">
                  <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{inviteLink || "-"}</span>
                  <CopyBtn value={inviteLink} label={t("common.copy")} copied={copied === "link"} onCopied={() => setCopied("link")} />
                </div>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <span className="gx-label">{t("points.share.code")}</span>
                <span className="gx-mono" style={{ fontSize: 16, letterSpacing: "0.12em", flex: 1 }}>
                  {referral?.inviteCode ?? "-"}
                </span>
                <CopyBtn value={referral?.inviteCode ?? ""} label={t("common.copy")} copied={copied === "code"} onCopied={() => setCopied("code")} />
              </div>
              <span className="gx-card__hint">
                {t("points.share.stats", { count: referral?.invitees ?? 0, earned: formatPoints(referral?.earned ?? 0) })}
              </span>
            </div>
          </Card>

          <Card className="gx-rise gx-rise--2">
            <CardHead title={t("points.rates.title")} hint={t("points.rates.hint")} />
            <div style={{ padding: "0 18px 18px", display: "flex", flexDirection: "column", gap: 10 }}>
              {/* 只有一个比例：返现按好友**充值**的金额算，而充值不挑模型。 */}
              {(referral?.defaultBps ?? 0) === 0 ? (
                <span className="gx-card__hint">{t("points.rates.none")}</span>
              ) : (
                <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                  <span className="gx-serif" style={{ fontSize: 30, lineHeight: 1, color: "var(--gx-accent)" }}>
                    {formatBps(referral?.defaultBps ?? 0)}
                  </span>
                  <span className="gx-card__hint">{t("points.rates.ofRecharge")}</span>
                </div>
              )}
              <Note>{t("points.rates.rule")}</Note>
            </div>
          </Card>
        </div>

        {tab === "ledger" ? (
          <Card className="gx-rise gx-rise--3">
            <CardHead
              title={t("points.ledger.title")}
              action={
                <Seg
                  value={ledgerType}
                  onChange={(value) => {
                    setLedgerType(value);
                    setLedgerPage(1);
                  }}
                  options={[
                    { value: "" as const, label: t("common.all") },
                    { value: "recharge" as const, label: t("points.type.recharge") },
                    { value: "usage" as const, label: t("points.type.usage") },
                    { value: "referral" as const, label: t("points.type.referral") },
                  ]}
                />
              }
            />
            <DataTable
              columns={[
                {
                  key: "time",
                  title: t("points.col.time"),
                  width: "112px",
                  render: (row: PointsLedgerEntry) => <span className="gx-mono gx-muted">{formatDateTime(row.createdAt)}</span>,
                },
                {
                  key: "type",
                  title: t("points.col.type"),
                  width: "90px",
                  render: (row: PointsLedgerEntry) => (
                    <Pill tone={row.type === "recharge" || row.type === "refund" ? "ok" : row.type === "referral" ? "accent" : "default"}>
                      {t(`points.type.${row.type}`)}
                    </Pill>
                  ),
                },
                {
                  key: "detail",
                  title: t("points.col.detail"),
                  width: "1fr",
                  render: (row: PointsLedgerEntry) => <span className="gx-soft">{ledgerDetail(row, t)}</span>,
                },
                {
                  key: "amount",
                  title: t("points.col.amount"),
                  width: "110px",
                  align: "right",
                  render: (row: PointsLedgerEntry) => (
                    <span className="gx-mono" style={{ color: row.amount > 0 ? "var(--gx-ok)" : undefined }}>
                      {row.amount > 0 ? `+${formatPoints(row.amount)}` : `−${formatPoints(Math.abs(row.amount))}`}
                    </span>
                  ),
                },
                {
                  key: "after",
                  title: t("points.col.after"),
                  width: "110px",
                  align: "right",
                  render: (row: PointsLedgerEntry) => <span className="gx-mono gx-soft">{formatPoints(row.balanceAfter)}</span>,
                },
              ]}
              rows={ledger?.entries ?? []}
              rowKey={(row) => row.txnId}
              empty={t("points.ledger.empty")}
              foot={
                (ledger?.total ?? 0) > PAGE_SIZE ? (
                  <Pager
                    page={ledgerPage}
                    pageSize={PAGE_SIZE}
                    total={ledger?.total ?? 0}
                    onChange={setLedgerPage}
                    summary={t("points.pageSummary", { total: ledger?.total ?? 0 })}
                  />
                ) : null
              }
            />
          </Card>
        ) : (
          <Card className="gx-rise gx-rise--3">
            <CardHead title={t("points.invitees.title")} hint={t("points.invitees.hint")} />
            <DataTable
              columns={[
                { key: "name", title: t("points.invitees.col.name"), width: "1fr", render: (row) => <span className="gx-mono">{row.name}</span> },
                {
                  key: "joined",
                  title: t("points.invitees.col.joined"),
                  width: "140px",
                  render: (row) => <span className="gx-mono gx-muted">{formatDateTime(row.joinedAt)}</span>,
                },
                {
                  key: "earned",
                  title: t("points.invitees.col.earned"),
                  width: "140px",
                  align: "right",
                  render: (row) => <span className="gx-mono">{formatPoints(row.earned)}</span>,
                },
              ]}
              rows={invitees?.invitees ?? []}
              rowKey={(row) => `${row.name}-${row.joinedAt}`}
              empty={t("points.invitees.empty")}
              foot={
                (invitees?.total ?? 0) > PAGE_SIZE ? (
                  <Pager
                    page={inviteePage}
                    pageSize={PAGE_SIZE}
                    total={invitees?.total ?? 0}
                    onChange={setInviteePage}
                    summary={t("points.pageSummary", { total: invitees?.total ?? 0 })}
                  />
                ) : null
              }
            />
          </Card>
        )}
      </div>
    </>
  );
}

/** 一行流水的来龙去脉。充值写实付多少钱，购买写订单号，返现写谁买了什么、按多少返。 */
function ledgerDetail(row: PointsLedgerEntry, t: (key: string, vars?: Record<string, string | number>) => string): string {
  if (row.type === "recharge") {
    return row.baseAmount > 0 ? t("points.detail.recharge", { paid: formatCny(row.baseAmount) }) : t("points.detail.gift");
  }
  // 消费与退款都指向同一次请求：把 unitId 摆出来，账单和申诉才接得上。
  if (row.type === "usage") {
    return t("points.detail.usage", { model: row.modelId || row.kind || "-", unit: row.unitId });
  }
  if (row.type === "refund") {
    return t("points.detail.refund", { unit: row.unitId });
  }
  if (row.type === "purchase") {
    return t("points.detail.purchase", { order: row.orderId });
  }
  return t("points.detail.referral", {
    name: row.relatedName || "-",
    base: formatPoints(row.baseAmount),
    rate: formatBps(row.rateBps),
  });
}
