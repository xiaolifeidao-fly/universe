"use client";

/**
 * 账户。
 *
 * 从上到下按「多常来看」排：这台电脑 → 其他机器 → 安装 ai-bridge → 接入密钥 → 登录与安全。
 * 主人名下除了这台电脑，还可能有一排机房服务器。以前按「资料、机器、密钥、本机」平铺，
 * 机器一多，最常要确认的「这台接上没有」被挤到页面最底下；机器、密钥里作废的和在用的
 * 也搅在一起。现在这台电脑单独一块钉在最上面，机器和密钥各自分「在用 / 作废」两栏。
 * 安装夹在机器和密钥中间，是照着接一台服务器的顺序：先装，再拿密钥注册。
 *
 * 改密码是单独一页（/password）：运营重置过密码的人登进来也被挡到那一页，两种人共用一套表单。
 * 原型上还画了改头像、设备列表 —— 设备列表要有会话表，这一版只做已经有真实数据支撑的部分。
 *
 * 身份一个字都不露：散户 / 工作室是平台内部的分法，注册出来一律是散户、只有运营能改，
 * 本人看见了也做不了什么，反而要问「怎么才能变成工作室」。
 * 中间三块（其他机器、安装 ai-bridge、接入密钥）是机房那一套，只有工作室看得到：
 * 散户名下就自己坐着的这一台，给他一排「怎么接服务器」只是在教他做一件他不会做的事。
 * 于是散户的账户页就剩两块 —— 这台电脑，和登录与安全。
 */

import { Modal, message } from "antd";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { PageHeader } from "@/components/shell/GalaxyShell";
import { IconLock, IconLogout } from "@/components/ui/icons";
import { Btn, Card, CardHead, Loading, Seg } from "@/components/ui/kit";
import { useLocale } from "@/i18n/LocaleProvider";
import { clearAuthToken, isStudio } from "@/utils/auth";
import { isDesktop } from "@/utils/product";
import { pingBridge } from "../../api/bridge.api";
import {
  fetchBridgeReleases,
  fetchNodes,
  fetchProviderEndpoint,
  fetchProviderKeys,
  fetchRetiredNodes,
  fetchTerms,
  isUpgradeInProgress,
  nodeDisplayName,
  orderMachines,
  requestNodeUpgrade,
  revokeNode,
  type BridgeReleaseManifest,
  type NodeView,
  type ProviderKeyView,
  type TermsStatus,
} from "../../api/provider.api";
import { useCurrentAccount } from "../../useAccount";
import { AccessKeyPanel } from "./AccessKeyPanel";
import { BridgeInstallPanel } from "./BridgeInstallPanel";
import { MachineList } from "./MachineList";
import { ThisComputerPanel } from "./ThisComputerPanel";

/** 和「今天」「共享设置」同一个节奏：心跳 15 秒一次，前端刷得比数据还勤没有意义。 */
const REFRESH_MS = 20_000;

/**
 * 有机器在升级时的节奏。进度是节点当场上报的，不等心跳：下载、安装、重启几步常常不到一分钟，
 * 按 20 秒一刷，盯着看的那一台会从「等机器领取」直接跳到「已升级」，中间几步全看不见。
 */
