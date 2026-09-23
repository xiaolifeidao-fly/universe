"use client";

import { ReloadOutlined, StopOutlined } from "@ant-design/icons";
import { Alert, Button, Empty, Form, Input, Modal, Segmented, Space, Table, Tag, Typography, message } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useCallback, useEffect, useState } from "react";
import { useLocale } from "@/i18n/LocaleProvider";
import { useCanWrite } from "@/components/permission/WritePermission";
import { banMachine, fetchBannedMachines, type BannedMachineView } from "../api/galaxy.api";

/**
 * 封禁名单。
 *
 * 封禁记在**设备指纹**上，而「节点与贡献」那页的解封是按 node_id 找机器的：
 * 机器一旦从节点表里消失 —— 撤销、重装、换了 node_id —— 那个指纹就再也没有入口
 * 碰得到。封禁于是变成永久的，而且在管理端任何一页上都看不见：那台机器的主人
 * 反复重装、反复连不上，而运营这边查不出任何原因。
 *
 * 这张名单是那些指纹唯一的去处：列得出来，也解得开。
 */
export function BanList() {
  const { t } = useLocale();
  // 解封会让一台被判定伪造响应的机器重新进池子，只读角色看不到入口。
  const canWrite = useCanWrite();
  const [scope, setScope] = useState<"banned" | "all">("banned");
  const [rows, setRows] = useState<BannedMachineView[]>([]);
  const [loading, setLoading] = useState(true);
  const [target, setTarget] = useState<BannedMachineView | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setRows(await fetchBannedMachines(scope === "banned"));
    } catch (error) {
      message.error((error as Error).message || t("galaxy.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [scope, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const columns: ColumnsType<BannedMachineView> = [
    {
      title: t("galaxy.ban.machine"),
      dataIndex: "fingerprint",
      width: 300,
      render: (fingerprint: string, row) => {
        const first = row.nodes?.[0];
        return (
          <Space direction="vertical" size={0}>
            {/* 名字优先：指纹哈希认不出是谁的机器，而运营要认出来才敢解封。 */}
            <span style={{ fontWeight: 600 }}>{first?.displayName || first?.nodeId || t("galaxy.ban.goneMachine")}</span>
            <Typography.Text type="secondary" className="manager-mono" style={{ fontSize: 12 }} copyable={{ text: fingerprint }}>
              {fingerprint.slice(0, 16)}…
            </Typography.Text>
          </Space>
        );
      },
    },
    {
      title: t("galaxy.ban.owner"),
      key: "owner",
      width: 200,
      render: (_, row) => {
        const first = row.nodes?.[0];
        if (!first) {
          // 节点记录没了，这一行就只剩指纹 —— 正是这张名单存在的理由。
          return <Typography.Text type="secondary">{t("galaxy.ban.goneOwner")}</Typography.Text>;
        }
        return (
          <Space direction="vertical" size={0}>
            <span>{first.ownerName || first.ownerUserId || "-"}</span>
            {row.nodes.length > 1 ? (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {t("galaxy.ban.nodeCount").replace("{count}", String(row.nodes.length))}
              </Typography.Text>
            ) : null}
          </Space>
        );
      },
    },
    {
      title: t("galaxy.ban.status"),
      dataIndex: "banned",
      width: 100,
      render: (banned: boolean) => (
        <Tag color={banned ? "error" : "default"}>{t(banned ? "galaxy.ban.banned" : "galaxy.ban.lifted")}</Tag>
      ),
    },
    { title: t("galaxy.ban.reason"), dataIndex: "reason", render: (value: string) => value || "-" },
    {
      title: t("galaxy.ban.updatedAt"),
      dataIndex: "updatedTime",
      width: 170,
      render: (value: string, row) => (
        <Space direction="vertical" size={0}>
          <span>{value ? new Date(value).toLocaleString() : "-"}</span>
          {row.updatedBy ? (
            <Typography.Text type="secondary" className="manager-mono" style={{ fontSize: 12 }}>
              {row.updatedBy}
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
          <Button type="link" size="small" danger={!row.banned} onClick={() => setTarget(row)}>
            {t(row.banned ? "galaxy.ban.lift" : "galaxy.ban.reban")}
          </Button>
        ) : null,
    },
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <Alert type="info" showIcon icon={<StopOutlined />} message={t("galaxy.ban.hint")} />

      <Space wrap>
        <Segmented
          value={scope}
          onChange={(value) => setScope(value as "banned" | "all")}
          options={[
            { value: "banned", label: t("galaxy.ban.onlyBanned") },
            { value: "all", label: t("galaxy.ban.all") },
          ]}
        />
        <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void load()}>
          {t("galaxy.refresh")}
        </Button>
      </Space>

      <Table<BannedMachineView>
        rowKey="fingerprint"
        size="small"
        loading={loading}
        columns={columns}
        dataSource={rows}
        pagination={{ pageSize: 20, showSizeChanger: false }}
        scroll={{ x: 1100 }}
        expandable={{
          rowExpandable: (row) => row.nodes.length > 0,
          expandedRowRender: (row) => (
            <Space direction="vertical" size={2} style={{ width: "100%" }}>
              {row.nodes.map((node) => (
                <Typography.Text key={node.nodeId} type="secondary" style={{ fontSize: 12 }}>
                  <span className="manager-mono">{node.nodeId}</span>
                  {node.displayName ? ` · ${node.displayName}` : ""}
                  {node.status ? ` · ${node.status}` : ""}
                  {node.ownerName || node.ownerUserId ? ` · ${node.ownerName || node.ownerUserId}` : ""}
                </Typography.Text>
              ))}
            </Space>
          ),
        }}
        locale={{ emptyText: <Empty description={t("galaxy.ban.empty")} /> }}
      />

      <BanModal machine={target} onClose={() => setTarget(null)} onSaved={load} />
    </div>
  );
}

function BanModal({
  machine,
  onClose,
  onSaved,
}: {
  machine: BannedMachineView | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useLocale();
  const [form] = Form.useForm<{ reason: string }>();
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (machine) form.setFieldsValue({ reason: "" });
  }, [machine, form]);

  // 名单上还封着的，这一次就是解封；已经解过的，这一次是重新封上。
  const lifting = machine?.banned === true;

  const submit = async () => {
    if (!machine) return;
    const values = await form.validateFields();
    setSubmitting(true);
    try {
      await banMachine(machine.fingerprint, !lifting, values.reason?.trim() ?? "");
      message.success(t("galaxy.banned"));
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
      open={machine !== null}
      title={t(lifting ? "galaxy.ban.liftTitle" : "galaxy.ban.rebanTitle")}
      okText={t("galaxy.confirm")}
      okButtonProps={{ danger: !lifting }}
      cancelText={t("galaxy.cancel")}
      confirmLoading={submitting}
      onOk={() => void submit()}
      onCancel={onClose}
      destroyOnClose
    >
      <Alert
        type={lifting ? "warning" : "error"}
        showIcon
        style={{ marginBottom: 16 }}
        message={t(lifting ? "galaxy.ban.liftHint" : "galaxy.ban.rebanHint")}
      />
      <Form form={form} layout="vertical">
        {/* 封禁和解封都覆盖同一行的 reason，下一个来查的人只看得到最近这一次写的。 */}
        <Form.Item name="reason" label={t("galaxy.ban.reason")} rules={[{ required: true }]}>
          <Input.TextArea rows={3} maxLength={255} showCount placeholder={t("galaxy.ban.reasonPlaceholder")} />
        </Form.Item>
      </Form>
    </Modal>
  );
}
