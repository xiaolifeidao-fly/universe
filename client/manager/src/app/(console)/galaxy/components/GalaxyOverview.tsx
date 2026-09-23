"use client";

import { ArrowRightOutlined, ReloadOutlined } from "@ant-design/icons";
import { Alert, Button, Skeleton, Space, Typography, message } from "antd";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { useLocale, type TranslationKey } from "@/i18n/LocaleProvider";
import { fetchOverview, type AdminOverview } from "../api/galaxy.api";

/** 一格待办：数字 + 一句话 + 去哪一页。 */
type Todo = {
  key: string;
  labelKey: TranslationKey;
  hintKey: TranslationKey;
  count: number;
  href: string;
  /** 不是零就该有人去处理 —— 这类格子要跳出来。 */
  urgent?: boolean;
};

/**
 * 运营总览。
 *
 * 共享池的运营散在十几个页面上。没有这一页，判断「有没有事要处理」只能一页页翻 ——
 * 而那些事里有几件是**有人在等**：提现停在待处理，就是有人的钱既不在手上也没打出去；
 * 订单停在待付款，就是有人付了钱没拿到额度。
 *
 * 所以这一页上每一格都是一个待办计数，点进去就是对应那一页。不放趋势图：
 * 一块看着好看但不指向任何动作的仪表盘，第二周就没人看了。
 */