const UPGRADE_REFRESH_MS = 5_000;

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function AccountPanel() {
  const { t, locale, setLocale } = useLocale();
  const router = useRouter();
  // 静态 Modal.confirm 拿不到 ConfigProvider 的主题，按钮会是 antd 默认的蓝色，所以用 hook 版。
  const [modal, modalHolder] = Modal.useModal();
  // 身份决定中间三块给不给，所以取的是库里最新的那份（见 useCurrentAccount），不是登录时的快照。
  const user = useCurrentAccount();
  const studio = isStudio(user);
  const [nodes, setNodes] = useState<NodeView[]>([]);
  // 列表真拿到过才算数：「这台电脑」要拿它判断自己还在不在名下，
  // 加载失败时的空列表会让它误报「已解绑」。
  const [nodesLoaded, setNodesLoaded] = useState(false);
  const [retired, setRetired] = useState<NodeView[] | null>(null);
  const [retiredFailed, setRetiredFailed] = useState(false);
  const [keys, setKeys] = useState<ProviderKeyView[]>([]);
  const [terms, setTerms] = useState<TermsStatus | null>(null);
  const [hubUrl, setHubUrl] = useState("");
  const [releases, setReleases] = useState<BridgeReleaseManifest | null>(null);
  const [releasesFailed, setReleasesFailed] = useState(false);
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

  const loadReleases = useCallback(async () => {
    try {
      setReleases(await fetchBridgeReleases());
      setReleasesFailed(false);
    } catch {
      // 同「已解绑」那一栏：只影响安装那一块，不弹全局报错，那一块自己说没加载出来、给个重试。
      setReleasesFailed(true);
    }
  }, []);

  useEffect(() => {
    let alive = true;
    const self = pingBridge().then((ping) => (ping ? { nodeId: ping.nodeId ?? "", paired: Boolean(ping.paired && ping.nodeId) } : null));
    void self.then((value) => {
      if (alive) setLocal(value);
    });
    const failed = (error: unknown) => message.error((error as Error).message || t("common.loadFailed"));
    // 整页一次画出来，而且等本机 bridge 报出自己是哪台再画（同今天、共享设置）：分几步到的话，
    // 这台电脑会先在「其他机器」里闪一下再挪到最上面，下面几块卡片也跟着一截一截往下跳。
    // 等不过 1.5 秒就先画，IPC 卡住不能把整页挡在加载圈上。
    void Promise.all([
      loadNodes().catch(failed),
      loadKeys().catch(failed),
      loadRetired(),
      loadReleases(),
      Promise.race([self, delay(1500)]),
    ]).finally(() => {
      if (alive) setLoading(false);
    });
    return () => {
      alive = false;
    };
  }, [loadKeys, loadNodes, loadReleases, loadRetired, t]);

  const upgrading = nodes.some((node) => isUpgradeInProgress(node.upgrade));

  // 别的机器上下线、回连通不通、升级走到哪都得看得见。刷新失败不弹：
  // 断网时每 20 秒冒一条报错，比数据旧 20 秒更扰人。
  useEffect(() => {
    const timer = setInterval(() => void loadNodes().catch(() => undefined), upgrading ? UPGRADE_REFRESH_MS : REFRESH_MS);
    return () => clearInterval(timer);
  }, [loadNodes, upgrading]);

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

  // 确认框里把代价说清楚：升级不是后台悄悄装，那台机器会有一两分钟不接新活。
  const upgrade = (node: NodeView) => {
    void modal.confirm({
      title: t("account.upgradeTitle", { name: nodeDisplayName(node), version: node.latestVersion }),
      content: t("account.upgradeConfirm"),
      okText: t("account.upgradeOk"),
      cancelText: t("common.cancel"),
      onOk: async () => {
        try {
          const started = await requestNodeUpgrade(node.nodeId);
          // 先把这一台就地标成升级中再去刷新：列表回来之前按钮还亮着，手快再点一次只会被服务端拒回来。
          // 这一改也立刻把轮询切到 5 秒。
          if (started) {
            setNodes((current) => current.map((item) => (item.nodeId === node.nodeId ? { ...item, upgrade: started } : item)));
          }
          message.success(t("account.upgradeRequested"));
          await loadNodes().catch(() => undefined);
        } catch (error) {
          message.error((error as Error).message || t("common.actionFailed"));
        }
      },
    });
  };

  // 签发弹窗里那条带密钥的一行安装命令用的是 sh 脚本：平台一个 Linux 包都没发布时不给，
  // 照着跑只会装到一半报「没有这个平台的包」。手装 ai-bridge 只认 Linux，同「安装 ai-bridge」那一块。
  const unixInstallScript =
    releases?.installScript && (releases.platforms ?? []).some((item) => /^linux-/.test(item.platform ?? ""))
      ? releases.installScript
      : "";

  return (
    <>
      {/* 副标题报的是这一页有哪几块，散户少了中间三块，就不能再报「名下机器与接入密钥」。 */}
      <PageHeader title={t("account.title")} meta={t(studio ? "account.subtitle" : "account.subtitleIndividual")} />
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

            {/* 机房那一套，只给工作室。三块是一整条路（先看机器、再装、再拿密钥注册），拆开给没有意义。 */}
            {studio ? (
              <>
                <MachineList
                  machines={machines}
                  retired={retired}
                  retiredFailed={retiredFailed}
                  localNodeId={localNodeId}
                  desktop={desktop}
                  busy={busy}
                  onUnbind={unbind}
                  onUpgrade={upgrade}
                  onAddServer={() => setIssueOpen(true)}
                  onRetryRetired={() => void loadRetired()}
                />

                <BridgeInstallPanel manifest={releases} failed={releasesFailed} hubUrl={hubUrl} onRetry={() => void loadReleases()} />

                <AccessKeyPanel
                  keys={keys}
                  terms={terms}
                  hubUrl={hubUrl}
                  installScript={unixInstallScript}
                  nodeNames={nodeNames}
                  issueOpen={issueOpen}
                  onIssueOpenChange={setIssueOpen}
                  onChanged={() =>
                    loadKeys().catch((error) => {
                      message.error((error as Error).message || t("common.loadFailed"));
                    })
                  }
                />
              </>
            ) : null}

            {/* 资料和登录合成一块放到底：左栏底部已经挂着头像和名字，这里再单占一张大卡什么也没多说。 */}
            {/* 入场延迟按它实际排第几块算：散户那里中间三块没有，它就是第二块。 */}
            <Card className={`gx-rise gx-rise--${studio ? 3 : 1}`}>
              <CardHead title={t("account.security")} hint={t("account.securityHint")} />
              <div style={{ display: "flex", alignItems: "center", gap: "12px 16px", padding: "4px 18px 18px", flexWrap: "wrap" }}>
                <span className="gx-avatar" style={{ width: 40, height: 40, fontSize: 16 }}>
                  {(user?.displayName || user?.username || "·").slice(0, 1)}
                </span>
                <span style={{ display: "flex", flexDirection: "column", gap: 3, minWidth: 0 }}>
                  {/* 名字旁边不挂身份标：身份改不了，标出来只是个答不上来的问题。
                      两种人看到的界面差多少，上面那几块已经说清楚了。 */}
                  <span style={{ fontSize: 14, fontWeight: 600 }}>{user?.displayName || user?.username || "—"}</span>
                  <span className="gx-mono" style={{ fontSize: 11.5, color: "var(--gx-faint)" }}>
                    {user?.username}
                  </span>
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
