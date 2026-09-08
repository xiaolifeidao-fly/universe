"use client";

import { CopyOutlined } from "@ant-design/icons";
import { Button, Tabs, Typography, message } from "antd";
import { useLocale } from "@/i18n/LocaleProvider";
import { copyText } from "@/utils/format";

const { Paragraph } = Typography;

/**
 * 插件安装教程。
 *
 * 仓库地址由部署侧给（NEXT_PUBLIC_BRIDGE_REPO）：这份控制台会被不同的部署方跑起来，
 * 各自的插件源码放在哪儿只有他们自己知道，写死一个地址等于让别人复制一条跑不通的命令。
 * 没配就露出占位符 —— 比默默给一个错的地址好。
 */
const REPO = process.env.NEXT_PUBLIC_BRIDGE_REPO || "<插件仓库地址>";

/** 一段可复制的命令。命令行是这一步唯一的交互，所以每一段都给复制按钮。 */
function Command({ text }: { text: string }) {
  const { t } = useLocale();
  const copy = async () => {
    const ok = await copyText(text);
    if (ok) message.success(t("common.copied"));
    else message.warning(t("common.copyFailed"));
  };
  return (
    <div className="galaxy-secret" style={{ marginBottom: 8 }}>
      <code style={{ flex: 1, whiteSpace: "pre-wrap", wordBreak: "break-all" }}>{text}</code>
      <Button size="small" icon={<CopyOutlined />} onClick={() => void copy()}>
        {t("common.copy")}
      </Button>
    </div>
  );
}

export function InstallGuide() {
  const { t } = useLocale();

  // --pool 而不是裸的 install.sh：后者会登记 Claude/Codex 插件并起 relay，
  // 在本机开一个 8787 端口。贡献者要的是 pool 模式，不监听任何端口。
  const unix = `git clone ${REPO} galaxy\nbash galaxy/ai-bridge/scripts/install.sh --pool`;
  const windows = `git clone ${REPO} galaxy\ncd galaxy\\ai-bridge\nnpm ci && npm run build\nnode dist/main.js init\nnode dist/main.js pool setup`;

  return (
    <div>
      <Paragraph style={{ marginBottom: 10, color: "var(--manager-text-muted)" }}>
        {t("provider.install.prereq")}
      </Paragraph>
      <Tabs
        size="small"
        items={[
          {
            key: "unix",
            label: t("provider.install.unix"),
            children: (
              <>
                <Command text={unix} />
                <Paragraph style={{ margin: 0, color: "var(--manager-text-muted)" }}>
                  {t("provider.install.unixHint")}
                </Paragraph>
              </>
            ),
          },
          {
            key: "windows",
            label: t("provider.install.windows"),
            children: (
              <>
                <Command text={windows} />
                <Paragraph style={{ margin: 0, color: "var(--manager-text-muted)" }}>
                  {t("provider.install.windowsHint")}
                </Paragraph>
              </>
            ),
          },
        ]}
      />
    </div>
  );
}
