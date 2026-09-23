import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { AntdRegistry } from "@ant-design/nextjs-registry";
import { AppLocaleProvider } from "@/i18n/LocaleProvider";
import { SiteConfigProvider } from "@/components/site/SiteConfigProvider";
import { readSiteConfig } from "@/utils/site.server";
import "./globals.css";

export const metadata: Metadata = {
  // 标题模板让每个页面只写自己那半：模型 / 定价 / 联系我们。
  title: {
    default: "Orbit Galaxy · Claude 与 GPT 统一接入",
    template: "%s · Orbit Galaxy",
  },
  description:
    "改一行 base_url，Claude 和 Codex 照常用。Anthropic 与 OpenAI 两族模型统一接入，额度跟着密钥走，按 token 计费，每一次调用都查得到。",
  keywords: ["Claude API", "OpenAI API", "Codex", "AI 网关", "按 token 计费", "Claude Code"],
  robots: { index: true, follow: true },
};

export const viewport: Viewport = {
  themeColor: "#f7f9f8",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  // 站点配置在这一层读一次就够：它在根布局上，四个页面都在它下面。
  // 读的是**本进程的环境变量**，不是构建时烙进去的常量（见 utils/site.server.ts）。
  const siteConfig = readSiteConfig();

  return (
    <html lang="zh-CN">
      <body>
        <AntdRegistry>
          <SiteConfigProvider value={siteConfig}>
            <AppLocaleProvider>{children}</AppLocaleProvider>
          </SiteConfigProvider>
        </AntdRegistry>
      </body>
    </html>
  );
}
