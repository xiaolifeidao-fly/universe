"use client";

import { ReloadOutlined } from "@ant-design/icons";
import { Alert, Button, Empty, Form, Input, InputNumber, Modal, Progress, Space, Table, Tag, Typography, message } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useCallback, useEffect, useState } from "react";
import { useLocale } from "@/i18n/LocaleProvider";
import { useCanWrite } from "@/components/permission/WritePermission";
import { fetchReputations, setReputation, type ReputationPage, type ReputationView } from "../api/galaxy.api";

const KIND_COLOR: Record<string, string> = { account: "blue", device: "purple", node: "default" };

/**
 * 信誉名单。
 *
 * 信誉此前在管理端只露出一个派生值：节点列表上每条贡献旁边那个分数。那有两个问题 ——
 *
 * 1. **被扣分的主体不一定还在节点列表上**。信誉按 account: / device: 记，机器撤销、
 *    重装、换了 node_id 之后，那份 device: 记录就没有任何入口看得到了（和封禁名单同一个毛病）。
 * 2. **没有任何地方能把分数改回去**。抽检误判、探针自己出错，扣掉的分只能等它按天
 *    自己回升 —— 而一次误判够那台机器少接好几天单。
 *
 * 表上显示的是**此刻**的分数（按回升速率现算），不是库里那个结算值：
 * 显示结算值会把早就自然回满的主体说成还在低分。
 */
