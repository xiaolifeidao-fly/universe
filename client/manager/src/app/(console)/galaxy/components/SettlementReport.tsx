"use client";

import { ReloadOutlined } from "@ant-design/icons";
import { Button, Space, Table, message } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useCallback, useEffect, useState } from "react";
import { useLocale } from "@/i18n/LocaleProvider";
import { fetchAdminUsage, type UsageLine, type UsageReport } from "../api/galaxy.api";

/** 结算汇总：近 30 天按能力与上游分组的用量和金额。 */
export function SettlementReport() {
  const { t } = useLocale();
  const [usage, setUsage] = useState<UsageReport | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const to = new Date();
      const from = new Date(to.getTime() - 30 * 24 * 3600 * 1000);
      setUsage(await fetchAdminUsage({ from: from.toISOString(), to: to.toISOString() }));
    } catch (error) {
      message.error((error as Error).message || t("galaxy.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const columns: ColumnsType<UsageLine> = [
    { title: t("galaxy.usage.kind"), dataIndex: "kind", width: 160 },
    // 上游单独一列：llm.chat 底下 Claude 与 Codex 的量各算各的，合在一起看不出池子里谁在被用。
    {
      title: t("galaxy.usage.provider"),
      dataIndex: "provider",
      width: 170,
      render: (provider: string) => provider || "-",
    },
    { title: t("galaxy.usage.unit"), dataIndex: "unit", width: 220 },
    { title: t("galaxy.usage.amount"), dataIndex: "amount", align: "right", width: 140 },
    { title: t("galaxy.usage.calls"), dataIndex: "calls", align: "right", width: 120 },
    {
      title: t("galaxy.usage.cost"),
      dataIndex: "cost",
      align: "right",
      width: 140,
      render: (cost: number) => (cost > 0 ? `¥${(cost / 1_000_000).toFixed(2)}` : "-"),
    },
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <Space>
        <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void load()}>
          {t("galaxy.refresh")}
        </Button>
      </Space>

      <div style={{ color: "var(--manager-text-muted)" }}>
        {t("galaxy.usage.total")}: ¥{((usage?.totalFee ?? 0) / 1_000_000).toFixed(2)}
      </div>

      <Table<UsageLine>
        rowKey={(row) => `${row.kind}:${row.provider}:${row.unit}`}
        size="small"
        loading={loading}
        columns={columns}
        dataSource={usage?.lines ?? []}
        pagination={false}
        scroll={{ x: 970 }}
      />
    </div>
  );
}
