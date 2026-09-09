"use client";

import { CopyOutlined } from "@ant-design/icons";
import { Button, Tabs, Typography, message } from "antd";
import { useEffect, useState } from "react";
import { useLocale } from "@/i18n/LocaleProvider";
import { copyText } from "@/utils/format";

const { Paragraph } = Typography;

/**
 * 插件安装教程。
 *
 * 仓库地址可以被部署方覆盖（NEXT_PUBLIC_BRIDGE_REPO）：这份控制台会被不同的人跑起来，
 * 自建的那份插件源码不一定在同一个地方。默认值是上游仓库。
 */
const REPO = process.env.NEXT_PUBLIC_BRIDGE_REPO || "https://github.com/xiaolifeidao-fly/galaxy";

/** 一段可复制的文本块。这一步唯一的交互就是复制，所以每一块都自带按钮。 */
function CopyBlock({ text, scroll }: { text: string; scroll?: boolean }) {
  const { t } = useLocale();
  const copy = async () => {
    const ok = await copyText(text);
    if (ok) message.success(t("common.copied"));
    else message.warning(t("common.copyFailed"));
  };
  return (
    <div
      className="galaxy-secret"
      style={{ alignItems: "flex-start", maxHeight: scroll ? 260 : undefined, overflow: scroll ? "auto" : undefined }}
    >
      <code style={{ flex: 1, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{text}</code>
      <Button size="small" icon={<CopyOutlined />} onClick={() => void copy()} style={{ flex: "none" }}>
        {t("common.copy")}
      </Button>
    </div>
  );
}

export function InstallGuide() {
  const { t } = useLocale();
  const [origin, setOrigin] = useState("");

  // 本站地址只有浏览器里才有，服务端渲染时读会造成 hydration 不一致。
  useEffect(() => {
    setOrigin(window.location.origin);
  }, []);

  /**
   * 把本站地址交给向导：它会打印并打开一个带连接参数的控制台地址
   * （?bridge=<端口>&t=<一次性令牌>），配对因此能在控制台里完成，不用在两个页面之间跳。
   *
   * 走环境变量而不是给 install.sh 加参数：runSetup 本来就读 AI_BRIDGE_CONSOLE_URL，
   * 而环境变量会被 install.sh 里那层 node 原样继承 —— 脚本一行都不用改。
   * origin 还没读到时退回不带它的命令，那条路（本机页面）永远是通的。
   */
  const withConsole = (command: string) =>
    origin ? `AI_BRIDGE_CONSOLE_URL=${origin} ${command}` : command;

  /**
   * 丢给 AI 工具的那段提示词。
   *
   * 明确写了两条禁令：AI 工具会把执行过程回显到对话里，而配置文件里有上游凭据的
   * 路径、admin token 和节点令牌 —— 不说清楚就会被原样贴出来。
   */
  const aiPrompt = [
    `帮我把 ${REPO} 里的 ai-bridge 装到这台机器上，我要把本机的 AI 订阅算力共享到 Galaxy 共享池。`,
    "",
    "请按这个顺序做：",
    "1. 检查本机 Node.js 版本，低于 20 就先装一个 20 以上的",
    `2. git clone ${REPO}`,
    `3. 进入 galaxy/ai-bridge 目录，执行 ${withConsole("bash scripts/install.sh --pool")}`,
    "4. 这个脚本会编译、生成配置，然后启动一个只监听 127.0.0.1 的配置向导",
    "5. 把它打印出来的地址原样告诉我。它会打印两条：一条本机的 http://127.0.0.1:... ，",
    "   另一条是 Galaxy 控制台的地址 —— 两条都给我，我用控制台那条在浏览器里打开",
    "",
    "两条限制：",
    "- 不要修改 configs/ 下的任何文件，配置由那个向导页面写",
    "- 不要把任何 token、密钥或配置文件内容回显到对话里",
  ].join("\n");

  // --pool 而不是裸的 install.sh：后者会登记 Claude/Codex 插件并起 relay，
  // 在本机开一个 8787 端口。贡献者要的是 pool 模式，不监听任何端口。
  const unix = `git clone ${REPO} galaxy\n${withConsole("bash galaxy/ai-bridge/scripts/install.sh --pool")}`;
  // Windows 用 set 而不是行内前缀：cmd 不认 `VAR=value 命令` 那种写法。
  const windows = [
    `git clone ${REPO} galaxy`,
    "cd galaxy\\ai-bridge",
    "npm ci && npm run build",
    "node dist/main.js init",
    ...(origin ? [`set AI_BRIDGE_CONSOLE_URL=${origin}`] : []),
    "node dist/main.js pool setup",
  ].join("\n");

  return (
    <Tabs
      size="small"
      items={[
        {
          key: "ai",
          label: t("provider.install.ai"),
          children: (
            <>
              <Paragraph style={{ marginBottom: 10, color: "var(--manager-text-muted)" }}>
                {t("provider.install.aiHint")}
              </Paragraph>
              <CopyBlock text={aiPrompt} scroll />
            </>
          ),
        },
        {
          key: "unix",
          label: t("provider.install.unix"),
          children: (
            <>
              <Paragraph style={{ marginBottom: 10, color: "var(--manager-text-muted)" }}>
                {t("provider.install.prereq")}
              </Paragraph>
              <CopyBlock text={unix} />
              <Paragraph style={{ margin: "8px 0 0", color: "var(--manager-text-muted)" }}>
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
              <Paragraph style={{ marginBottom: 10, color: "var(--manager-text-muted)" }}>
                {t("provider.install.prereq")}
              </Paragraph>
              <CopyBlock text={windows} />
              <Paragraph style={{ margin: "8px 0 0", color: "var(--manager-text-muted)" }}>
                {t("provider.install.windowsHint")}
              </Paragraph>
            </>
          ),
        },
      ]}
    />
  );
}
