"use client";

import { ReloadOutlined } from "@ant-design/icons";
import { Button, Space, Tag, Tooltip, message } from "antd";
import { useCallback, useEffect, useState } from "react";
import { useLocale } from "@/i18n/LocaleProvider";
import { BRIDGE_PORT, fetchTools, upgradeTool, type ToolStatus } from "../../api/bridge.api";

/**
 * 本机工具的版本面板。
 *
 * 只对**你正坐着的这台**机器有意义 —— 版本是问本机 bridge 拿的，浏览器够不到
 * 别的机器。所以调用方要先比对 nodeId，只在本机那张卡片上挂它。
 *
 * 升级是异步的：npm 全局安装几十秒起步，接口拉起就返回。所以点完不立刻刷新，
 * 而是提示「装完再刷新」——  假装已经装好、显示旧版本，比不刷新更让人困惑。
 */
export function ToolVersions() {
  const { t } = useLocale();
  const [tools, setTools] = useState<ToolStatus[]>([]);
  const [busy, setBusy] = useState("");

  const conn = { port: BRIDGE_PORT, resident: true };

  const load = useCallback(async () => {
    setTools(await fetchTools(conn));
    // conn 是每次渲染新建的字面量，放进依赖会无限循环；它的值恒定，省掉是安全的。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const upgrade = async (tool: ToolStatus) => {
    setBusy(tool.name);
    try {
      await upgradeTool(conn, tool.name);
      message.success(t("provider.tools.upgrading").replace("{name}", tool.name));
    } catch (error) {
      message.error((error as Error).message || t("common.actionFailed"));
    } finally {
      setBusy("");
    }
  };

  if (tools.length === 0) return null;

  return (
    <div className="galaxy-meta" style={{ marginTop: 10, alignItems: "center", flexWrap: "wrap" }}>
      <span style={{ color: "var(--manager-text-muted)" }}>{t("provider.tools.title")}</span>
      {tools.map((tool) => (
        <Space key={tool.name} size={4}>
          <span>
            <b>{tool.name}</b> {tool.installed ? tool.current : t("provider.tools.missing")}
          </span>
          {tool.upgradable ? (
            <Tooltip title={t("provider.tools.newVersion").replace("{version}", tool.latest)}>
              <Button
                size="small"
                type="primary"
                loading={busy === tool.name}
                onClick={() => void upgrade(tool)}
              >
                {t("provider.tools.upgrade")}
              </Button>
            </Tooltip>
          ) : tool.installed && tool.latest ? (
            <Tag color="success">{t("provider.tools.latest")}</Tag>
          ) : null}
        </Space>
      ))}
      <Button size="small" icon={<ReloadOutlined />} onClick={() => void load()}>
        {t("common.refresh")}
      </Button>
    </div>
  );
}
