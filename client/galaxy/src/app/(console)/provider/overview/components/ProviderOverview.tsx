"use client";

import { DisconnectOutlined, ReloadOutlined } from "@ant-design/icons";
import { Button, Empty, Popconfirm, Space, Spin, Tag, message } from "antd";
import { useCallback, useEffect, useState } from "react";
import { useLocale } from "@/i18n/LocaleProvider";
import { formatRelative } from "@/utils/format";
import {
  fetchNodes,
  fetchTerms,
  isNodeOnline,
  revokeNode,
  visibleContributions,
  type NodeView,
  type TermsStatus,
} from "../../api/provider.api";
import { pingBridge } from "../../api/bridge.api";
import { ContributionCard } from "./ContributionCard";
import { ToolVersions } from "./ToolVersions";
import { JoinPoolCard } from "./JoinPoolCard";

/**
 * 提供者总览：加入共享池 + 我的机器与贡献。
 *
 * 页面自己轮询，不做 WebSocket：贡献的在线/额度状态由心跳每 15 秒推一次，
 * 前端 20 秒拉一次已经比数据本身更新得还勤了，没必要为此多开一条长连接。
 */
export function ProviderOverview() {
  const { t } = useLocale();
  const [terms, setTerms] = useState<TermsStatus | null>(null);
  const [nodes, setNodes] = useState<NodeView[]>([]);
  const [loading, setLoading] = useState(true);
  // 本机 bridge 的 nodeId。工具版本只能问本机拿，所以只在这台机器的卡片上显示。
  const [localNodeId, setLocalNodeId] = useState("");

  const load = useCallback(async () => {
    try {
      const [termsResult, nodesResult] = await Promise.all([fetchTerms(), fetchNodes()]);
      setTerms(termsResult);
      setNodes(nodesResult);
    } catch (error) {
      message.error((error as Error).message || t("common.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 20_000);
    return () => clearInterval(timer);
  }, [load]);

  useEffect(() => {
    void pingBridge().then((ping) => setLocalNodeId(ping?.nodeId ?? ""));
  }, []);

  const revoke = async (nodeId: string) => {
    try {
      await revokeNode(nodeId);
      message.success(t("provider.node.revoked"));
      void load();
    } catch (error) {
      message.error((error as Error).message || t("common.loadFailed"));
    }
  };

  return (
    <div className="galaxy-page">
      <JoinPoolCard
        terms={terms}
        joined={nodes.length > 0}
        online={nodes.find(isNodeOnline) ?? null}
        onAccepted={() => void load()}
        onPaired={() => void load()}
      />

      <section className="galaxy-card">
        <div className="galaxy-card__head">
          <div style={{ flex: 1, minWidth: 0 }}>
            <p style={{ margin: 0 }}>{t("provider.quota.hint")}</p>
          </div>
          <Button icon={<ReloadOutlined />} onClick={() => void load()}>
            {t("common.refresh")}
          </Button>
        </div>

        {loading ? (
          <div style={{ padding: 40, display: "grid", placeItems: "center" }}>
            <Spin />
          </div>
        ) : nodes.length === 0 ? (
          <Empty description={t("provider.nodes.empty")} />
        ) : (
          <Space direction="vertical" size={20} style={{ width: "100%" }}>
            {nodes.map((node) => (
              <div key={node.nodeId}>
                <div className="galaxy-meta" style={{ marginBottom: 10, alignItems: "center" }}>
                  <b style={{ fontSize: "var(--manager-fs-base)" }}>{node.displayName || node.nodeId}</b>
                  {node.banned ? (
                    <Tag color="error">{t("provider.node.banned")}</Tag>
                  ) : isNodeOnline(node) ? (
                    <Tag color="success">{t("provider.node.online")}</Tag>
                  ) : (
                    <Tag>{t("provider.node.offline")}</Tag>
                  )}
                  <span>ai-bridge {node.bridgeVersion || "-"}</span>
                  <span>
                    {t("provider.node.lastBeat")} <b>{formatRelative(node.lastBeatAt)}</b>
                  </span>
                  <span style={{ flex: 1 }} />
                  <Popconfirm
                    title={t("provider.node.revoke")}
                    description={t("provider.node.revokeConfirm")}
                    okText={t("common.confirm")}
                    cancelText={t("common.cancel")}
                    onConfirm={() => void revoke(node.nodeId)}
                  >
                    <Button size="small" danger icon={<DisconnectOutlined />}>
                      {t("provider.node.revoke")}
                    </Button>
                  </Popconfirm>
                </div>
                {/* 工具版本只对本机有意义：版本是问本机 bridge 拿的，
                    浏览器够不到别的机器上的 bridge。 */}
                {localNodeId && localNodeId === node.nodeId ? <ToolVersions /> : null}
                <div className="galaxy-grid">
                  {/* visibleContributions 顺便兜住 null：服务端已经保证列不会是 null
                      （见 orEmpty 与 TestListFieldsNeverSerializeToNull），但整页白屏
                      的代价太大，不值得只靠一端的约定。 */}
                  {visibleContributions(node.contributions).map((contribution) => (
                    <ContributionCard key={contribution.cid} contribution={contribution} onChanged={() => void load()} />
                  ))}
                </div>
              </div>
            ))}
          </Space>
        )}
      </section>
    </div>
  );
}
