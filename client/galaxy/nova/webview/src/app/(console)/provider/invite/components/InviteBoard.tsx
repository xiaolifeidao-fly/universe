"use client";

/**
 * 邀请好友。
 *
 * 进这一页十有八九是来复制链接的，所以链接和邀请码摆最上面，数字其次，名单最后。
 *
 * 「平台额外发、不影响好友自己的收益」这句紧挨着链接写：发链接的人最怕好友以为自己在抽他的成，
 * 这一点不说清楚，链接就不会发出去。
 *
 * 争议期内的奖励单独一格，道理同收益页把「可提现」「待结算」分开：合进累计里，
 * 人去提现时会发现提不出那么多。
 *
 * 名单里的名字是服务端打过码的（al***e）：邀请关系不该变成查别人账号的入口。
 */

import { message } from "antd";
import { useCallback, useEffect, useState } from "react";
import { PageHeader } from "@/components/shell/GalaxyShell";
import { Btn, Card, CardHead, CopyBtn, DataTable, EmptyState, Kpi, Loading, Note, Pager, type Column } from "@/components/ui/kit";
import { useLocale } from "@/i18n/LocaleProvider";
import { formatDateTime, formatDay, formatInt, formatPoints, formatSignedPoints } from "@/utils/format";
import { fetchInvitees, fetchReferral, type ReferralInvitee, type ReferralInviteePage, type ReferralOverview } from "../api/invite.api";

const PAGE_SIZE = 20;

/** 0.1 → 10%，0.125 → 12.5%。 */
function formatRate(rate: number): string {
  return `${Number((rate * 100).toFixed(2))}%`;
}

