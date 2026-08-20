"use client";

import { Suspense } from "react";
import { LoginFormCard } from "./components/LoginFormCard";
import { Select, Spin } from "antd";
import { AppLocale, SUPPORTED_LOCALES, TranslationKey, useLocale } from "@/i18n/LocaleProvider";

export default function LoginPage() {
  const { locale, setLocale, t } = useLocale();

  return (
    <main className="manager-login-shell">
      <section
        className="manager-grid-bg manager-login-panel"
        style={{
          width: "100%",
        }}
      >
        <Select
          aria-label={t("locale.label")}
          className="manager-login-locale-select"
          value={locale}
          onChange={(value) => setLocale(value as AppLocale)}
          options={SUPPORTED_LOCALES.map((item) => ({
            value: item,
            label: t(`locale.${item}` as TranslationKey),
          }))}
        />
        <div
          style={{
            position: "relative",
            zIndex: 1,
            minHeight: "calc(100vh - 96px)",
            display: "grid",
            placeItems: "center",
          }}
        >
          <div style={{ width: "100%", maxWidth: 440 }}>
            {/* LoginFormCard 读 ?redirect=，静态预渲染时必须有 Suspense 边界。 */}
            <Suspense fallback={<div style={{ display: "grid", placeItems: "center", minHeight: 320 }}><Spin size="large" /></div>}>
              <LoginFormCard />
            </Suspense>
          </div>
        </div>
      </section>
    </main>
  );
}
