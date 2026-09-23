"use client";

import { ReloadOutlined } from "@ant-design/icons";
import { Button, Space, Table, Tag, message } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useCallback, useEffect, useState } from "react";
import { useLocale } from "@/i18n/LocaleProvider";
import { fetchProbes, type AuditProbeView } from "../api/galaxy.api";

/** 抽检：平台按贡献抽样发出的探针，以及它们的判定结果。 */
export function AuditProbes() {
  const { t } = useLocale();
  const [probes, setProbes] = useState<AuditProbeView[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setProbes(await fetchProbes());
    } catch (error) {
      message.error((error as Error).message || t("galaxy.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const columns: ColumnsType<AuditProbeView> = [
    { title: t("galaxy.probe.cid"), dataIndex: "cid", width: 220 },
    { title: t("galaxy.probe.model"), dataIndex: "model", width: 180, render: (value: string) => value || "-" },
    {
      title: t("galaxy.probe.similarity"),
      dataIndex: "similarity",
      width: 130,
      render: (value: number, row) => (row.verdict === "pending" || row.verdict === "ready" ? "-" : value.toFixed(2)),
    },
    {
      title: t("galaxy.probe.verdict"),
      dataIndex: "verdict",
      width: 130,
      render: (verdict: string) => {
        const color =
          verdict === "forged" ? "error" : verdict === "suspect" ? "warning" : verdict === "pass" ? "success" : "default";
        return <Tag color={color}>{verdict}</Tag>;
      },
    },
    { title: t("galaxy.probe.detail"), dataIndex: "detail", render: (value: string) => value || "-" },
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <Space>
        <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void load()}>
          {t("galaxy.refresh")}
        </Button>
      </Space>

      <Table<AuditProbeView>
        rowKey="probeId"
        size="small"
        loading={loading}
        columns={columns}
        dataSource={probes}
        pagination={{ pageSize: 20, showSizeChanger: false }}
        scroll={{ x: 900 }}
      />
    </div>
  );
}
