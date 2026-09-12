"use client";

/**
 * 购买记录。
 *
 * 头上三个数字回答「一共花了多少积分、买到了几笔、还剩多少」—— 打开这一页的人基本只为这三件事。
 * 表格是给对账用的。积分购买是一个事务，不会停在「已付款」；还挂着「待支付」的只可能是
 * 接支付渠道那会儿留下的老订单，给一个取消的出口就够了。
 */

import { message } from "antd";
import { Card, DataTable, Kpi, Pill } from "@/components/ui/kit";
import { useLocale } from "@/i18n/LocaleProvider";
import { formatCompact, formatDateTime, formatPoints } from "@/utils/format";
import { cancelOrder, type ConsumerKeyView, type OrderView, type PointsSummary } from "../../api/consumer.api";

export function OrderHistory({
  orders,
  keys,
  points,
  onChanged,
}: {
  orders: OrderView[];
  keys: ConsumerKeyView[];
  points: PointsSummary | null;
  onChanged: () => void;
}) {
  const { t } = useLocale();
  const fulfilled = orders.filter((order) => order.status === "fulfilled");
  const alias = new Map(keys.map((key) => [key.keyId, key.alias || key.keyId]));

  const cancel = async (order: OrderView) => {
    try {
      await cancelOrder(order.orderId);
      message.success(t("store.cancelled"));
      onChanged();
    } catch (error) {
      message.error((error as Error).message || t("common.actionFailed"));
    }
  };

  return (
    <div className="gx-body gx-body--fixed">
      <div className="gx-kpi gx-rise" style={{ gridTemplateColumns: "repeat(3, minmax(0, 1fr))" }}>
        <Kpi label={t("orders.spent")} value={formatPoints(points?.spent ?? 0)} hint={t("orders.spentHint")} />
        <Kpi label={t("orders.fulfilled")} value={fulfilled.length} hint={t("orders.fulfilledHint")} />
        <Kpi label={t("orders.balance")} value={formatPoints(points?.balance ?? 0)} hint={t("orders.balanceHint")} />
      </div>

      <Card className="gx-rise gx-rise--1" style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
        <DataTable
          columns={[
            {
              key: "time",
              title: t("orders.col.time"),
              width: "112px",
              render: (row: OrderView) => <span className="gx-mono gx-muted">{formatDateTime(row.createdTime)}</span>,
            },
            {
              key: "order",
              title: t("orders.col.order"),
              width: "140px",
              render: (row: OrderView) => <span className="gx-mono gx-soft">{shorten(row.orderId)}</span>,
            },
            {
              key: "package",
              title: t("orders.col.package"),
              width: "1fr",
              render: (row: OrderView) => row.packageCode,
            },
            {
              key: "units",
              title: t("orders.col.units"),
              width: "110px",
              align: "right",
              render: (row: OrderView) => {
                const total = Object.values(row.units ?? {}).reduce((sum, value) => sum + value, 0);
                return <span className="gx-mono gx-soft">{total > 0 ? formatCompact(total) : "-"}</span>;
              },
            },
            {
              key: "target",
              title: t("orders.col.target"),
              width: "120px",
              render: (row: OrderView) => (
                <span className="gx-soft">{alias.get(row.keyId || row.targetKeyId) ?? t("orders.newKey")}</span>
              ),
            },
            {
              key: "amount",
              title: t("orders.col.amount"),
              width: "110px",
              align: "right",
              render: (row: OrderView) => (
                <span className="gx-mono">
                  {row.payMethod === "points" ? `${formatPoints(row.amount)} ${t("points.unit")}` : `¥${formatPoints(row.amount)}`}
                </span>
              ),
            },
            {
              key: "status",
              title: t("orders.col.status"),
              width: "140px",
              render: (row: OrderView) => (
                <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <Pill tone={statusTone(row.status)}>{t(`orders.status.${row.status}`)}</Pill>
                  {row.status === "pending" ? (
                    <button type="button" className="gx-link" style={{ color: "var(--gx-faint)" }} onClick={() => void cancel(row)}>
                      {t("common.cancel")}
                    </button>
                  ) : null}
                </span>
              ),
            },
          ]}
          rows={orders}
          rowKey={(row) => row.orderId}
          empty={t("orders.empty")}
        />
      </Card>
    </div>
  );
}

function statusTone(status: string): "ok" | "warn" | "default" {
  if (status === "fulfilled") return "ok";
  if (status === "pending" || status === "paid") return "warn";
  return "default";
}

function shorten(value: string): string {
  return value.length > 16 ? `${value.slice(0, 11)}…${value.slice(-2)}` : value;
}
