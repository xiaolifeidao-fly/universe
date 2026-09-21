"use client";

/**
 * 「拿到密钥之后怎么用」。
 *
 * 签发那一刻人手里只有一串 sk-galaxy-…，而它要落到的是本机某个客户端的配置文件 ——
 * 这一步没人告诉他怎么走，密钥就停在剪贴板里。下面「接入方式」给的是**填什么**，
 * 这张卡回答的是**走哪条路**，两张卡是一前一后的关系，不是同一件事说两遍。
 *
 * 三条路按「要动的手最少」排：
 *   1. 平台客户端（Orbit）：点一下就写好，但只有桌面壳里有这个按钮。
 *   2. cc-switch：第三方开源的配置管理器。手里不止一把密钥、或者同时接着好几家的人，
 *      靠它切换比每次手改配置文件省事得多 —— 这是我们自己不打算做的那一块。
 *   3. 手填：谁都能走，接到别的机器上也只有这一条。
 *
 * 第一条在浏览器里、而且这套部署又没登记安装包时整条不画：那种情况下「去下载客户端」
 * 指向的是一个不存在的东西，留着只会让人去找一个找不到的按钮。
 *
 * 三条路共用同一句收尾 —— 配置是**启动时读一次**的，不退出重开，改了也不生效。
 * 这句话放在这里而不是只放在「使用」之后：走另外两条路的人同样会踩。
 */

import { message } from "antd";
import type { ReactNode } from "react";
import { IconDownload, IconMonitor, IconPlug, IconSliders } from "@/components/ui/icons";
import { Btn, Card, CardHead, Note } from "@/components/ui/kit";
import { useLocale, type TranslationKey } from "@/i18n/LocaleProvider";
import { copyText } from "@/utils/format";
import { openExternal } from "@/utils/shell";

/**
 * cc-switch 的下载页。
 *
 * 写死在前端，不做成运行参数：它是一个有名有姓的第三方开源项目，不是这套部署
 * 自己托管的安装包（那几条才归 client.consumer_download_url）。做成参数的结果是
 * 每套部署都得填一遍同一个地址，漏填的那套就少一条路。
 */
const CC_SWITCH_URL = "https://github.com/farion1231/cc-switch/releases";

/** 一条路：图标、标题、一句说明，末尾可能有一个动作。 */
function Route({ icon, title, desc, action }: { icon: ReactNode; title: string; desc: string; action?: ReactNode }) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "auto minmax(0, 1fr) auto",
        alignItems: "center",
        gap: 14,
        padding: "12px 0",
        borderTop: "1px solid var(--gx-line)",
      }}
    >
      <span style={{ color: "var(--gx-faint)", display: "flex" }}>{icon}</span>
      <span style={{ display: "flex", flexDirection: "column", gap: 3, minWidth: 0 }}>
        <span style={{ fontSize: 13, fontWeight: 600 }}>{title}</span>
        <span className="gx-card__hint">{desc}</span>
      </span>
      {action ?? <span />}
    </div>
  );
}

export function UsageGuide({ desktop, hasDownload }: { desktop: boolean; hasDownload: boolean }) {
  const { t } = useLocale();

  // 桌面壳里 window.open 被拦，只能交给主进程去开；旧版壳里连那条通道都没有，
  // 那就把地址复制给他自己去浏览器里开 —— 点了什么都不发生是最糟的一种结果。
  const openCcSwitch = async () => {
    try {
      if (await openExternal(CC_SWITCH_URL)) return;
      if (await copyText(CC_SWITCH_URL)) message.info(t("guide.ccswitch.copied"));
      else message.info(t("guide.ccswitch.manual", { url: CC_SWITCH_URL }));
    } catch (error) {
      message.error((error as Error).message || t("common.actionFailed"));
    }
  };

  // 浏览器里这一条指向的是「去装桌面客户端」，那得先有安装包可下。
  const orbitDesc: TranslationKey | null = desktop ? "guide.orbit.desktop" : hasDownload ? "guide.orbit.browser" : null;

  return (
    <Card className="gx-rise">
      <CardHead title={t("guide.title")} hint={t("guide.hint")} />
      <div style={{ padding: "0 18px 18px", display: "flex", flexDirection: "column" }}>
        {orbitDesc ? <Route icon={<IconMonitor size={17} />} title={t("guide.orbit.title")} desc={t(orbitDesc)} /> : null}
        <Route
          icon={<IconSliders size={17} />}
          title={t("guide.ccswitch.title")}
          desc={t("guide.ccswitch.desc")}
          action={
            <Btn tone="ghost" small icon={<IconDownload size={14} />} onClick={() => void openCcSwitch()}>
              {t("guide.ccswitch.open")}
            </Btn>
          }
        />
        <Route icon={<IconPlug size={17} />} title={t("guide.manual.title")} desc={t("guide.manual.desc")} />
        <div style={{ paddingTop: 14 }}>
          <Note tone="warn">{t("guide.restart")}</Note>
        </div>
      </div>
    </Card>
  );
}
