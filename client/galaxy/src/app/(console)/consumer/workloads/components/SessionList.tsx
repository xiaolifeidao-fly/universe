"use client";

import { Alert, Button, Drawer, Empty, Popconfirm, Space, Table, Tag, Timeline, Typography, message } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useCallback, useEffect, useState } from "react";
import { useLocale } from "@/i18n/LocaleProvider";
import { formatTime, formatUnitValue, unitLabel } from "@/utils/format";
import {
  closeSession,
  fetchSessionContext,
  fetchSessions,
  type SessionContextView,
  type SessionView,
} from "../../api/consumer.api";

const STATE_COLOR: Record<string, string> = {
  open: "processing",
  pinned: "success",
  migrating: "warning",
  closed: "default",
};

type Props = { keyId: string; refreshToken: number; onChanged: () => void };

export function SessionList({ keyId, refreshToken, onChanged }: Props) {
  const { t } = useLocale();
  const [rows, setRows] = useState<SessionView[]>([]);
  const [loading, setLoading] = useState(true);
  const [detail, setDetail] = useState<SessionContextView | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setRows(await fetchSessions({ keyId: keyId || undefined, limit: 100 }));
    } catch (error) {
      message.error((error as Error).message || t("common.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [keyId, t]);

  useEffect(() => {
    void load();
  }, [load, refreshToken]);

  const openDetail = async (sid: string) => {
    setDetailLoading(true);
    try {
      setDetail(await fetchSessionContext(sid));
    } catch (error) {
      message.error((error as Error).message || t("common.loadFailed"));
    } finally {
      setDetailLoading(false);
    }
  };

  const close = async (sid: string) => {
    try {
      await closeSession(sid, "closed_by_console");
      message.success(t("workloads.session.closed"));
      onChanged();
    } catch (error) {
      message.error((error as Error).message || t("common.actionFailed"));
    }
  };

  const columns: ColumnsType<SessionView> = [
    {
      title: t("workloads.session.sid"),
      dataIndex: "sid",
      width: 220,
      render: (sid: string) => <span className="manager-mono">{sid}</span>,
    },
    { title: t("workloads.kind"), dataIndex: "kind", width: 150 },
    {
      title: t("workloads.session.state"),
      dataIndex: "state",
      width: 150,
      render: (state: string, row) => (
        <Space size={4}>
          <Tag color={STATE_COLOR[state] ?? "default"}>{state}</Tag>
          {/* 迁移过意味着上下文是从账本重建的，不是原样接着跑的 —— 排查「它怎么忘了刚才那句」时这是第一条线索。 */}
          {row.migrated ? <Tag color="warning">{t("workloads.session.migrated")}</Tag> : null}
        </Space>
      ),
    },
    { title: t("workloads.session.turns"), dataIndex: "lastSeq", width: 90 },
    {
      title: t("workloads.session.lastTurnAt"),
      dataIndex: "lastTurnAt",
      width: 180,
      render: (value?: string) => formatTime(value),
    },
    {
      title: t("common.actions"),
      key: "actions",
      width: 170,
      render: (_, row) => (
        <Space size={4}>
          <Button type="link" size="small" onClick={() => void openDetail(row.sid)}>
            {t("workloads.session.context")}
          </Button>
          {row.state === "closed" ? null : (
            <Popconfirm title={t("workloads.session.closeConfirm")} onConfirm={() => void close(row.sid)}>
              <Button type="link" size="small" danger>
                {t("workloads.session.close")}
              </Button>
            </Popconfirm>
          )}
        </Space>
      ),
    },
  ];

  return (
    <>
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message={t("workloads.session.hint")}
      />
      <Table
        rowKey="sid"
        size="small"
        loading={loading}
        dataSource={rows}
        columns={columns}
        pagination={{ pageSize: 20, hideOnSinglePage: true }}
        locale={{ emptyText: <Empty description={t("workloads.session.empty")} /> }}
      />
      <Drawer
        width={640}
        open={detail !== null}
        loading={detailLoading}
        onClose={() => setDetail(null)}
        title={t("workloads.session.context")}
      >
        {detail ? <SessionContextBody detail={detail} /> : null}
      </Drawer>
    </>
  );
}

/**
 * 上下文账本。节点已经不在了这份东西仍然完整 —— 它是平台侧记的，不是从节点上拉的。
 * 所以这里刻意不显示节点身份：消费者与提供者互不可见。
 */
function SessionContextBody({ detail }: { detail: SessionContextView }) {
  const { t } = useLocale();
  if (detail.turns.length === 0) {
    return <Empty description={t("workloads.session.noTurns")} />;
  }
  return (
    <Timeline
      items={detail.turns.map((turn) => ({
        color: turn.state === "completed" ? "green" : turn.state === "failed" ? "red" : "blue",
        children: (
          <Space direction="vertical" size={2} style={{ width: "100%" }}>
            <Space size={8}>
              <Typography.Text strong>#{turn.seq}</Typography.Text>
              <Tag>{turn.state}</Tag>
              <Typography.Text type="secondary">{formatTime(turn.startedAt)}</Typography.Text>
              {turn.workspaceLost ? <Tag color="warning">{t("workloads.session.workspaceLost")}</Tag> : null}
            </Space>
            {turn.outputSummary ? <Typography.Text>{turn.outputSummary}</Typography.Text> : null}
            {turn.changedFiles.length > 0 ? (
              <Typography.Text type="secondary" className="manager-mono" style={{ fontSize: 12 }}>
                {turn.changedFiles.join(", ")}
              </Typography.Text>
            ) : null}
            <Space size={[8, 2]} wrap>
              {Object.entries(turn.usage ?? {})
                .filter(([, value]) => value > 0)
                .map(([unit, value]) => (
                  <Tag key={unit}>{`${unitLabel(unit)} ${formatUnitValue(unit, value)}`}</Tag>
                ))}
            </Space>
          </Space>
        ),
      }))}
    />
  );
}
