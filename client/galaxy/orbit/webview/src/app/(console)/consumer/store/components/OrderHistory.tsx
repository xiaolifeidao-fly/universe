"use client";

/**
 * 充值记录。
 *
 * 头上那三个数字回答的是「一共花了多少、有没有还没付的、能不能开票」——
 * 打开这一页的人基本只为这三件事。表格是给对账用的。
 */

import { Card, DataTable, Kpi, Pill } from "@/components/ui/kit";
import { useLocale } from "@/i18n/LocaleProvider";
import { formatCny, formatCompact, formatDateTime } from "@/utils/format";
import type { ConsumerKeyView, OrderView, PaymentChannelView } from "../../api/consumer.api";

export function OrderHistory({
  orders,
  keys,
  channels,
  onPay,
  onCancel,
}: {
  orders: OrderView[];
  keys: ConsumerKeyView[];
  channels: PaymentChannelView[];
  onPay: (order: OrderView) => void;
  onCancel: (order: OrderView) => void;
}) {
  const { t } = useLocale();
  const paid = orders.filter((order) => order.status === "fulfilled" || order.status === "paid");
  const pending = orders.filter((order) => order.status === "pending");
  const total = paid.reduce((sum, order) => sum + order.amount, 0);
  const alias = new Map(keys.map((key) => [key.keyId, key.alias || key.keyId]));
  const channelTitle = new Map(channels.map((item) => [item.code, item.title]));

  return (
    <div className="gx-body gx-body--fixed">
      <div className="gx-kpi gx-rise" style={{ gridTemplateColumns: "repeat(3, minmax(0, 1fr))" }}>
        <Kpi label={t("orders.paidTotal")} value={formatCny(total)} hint={t("orders.paidCount", { value: paid.length })} />
        <Kpi
          label={t("orders.pending")}
          value={t("orders.pendingCount", { value: pending.length })}
          hint={pending.length > 0 ? t("orders.pendingHint") : undefined}
        />
        <Kpi label={t("orders.invoice")} value={formatCny(total)} hint={t("orders.invoiceHint")} />
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
              render: (row: OrderView) => (
                <span className="gx-mono gx-soft">
                  {Object.values(row.units ?? {}).reduce((sum, value) => sum + value, 0) > 0
                    ? formatCompact(Object.values(row.units ?? {}).reduce((sum, value) => sum + value, 0))
                    : "-"}
                </span>
              ),
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
              width: "92px",
              align: "right",
              render: (row: OrderView) => <span className="gx-mono">{formatCny(row.amount)}</span>,
            },
            {
              key: "status",
              title: t("orders.col.status"),
              width: "150px",
              render: (row: OrderView) => (
                <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <Pill tone={statusTone(row.status)}>{t(`orders.status.${row.status}`)}</Pill>
                  {row.status === "pending" ? (
                    <>
                      <button type="button" className="gx-link" onClick={() => onPay(row)}>
                        {t("store.pay")}
                      </button>
                      <button type="button" className="gx-link" style={{ color: "var(--gx-faint)" }} onClick={() => onCancel(row)}>
                        {t("common.cancel")}
                      </button>
                    </>
                  ) : null}
                </span>
              ),
            },
          ]}
          rows={orders}
          rowKey={(row) => row.orderId}
          empty={t("orders.empty")}
          foot={
            channels.length > 0 ? (
              <div className="gx-row__foot">
                <span>{Array.from(channelTitle.values()).join(" · ")}</span>
                <span>{t("orders.pendingHint")}</span>
              </div>
            ) : null
          }
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
