import type { Metadata } from "next";
import type { ReactNode } from "react";
import { AntdRegistry } from "@ant-design/nextjs-registry";
import { BusinessLineProvider } from "@/business-lines/BusinessLineProvider";
import { AppLocaleProvider } from "@/i18n/LocaleProvider";
import { AIPreferencesProvider } from "@/ai-preferences/AIPreferencesProvider";
import "./globals.css";

export const metadata: Metadata = {
  title: "任务宇宙",
  description: "任务宇宙 · 需求受理与交付协同平台",
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
            <AIPreferencesProvider>
              <BusinessLineProvider>{children}</BusinessLineProvider>
            </AIPreferencesProvider>
          </AppLocaleProvider>
        </AntdRegistry>
      </body>
    </html>
  );
}
