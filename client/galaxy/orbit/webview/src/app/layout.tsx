import { productConfig } from "@/utils/product";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { AntdRegistry } from "@ant-design/nextjs-registry";
import { AppLocaleProvider } from "@/i18n/LocaleProvider";
import "./globals.css";

export const metadata: Metadata = {
  title: `Galaxy ${productConfig.name}`,
  description: "Claude 与 GPT 统一接入：密钥、额度、账单与使用记录。",
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
