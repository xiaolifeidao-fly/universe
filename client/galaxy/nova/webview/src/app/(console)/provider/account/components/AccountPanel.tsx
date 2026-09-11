"use client";

/**
 * 账户。
 *
 * 从上到下按「多常来看」排：这台电脑 → 其他机器 → 接入密钥 → 登录与安全。
 * 主人名下除了这台电脑，还可能有一排机房服务器。以前按「资料、机器、密钥、本机」平铺，
 * 机器一多，最常要确认的「这台接上没有」被挤到页面最底下；机器、密钥里作废的和在用的
 * 也搅在一起。现在这台电脑单独一块钉在最上面，机器和密钥各自分「在用 / 作废」两栏。
 *
 * 改密码是单独一页（/password）：运营重置过密码的人登进来也被挡到那一页，两种人共用一套表单。
 * 原型上还画了改头像、设备列表 —— 设备列表要有会话表，这一版只做已经有真实数据支撑的部分。
 *
 * 散户 / 工作室只展示不能改：注册出来一律是散户，工作室由平台运营在管理端设。
 */

import { Modal, message } from "antd";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { PageHeader } from "@/components/shell/GalaxyShell";
import { IconLock, IconLogout } from "@/components/ui/icons";
import { Btn, Card, CardHead, Loading, Pill, Seg } from "@/components/ui/kit";
import { useLocale } from "@/i18n/LocaleProvider";
import { clearAuthToken, getAuthUser, isAuthTokenRemembered, setAuthUser, type AuthUser } from "@/utils/auth";
import { isDesktop } from "@/utils/product";
import { fetchCurrentAccount } from "../api/account.api";
import { pingBridge } from "../../api/bridge.api";
import {
  fetchNodes,
  fetchProviderEndpoint,
  fetchProviderKeys,
  fetchRetiredNodes,
  fetchTerms,
  nodeDisplayName,
  orderMachines,
  revokeNode,
  type NodeView,
  type ProviderKeyView,
  type TermsStatus,
} from "../../api/provider.api";
import { AccessKeyPanel } from "./AccessKeyPanel";
import { MachineList } from "./MachineList";
import { ThisComputerPanel } from "./ThisComputerPanel";

