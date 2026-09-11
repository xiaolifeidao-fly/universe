"use client";

/**
 * 这台电脑：Nova 内置的 ai-bridge 连没连上平台，以及本机工具的版本。
 *
 * 只对**你正坐着的这台**机器有意义 —— 状态和版本都是问本机 bridge 拿的，
 * 浏览器够不到别的机器。所以纯浏览器调试时整块不显示，而不是显示一堆问号。
 *
 * 这里不给启动 / 停止 / 重启。内置 bridge 没有要人照看的生命周期：配对过的机器
 * 打开 Nova 就自己接上，配对、改绑平台时 runner 自己停自己起，连不上 Hub 时自己
 * 退避重试。「停止」也只停内存里的 runner，下次打开 Nova 又会自动起来 —— 想暂停接单
 * 该用「今天」页的共享总开关（服务端暂停，重启不丢），想彻底不接用上面的解绑。
 * 只有已配对却没在跑（启动出错、开发时关了自启）才给一个「重新连接」兜底。
 *
 * 升级是异步的：npm 全局安装几十秒起步，接口拉起就返回。所以点完不立刻刷新，
 * 而是提示「装完再刷新」—— 假装已经装好、显示旧版本，比不刷新更让人困惑。
 */

import { message } from "antd";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { IconPlug, IconRefresh } from "@/components/ui/icons";
import { Btn, Card, CardHead, Note, Pill } from "@/components/ui/kit";
import { useLocale, type TranslationKey } from "@/i18n/LocaleProvider";
import { isDesktop } from "@/utils/product";
import { bridgeApi, fetchTools, syncBridgeHub, upgradeTool, type BridgeRuntimeStatus, type ToolStatus } from "../../api/bridge.api";
import { fetchProviderEndpoint } from "../../api/provider.api";

/**
 * nodeIds 是主人名下的机器（没加载成功时是 null）。拿它判断「本机自认为配着，平台却已经不认」：
 * 在控制台解绑这台电脑之后，本机令牌文件还在，bridge 只会在后台一遍遍被 401 退回来，
 * 状态停在「正在连接平台」—— 不点破的话，主人会一直等，而且哪儿都没有重新配对的入口。
 */
