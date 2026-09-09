"use client";

import { ReloadOutlined } from "@ant-design/icons";
import { Alert, Button, Empty, Segmented, Space, Spin, Switch, Tag, Tooltip, message } from "antd";
import { useCallback, useEffect, useMemo, useState } from "react";
import { QuotaBars } from "@/components/galaxy/QuotaBars";
import { useLocale } from "@/i18n/LocaleProvider";
import {
  fetchNodes,
  setContributionStatus,
  visibleContributions,
  type ContributionView,
} from "../../api/provider.api";
import { BRIDGE_PORT, pingBridge, startUpstreamLogin } from "../../api/bridge.api";
import { GrantForm } from "./GrantForm";

/**
 * 贡献授权 —— 提供者的**唯一**配置入口。
 *
 * 开关、额度、座位、模型范围、挂机时段都在这里改，改完下一次心跳（≤15s）
 * 那台机器就换过来了。主人不需要回到那台机器上做任何事。
 *
 * 仍然不能在这里**凭空造**一条贡献：能力是节点探测出来上报的，
 * 「这台机器上有没有 Claude」只有那台机器知道。控制台管的是「要不要、给多少」。
 *
 * 两个状态要分开看，处置方式完全不同：
 *   status=disabled  你自己关掉了      → 打开就行
 *   available=false  本机干不了这件事  → 得去那台机器上修（多半是登录态过期）
 */
export function ContributionGrants() {
  const { t } = useLocale();
  const [contributions, setContributions] = useState<ContributionView[]>([]);
  const [selected, setSelected] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [toggling, setToggling] = useState(false);
  // 本机 bridge 的 nodeId。「去授权」只对**这台机器**的贡献有意义 ——
  // 贡献可能属于别的机器，浏览器够不到那台的 bridge。
  const [localNodeId, setLocalNodeId] = useState("");
  const [authing, setAuthing] = useState(false);

  const load = useCallback(async () => {
    try {
      const nodes = await fetchNodes();
      const flattened = nodes.flatMap((node) => visibleContributions(node.contributions));
      setContributions(flattened);
      setSelected((current) => (flattened.some((item) => item.cid === current) ? current : (flattened[0]?.cid ?? "")));
    } catch (error) {
      message.error((error as Error).message || t("common.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    void pingBridge().then((ping) => setLocalNodeId(ping?.nodeId ?? ""));
  }, []);

  /**
   * 让本机拉起上游的登录流程。凭据修好之后不用重启 bridge，
   * 下一次心跳（≤15 秒）这条贡献就会从「不可用」变回可用。
   */
  const authorize = async (contribution: ContributionView) => {
    setAuthing(true);
    try {
      const result = await startUpstreamLogin({ port: BRIDGE_PORT, resident: true }, contribution.cid);
      if (result.alreadyAuthorized) {
        message.info(t("provider.contribution.authAlready"));
      } else if (result.launched) {
        message.success(t("provider.contribution.authLaunched"));
      } else {
        // 拉不起终端（非 macOS）就把命令给出来，这条路在所有平台都通。
        message.warning(t("provider.contribution.authManual").replace("{command}", result.command));
      }
    } catch (error) {
      message.error((error as Error).message || t("common.actionFailed"));
    } finally {
      setAuthing(false);
    }
  };

  const toggle = async (contribution: ContributionView, on: boolean) => {
    setToggling(true);
    try {
      await setContributionStatus(contribution.nodeId, contribution.cid, on ? "active" : "disabled");
      message.success(t(on ? "provider.contribution.opened" : "provider.contribution.closed"));
      void load();
    } catch (error) {
      // 「还有人绑在上面」是服务端拒的，原文比任何前端兜底话术都准。
      message.error((error as Error).message || t("common.actionFailed"));
    } finally {
      setToggling(false);
    }
  };

  const current = useMemo(
    () => contributions.find((item) => item.cid === selected) ?? null,
    [contributions, selected],
  );

  if (loading) {
    return (
      <div style={{ padding: 60, display: "grid", placeItems: "center" }}>
        <Spin />
      </div>
    );
  }

  if (contributions.length === 0) {
    return (
      <section className="galaxy-card">
        <Empty description={t("provider.nodes.empty")} />
      </section>
    );
  }

  return (
    <div className="galaxy-page">
      <section className="galaxy-card">
        <div className="galaxy-card__head">
          <div style={{ flex: 1, minWidth: 0 }}>
            <p style={{ margin: 0 }}>{t("provider.limits.hint")}</p>
          </div>
          <Button icon={<ReloadOutlined />} onClick={() => void load()}>
            {t("common.refresh")}
          </Button>
        </div>

        <Segmented
          value={selected}
          onChange={(value) => setSelected(String(value))}
          options={contributions.map((item) => ({
            value: item.cid,
            label: (
              <span style={{ opacity: item.status === "disabled" ? 0.55 : 1 }}>
                {item.cid}
                {item.status === "disabled" ? ` · ${t("provider.contribution.off")}` : ""}
                {!item.available ? " ⚠" : ""}
              </span>
            ),
          }))}
          style={{ marginBottom: 16, maxWidth: "100%", overflowX: "auto" }}
        />

        {current ? (
          <>
            <Space wrap style={{ marginBottom: 14 }}>
              {/* 有人绑在上面时开关是锁住的：会话中途换机器会丢上下文。
                  额度和时段不锁 —— 那才是「我现在就想少给一点」的正确出口。 */}
              <Tooltip title={current.seatsBound > 0 ? t("provider.contribution.lockedHint") : ""}>
                <span>
                  <Switch
                    checked={current.status !== "disabled"}
                    disabled={toggling || (current.status !== "disabled" && current.seatsBound > 0)}
                    loading={toggling}
                    onChange={(next) => void toggle(current, next)}
                    checkedChildren={t("provider.contribution.on")}
                    unCheckedChildren={t("provider.contribution.off")}
                  />
                </span>
              </Tooltip>
              {current.seatsBound > 0 ? (
                <Tag color="processing">
                  {t("provider.contribution.bound").replace("{n}", String(current.seatsBound))}
                </Tag>
              ) : null}
              {!current.available ? <Tag color="warning">{t("provider.contribution.unavailable")}</Tag> : null}
            </Space>

            {!current.available ? (
              // 原因是节点报上来的人话，原样显示 —— 它通常直接告诉主人该敲哪条命令。
              // 而如果这条贡献就在**你正坐着的这台**机器上，那条命令可以由我们代劳。
              <Alert
                type="warning"
                showIcon
                message={current.unavailableReason || t("provider.contribution.unavailable")}
                style={{ marginBottom: 16 }}
                action={
                  current.kind === "llm.chat" && localNodeId && localNodeId === current.nodeId ? (
                    <Button size="small" type="primary" loading={authing} onClick={() => void authorize(current)}>
                      {t("provider.contribution.authorize")}
                    </Button>
                  ) : null
                }
              />
            ) : null}

            <Alert type="info" showIcon message={t("provider.quota.hint")} style={{ marginBottom: 16 }} />
            <div style={{ marginBottom: 18 }}>
              <QuotaBars quota={current.quota} />
            </div>
            <GrantForm contribution={current} onSaved={() => void load()} />
          </>
        ) : null}
      </section>
    </div>
  );
}
