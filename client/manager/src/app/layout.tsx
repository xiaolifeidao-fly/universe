import type { Metadata } from "next";
import type { ReactNode } from "react";
import { AntdRegistry } from "@ant-design/nextjs-registry";
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
          <AppLocaleProvider>{children}</AppLocaleProvider>
        </AntdRegistry>
      </body>
    </html>
  );
}
