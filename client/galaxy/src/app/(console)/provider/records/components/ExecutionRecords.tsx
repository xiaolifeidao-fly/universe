"use client";

import { ReloadOutlined } from "@ant-design/icons";
import { Alert, Button, Select, Space, Table, Tag, message } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useCallback, useEffect, useState } from "react";
import { useLocale } from "@/i18n/LocaleProvider";
import { formatMoney, formatTime, formatUnitValue, unitLabel } from "@/utils/format";
import {
  fetchCredits,
  fetchNodes,
  fetchRecords,
  type ContributionView,
  type ExecutionRecord,
} from "../../api/provider.api";

/**
 * 「我的机器上跑过什么」。
 *
 * 这里刻意看不到使用者是谁、也看不到请求内容 —— 那是协议对消费者的承诺（C-12）。
 * 主人需要知道的是：跑了什么能力、烧了多少额度、成没成功。
 */
export function ExecutionRecords() {
  const { t } = useLocale();
  const [records, setRecords] = useState<ExecutionRecord[]>([]);
  const [contributions, setContributions] = useState<ContributionView[]>([]);
  const [cid, setCid] = useState<string>("");
  const [credits, setCredits] = useState(0);
  const [loading, setLoading] = useState(true);

  const load = useCallback(
    async (targetCid: string) => {
      setLoading(true);
      try {
        const [nodes, list, balance] = await Promise.all([fetchNodes(), fetchRecords(targetCid), fetchCredits()]);
        setContributions(nodes.flatMap((node) => node.contributions ?? []));
        setRecords(list);
        setCredits(balance.balance);
      } catch (error) {
        message.error((error as Error).message || t("common.loadFailed"));
      } finally {
        setLoading(false);
      }
    },
    [t],
  );

  useEffect(() => {
    void load(cid);
  }, [cid, load]);

  const columns: ColumnsType<ExecutionRecord> = [
    { title: t("provider.records.kind"), dataIndex: "kind", width: 150 },
    { title: t("provider.records.model"), dataIndex: "model", width: 180, render: (value: string) => value || "-" },
    {
      title: t("provider.records.result"),
      dataIndex: "state",
      width: 140,
      render: (state: string, row) =>
        state === "completed" ? (
          <Tag color="success">{state}</Tag>
        ) : (
          <Tag color={state === "failed" ? "error" : "default"}>{row.errorCode || state}</Tag>
        ),
    },
    {
      title: t("provider.records.usage"),
      dataIndex: "usage",
      render: (usage: Record<string, number>) => {
        const entries = Object.entries(usage ?? {}).filter(([, value]) => value > 0);
        if (entries.length === 0) return "-";
        return (
          <Space size={12} wrap>
            {entries.map(([unit, value]) => (
              <span key={unit} style={{ color: "var(--manager-text-muted)" }}>
                {unitLabel(unit)} <b style={{ color: "var(--manager-text)" }}>{formatUnitValue(unit, value)}</b>
              </span>
            ))}
          </Space>
        );
      },
    },
    {
      title: t("common.createdAt"),
      dataIndex: "startedAt",
      width: 190,
      render: (value?: string) => formatTime(value),
    },
  ];

  return (
    <div className="galaxy-page">
      <section className="galaxy-card">
        <div className="galaxy-card__head">
          <div style={{ flex: 1, minWidth: 0 }}>
            <h2>{t("provider.credits.title")}</h2>
            <p>{t("provider.credits.hint")}</p>
          </div>
        </div>
        <div className="galaxy-kpi">
          <div className="galaxy-kpi__item">
            <span>{t("provider.credits.balance")}</span>
            <strong>{formatMoney(credits)}</strong>
          </div>
        </div>
      </section>

      <section className="galaxy-card">
        <div className="galaxy-card__head">
          <div style={{ flex: 1, minWidth: 0 }} />
          <Space>
            <Select
              value={cid}
              style={{ minWidth: 200 }}
              onChange={(value) => setCid(value)}
              options={[
                { value: "", label: t("consumer.usage.allKeys") },
                ...contributions.map((item) => ({ value: item.cid, label: item.cid })),
              ]}
            />
            <Button icon={<ReloadOutlined />} onClick={() => void load(cid)}>
              {t("common.refresh")}
            </Button>
          </Space>
        </div>

        <Alert type="info" showIcon message={t("provider.records.hint")} style={{ marginBottom: 14 }} />

        <Table<ExecutionRecord>
          rowKey="unitId"
          size="small"
          loading={loading}
          columns={columns}
          dataSource={records}
          locale={{ emptyText: t("common.empty") }}
          pagination={{ pageSize: 20, showSizeChanger: false }}
          scroll={{ x: 860 }}
        />
      </section>
    </div>
  );
}