export function LocalServicePanel({ nodeIds }: { nodeIds: string[] | null }) {
  const { t } = useLocale();
  const router = useRouter();
  const [status, setStatus] = useState<BridgeRuntimeStatus | null>(null);
  const [tools, setTools] = useState<ToolStatus[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");

  const load = useCallback(async () => {
    if (!isDesktop()) return;
    try {
      setStatus(await bridgeApi.getStatus());
      setError("");
    } catch (loadError) {
      setError((loadError as Error).message);
    }
    try {
      setTools(await fetchTools());
    } catch {
      // 工具版本要问 npm 拿最新版，网络不通就没有。拿不到不显示这一行，
      // 比显示一排「未知」有用 —— 后者会让人以为工具坏了。
      setTools([]);
    }
  }, []);

  useEffect(() => {
    void load();
    if (!isDesktop()) return undefined;
    const timer = setInterval(() => void load(), 5_000);
    return () => clearInterval(timer);
  }, [load]);

  // 进这个页面时校准一次平台地址：控制台连的是哪台，本机就该绑哪台。
  //
  // 平台的对外地址由部署方在 galaxy.provider_hub_url 里定，换了域名或机房之后
  // 本机配置不会自己跟上 —— 这一格显示的还是旧地址，而且重新配对会被
  // 「本机已绑定其他平台」拦住，主人只能去 userData 里手改 yaml。
  //
  // 只在进页面时做，不挂在 load() 上：那是 5 秒一次的轮询，跟着它跑等于
  // 每 5 秒问一次平台，而这个地址不会一分钟变三回。
  useEffect(() => {
    if (!isDesktop()) return;
    void (async () => {
      try {
        const endpoint = await fetchProviderEndpoint();
        if (!endpoint.hubUrl) return;
        const synced = await syncBridgeHub(endpoint.hubUrl);
        // 换平台等于旧令牌作废，得让主人知道要重配一次，
        // 否则他看到的是「地址对了但一直未连接」。
        if (synced.changed) message.warning(t("bridge.hubRebound", { hub: synced.hubURL }));
      } catch {
        // 平台地址拿不到（离线、接口还没起来）就先不校准。
        // 拿一个猜出来的地址去覆盖正在用的配置，比不校准糟得多。
      } finally {
        void load();
      }
    })();
  }, [load, t]);

  if (!isDesktop()) return null;

  const reconnect = async () => {
    setBusy("reconnect");
    try {
      setStatus(await bridgeApi.restart());
      setError("");
    } catch (actionError) {
      message.error((actionError as Error).message || t("common.actionFailed"));
    } finally {
      setBusy("");
    }
  };

  const upgrade = async (tool: ToolStatus) => {
    setBusy(tool.name);
    try {
      await upgradeTool(tool.name);
      message.success(t("bridge.toolsUpgrading", { name: tool.name }));
    } catch (upgradeError) {
      message.error((upgradeError as Error).message || t("common.actionFailed"));
    } finally {
      setBusy("");
    }
  };

  const state = status?.state ?? "stopped";
  const paired = Boolean(status?.paired);
  const detached = Boolean(paired && status?.nodeId && nodeIds && !nodeIds.includes(status.nodeId));
  // 状态还没拿到时什么都不说：先闪一下「还没加入共享池」再变成「已连接」，比空着更误导。
  const headline = !status
    ? "—"
    : detached
      ? t("bridge.detached")
      : paired
        ? t(`bridge.state.${state}` as TranslationKey)
        : t("bridge.unpaired");
  const detail = !status
    ? ""
    : detached
      ? t("bridge.detachedHint", { node: status.nodeId || "-" })
      : paired
        ? t("bridge.identity", { node: status.nodeId || "-", hub: status.hubURL || "-" })
        : t("bridge.unpairedHint");

  return (
    <Card className="gx-rise gx-rise--2">
      <CardHead
        title={t("bridge.runtime")}
        hint={t("bridge.builtin")}
        action={
          <Btn tone="ghost" small icon={<IconRefresh size={14} />} onClick={() => void load()}>
            {t("common.refresh")}
          </Btn>
        }
      />
      <div style={{ padding: "0 22px 20px", display: "flex", flexDirection: "column", gap: 14 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 0", borderTop: "1px solid var(--gx-line)" }}>
          <IconPlug size={18} style={{ color: "var(--gx-faint)" }} />
          <span style={{ flex: 1, minWidth: 0 }}>
            <span style={{ display: "block", fontSize: 13.5, fontWeight: 600 }}>{headline}</span>
            {detail ? (
              <span
                className={paired && !detached ? "gx-mono" : undefined}
                style={{
                  display: "block",
                  fontSize: 11,
                  color: detached ? "var(--gx-warn-ink)" : "var(--gx-faint)",
                  marginTop: 2,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {detail}
              </span>
            ) : null}
          </span>
          {!status ? null : !paired || detached ? (
            // 解绑过的电脑也走配对：本机旧令牌不用手动清，配对时会带上旧 nodeId，新令牌直接覆盖。
            <Btn tone={detached ? "accent" : "ghost"} small onClick={() => router.push("/provider/pair")}>
              {detached ? t("bridge.repair") : t("bridge.pair")}
            </Btn>
          ) : state === "stopped" || state === "error" ? (
            <Btn tone="ghost" small loading={busy === "reconnect"} onClick={() => void reconnect()}>
              {t("bridge.reconnect")}
            </Btn>
          ) : null}
        </div>

        {tools.length > 0 ? (
          <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 0", borderTop: "1px solid var(--gx-line)", flexWrap: "wrap" }}>
            <span style={{ fontSize: 13, color: "var(--gx-soft)" }}>{t("bridge.tools")}</span>
            {tools.map((tool) => (
              <span key={tool.name} style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12.5 }}>
                <b>{tool.name}</b>
                <span className="gx-mono gx-muted">{tool.installed ? tool.current : t("bridge.toolsMissing")}</span>
                {tool.upgradable ? (
                  <Btn tone="soft" small loading={busy === tool.name} onClick={() => void upgrade(tool)}>
                    {t("bridge.toolsUpgrade")} {tool.latest}
                  </Btn>
                ) : tool.installed && tool.latest ? (
                  <Pill tone="ok">{t("bridge.toolsLatest")}</Pill>
                ) : null}
              </span>
            ))}
          </div>
        ) : null}

        {error || status?.error ? <Note tone="danger">{error || status?.error}</Note> : null}
      </div>
    </Card>
  );
}
