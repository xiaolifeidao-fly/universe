"use client";

import { ReloadOutlined } from "@ant-design/icons";
import { Alert, Button, Empty, Segmented, Space, Table, Tag, Typography, message } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useCallback, useEffect, useRef, useState } from "react";
import { useLocale } from "@/i18n/LocaleProvider";
import { useCanWrite } from "@/components/permission/WritePermission";
import { fetchLeads, handleLead, type LeadRecord, type LeadStatus } from "../api/galaxy.api";

const PAGE_SIZE = 20;

const STATUS_COLOR: Record<string, string> = {
  new: "processing",
  handled: "success",
  closed: "default",
};

/**
 * 门户「联系我们」收到的线索。
 *
 * 接口一直都在（/galaxy/admin/portal/leads），只是没有页面 —— 于是陌生人在门户上
 * 留下的每一条询问都进了库，没有人看得见。这一页把它接出来。
 *
 * 里面是**陌生人留下的手机与邮箱**：只读角色在资源表里就没有这条接口的授权，
 * 界面上也不提供导出 —— 一份能整表导出的联系方式名单，丢一次就再也收不回来。
 */
export function LeadQueue() {
  const { t } = useLocale();
  const canWrite = useCanWrite();
  const [status, setStatus] = useState<LeadStatus | "all">("new");
  const [pageIndex, setPageIndex] = useState(1);
  const [rows, setRows] = useState<LeadRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const latest = useRef(0);

  const load = useCallback(async () => {
    const seq = ++latest.current;
    setLoading(true);
    try {
      const page = await fetchLeads({
        status: status === "all" ? "" : status,
        offset: (pageIndex - 1) * PAGE_SIZE,
        limit: PAGE_SIZE,
      });
      if (seq !== latest.current) return;
      setRows(page.leads ?? []);
      setTotal(page.total);
    } catch (error) {
      if (seq !== latest.current) return;
      message.error((error as Error).message || t("galaxy.loadFailed"));
    } finally {
      if (seq === latest.current) setLoading(false);
    }
  }, [status, pageIndex, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const mark = async (row: LeadRecord, next: LeadStatus) => {
    try {
      await handleLead(row.leadId, next);
      message.success(t("galaxy.lead.saved"));
      await load();
    } catch (error) {
      message.error((error as Error).message || t("galaxy.actionFailed"));
    }
  };

  const columns: ColumnsType<LeadRecord> = [
    {
      title: t("galaxy.lead.who"),
      dataIndex: "contact",
      width: 230,
      render: (contact: string, row) => (
        <Space direction="vertical" size={0}>
          <span style={{ fontWeight: 600 }}>{row.name || t("galaxy.lead.anonymous")}</span>
          <Typography.Text className="manager-mono" copyable={{ text: contact }} style={{ fontSize: 12 }}>
            {contact || "-"}
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: t("galaxy.lead.company"),
      dataIndex: "company",
      width: 170,
      render: (value: string, row) => (
        <Space direction="vertical" size={0}>
          <span>{value || "-"}</span>
          {row.scale ? (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {row.scale}
            </Typography.Text>
          ) : null}
        </Space>
      ),
    },
    { title: t("galaxy.lead.topic"), dataIndex: "topic", width: 140, render: (value: string) => value || "-" },
    {
      title: t("galaxy.lead.source"),
      dataIndex: "source",
      width: 120,
      render: (value: string) => (value ? <Tag>{value}</Tag> : "-"),
    },
    {
      title: t("galaxy.lead.status"),
      dataIndex: "status",
      width: 100,
      render: (value: string) => <Tag color={STATUS_COLOR[value] ?? "default"}>{t(`galaxy.lead.status.${value}`)}</Tag>,
    },
    {
      title: t("galaxy.lead.createdAt"),
      dataIndex: "createdTime",
      width: 165,
      render: (value: string) => (value ? new Date(value).toLocaleString() : "-"),
    },
    {
      title: t("galaxy.actions"),
      key: "actions",
      width: 150,
      fixed: "right",
      render: (_, row) =>
        canWrite ? (
          <Space size={4}>
            {row.status !== "handled" ? (
              <Button type="link" size="small" onClick={() => void mark(row, "handled")}>
                {t("galaxy.lead.markHandled")}
              </Button>
            ) : null}
            {row.status !== "closed" ? (
              <Button type="link" size="small" onClick={() => void mark(row, "closed")}>
                {t("galaxy.lead.markClosed")}
              </Button>
            ) : null}
          </Space>
        ) : null,
    },
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <Alert type="info" showIcon message={t("galaxy.lead.privacy")} />

      <Space wrap>
        <Segmented
          value={status}
          onChange={(value) => {
            setStatus(value as LeadStatus | "all");
            setPageIndex(1);
          }}
          options={[
            { value: "new", label: t("galaxy.lead.status.new") },
            { value: "handled", label: t("galaxy.lead.status.handled") },
            { value: "closed", label: t("galaxy.lead.status.closed") },
            { value: "all", label: t("galaxy.lead.all") },
          ]}
        />
        <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void load()}>
          {t("galaxy.refresh")}
        </Button>
      </Space>

      <Table<LeadRecord>
        rowKey="leadId"
        size="small"
        loading={loading}
        columns={columns}
        dataSource={rows}
        scroll={{ x: 1075 }}
        pagination={{
          current: pageIndex,
          pageSize: PAGE_SIZE,
          total,
          showSizeChanger: false,
          onChange: setPageIndex,
        }}
        expandable={{
          rowExpandable: (row) => Boolean(row.message || row.handledBy),
          expandedRowRender: (row) => (
            <Space direction="vertical" size={4} style={{ width: "100%" }}>
              {row.message ? <Typography.Text>{row.message}</Typography.Text> : null}
              {row.handledBy ? (
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {`${t("galaxy.lead.handledBy")}：${row.handledBy}`}
                  {row.handledAt ? ` · ${new Date(row.handledAt).toLocaleString()}` : ""}
                </Typography.Text>
              ) : null}
            </Space>
          ),
        }}
        locale={{ emptyText: <Empty description={t("galaxy.lead.empty")} /> }}
      />
    </div>
  );
}
