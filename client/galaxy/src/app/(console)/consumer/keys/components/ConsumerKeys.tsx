"use client";

import { CheckCircleFilled, ReloadOutlined, StopOutlined, SyncOutlined } from "@ant-design/icons";
import { Alert, Button, Empty, Popconfirm, Space, Spin, Table, Tag, Tooltip, message } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useCallback, useEffect, useState } from "react";
import { useLocale } from "@/i18n/LocaleProvider";
import { formatTime, formatUnitValue, unitLabel } from "@/utils/format";
import {
  acceptNotice,
  fetchKeys,
  fetchNotice,
  renewKey,
  revokeKey,
  type ConsumerKeyView,
  type IssuedKeyView,
  type NoticeStatus,
} from "../../api/consumer.api";
import { SecretOnceModal } from "./SecretOnceModal";

const STATUS_TAGS: Record<string, { color: string; key: string }> = {
  active: { color: "success", key: "consumer.keys.status.active" },
  expired: { color: "warning", key: "consumer.keys.status.expired" },
  frozen: { color: "default", key: "consumer.keys.status.frozen" },
  revoked: { color: "error", key: "consumer.keys.status.revoked" },
};

export function ConsumerKeys() {
  const { t } = useLocale();
  const [keys, setKeys] = useState<ConsumerKeyView[]>([]);
  const [notice, setNotice] = useState<NoticeStatus | null>(null);
  const [issued, setIssued] = useState<IssuedKeyView | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const [list, noticeResult] = await Promise.all([fetchKeys(), fetchNotice()]);
      setKeys(list);
      setNotice(noticeResult);
    } catch (error) {
      message.error((error as Error).message || t("common.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const accept = async () => {
    try {
      await acceptNotice();
      void load();
    } catch (error) {
      message.error((error as Error).message || t("common.loadFailed"));
    }
  };

  const renew = async (keyId: string) => {
    try {
      // 换发返回的新明文只在这一次响应里出现，所以立刻弹出来让用户存走。
      setIssued(await renewKey(keyId));
      message.success(t("consumer.keys.renewed"));
      void load();
    } catch (error) {
      message.error((error as Error).message || t("common.loadFailed"));
    }
  };

  const revoke = async (keyId: string) => {
    try {
      await revokeKey(keyId);
      message.success(t("consumer.keys.revoked"));
      void load();
    } catch (error) {
      message.error((error as Error).message || t("common.loadFailed"));
    }
  };

  const columns: ColumnsType<ConsumerKeyView> = [
    {
      title: t("consumer.keys.alias"),
      dataIndex: "alias",
      width: 200,
      render: (alias: string, row) => (
        <div>
          <div style={{ fontWeight: 600 }}>{alias || row.keyId}</div>
          {/* keyId 是匿名标识，节点看到的就是它；明文早就查不到了 */}
          <div style={{ fontSize: "var(--manager-fs-sm)", color: "var(--manager-text-muted)" }}>{row.keyId}</div>
        </div>
      ),
    },
    {
      title: t("common.status"),
      dataIndex: "status",
      width: 110,
      render: (status: string) => {
        const tag = STATUS_TAGS[status] ?? { color: "default", key: "common.empty" };
        return <Tag color={tag.color}>{t(tag.key)}</Tag>;
      },
    },
    {
      title: t("consumer.keys.balance"),
      dataIndex: "balance",
      render: (balance: Record<string, number>) => {
        const entries = Object.entries(balance ?? {}).filter(([, value]) => value !== 0);
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
      title: t("consumer.keys.expiresAt"),
      dataIndex: "expiresAt",
      width: 190,
      render: (value: string) => formatTime(value),
    },
    {
      title: t("consumer.keys.scope"),
      dataIndex: "allowedKinds",
      width: 200,
      render: (kinds: string[], row) => {
        const parts = [...(kinds ?? []), ...(row.modelTier ?? [])];
        return parts.length > 0 ? parts.join(", ") : t("consumer.keys.scopeAll");
      },
    },
    {
      title: t("common.actions"),
      key: "actions",
      width: 190,
      render: (_, row) => (
        <Space>
          <Tooltip title={t("consumer.keys.renewHint")}>
            <Button size="small" icon={<SyncOutlined />} onClick={() => void renew(row.keyId)}>
              {t("consumer.keys.renew")}
            </Button>
          </Tooltip>
          {row.status !== "revoked" ? (
            <Popconfirm
              title={t("consumer.keys.revoke")}
              description={t("consumer.keys.revokeConfirm")}
              okText={t("common.confirm")}
              cancelText={t("common.cancel")}
              onConfirm={() => void revoke(row.keyId)}
            >
              <Button size="small" danger icon={<StopOutlined />} />
            </Popconfirm>
          ) : null}
        </Space>
      ),
    },
  ];

  return (
    <div className="galaxy-page">
      <section className="galaxy-card">
        {/* 标题与副标题由外壳的命令条统一显示，这里不重复一遍。 */}
        <div className="galaxy-card__head">
          <div style={{ flex: 1, minWidth: 0 }} />
          <Space>
            {notice?.accepted ? (
              <Tag icon={<CheckCircleFilled />} color="success">
                {t("consumer.keys.noticeAccepted").replace("{version}", notice.version)}
              </Tag>
            ) : null}
            <Button icon={<ReloadOutlined />} onClick={() => void load()}>
              {t("common.refresh")}
            </Button>
          </Space>
        </div>

        {/* 数据告知是签发密钥的硬前置：没确认过就买不了额度，也发不出密钥（C-13）。 */}
        {notice && !notice.accepted ? (
          <Alert
            type="warning"
            showIcon
            message={t("consumer.keys.notice")}
            action={
              <Button size="small" type="primary" onClick={() => void accept()}>
                {t("consumer.keys.noticeAccept")}
              </Button>
            }
            style={{ marginBottom: 14 }}
          />
        ) : null}

        {loading ? (
          <div style={{ padding: 40, display: "grid", placeItems: "center" }}>
            <Spin />
          </div>
        ) : keys.length === 0 ? (
          <Empty description={t("consumer.keys.empty")} />
        ) : (
          <Table<ConsumerKeyView>
            rowKey="keyId"
            size="small"
            columns={columns}
            dataSource={keys}
            pagination={false}
            scroll={{ x: 1000 }}
          />
        )}
      </section>

      <SecretOnceModal issued={issued} onClose={() => setIssued(null)} />
    </div>
  );
}
