"use client";

import { ReloadOutlined, StopOutlined, TeamOutlined } from "@ant-design/icons";
import { Button, Popconfirm, Space, Table, Tag, Typography, message } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useCallback, useEffect, useState } from "react";
import { useLocale } from "@/i18n/LocaleProvider";
import { useCanWrite } from "@/components/permission/WritePermission";
import { UpstreamUsagePanel } from "./UpstreamUsagePanel";
import {
  banNode,
  fetchAdminNodes,
  setProviderType,
  type AdminNodeView,
  type ProviderType,
} from "../api/galaxy.api";

/**
 * 节点与贡献：全池的机器、它们的主人和各自的贡献位。
 *
 * 这里是**平台**视角，和 client/galaxy 那个终端用户控制台不是一回事：
 * 那边一个人只看得到自己的机器，这边看得到全池，还能封禁。
 */
export function NodeRoster() {
  const { t } = useLocale();
  const canWrite = useCanWrite();
  const [nodes, setNodes] = useState<AdminNodeView[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setNodes(await fetchAdminNodes());
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
  // 账号页面同样在挂载时重拉，切过去看到的不会是旧标签。
  const changeProviderType = async (ownerUserId: string, providerType: ProviderType) => {
    try {
      await setProviderType(ownerUserId, providerType);
      message.success(t("galaxy.provider.saved"));
      void load();
    } catch (error) {
      message.error((error as Error).message || t("galaxy.loadFailed"));
    }
  };

  const columns: ColumnsType<AdminNodeView> = [
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
      width: 220,
      // 账号查不到（迁移前的老数据）时 ownerName 是空串，退回显示 id。
      render: (ownerUserId: string, row) => (
        <Space direction="vertical" size={0}>
          <Space size={6} wrap>
            {row.ownerName ? <span>{row.ownerName}</span> : <span className="manager-mono">{ownerUserId}</span>}
            {row.providerType === "studio" ? (
              <Tag color="geekblue">{t("galaxy.provider.studio")}</Tag>
            ) : (
              <Tag>{t("galaxy.provider.individual")}</Tag>
            )}
          </Space>
          {row.ownerName ? (
            <Typography.Text type="secondary" className="manager-mono" style={{ fontSize: 12 }}>
              {ownerUserId}
            </Typography.Text>
          ) : null}
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
      // 机器贡献就是空的，这一列崩掉会带走整个节点页。
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
            {/* 主人账号查不到就改不了身份：服务端只认存在的共享端账号，按钮留着也是点了报错。 */}
            {row.ownerName ? (
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
            ) : null}
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

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <Space>
        <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void load()}>
          {t("galaxy.refresh")}
        </Button>
      </Space>

      <Table<AdminNodeView>
        rowKey="nodeId"
        size="small"
        loading={loading}
        columns={columns}
        dataSource={nodes}
        pagination={{ pageSize: 20, showSizeChanger: false }}
        scroll={{ x: 1100 }}
        expandable={{
          // 上游余量摊在展开层里，不进主表：它一台机器好几条通道、每条好几个桶，
          // 挤进一列只能显示成一串看不懂的数字。
          expandedRowRender: (row) => <UpstreamUsagePanel contributions={row.contributions ?? []} />,
          rowExpandable: (row) => (row.contributions ?? []).length > 0,
        }}
      />
    </div>
  );
}
