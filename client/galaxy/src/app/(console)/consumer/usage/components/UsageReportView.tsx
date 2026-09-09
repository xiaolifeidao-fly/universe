"use client";

import { ReloadOutlined } from "@ant-design/icons";
import { Alert, Button, Select, Space, Spin, Table, message } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useCallback, useEffect, useState } from "react";
import { useLocale } from "@/i18n/LocaleProvider";
import { formatMoney, formatNumber, formatUnitPrice, formatUnitValue, providerLabel, unitLabel } from "@/utils/format";
import {
  fetchKeys,
  fetchUsage,
  type ConsumerKeyView,
  type UsageLine,
  type UsageReport,
} from "../../api/consumer.api";

const RANGES = [7, 30, 90];

/**
 * 用量与扣费明细。
 *
 * input 与 output token 分行列出，各按各的单价算 —— 这是定价口径要求的
 * （决策 D-02），把它们合成一个「总 token」会让账单对不上。
 * calls 与 time.seconds 不计价，只作供给侧额度与统计，所以单价列显示「不计价」。
 *
 * 同一个能力下 Claude 与 Codex 也分行列出：kind 都是 llm.chat，不拆开的话
 * 消费者只能看见一个合计，看不出这笔钱花在哪个上游上。
 */
export function UsageReportView() {
  const { t } = useLocale();
  const [report, setReport] = useState<UsageReport | null>(null);
  const [keys, setKeys] = useState<ConsumerKeyView[]>([]);
  const [keyId, setKeyId] = useState("");
  const [days, setDays] = useState(30);
  const [loading, setLoading] = useState(true);

  const load = useCallback(
    async (targetKey: string, range: number) => {
      setLoading(true);
      try {
        const to = new Date();
        const from = new Date(to.getTime() - range * 24 * 3600 * 1000);
        const [usage, keyList] = await Promise.all([
          fetchUsage({ keyId: targetKey || undefined, from: from.toISOString(), to: to.toISOString() }),
          fetchKeys(),
        ]);
        setReport(usage);
        setKeys(keyList);
      } catch (error) {
        message.error((error as Error).message || t("common.loadFailed"));
      } finally {
        setLoading(false);
      }
    },
    [t],
  );

  useEffect(() => {
    void load(keyId, days);
  }, [days, keyId, load]);

  const columns: ColumnsType<UsageLine> = [
    { title: t("consumer.usage.kind"), dataIndex: "kind", width: 160 },
    {
      title: t("consumer.usage.provider"),
      dataIndex: "provider",
      width: 170,
      render: (provider: string) =>
        provider ? (
          <span>
            {providerLabel(provider)}
            <span style={{ marginLeft: 6, color: "var(--manager-text-muted)", fontSize: "var(--manager-fs-sm)" }}>
              {provider}
            </span>
          </span>
        ) : (
          <span style={{ color: "var(--manager-text-muted)" }}>{t("consumer.usage.unknownProvider")}</span>
        ),
    },
    {
      title: t("consumer.usage.unit"),
      dataIndex: "unit",
      width: 200,
      render: (unit: string) => (
        <span>
          {unitLabel(unit)}
          <span style={{ marginLeft: 6, color: "var(--manager-text-muted)", fontSize: "var(--manager-fs-sm)" }}>{unit}</span>
        </span>
      ),
    },
    {
      title: t("consumer.usage.amount"),
      dataIndex: "amount",
      align: "right",
      width: 130,
      render: (amount: number, row) => formatUnitValue(row.unit, amount),
    },
    {
      title: t("consumer.usage.calls"),
      dataIndex: "calls",
      align: "right",
      width: 110,
      render: (calls: number) => formatNumber(calls),
    },
    {
      title: t("consumer.usage.unitPrice"),
      dataIndex: "unitPrice",
      align: "right",
      width: 150,
      render: (price: number) =>
        price > 0 ? formatUnitPrice(price, report?.currency) : <span style={{ color: "var(--manager-text-muted)" }}>{t("consumer.usage.notPriced")}</span>,
    },
    {
      title: t("consumer.usage.cost"),
      dataIndex: "cost",
      align: "right",
      width: 130,
      render: (cost: number) => (cost > 0 ? formatMoney(cost, report?.currency) : "-"),
    },
  ];

  return (
    <div className="galaxy-page">
      <section className="galaxy-card">
        <div className="galaxy-card__head">
          <div style={{ flex: 1, minWidth: 0 }} />
          <Space>
            <Select
              value={keyId}
              style={{ minWidth: 200 }}
              onChange={(value) => setKeyId(value)}
              options={[
                { value: "", label: t("consumer.usage.allKeys") },
                ...keys.map((key) => ({ value: key.keyId, label: key.alias || key.keyId })),
              ]}
            />
            <Select
              value={days}
              style={{ width: 120 }}
              onChange={(value) => setDays(value)}
              options={RANGES.map((value) => ({ value, label: `${value}d` }))}
            />
            <Button icon={<ReloadOutlined />} onClick={() => void load(keyId, days)}>
              {t("common.refresh")}
            </Button>
          </Space>
        </div>

        {loading ? (
          <div style={{ padding: 40, display: "grid", placeItems: "center" }}>
            <Spin />
          </div>
        ) : (
          <>
            <div className="galaxy-kpi" style={{ marginBottom: 16 }}>
              <div className="galaxy-kpi__item">
                <span>{t("consumer.usage.total")}</span>
                <strong>{formatMoney(report?.totalFee ?? 0, report?.currency)}</strong>
              </div>
            </div>
            <Table<UsageLine>
              rowKey={(row) => `${row.kind}:${row.provider}:${row.unit}`}
              size="small"
              columns={columns}
              dataSource={report?.lines ?? []}
              locale={{ emptyText: t("consumer.usage.empty") }}
              pagination={false}
              scroll={{ x: 1050 }}
            />
          </>
        )}
      </section>
    </div>
  );
}
