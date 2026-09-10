"use client";

/**
 * 账户。
 *
 * 原型上还画了改密码、改头像、设备列表 —— 那三样都要 identity 那边先有接口
 * （改密码是 /auth/*，设备列表要有会话表）。这一版只做已经有真实数据支撑的部分：
 * 资料只读、本机节点、解绑、退出登录、界面语言。
 *
 * 摆一个改了没反应的密码框，比暂时不摆更糟。
 */

import { Modal, message } from "antd";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { PageHeader } from "@/components/shell/GalaxyShell";
import { IconLogout, IconMonitor, IconPlug } from "@/components/ui/icons";
import { Btn, Card, CardHead, Loading, Note, Pill, Seg } from "@/components/ui/kit";
import { useLocale } from "@/i18n/LocaleProvider";
import { clearAuthToken, getAuthUser, type AuthUser } from "@/utils/auth";
import { formatRelative } from "@/utils/format";
import { isDesktop, productConfig } from "@/utils/product";
import { fetchNodes, isNodeOnline, revokeNode, type NodeView } from "../../api/provider.api";
import { LocalServicePanel } from "./LocalServicePanel";

export function AccountPanel() {
  const { t, locale, setLocale } = useLocale();
  const router = useRouter();
  const [user, setUser] = useState<AuthUser | null>(null);
  const [nodes, setNodes] = useState<NodeView[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setNodes(await fetchNodes());
    } catch (error) {
      message.error((error as Error).message || t("common.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    setUser(getAuthUser());
    void load();
  }, [load]);

  const unbind = (node: NodeView) => {
    Modal.confirm({
      title: t("account.unbindAction"),
      content: t("account.unbindConfirm"),
      okText: t("common.confirm"),
      cancelText: t("common.cancel"),
      okButtonProps: { danger: true },
      onOk: async () => {
        setBusy(true);
        try {
          await revokeNode(node.nodeId);
          message.success(t("account.unbound"));
          await load();
        } catch (error) {
          message.error((error as Error).message || t("common.actionFailed"));
        } finally {
          setBusy(false);
        }
      },
    });
  };

  return (
    <>
      <PageHeader title={t("account.title")} meta={t("account.subtitle")} />
      <div className="gx-body">
        <Card className="gx-rise">
          <CardHead title={t("account.profile")} />
          <div style={{ display: "flex", alignItems: "center", gap: 16, padding: "0 22px 20px" }}>
            <span className="gx-avatar" style={{ width: 56, height: 56, fontSize: 22 }}>
              {(user?.displayName || user?.username || "·").slice(0, 1)}
            </span>
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <span style={{ fontSize: 17, fontWeight: 600 }}>{user?.displayName || user?.username || "—"}</span>
              <span className="gx-mono" style={{ fontSize: 12, color: "var(--gx-faint)" }}>
                {user?.username} · {user?.role || productConfig.role}
              </span>
            </div>
          </div>
        </Card>

        <Card className="gx-rise gx-rise--1">
          <CardHead title={t("account.node")} hint={isDesktop() ? undefined : t("bridge.desktopRequired")} />
          {loading ? (
            <Loading />
          ) : (
            <div style={{ padding: "0 22px 18px" }}>
              {nodes.length === 0 ? (
                <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "14px 0", borderTop: "1px solid var(--gx-line)" }}>
                  <IconPlug size={18} style={{ color: "var(--gx-faint)" }} />
                  <span style={{ flex: 1, fontSize: 13.5 }}>{t("account.nodeNone")}</span>
                  <Btn tone="accent" small onClick={() => router.push("/provider/pair")}>
                    {t("today.emptyAction")}
                  </Btn>
                </div>
              ) : (
                nodes.map((node) => (
                  <div
                    key={node.nodeId}
                    style={{ display: "flex", alignItems: "center", gap: 12, padding: "14px 0", borderTop: "1px solid var(--gx-line)" }}
                  >
                    <IconMonitor size={18} style={{ color: "var(--gx-faint)" }} />
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <span style={{ display: "block", fontSize: 13.5, fontWeight: 600 }}>{node.displayName || node.nodeId}</span>
                      <span className="gx-mono" style={{ display: "block", fontSize: 11, color: "var(--gx-faint)", marginTop: 2 }}>
                        ai-bridge {node.bridgeVersion || "-"} · {formatRelative(node.lastBeatAt)}
                      </span>
                    </span>
                    <Pill tone={node.banned ? "err" : isNodeOnline(node) ? "ok" : "default"}>
                      {node.banned ? t("share.off") : isNodeOnline(node) ? t("today.sharing") : t("today.offline")}
                    </Pill>
                    <Btn tone="danger" small disabled={busy} onClick={() => unbind(node)}>
                      {t("account.unbindAction")}
                    </Btn>
                  </div>
                ))
              )}
              <div style={{ marginTop: 12 }}>
                <Note>{t("account.unbindHint")}</Note>
              </div>
            </div>
          )}
        </Card>

        <LocalServicePanel />

        <Card className="gx-rise gx-rise--3">
          <CardHead title={t("account.security")} hint={t("account.securityHint")} />
          <div style={{ display: "flex", alignItems: "center", gap: 16, padding: "0 22px 20px" }}>
            <span style={{ fontSize: 13, color: "var(--gx-soft)" }}>{t("account.locale")}</span>
            <Seg
              value={locale}
              onChange={(next) => setLocale(next)}
              options={[
                { value: "zh-CN" as const, label: t("locale.zh-CN") },
                { value: "en-US" as const, label: t("locale.en-US") },
              ]}
            />
            <span style={{ flex: 1 }} />
            <Btn
              tone="ghost"
              icon={<IconLogout size={16} />}
              onClick={() => {
                clearAuthToken();
                router.replace("/login");
              }}
            >
              {t("account.logout")}
            </Btn>
          </div>
        </Card>
      </div>
    </>
  );
}
