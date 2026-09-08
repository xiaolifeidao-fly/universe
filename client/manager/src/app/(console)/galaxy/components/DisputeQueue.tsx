"use client";

import { Alert, Button, Empty, Form, Input, Modal, Radio, Segmented, Space, Table, Tag, Typography, message } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useCallback, useEffect, useState } from "react";
import { useLocale } from "@/i18n/LocaleProvider";
import { useCanWrite } from "@/components/permission/WritePermission";
import { fetchDisputes, resolveDispute, type AdminDisputeView } from "../api/galaxy.api";

const STATUS_COLOR: Record<string, string> = {
  open: "processing",
  reviewing: "warning",
  upheld: "success",
  rejected: "default",
  withdrawn: "default",
};

/** 还能裁的状态。已裁决的不再出现「处理」按钮 —— 钱只能动一次。 */
const ACTIONABLE = new Set(["open", "reviewing"]);

/**
 * 争议工单队列。
 *
 * 这是运营在共享池里唯一能直接动钱的地方：支持申诉会在消费侧、供给侧、平台侧
 * 三本账上各记一笔反向流水，并从提供者的积分里扣回分成。所以默认只看待办，
 * 且每一次裁决都必须写处理说明 —— 那段话会原样给到申诉人。
 */
export function DisputeQueue() {
  const { t } = useLocale();
  // 裁决会在三本账上记反向流水并扣信誉 —— 这是笔真钱，只读角色一律看不到入口。
  const canWrite = useCanWrite();
  const [status, setStatus] = useState<string>("open");
  const [rows, setRows] = useState<AdminDisputeView[]>([]);
  const [loading, setLoading] = useState(true);
  const [target, setTarget] = useState<AdminDisputeView | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setRows(await fetchDisputes(status === "all" ? "" : status));
    } catch (error) {
      message.error((error as Error).message || t("galaxy.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [status, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const columns: ColumnsType<AdminDisputeView> = [
    {
      title: t("galaxy.dispute.unitId"),
      dataIndex: "unitId",
      width: 210,
      render: (unitId: string, row) => (
        <Space direction="vertical" size={0}>
          <span className="manager-mono">{unitId}</span>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {row.kind}
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: t("galaxy.dispute.cid"),
      dataIndex: "cid",
      width: 200,
      render: (cid: string) => <span className="manager-mono">{cid || "-"}</span>,
    },
    {
      title: t("galaxy.dispute.reason"),
      dataIndex: "reason",
      width: 120,
      render: (reason: string) => t(`galaxy.dispute.reason.${reason}`),
    },
    {
      title: t("galaxy.dispute.status"),
      dataIndex: "status",
      width: 110,
      render: (value: string) => <Tag color={STATUS_COLOR[value] ?? "default"}>{t(`galaxy.dispute.status.${value}`)}</Tag>,
    },
    {
      title: t("galaxy.dispute.clawback"),
      dataIndex: "clawbackAmount",
      align: "right",
      width: 130,
      render: (amount: number) => (amount > 0 ? `¥${(amount / 1_000_000).toFixed(2)}` : "-"),
    },
    {
      title: t("galaxy.dispute.filedAt"),
      dataIndex: "createdTime",
      width: 170,
      render: (value: string) => (value ? new Date(value).toLocaleString() : "-"),
    },
    {
      title: t("galaxy.actions"),
      key: "actions",
      width: 100,
      render: (_, row) =>
        canWrite && ACTIONABLE.has(row.status) ? (
          <Button type="link" size="small" onClick={() => setTarget(row)}>
            {t("galaxy.dispute.handle")}
          </Button>
        ) : null,
    },
  ];

  return (
    <>
      <Space style={{ marginBottom: 12 }}>
        <Segmented
          value={status}
          onChange={(value) => setStatus(String(value))}
          options={[
            { value: "open", label: t("galaxy.dispute.status.open") },
            { value: "reviewing", label: t("galaxy.dispute.status.reviewing") },
            { value: "upheld", label: t("galaxy.dispute.status.upheld") },
            { value: "rejected", label: t("galaxy.dispute.status.rejected") },
            { value: "all", label: t("galaxy.dispute.all") },
          ]}
        />
      </Space>
      <Table<AdminDisputeView>
        rowKey="disputeId"
        size="small"
        loading={loading}
        columns={columns}
        dataSource={rows}
        pagination={{ pageSize: 20, showSizeChanger: false }}
        scroll={{ x: 1050 }}
        expandable={{
          rowExpandable: (row) => Boolean(row.detail || row.resolution),
          expandedRowRender: (row) => (
            <Space direction="vertical" size={4} style={{ width: "100%" }}>
              {row.detail ? (
                <Typography.Text type="secondary">{`${t("galaxy.dispute.detail")}：${row.detail}`}</Typography.Text>
              ) : null}
              {row.resolution ? (
                <Typography.Text>{`${t("galaxy.dispute.resolution")}：${row.resolution}`}</Typography.Text>
              ) : null}
            </Space>
          ),
        }}
        locale={{ emptyText: <Empty description={t("galaxy.dispute.empty")} /> }}
      />
      <ResolveModal dispute={target} onClose={() => setTarget(null)} onResolved={load} />
    </>
  );
}

function ResolveModal({
  dispute,
  onClose,
  onResolved,
}: {
  dispute: AdminDisputeView | null;
  onClose: () => void;
  onResolved: () => void;
}) {
  const { t } = useLocale();
  const [form] = Form.useForm<{ status: string; resolution: string }>();
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (dispute) form.setFieldsValue({ status: "upheld", resolution: "" });
  }, [dispute, form]);

  const submit = async () => {
    if (!dispute) return;
    const values = await form.validateFields();
    setSubmitting(true);
    try {
      await resolveDispute(dispute.disputeId, values.status, values.resolution);
      message.success(t("galaxy.dispute.resolved"));
      onClose();
      onResolved();
    } catch (error) {
      message.error((error as Error).message || t("galaxy.actionFailed"));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={dispute !== null}
      title={t("galaxy.dispute.handle")}
      okText={t("galaxy.dispute.confirm")}
      cancelText={t("galaxy.cancel")}
      confirmLoading={submitting}
      onOk={() => void submit()}
      onCancel={onClose}
      destroyOnClose
    >
      {/* 「支持」是不可逆的：账已经记了，信誉已经扣了。所以先把后果说清楚。 */}
      <Alert type="warning" showIcon style={{ marginBottom: 16 }} message={t("galaxy.dispute.upheldWarning")} />
      <Form form={form} layout="vertical">
        <Form.Item name="status" label={t("galaxy.dispute.decision")} rules={[{ required: true }]}>
          <Radio.Group>
            <Radio.Button value="upheld">{t("galaxy.dispute.status.upheld")}</Radio.Button>
            <Radio.Button value="rejected">{t("galaxy.dispute.status.rejected")}</Radio.Button>
            <Radio.Button value="reviewing">{t("galaxy.dispute.status.reviewing")}</Radio.Button>
          </Radio.Group>
        </Form.Item>
        {/* 处理说明会原样发给申诉人，所以是必填。 */}
        <Form.Item
          name="resolution"
          label={t("galaxy.dispute.resolution")}
          rules={[{ required: true }]}
          extra={t("galaxy.dispute.resolutionHint")}
        >
          <Input.TextArea rows={4} maxLength={512} showCount />
        </Form.Item>
      </Form>
    </Modal>
  );
}
