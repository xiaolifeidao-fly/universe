"use client";

/**
 * 本机服务与本机工具。
 *
 * 只对**你正坐着的这台**机器有意义 —— 状态和版本都是问本机 bridge 拿的，
 * 浏览器够不到别的机器。所以纯浏览器调试时整块不显示，而不是显示一堆问号。
 *
 * 升级是异步的：npm 全局安装几十秒起步，接口拉起就返回。所以点完不立刻刷新，
 * 而是提示「装完再刷新」—— 假装已经装好、显示旧版本，比不刷新更让人困惑。
 */

import { message } from "antd";
import { useCallback, useEffect, useState } from "react";
import { IconPlug, IconRefresh } from "@/components/ui/icons";
import { Btn, Card, CardHead, Note, Pill } from "@/components/ui/kit";
import { useLocale, type TranslationKey } from "@/i18n/LocaleProvider";
import { isDesktop } from "@/utils/product";
import { bridgeApi, fetchTools, upgradeTool, type BridgeRuntimeStatus, type ToolStatus } from "../../api/bridge.api";

export function LocalServicePanel() {
  const { t } = useLocale();
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

  if (!isDesktop()) return null;

  const change = async (action: "start" | "stop" | "restart") => {
    setBusy(action);
    try {
      setStatus(await bridgeApi[action]());
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
            <span style={{ display: "block", fontSize: 13.5, fontWeight: 600 }}>
              {t(`bridge.state.${state}` as TranslationKey)}
            </span>
            <span className="gx-mono" style={{ display: "block", fontSize: 11, color: "var(--gx-faint)", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {status?.hubURL || status?.configPath || "—"}
            </span>
          </span>
          <Pill tone={state === "running" ? "ok" : state === "error" ? "err" : "default"}>{status?.mode ?? "-"}</Pill>
          <Btn tone="ghost" small loading={busy === "start"} disabled={state === "running" || state === "starting"} onClick={() => void change("start")}>
            {t("bridge.start")}
          </Btn>
          <Btn tone="ghost" small loading={busy === "stop"} disabled={state === "stopped"} onClick={() => void change("stop")}>
            {t("bridge.stop")}
          </Btn>
          <Btn tone="ghost" small loading={busy === "restart"} onClick={() => void change("restart")}>
            {t("bridge.restart")}
          </Btn>
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
