"use client";

import { Suspense } from "react";
import { LoginFormCard } from "./components/LoginFormCard";
import { LoginHero } from "./components/LoginHero";
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
        <div className="manager-login-layout">
          <LoginHero />
          <div className="manager-login-layout__form">
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