export function GalaxyOverview() {
  const { t } = useLocale();
  const router = useRouter();
  const [data, setData] = useState<AdminOverview | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await fetchOverview());
    } catch (error) {
      message.error((error as Error).message || t("galaxy.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const todos: Todo[] = data
    ? [
        {
          key: "payouts",
          labelKey: "galaxy.overview.payouts",
          hintKey: "galaxy.overview.payoutsHint",
          count: data.pendingPayouts,
          href: "/galaxy/payouts",
          urgent: true,
        },
        {
          key: "orders",
          labelKey: "galaxy.overview.orders",
          hintKey: "galaxy.overview.ordersHint",
          count: data.pendingOrders,
          href: "/galaxy/orders",
          urgent: true,
        },
        {
          key: "disputes",
          labelKey: "galaxy.overview.disputes",
          hintKey: "galaxy.overview.disputesHint",
          count: data.openDisputes,
          href: "/galaxy/disputes",
          urgent: true,
        },
        {
          key: "pricing",
          labelKey: "galaxy.overview.unpriced",
          hintKey: "galaxy.overview.unpricedHint",
          count: data.unpricedUnits,
          href: "/galaxy/pricing",
          urgent: true,
        },
        {
          key: "leads",
          labelKey: "galaxy.overview.leads",
          hintKey: "galaxy.overview.leadsHint",
          count: data.newLeads,
          href: "/galaxy/leads",
        },
        {
          key: "mismatches",
          labelKey: "galaxy.overview.mismatches",
          hintKey: "galaxy.overview.mismatchesHint",
          count: data.recentMismatches,
          href: "/galaxy/mismatches",
        },
        {
          key: "bans",
          labelKey: "galaxy.overview.bans",
          hintKey: "galaxy.overview.bansHint",
          count: data.bannedMachines,
          href: "/galaxy/bans",
        },
      ]
    : [];

  // 池水位在 Redis 上，是唯一可能整块取不到的一项。
  // 取不到时说「取不到」，不显示 0 —— 「在线 0」会被读成「池子空了」，那是完全不同的一件事。
  const poolDown = data?.degraded?.includes("pool") ?? false;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <Space>
        <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void load()}>
          {t("galaxy.refresh")}
        </Button>
      </Space>

      {loading && !data ? (
        <section className="manager-data-card">
          <Skeleton active paragraph={{ rows: 4 }} />
        </section>
      ) : (
        <>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
              gap: 12,
            }}
          >
            {todos.map((todo) => {
              const active = todo.count > 0;
              return (
                <button
                  key={todo.key}
                  type="button"
                  className="manager-data-card"
                  onClick={() => router.push(todo.href)}
                  style={{
                    textAlign: "left",
                    cursor: "pointer",
                    padding: 16,
                    // 只有「不是零」才上强调色。全站都染色等于没有强调。
                    borderColor: active && todo.urgent ? "var(--manager-primary)" : "var(--manager-border)",
                    display: "flex",
                    flexDirection: "column",
                    gap: 4,
                  }}
                >
                  <Space align="center" style={{ justifyContent: "space-between", width: "100%" }}>
                    <span style={{ color: "var(--manager-text-soft)", fontSize: "var(--manager-fs-sm)" }}>
                      {t(todo.labelKey)}
                    </span>
                    <ArrowRightOutlined style={{ color: "var(--manager-text-faint)", fontSize: 12 }} />
                  </Space>
                  <span
                    style={{
                      fontSize: 30,
                      fontWeight: 700,
                      lineHeight: 1.1,
                      color: active && todo.urgent ? "var(--manager-primary)" : "var(--manager-text)",
                    }}
                  >
                    {todo.count}
                  </span>
                  <span style={{ color: "var(--manager-text-faint)", fontSize: "var(--manager-fs-xs)" }}>
                    {t(todo.hintKey)}
                  </span>
                </button>
              );
            })}
          </div>

          <section className="manager-data-card">
            <Typography.Title level={5} style={{ marginTop: 0 }}>
              {t("galaxy.overview.poolTitle")}
            </Typography.Title>
            {poolDown ? (
              <Alert type="warning" showIcon message={t("galaxy.overview.poolDown")} />
            ) : (
              <Space size={[32, 12]} wrap>
                <Metric label={t("galaxy.overview.online")} value={`${data?.pool.online ?? 0} / ${data?.pool.contributions ?? 0}`} />
                <Metric label={t("galaxy.overview.seats")} value={`${data?.pool.seatsUsed ?? 0} / ${data?.pool.seatsTotal ?? 0}`} />
                <Metric label={t("galaxy.overview.inflight")} value={String(data?.pool.inflight ?? 0)} />
                <Metric label={t("galaxy.overview.waitQueue")} value={String(data?.pool.waitQueue ?? 0)} />
                <Metric label={t("galaxy.overview.lanes")} value={String(data?.pool.lanes ?? 0)} />
              </Space>
            )}
          </section>

          <section className="manager-data-card">
            <Typography.Title level={5} style={{ marginTop: 0 }}>
              {t("galaxy.overview.todayTitle")}
            </Typography.Title>
            <Space size={[32, 12]} wrap>
              <Metric label={t("galaxy.overview.todayUnits")} value={String(data?.today.units ?? 0)} />
              <Metric label={t("galaxy.overview.todayRunning")} value={String(data?.today.running ?? 0)} />
              <Metric
                label={t("galaxy.overview.todayFailed")}
                value={String(data?.today.failed ?? 0)}
                tone={(data?.today.failed ?? 0) > 0 ? "danger" : undefined}
              />
            </Space>
            <div style={{ marginTop: 12 }}>
              <Button type="link" size="small" style={{ paddingLeft: 0 }} onClick={() => router.push("/galaxy/units")}>
                {t("galaxy.overview.toUnits")}
              </Button>
            </div>
          </section>
        </>
      )}
    </div>
  );
}

function Metric({ label, value, tone }: { label: string; value: string; tone?: "danger" }) {
  return (
    <Space direction="vertical" size={0}>
      <span style={{ color: "var(--manager-text-faint)", fontSize: "var(--manager-fs-xs)" }}>{label}</span>
      <span
        className="manager-mono"
        style={{
          fontSize: 22,
          fontWeight: 700,
          color: tone === "danger" ? "var(--manager-danger)" : "var(--manager-text)",
        }}
      >
        {value}
      </span>
    </Space>
  );
}
