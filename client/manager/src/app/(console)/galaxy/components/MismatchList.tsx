"use client";

import { ReloadOutlined, WarningOutlined } from "@ant-design/icons";
import { Alert, Button, Empty, Segmented, Space, Table, Tag, Typography, message } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useCallback, useEffect, useRef, useState } from "react";
import { useLocale } from "@/i18n/LocaleProvider";
import { fetchMismatches, type MismatchOffender, type MismatchPage, type UsageMismatchView } from "../api/galaxy.api";

const PAGE_SIZE = 20;

/** 1.21M / 316k。token 这种大基数要一眼读出量级。 */
function compact(value: number): string {
  if (Math.abs(value) >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (Math.abs(value) >= 10_000) return `${Math.round(value / 1000)}k`;
  return value.toLocaleString("en-US");
}

/**
 * 用量偏差：节点自报和 Hub 解析对不上的那些记录。
 *
 * 这张表此前**只写不读** —— 超过阈值就落一行，然后没有任何地方看得见它。
 * 于是「某台机器一直在虚报用量」这件事，在库里有据可查，在管理端查不出来，
 * 最后只会以「账一直对不上」的形式冒出来，而那时候已经没法归因到某一台机器。
 *
 * 页面的重点是**上面那份排行**，不是下面的流水：偶发一次是解析抖动，
 * 同一条贡献反复上榜才是虚报。
 */
export function MismatchList() {
  const { t } = useLocale();
  const [days, setDays] = useState(7);
  const [pageIndex, setPageIndex] = useState(1);
  const [page, setPage] = useState<MismatchPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [cid, setCid] = useState("");
  const latest = useRef(0);

  const load = useCallback(async () => {
    const seq = ++latest.current;
    setLoading(true);
    try {
      const result = await fetchMismatches({ cid, days, offset: (pageIndex - 1) * PAGE_SIZE, limit: PAGE_SIZE });
      if (seq !== latest.current) return;
      setPage(result);
    } catch (error) {
      if (seq !== latest.current) return;
      message.error((error as Error).message || t("galaxy.loadFailed"));
    } finally {
      if (seq === latest.current) setLoading(false);
    }
  }, [cid, days, pageIndex, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const offenders = page?.offenders ?? [];

  const offenderColumns: ColumnsType<MismatchOffender> = [
    {
      title: t("galaxy.mismatch.cid"),
      dataIndex: "cid",
      render: (value: string, row) => (
        <Space direction="vertical" size={0}>
          <span style={{ fontWeight: 600 }}>{row.ownerName || t("galaxy.mismatch.unknownOwner")}</span>
          <Typography.Text type="secondary" className="manager-mono" style={{ fontSize: 12 }}>
            {value}
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: t("galaxy.mismatch.times"),
      dataIndex: "times",
      align: "right",
      width: 120,
      render: (value: number) => <span className="manager-mono">{value}</span>,
    },
    {
      title: t("galaxy.mismatch.worst"),
      dataIndex: "worstRatio",
      align: "right",
      width: 130,
      render: (value: number) => <Tag color={value >= 0.5 ? "error" : "warning"}>{`${Math.round(value * 100)}%`}</Tag>,
    },
    {
      title: t("galaxy.actions"),
      key: "actions",
      width: 110,
      render: (_, row) => (
        <Button
          type="link"
          size="small"
          onClick={() => {
            setCid(row.cid === cid ? "" : row.cid);
            setPageIndex(1);
          }}
        >
          {row.cid === cid ? t("galaxy.mismatch.clearFilter") : t("galaxy.mismatch.filter")}
        </Button>
      ),
    },
  ];

  const columns: ColumnsType<UsageMismatchView> = [
    {
      title: t("galaxy.mismatch.time"),
      dataIndex: "createdAt",
      width: 165,
      render: (value: string) => (value ? new Date(value).toLocaleString() : "-"),
    },
    {
      title: t("galaxy.mismatch.cid"),
      dataIndex: "cid",
      width: 240,
      render: (value: string, row) => (
        <Space direction="vertical" size={0}>
          <span>{row.ownerName || t("galaxy.mismatch.unknownOwner")}</span>
          <Typography.Text type="secondary" className="manager-mono" style={{ fontSize: 12 }}>
            {value}
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: t("galaxy.mismatch.unit"),
      dataIndex: "unit",
      width: 190,
      render: (value: string) => <span className="manager-mono">{value}</span>,
    },
    {
      title: t("galaxy.mismatch.hub"),
      dataIndex: "hubValue",
      align: "right",
      width: 120,
      render: (value: number) => <span className="manager-mono">{compact(value)}</span>,
    },
    {
      title: t("galaxy.mismatch.node"),
      dataIndex: "nodeValue",
      align: "right",
      width: 120,
      render: (value: number) => <span className="manager-mono">{compact(value)}</span>,
    },
    {
      title: t("galaxy.mismatch.ratio"),
      dataIndex: "ratio",
      align: "right",
      width: 110,
      render: (value: number) => <Tag color={value >= 0.5 ? "error" : "warning"}>{`${Math.round(value * 100)}%`}</Tag>,
    },
    {
      title: t("galaxy.mismatch.unitId"),
      dataIndex: "unitId",
      width: 210,
      render: (value: string) => <span className="manager-mono">{value}</span>,
    },
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <Alert
        type="info"
        showIcon
        icon={<WarningOutlined />}
        message={t("galaxy.mismatch.hint").replace("{threshold}", String(Math.round((page?.threshold ?? 0) * 100)))}
      />

      <Space wrap>
        <Segmented
          value={days}
          onChange={(value) => {
            setDays(Number(value));
            setPageIndex(1);
          }}
          options={[
            { value: 1, label: t("galaxy.mismatch.day1") },
            { value: 7, label: t("galaxy.mismatch.day7") },
            { value: 30, label: t("galaxy.mismatch.day30") },
          ]}
        />
        {cid ? (
          <Tag closable onClose={() => setCid("")} color="processing">
            {t("galaxy.mismatch.filtered")} {cid}
          </Tag>
        ) : null}
        <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void load()}>
          {t("galaxy.refresh")}
        </Button>
      </Space>

      {/* 排行在前：逐行看看不出规律，这份才是结论。 */}
      {offenders.length > 0 ? (
        <section className="manager-data-card" style={{ padding: 16 }}>
          <Typography.Title level={5} style={{ marginTop: 0 }}>
            {t("galaxy.mismatch.offendersTitle")}
          </Typography.Title>
          <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
            {t("galaxy.mismatch.offendersHint")}
          </Typography.Paragraph>
          <Table<MismatchOffender>
            rowKey="cid"
            size="small"
            columns={offenderColumns}
            dataSource={offenders}
            pagination={false}
            scroll={{ x: 640 }}
          />
        </section>
      ) : null}

      <Table<UsageMismatchView>
        rowKey={(row) => `${row.unitId}:${row.unit}`}
        size="small"
        loading={loading}
        columns={columns}
        dataSource={page?.records ?? []}
        scroll={{ x: 1155 }}
        pagination={{
          current: pageIndex,
          pageSize: PAGE_SIZE,
          total: page?.total ?? 0,
          showSizeChanger: false,
          onChange: setPageIndex,
        }}
        locale={{ emptyText: <Empty description={t("galaxy.mismatch.empty")} /> }}
      />
    </div>
  );
}