/** 和「今天」「共享设置」同一个节奏：心跳 15 秒一次，前端刷得比数据还勤没有意义。 */
const REFRESH_MS = 20_000;

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function AccountPanel() {
  const { t, locale, setLocale } = useLocale();
  const router = useRouter();
  // 静态 Modal.confirm 拿不到 ConfigProvider 的主题，按钮会是 antd 默认的蓝色，所以用 hook 版。
  const [modal, modalHolder] = Modal.useModal();
  const [user, setUser] = useState<AuthUser | null>(null);
  const [nodes, setNodes] = useState<NodeView[]>([]);
  // 列表真拿到过才算数：「这台电脑」要拿它判断自己还在不在名下，
  // 加载失败时的空列表会让它误报「已解绑」。
  const [nodesLoaded, setNodesLoaded] = useState(false);
  const [retired, setRetired] = useState<NodeView[] | null>(null);
  const [retiredFailed, setRetiredFailed] = useState(false);
  const [keys, setKeys] = useState<ProviderKeyView[]>([]);
  const [terms, setTerms] = useState<TermsStatus | null>(null);
  const [hubUrl, setHubUrl] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  // 本机 bridge 报的自己。配着的那台不进下面的列表，摆在最上面那一块；
  // 纯浏览器里是 null —— 浏览器不是任何一台机器。
  const [local, setLocal] = useState<{ nodeId: string; paired: boolean } | null>(null);
  const [issueOpen, setIssueOpen] = useState(false);
  const desktop = isDesktop();

  const loadNodes = useCallback(async () => {
    setNodes(await fetchNodes());
    setNodesLoaded(true);
  }, []);

  const loadRetired = useCallback(async () => {
    try {
      setRetired(await fetchRetiredNodes());
      setRetiredFailed(false);
    } catch {
      // 只影响「已解绑」那一栏，不弹全局报错：平台还没更新到有这个接口时，每进一次页面
      // 就弹一条「加载失败」，主人会以为整页都坏了。那一栏自己说没加载出来，给个重试。
      // 之前拿到过的列表留着，比刷新失败就清空强。
      setRetiredFailed(true);
    }
  }, []);

  const loadKeys = useCallback(async () => {
    const [list, termsStatus, endpoint] = await Promise.all([fetchProviderKeys(), fetchTerms(), fetchProviderEndpoint()]);
    setKeys(list);
    setTerms(termsStatus);
    setHubUrl(endpoint.hubUrl);
  }, []);

  useEffect(() => {
    let alive = true;
    setUser(getAuthUser());
    // 本地那份是登录那一刻的快照：运营后来把人改成工作室，得现取一次才看得到。
    // 取不到就先用快照，不弹报错 —— 这一块只是展示，不该让整页看起来坏了。
    void fetchCurrentAccount()
      .then((fresh) => {
        if (!alive) return;
        setUser(fresh);
        setAuthUser(fresh, isAuthTokenRemembered());
      })
      .catch(() => undefined);
    const self = pingBridge().then((ping) => (ping ? { nodeId: ping.nodeId ?? "", paired: Boolean(ping.paired && ping.nodeId) } : null));
    void self.then((value) => {
      if (alive) setLocal(value);
    });
    const failed = (error: unknown) => message.error((error as Error).message || t("common.loadFailed"));
    // 整页一次画出来，而且等本机 bridge 报出自己是哪台再画（同今天、共享设置）：分几步到的话，
    // 这台电脑会先在「其他机器」里闪一下再挪到最上面，下面几块卡片也跟着一截一截往下跳。
    // 等不过 1.5 秒就先画，IPC 卡住不能把整页挡在加载圈上。
    void Promise.all([loadNodes().catch(failed), loadKeys().catch(failed), loadRetired(), Promise.race([self, delay(1500)])]).finally(() => {
      if (alive) setLoading(false);
    });
    // 别的机器上下线、回连通不通都得看得见。刷新失败不弹：
    // 断网时每 20 秒冒一条报错，比数据旧 20 秒更扰人。
    const timer = setInterval(() => void loadNodes().catch(() => undefined), REFRESH_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [loadKeys, loadNodes, loadRetired, t]);

  const localNodeId = local?.nodeId ?? "";
  // 配着的这台电脑在最上面那一块，不在列表里重复一遍。没配、被解绑时本来就不在名下，没什么可剔的。
  const machines = useMemo(
    () => orderMachines(local?.paired ? nodes.filter((node) => node.nodeId !== local.nodeId) : nodes, ""),
    [nodes, local],
  );
  const nodeNames = useMemo(() => {
    const names: Record<string, string> = {};
    for (const node of [...(retired ?? []), ...nodes]) names[node.nodeId] = nodeDisplayName(node);
    return names;
  }, [nodes, retired]);

  const unbind = (node: NodeView) => {
    const self = Boolean(localNodeId) && node.nodeId === localNodeId;
    void modal.confirm({
      title: t("account.unbindTitle", { name: self ? t("account.thisComputer") : nodeDisplayName(node) }),
      content: self ? t("account.unbindLocalConfirm") : t("account.unbindConfirm"),
      okText: t("account.unbindAction"),
      cancelText: t("common.cancel"),
      okButtonProps: { danger: true },
      onOk: async () => {
        setBusy(true);
        try {
          await revokeNode(node.nodeId);
          message.success(t("account.unbound"));
          // 两栏一起刷：这台从「在用」挪到「已解绑」，数字跟着变，主人才看得出解绑生效了。
          await Promise.all([loadNodes().catch(() => undefined), loadRetired()]);
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
      {modalHolder}
      <div className="gx-body">
        {loading ? (
          <Loading />
        ) : (
          <>
            <ThisComputerPanel
              nodes={nodesLoaded ? nodes : null}
              busy={busy}
              onUnbind={unbind}
              onRefresh={() => void loadNodes().catch(() => undefined)}
            />

            <MachineList
              machines={machines}
              retired={retired}
              retiredFailed={retiredFailed}
              localNodeId={localNodeId}
              desktop={desktop}
              busy={busy}
              onUnbind={unbind}
              onAddServer={() => setIssueOpen(true)}
              onRetryRetired={() => void loadRetired()}
            />

            <AccessKeyPanel
              keys={keys}
              terms={terms}
              hubUrl={hubUrl}
              nodeNames={nodeNames}
              issueOpen={issueOpen}
              onIssueOpenChange={setIssueOpen}
              onChanged={() =>
                loadKeys().catch((error) => {
                  message.error((error as Error).message || t("common.loadFailed"));
                })
              }
            />

            {/* 资料和登录合成一块放到底：左栏底部已经挂着头像和名字，这里再单占一张大卡什么也没多说。 */}
            <Card className="gx-rise gx-rise--3">
              <CardHead title={t("account.security")} hint={t("account.securityHint")} />
              <div style={{ display: "flex", alignItems: "center", gap: "12px 16px", padding: "4px 18px 18px", flexWrap: "wrap" }}>
                <span className="gx-avatar" style={{ width: 40, height: 40, fontSize: 16 }}>
                  {(user?.displayName || user?.username || "·").slice(0, 1)}
                </span>
                <span style={{ display: "flex", flexDirection: "column", gap: 3, minWidth: 0 }}>
                  <span style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                    <span style={{ fontSize: 14, fontWeight: 600 }}>{user?.displayName || user?.username || "—"}</span>
                    {user?.providerType ? (
                      <Pill tone={user.providerType === "studio" ? "accent" : "default"}>
                        {t(user.providerType === "studio" ? "account.identityStudio" : "account.identityIndividual")}
                      </Pill>
                    ) : null}
                  </span>
                  <span className="gx-mono" style={{ fontSize: 11.5, color: "var(--gx-faint)" }}>
                    {user?.username}
                  </span>
                  {user?.providerType ? (
                    <span style={{ fontSize: 12, lineHeight: 1.6, color: "var(--gx-faint)" }}>
                      {t(user.providerType === "studio" ? "account.identityStudioHint" : "account.identityIndividualHint")}
                    </span>
                  ) : null}
                </span>
                <span style={{ flex: 1 }} />
                <span style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <span style={{ fontSize: 12.5, color: "var(--gx-soft)" }}>{t("account.locale")}</span>
                  <Seg
                    value={locale}
                    onChange={(next) => setLocale(next)}
                    options={[
                      { value: "zh-CN" as const, label: t("locale.zh-CN") },
                      { value: "en-US" as const, label: t("locale.en-US") },
                    ]}
                  />
                </span>
                <Btn tone="ghost" small icon={<IconLock size={15} />} onClick={() => router.push("/password")}>
                  {t("account.changePassword")}
                </Btn>
                <Btn
                  tone="ghost"
                  small
                  icon={<IconLogout size={15} />}
                  onClick={() => {
                    clearAuthToken();
                    router.replace("/login");
                  }}
                >
                  {t("account.logout")}
                </Btn>
              </div>
            </Card>
          </>
        )}
      </div>
    </>
  );
}
