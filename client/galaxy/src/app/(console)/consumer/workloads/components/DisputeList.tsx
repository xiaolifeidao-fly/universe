"use client";

import { Alert, Button, Empty, Form, Input, Modal, Popconfirm, Space, Table, Tag, Typography, message } from "antd";
import type { ColumnsType } from "antd/es/table";
import { Select } from "antd";
import { useCallback, useEffect, useState } from "react";
import { useLocale } from "@/i18n/LocaleProvider";
import { formatTime, formatUnitValue, unitLabel } from "@/utils/format";
import {
  DISPUTE_REASONS,
  fetchDisputes,
  fileDispute,
  withdrawDispute,
  type DisputeReason,
  type DisputeView,
} from "../../api/consumer.api";

const STATUS_COLOR: Record<string, string> = {
  open: "processing",
  reviewing: "warning",
  upheld: "success",
  rejected: "default",
  withdrawn: "default",
};

/** 还能撤的状态。已裁决的撤不了 —— 钱已经动过了。 */
const WITHDRAWABLE = new Set(["open", "reviewing"]);

type Props = { refreshToken: number; onChanged: () => void };

export function DisputeList({ refreshToken, onChanged }: Props) {
  const { t } = useLocale();
  const [rows, setRows] = useState<DisputeView[]>([]);
  const [loading, setLoading] = useState(true);
  const [filing, setFiling] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setRows(await fetchDisputes(100));
    } catch (error) {
      message.error((error as Error).message || t("common.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load, refreshToken]);

  const withdraw = async (disputeId: string) => {
    try {
      await withdrawDispute(disputeId);
      message.success(t("dispute.withdrawn"));
      onChanged();
    } catch (error) {
      message.error((error as Error).message || t("common.actionFailed"));
    }
  };

  const columns: ColumnsType<DisputeView> = [
    {
      title: t("dispute.unitId"),
      dataIndex: "unitId",
      width: 220,
      render: (unitId: string) => <span className="manager-mono">{unitId}</span>,
    },
    { title: t("workloads.kind"), dataIndex: "kind", width: 140 },
    {
      title: t("dispute.reason"),
      dataIndex: "reason",
      width: 130,
      render: (reason: string) => t(`dispute.reason.${reason}`),
    },
    {
      title: t("common.status"),
      dataIndex: "status",
      width: 120,
      render: (status: string) => <Tag color={STATUS_COLOR[status] ?? "default"}>{t(`dispute.status.${status}`)}</Tag>,
    },
    {
      title: t("dispute.refund"),
      dataIndex: "refund",
      // 明确给宽度：不给的话这一列会被压到表头断行成「退回额 / 度」。
      width: 200,
      render: (refund: Record<string, number>) => {
        const entries = Object.entries(refund ?? {}).filter(([, value]) => value > 0);
        if (entries.length === 0) return "-";
        return (
          <Space size={[6, 2]} wrap>
            {entries.map(([unit, value]) => (
              <Tag key={unit} color="success">{`${unitLabel(unit)} ${formatUnitValue(unit, value)}`}</Tag>
            ))}
          </Space>
        );
      },
    },
    {
      title: t("common.createdAt"),
      dataIndex: "createdTime",
      width: 180,
      render: (value: string) => formatTime(value),
    },
    {
      title: t("common.actions"),
      key: "actions",
      width: 100,
      render: (_, row) =>
        WITHDRAWABLE.has(row.status) ? (
          <Popconfirm title={t("dispute.withdrawConfirm")} onConfirm={() => void withdraw(row.disputeId)}>
            <Button type="link" size="small">
              {t("dispute.withdraw")}
            </Button>
          </Popconfirm>
        ) : null,
    },
  ];

  return (
    <>
      <Space style={{ marginBottom: 16, width: "100%", justifyContent: "space-between" }}>
        <Alert type="info" showIcon message={t("dispute.hint")} style={{ flex: 1 }} />
        <Button type="primary" onClick={() => setFiling(true)}>
          {t("dispute.file")}
        </Button>
      </Space>
      <Table
        rowKey="disputeId"
        size="small"
        loading={loading}
        dataSource={rows}
        columns={columns}
        pagination={{ pageSize: 20, hideOnSinglePage: true }}
        scroll={{ x: 1000 }}
        expandable={{
          rowExpandable: (row) => Boolean(row.detail || row.resolution),
          expandedRowRender: (row) => (
            <Space direction="vertical" size={4} style={{ width: "100%" }}>
              {row.detail ? <Typography.Text type="secondary">{row.detail}</Typography.Text> : null}
              {row.resolution ? (
                <Typography.Text>{`${t("dispute.resolution")}：${row.resolution}`}</Typography.Text>
              ) : null}
            </Space>
          ),
        }}
        locale={{ emptyText: <Empty description={t("dispute.empty")} /> }}
      />
      <FileDisputeModal open={filing} onClose={() => setFiling(false)} onFiled={onChanged} />
    </>
  );
}

/**
 * 建单。unitId 来自响应头 `X-Galaxy-Request-Id` —— 每一次调用平台都会带回来，
 * 消费者手里必须有它才能指出「是哪一次」。
 */
export function FileDisputeModal({
  open,
  unitId,
  onClose,
  onFiled,
}: {
  open: boolean;
  unitId?: string;
  onClose: () => void;
  onFiled: () => void;
}) {
  const { t } = useLocale();
  const [form] = Form.useForm<{ unitId: string; reason: DisputeReason; detail: string }>();
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (open) form.setFieldsValue({ unitId: unitId ?? "", reason: "not_delivered", detail: "" });
  }, [open, unitId, form]);

  const submit = async () => {
    const values = await form.validateFields();
    setSubmitting(true);
    try {
      await fileDispute({ unitId: values.unitId.trim(), reason: values.reason, detail: values.detail });
      message.success(t("dispute.filed"));
      onClose();
      onFiled();
    } catch (error) {
      message.error((error as Error).message || t("common.actionFailed"));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={open}
      title={t("dispute.file")}
      okText={t("dispute.submit")}
      cancelText={t("common.cancel")}
      confirmLoading={submitting}
      onOk={() => void submit()}
      onCancel={onClose}
      destroyOnClose
    >
      <Alert type="warning" showIcon style={{ marginBottom: 16 }} message={t("dispute.fileHint")} />
      <Form form={form} layout="vertical">
        <Form.Item name="unitId" label={t("dispute.unitId")} rules={[{ required: true }]} extra={t("dispute.unitIdHint")}>
          <Input placeholder="u_..." disabled={Boolean(unitId)} />
        </Form.Item>
        <Form.Item name="reason" label={t("dispute.reason")} rules={[{ required: true }]}>
          <Select options={DISPUTE_REASONS.map((reason) => ({ value: reason, label: t(`dispute.reason.${reason}`) }))} />
        </Form.Item>
        {/* 详情限长，且提醒不要贴请求内容 —— 请求内容平台本来就不留存。 */}
        <Form.Item name="detail" label={t("dispute.detail")} extra={t("dispute.detailHint")}>
          <Input.TextArea rows={4} maxLength={512} showCount />
        </Form.Item>
      </Form>
    </Modal>
  );
}
