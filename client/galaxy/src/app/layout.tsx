import type { Metadata } from "next";
import type { ReactNode } from "react";
import { AntdRegistry } from "@ant-design/nextjs-registry";
import { AppLocaleProvider } from "@/i18n/LocaleProvider";
import "./globals.css";

export const metadata: Metadata = {
  title: "Galaxy 共享算力池",
  description: "把闲置算力贡献出去，或者按量买别人的算力",
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
