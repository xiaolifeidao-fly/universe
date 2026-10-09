import type { Metadata } from "next";
import type { ReactNode } from "react";
import { AntdRegistry } from "@ant-design/nextjs-registry";
import { ConfigProvider } from "antd";
import { AppLocaleProvider } from "@/i18n/LocaleProvider";
import "./globals.css";

export const metadata: Metadata = {
  title: "Galaxy 管理端",
  description: "Galaxy 管理端 · 账号、配置与系统状态",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body>
        <AntdRegistry>
          <AppLocaleProvider>
            {/* 嵌在 AppLocaleProvider 里面：主题和语言从外层继承，这里只补两条交互默认值 ——
                按钮里两个汉字之间不自动插空格（「确 定」读起来像排版事故），点击不出水波纹。 */}
            <ConfigProvider button={{ autoInsertSpace: false }} wave={{ disabled: true }}>
              {children}
            </ConfigProvider>
          </AppLocaleProvider>
        </AntdRegistry>
      </body>
    </html>
  );
}
