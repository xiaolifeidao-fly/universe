"use client";

import { ReloadOutlined } from "@ant-design/icons";
import { Button, Space, Table, Tag, Tooltip, message } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useCallback, useEffect, useState } from "react";
import { useLocale } from "@/i18n/LocaleProvider";
import { fetchPoolStatus, type LaneStatus, type PoolStatus } from "../api/galaxy.api";

/**
 * 池水位：每条泳道的在线贡献、座位、在途请求与排队压力。
 *
 * 自己拉自己的数据。和节点、抽检、结算拆成四个页面之后，进来一次只拉这一张表 ——
 * 原来那个统一 load() 每刷一次水位都顺带把另外三份也拉一遍。
 */
export function PoolLanes() {
  const { t } = useLocale();
  const [pool, setPool] = useState<PoolStatus | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setPool(await fetchPoolStatus());
    } catch (error) {
      message.error((error as Error).message || t("galaxy.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const columns: ColumnsType<LaneStatus> = [
    { title: t("galaxy.lane.kind"), dataIndex: "kind", width: 160 },
    { title: t("galaxy.lane.provider"), dataIndex: "provider", width: 160 },
    {
      title: t("galaxy.lane.contributions"),
      dataIndex: "contributions",
      width: 130,
      render: (total: number, row) => (
        <span>
          {row.online} / {total}
        </span>
      ),
    },
    {
      // 有效座位 vs 配置座位：前者是余量与窗口剩余时间算出来的，
      // 两者差得远说明池子快烧干了，是供需缺口最早的信号。
      title: t("galaxy.lane.seats"),
      dataIndex: "seatsEffective",
      width: 160,
      render: (effective: number, row) => (
        <Tooltip title={t("galaxy.lane.seatsHint")}>
          <span>
            {row.seatsUsed} / {effective} <span style={{ color: "var(--manager-text-muted)" }}>({row.seatsTotal})</span>
          </span>
        </Tooltip>
      ),
    },
    { title: t("galaxy.lane.inflight"), dataIndex: "inflight", width: 100 },
    {
      title: t("galaxy.lane.pressure"),
      dataIndex: "waitQueueDepth",
      width: 200,
      render: (waiting: number, row) => (
        <Space size={6} wrap>
          {waiting > 0 ? <Tag color="error">{t("galaxy.lane.waiting")} {waiting}</Tag> : null}
          {row.draining > 0 ? <Tag color="warning">{t("galaxy.lane.draining")} {row.draining}</Tag> : null}
          {row.throttled > 0 ? <Tag color="warning">{t("galaxy.lane.throttled")} {row.throttled}</Tag> : null}
          {waiting === 0 && row.draining === 0 && row.throttled === 0 ? <Tag color="success">OK</Tag> : null}
        </Space>
      ),
    },
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <Space>
        <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void load()}>
          {t("galaxy.refresh")}
        </Button>
      </Space>

      <Table<LaneStatus>
        rowKey={(row) => `${row.kind}:${row.provider}`}
        size="small"
        loading={loading}
        columns={columns}
        dataSource={pool?.lanes ?? []}
        pagination={false}
        scroll={{ x: 900 }}
      />
    </div>
  );
}
