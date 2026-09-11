"use client";

import { ReloadOutlined, StopOutlined, TeamOutlined } from "@ant-design/icons";
import { Button, Popconfirm, Space, Table, Tabs, Tag, Tooltip, message } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useCallback, useEffect, useState } from "react";
import { useLocale } from "@/i18n/LocaleProvider";
import { useCanWrite } from "@/components/permission/WritePermission";
import {
  banNode,
  fetchAdminNodes,
  fetchAdminUsage,
  fetchPoolStatus,
  fetchProbes,
  setProviderType,
  type AdminNodeView,
  type AuditProbeView,
  type LaneStatus,
  type PoolStatus,
  type ProviderType,
  type UsageLine,
  type UsageReport,
} from "../api/galaxy.api";
import { DisputeQueue } from "./DisputeQueue";
import { PackageCatalog } from "./PackageCatalog";

/**
 * 共享算力池的运营视图：池水位、节点与贡献、抽检、结算汇总、争议工单。
 *
 * 这里是**平台**视角，和 client/galaxy 那个终端用户控制台不是一回事：
 * 那边一个人只看得到自己的机器和自己的密钥，这边看得到全池，还能封禁。
 */
export function GalaxyOperations() {
  const { t } = useLocale();
  const canWrite = useCanWrite();
  const [pool, setPool] = useState<PoolStatus | null>(null);
  const [nodes, setNodes] = useState<AdminNodeView[]>([]);
  const [probes, setProbes] = useState<AuditProbeView[]>([]);
  const [usage, setUsage] = useState<UsageReport | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const to = new Date();
      const from = new Date(to.getTime() - 30 * 24 * 3600 * 1000);
      const [poolResult, nodeResult, probeResult, usageResult] = await Promise.all([
        fetchPoolStatus(),
        fetchAdminNodes(),
        fetchProbes(),
        fetchAdminUsage({ from: from.toISOString(), to: to.toISOString() }),
      ]);
      setPool(poolResult);
      setNodes(nodeResult);
      setProbes(probeResult);
      setUsage(usageResult);
    } catch (error) {
      message.error((error as Error).message || t("galaxy.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const ban = async (nodeId: string, banned: boolean) => {
    try {
      await banNode(nodeId, banned);
      message.success(t("galaxy.banned"));
      void load();
    } catch (error) {
      message.error((error as Error).message || t("galaxy.loadFailed"));
    }
  };

  // 身份挂在账号上：改一行，这个主人名下的每一行都跟着变，所以改完整表重拉。
  const changeProviderType = async (ownerUserId: string, providerType: ProviderType) => {
    try {
      await setProviderType(ownerUserId, providerType);
      message.success(t("galaxy.provider.saved"));
      void load();
    } catch (error) {
      message.error((error as Error).message || t("galaxy.loadFailed"));
    }
  };

  const laneColumns: ColumnsType<LaneStatus> = [
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

  const nodeColumns: ColumnsType<AdminNodeView> = [
    {
      title: t("galaxy.node.node"),
      dataIndex: "nodeId",
      width: 220,
      render: (nodeId: string, row) => (
        <div>
          <div style={{ fontWeight: 600 }}>{row.displayName || nodeId}</div>
          <div style={{ fontSize: 12, color: "var(--manager-text-muted)" }}>{nodeId}</div>
        </div>
      ),
    },
    {
      title: t("galaxy.node.owner"),
      dataIndex: "ownerUserId",
      width: 180,
      render: (ownerUserId: string, row) => (
        <Space size={6} wrap>
          <span>{ownerUserId}</span>
          {row.providerType === "studio" ? (
            <Tag color="geekblue">{t("galaxy.provider.studio")}</Tag>
          ) : (
            <Tag>{t("galaxy.provider.individual")}</Tag>
          )}
        </Space>
      ),
    },
    {
      title: t("galaxy.node.status"),
      dataIndex: "status",
      width: 120,
      render: (status: string, row) =>
        row.banned ? (
          <Tag color="error">{t("galaxy.node.banned")}</Tag>
        ) : status === "active" ? (
          <Tag color="success">{t("galaxy.node.online")}</Tag>
        ) : (
          <Tag>{t("galaxy.node.offline")}</Tag>
        ),
    },
    {
      title: t("galaxy.node.contributions"),
      dataIndex: "contributions",
      // ?? [] 是护栏：服务端已经保证列不会是 null，但一台刚配对、还没 hello 的
      // 机器贡献就是空的，这一列崩掉会带走整个运营页。
      render: (value: AdminNodeView["contributions"]) => {
        const contributions = value ?? [];
        return (
        <Space size={6} wrap>
          {contributions.length === 0 ? "-" : null}
          {contributions.map((item) => (
            <Tag key={item.cid} color={item.online ? "processing" : "default"}>
              {item.kind} · {item.seatsUsed}/{item.seatsEffective} · {t("galaxy.node.reputation")}{" "}
              {item.reputation.toFixed(2)}
            </Tag>
          ))}
        </Space>
        );
      },
    },
    {
      title: t("galaxy.actions"),
      key: "actions",
      width: 220,
      render: (_, row) => {
        if (!canWrite) {
          return null;
        }
        const toStudio = row.providerType !== "studio";
        return (
          <Space size={6}>
            <Popconfirm
              title={toStudio ? t("galaxy.provider.toStudio") : t("galaxy.provider.toIndividual")}
              description={
                <div style={{ maxWidth: 300 }}>
                  {toStudio ? t("galaxy.provider.toStudioHint") : t("galaxy.provider.toIndividualHint")}
                </div>
              }
              okText={t("galaxy.confirm")}
              cancelText={t("galaxy.cancel")}
              onConfirm={() => void changeProviderType(row.ownerUserId, toStudio ? "studio" : "individual")}
            >
              <Button size="small" icon={<TeamOutlined />}>
                {toStudio ? t("galaxy.provider.toStudio") : t("galaxy.provider.toIndividual")}
              </Button>
            </Popconfirm>
            <Popconfirm
              title={row.banned ? t("galaxy.node.unban") : t("galaxy.node.ban")}
              description={t("galaxy.node.banHint")}
              okText={t("galaxy.confirm")}
              cancelText={t("galaxy.cancel")}
              onConfirm={() => void ban(row.nodeId, !row.banned)}
            >
              <Button size="small" danger={!row.banned} icon={<StopOutlined />}>
                {row.banned ? t("galaxy.node.unban") : t("galaxy.node.ban")}
              </Button>
            </Popconfirm>
          </Space>
        );
      },
    },
  ];

  const probeColumns: ColumnsType<AuditProbeView> = [
    { title: t("galaxy.probe.cid"), dataIndex: "cid", width: 220 },
    { title: t("galaxy.probe.model"), dataIndex: "model", width: 180, render: (value: string) => value || "-" },
    {
      title: t("galaxy.probe.similarity"),
      dataIndex: "similarity",
      width: 130,
      render: (value: number, row) => (row.verdict === "pending" || row.verdict === "ready" ? "-" : value.toFixed(2)),
    },
    {
      title: t("galaxy.probe.verdict"),
      dataIndex: "verdict",
      width: 130,
      render: (verdict: string) => {
        const color =
          verdict === "forged" ? "error" : verdict === "suspect" ? "warning" : verdict === "pass" ? "success" : "default";
        return <Tag color={color}>{verdict}</Tag>;
      },
    },
    { title: t("galaxy.probe.detail"), dataIndex: "detail", render: (value: string) => value || "-" },
  ];

  const usageColumns: ColumnsType<UsageLine> = [
    { title: t("galaxy.usage.kind"), dataIndex: "kind", width: 160 },
    // 上游单独一列：llm.chat 底下 Claude 与 Codex 的量各算各的，合在一起看不出池子里谁在被用。
    {
      title: t("galaxy.usage.provider"),
      dataIndex: "provider",
      width: 170,
      render: (provider: string) => provider || "-",
    },
    { title: t("galaxy.usage.unit"), dataIndex: "unit", width: 220 },
    { title: t("galaxy.usage.amount"), dataIndex: "amount", align: "right", width: 140 },
    { title: t("galaxy.usage.calls"), dataIndex: "calls", align: "right", width: 120 },
    {
      title: t("galaxy.usage.cost"),
      dataIndex: "cost",
      align: "right",
      width: 140,
      render: (cost: number) => (cost > 0 ? `¥${(cost / 1_000_000).toFixed(2)}` : "-"),
    },
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void load()}>
          {t("galaxy.refresh")}
        </Button>
      </div>

      <Tabs
        items={[
          {
            key: "pool",
            label: t("galaxy.tab.pool"),
            children: (
              <Table<LaneStatus>
                rowKey={(row) => `${row.kind}:${row.provider}`}
                size="small"
                loading={loading}
                columns={laneColumns}
                dataSource={pool?.lanes ?? []}
                pagination={false}
                scroll={{ x: 900 }}
              />
            ),
          },
          {
            key: "nodes",
            label: t("galaxy.tab.nodes"),
            children: (
              <Table<AdminNodeView>
                rowKey="nodeId"
                size="small"
                loading={loading}
                columns={nodeColumns}
                dataSource={nodes}
                pagination={{ pageSize: 20, showSizeChanger: false }}
                scroll={{ x: 1100 }}
              />
            ),
          },
          {
            key: "probes",
            label: t("galaxy.tab.probes"),
            children: (
              <Table<AuditProbeView>
                rowKey="probeId"
                size="small"
                loading={loading}
                columns={probeColumns}
                dataSource={probes}
                pagination={{ pageSize: 20, showSizeChanger: false }}
                scroll={{ x: 900 }}
              />
            ),
          },
          {
            key: "disputes",
            label: t("galaxy.tab.disputes"),
            // 工单队列自己拉数据、自己按状态过滤：它的刷新节奏和上面那几块不一样，
            // 挂进统一的 load() 反而会在每次刷新时把运营正在筛的状态重置掉。
            children: <DisputeQueue />,
          },
          {
            key: "packages",
            label: t("galaxy.tab.packages"),
            // 目录自己拉数据、自己刷新：它是**写**面板，节奏和上面几块只读视图不一样，
            // 挂进统一的 load() 会在每次刷新时把运营正在编辑的那一行冲掉。
            children: <PackageCatalog />,
          },
          {
            key: "settlement",
            label: t("galaxy.tab.settlement"),
            children: (
              <>
                <div style={{ marginBottom: 12, color: "var(--manager-text-muted)" }}>
                  {t("galaxy.usage.total")}: ¥{((usage?.totalFee ?? 0) / 1_000_000).toFixed(2)}
                </div>
                <Table<UsageLine>
                  rowKey={(row) => `${row.kind}:${row.provider}:${row.unit}`}
                  size="small"
                  loading={loading}
                  columns={usageColumns}
                  dataSource={usage?.lines ?? []}
                  pagination={false}
                  scroll={{ x: 970 }}
                />
              </>
            ),
          },
        ]}
      />
    </div>
  );
}