export function ReputationList() {
  const { t } = useLocale();
  // 改信誉直接决定这台机器还能不能接到单，只读角色看不到入口。
  const canWrite = useCanWrite();
  const [page, setPage] = useState<ReputationPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [target, setTarget] = useState<ReputationView | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setPage(await fetchReputations());
    } catch (error) {
      message.error((error as Error).message || t("galaxy.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const columns: ColumnsType<ReputationView> = [
    {
      title: t("galaxy.reputation.subject"),
      dataIndex: "subject",
      width: 320,
      render: (_: string, row) => {
        const first = row.nodes?.[0];
        const title = row.ownerName || first?.displayName || first?.ownerName || t("galaxy.reputation.goneSubject");
        return (
          <Space direction="vertical" size={0}>
            <Space size={6}>
              <Tag color={KIND_COLOR[row.kind] ?? "default"}>{t(`galaxy.reputation.kind.${row.kind || "node"}`)}</Tag>
              <span style={{ fontWeight: 600 }}>{title}</span>
            </Space>
            <Typography.Text type="secondary" className="manager-mono" style={{ fontSize: 12 }} copyable={{ text: row.subject }}>
              {row.ref.length > 24 ? `${row.ref.slice(0, 24)}…` : row.ref}
            </Typography.Text>
          </Space>
        );
      },
    },
    {
      title: t("galaxy.reputation.score"),
      dataIndex: "effective",
      width: 200,
      render: (value: number) => (
        <Space direction="vertical" size={0} style={{ width: "100%" }}>
          <Progress
            percent={Math.round(value * 100)}
            size="small"
            status={value < 0.4 ? "exception" : value < 0.8 ? "normal" : "success"}
            format={(percent) => `${percent}%`}
          />
        </Space>
      ),
    },
    {
      title: t("galaxy.reputation.settled"),
      dataIndex: "settled",
      align: "right",
      width: 160,
      render: (value: number, row) => (
        <Space direction="vertical" size={0} style={{ alignItems: "flex-end" }}>
          <span className="manager-mono">{value.toFixed(2)}</span>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {row.settledAt ? new Date(row.settledAt).toLocaleDateString() : "-"}
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: t("galaxy.reputation.nodes"),
      key: "nodes",
      render: (_, row) =>
        row.nodes.length === 0 ? (
          // 机器不在册了 —— 那正是这张名单存在的理由：节点列表上找不到它。
          // 账号型的信誉说法不一样：它管的是这个人名下所有机器，一台都没有
          // 只意味着这个人当下没有在跑的机器，不是「记录丢了」。
          <Typography.Text type="secondary">
            {t(row.kind === "account" ? "galaxy.reputation.noOwnerNodes" : "galaxy.reputation.noNodes")}
          </Typography.Text>
        ) : (
          <Space direction="vertical" size={0}>
            {row.nodes.slice(0, 2).map((node) => (
              <Typography.Text key={node.nodeId} type="secondary" style={{ fontSize: 12 }}>
                {node.displayName || node.nodeId}
                {node.status ? ` · ${node.status}` : ""}
              </Typography.Text>
            ))}
            {row.nodes.length > 2 ? (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {t("galaxy.reputation.moreNodes").replace("{count}", String(row.nodes.length - 2))}
              </Typography.Text>
            ) : null}
          </Space>
        ),
    },
    {
      title: t("galaxy.actions"),
      key: "actions",
      width: 110,
      fixed: "right",
      render: (_, row) =>
        canWrite ? (
          <Button type="link" size="small" onClick={() => setTarget(row)}>
            {t("galaxy.reputation.adjust")}
          </Button>
        ) : null,
    },
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <Alert
        type="info"
        showIcon
        message={t("galaxy.reputation.hint")}
        description={t("galaxy.reputation.recovery").replace("{rate}", String(page?.recoveryPerDay ?? 0))}
      />

      <Space>
        <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void load()}>
          {t("galaxy.refresh")}
        </Button>
      </Space>

      <Table<ReputationView>
        rowKey="subject"
        size="small"
        loading={loading}
        columns={columns}
        dataSource={page?.records ?? []}
        pagination={{ pageSize: 20, showSizeChanger: false }}
        scroll={{ x: 1060 }}
        locale={{ emptyText: <Empty description={t("galaxy.reputation.empty")} /> }}
      />

      <AdjustModal target={target} onClose={() => setTarget(null)} onSaved={load} />
    </div>
  );
}

function AdjustModal({
  target,
  onClose,
  onSaved,
}: {
  target: ReputationView | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useLocale();
  const [form] = Form.useForm<{ value: number; reason: string }>();
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    // 默认填满分：来这里的绝大多数情况是「这次是误判，恢复它」。
    if (target) form.setFieldsValue({ value: 1, reason: "" });
  }, [target, form]);

  const submit = async () => {
    if (!target) return;
    const values = await form.validateFields();
    setSubmitting(true);
    try {
      await setReputation(target.subject, values.value, values.reason.trim());
      message.success(t("galaxy.reputation.saved"));
      onClose();
      onSaved();
    } catch (error) {
      message.error((error as Error).message || t("galaxy.actionFailed"));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={target !== null}
      title={t("galaxy.reputation.adjustTitle")}
      okText={t("galaxy.confirm")}
      cancelText={t("galaxy.cancel")}
      confirmLoading={submitting}
      onOk={() => void submit()}
      onCancel={onClose}
      destroyOnClose
    >
      {/* 「设成」不是「加减」：点两次和点一次结果一样，这一点要说在前面，
          否则运营会按「再加一点」的心智连点几下，而每一下都把分数覆盖成同一个值。 */}
      <Alert
        type="warning"
        showIcon
        style={{ marginBottom: 16 }}
        message={t("galaxy.reputation.adjustHint").replace("{current}", (target?.effective ?? 0).toFixed(2))}
      />
      <Form form={form} layout="vertical">
        <Form.Item
          name="value"
          label={t("galaxy.reputation.newScore")}
          extra={t("galaxy.reputation.newScoreHint")}
          rules={[{ required: true }]}
        >
          <InputNumber min={0} max={1} step={0.1} style={{ width: "100%" }} />
        </Form.Item>
        <Form.Item name="reason" label={t("galaxy.reputation.reason")} rules={[{ required: true }]}>
          <Input.TextArea rows={3} maxLength={200} showCount placeholder={t("galaxy.reputation.reasonPlaceholder")} />
        </Form.Item>
      </Form>
    </Modal>
  );
}