export function InviteBoard() {
  const { t } = useLocale();
  const [overview, setOverview] = useState<ReferralOverview | null>(null);
  const [invitees, setInvitees] = useState<ReferralInviteePage | null>(null);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [linkCopied, setLinkCopied] = useState(false);
  const [codeCopied, setCodeCopied] = useState(false);

  const load = useCallback(async () => {
    try {
      const [summary, list] = await Promise.all([
        fetchReferral(),
        fetchInvitees({ offset: (page - 1) * PAGE_SIZE, limit: PAGE_SIZE }),
      ]);
      setOverview(summary);
      setInvitees(list);
    } catch (error) {
      message.error((error as Error).message || t("common.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [page, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const header = <PageHeader title={t("invite.title")} meta={t("invite.subtitle")} />;

  if (loading || !overview) {
    return (
      <>
        {header}
        <div className="gx-body">
          {loading ? (
            <Loading />
          ) : (
            <EmptyState
              title={t("invite.loadFailed")}
              action={
                <Btn
                  tone="ghost"
                  small
                  onClick={() => {
                    setLoading(true);
                    void load();
                  }}
                >
                  {t("account.retry")}
                </Btn>
              }
            />
          )}
        </div>
      </>
    );
  }

  const rows = invitees?.items ?? [];
  const total = invitees?.total ?? 0;
  const columns: Column<ReferralInvitee>[] = [
    {
      key: "name",
      title: t("invite.col.name"),
      width: "minmax(0, 1fr)",
      render: (row) => <span className="gx-mono">{row.name || "—"}</span>,
    },
    {
      key: "joined",
      title: t("invite.col.joined"),
      width: "112px",
      render: (row) => <span className="gx-mono gx-muted">{formatDateTime(row.joinedAt)}</span>,
    },
    {
      key: "reward",
      title: t("invite.col.reward"),
      width: "110px",
      align: "right",
      render: (row) => (
        <span className="gx-mono" style={{ color: row.rewardTotal > 0 ? "var(--gx-accent-ink)" : "var(--gx-faint)", fontWeight: row.rewardTotal > 0 ? 500 : 400 }}>
          {row.rewardTotal ? formatSignedPoints(row.rewardTotal) : "0"}
        </span>
      ),
    },
    {
      key: "last",
      title: t("invite.col.last"),
      width: "112px",
      render: (row) => <span className="gx-mono gx-muted">{formatDateTime(row.lastRewardAt)}</span>,
    },
  ];
  // 长期有效时没有截止可言：整列不要，别摆一排「-」。过了截止的直接写「已截止」——
  // 主人看这一列想知道的是「这位还给不给我带奖励」，不是去比日期。
  if (overview.days > 0) {
    columns.push({
      key: "expires",
      title: t("invite.col.expires"),
      width: "96px",
      render: (row) =>
        row.expiresAt && new Date(row.expiresAt).getTime() < Date.now() ? (
          <span className="gx-muted">{t("invite.expired")}</span>
        ) : (
          <span className="gx-mono">{formatDay(row.expiresAt)}</span>
        ),
    });
  }

  const rule = t("invite.rule", {
    rate: formatRate(overview.rate),
    period: overview.days > 0 ? t("invite.periodDays", { days: overview.days }) : t("invite.periodForever"),
  });

  return (
    <>
      {header}
      <div className="gx-body">
        <Card className="gx-rise">
          <CardHead title={t("invite.linkTitle")} />
          <div style={{ display: "flex", flexDirection: "column", gap: 12, padding: "0 18px 18px" }}>
            {overview.link ? (
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <code
                  className="gx-mono"
                  style={{
                    flex: 1,
                    minWidth: 0,
                    padding: "10px 12px",
                    borderRadius: 10,
                    border: "1px solid var(--gx-line)",
                    background: "var(--gx-muted)",
                    fontSize: 13,
                    overflowWrap: "anywhere",
                  }}
                >
                  {overview.link}
                </code>
                <CopyBtn
                  value={overview.link}
                  label={linkCopied ? t("invite.copied") : t("invite.copyLink")}
                  copied={linkCopied}
                  onCopied={() => setLinkCopied(true)}
                />
              </div>
            ) : null}
            <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
              <span style={{ fontSize: 12.5, color: "var(--gx-soft)" }}>{t("invite.code")}</span>
              <span className="gx-mono" style={{ fontSize: 17, fontWeight: 600, letterSpacing: "0.14em" }}>
                {overview.code || "—"}
              </span>
              {overview.code ? (
                <CopyBtn
                  value={overview.code}
                  label={codeCopied ? t("invite.copied") : t("invite.copyCode")}
                  copied={codeCopied}
                  onCopied={() => setCodeCopied(true)}
                />
              ) : null}
            </div>
            {/* 没有链接时邀请码就是唯一能发出去的东西，说清楚为什么、好友那边要怎么用。 */}
            {overview.link ? null : <Note>{t("invite.noLink")}</Note>}
            {overview.enabled ? (
              <span style={{ fontSize: 12.5, lineHeight: 1.7, color: "var(--gx-soft)" }}>{rule}</span>
            ) : (
              // 暂停时比例是 0，照着拼出来就是「额外奖励你 0%」—— 不如直接说暂停了。
              <Note tone="warn">{t("invite.paused")}</Note>
            )}
          </div>
        </Card>

        <div className="gx-kpi gx-rise gx-rise--1" style={{ gridTemplateColumns: "repeat(4, minmax(0, 1fr))" }}>
          {/* 人数是个数；三个奖励都是微积分，和收益页同一个口径（1,000,000 = 1 积分 = ¥1）。 */}
          <Kpi label={t("invite.invitees")} value={formatInt(overview.invitees)} />
          <Kpi label={t("invite.rewardTotal")} value={formatPoints(overview.rewardTotal)} hint={t("invite.rewardTotalHint")} />
          <Kpi label={t("invite.rewardWeek")} value={formatPoints(overview.rewardWeek)} />
          <Kpi label={t("invite.rewardPending")} value={formatPoints(overview.rewardPending)} hint={t("invite.rewardPendingHint")} />
        </div>

        <Card className="gx-rise gx-rise--2" style={{ display: "flex", flexDirection: "column", flexShrink: 0 }}>
          <CardHead title={t("invite.list")} />
          <DataTable
            columns={columns}
            rows={rows}
            rowKey={(row) => `${row.name}:${row.joinedAt}`}
            empty={t("invite.empty")}
            foot={
              total > 0 ? (
                <Pager
                  page={page}
                  pageSize={PAGE_SIZE}
                  total={total}
                  onChange={setPage}
                  summary={t("invite.summary", {
                    from: (page - 1) * PAGE_SIZE + 1,
                    to: Math.min(page * PAGE_SIZE, total),
                    total,
                  })}
                />
              ) : null
            }
          />
        </Card>

        <Note>
          <b style={{ fontWeight: 600 }}>{t("invite.rules")}</b> · {t("invite.rulesBody")}
        </Note>
      </div>
    </>
  );
}
