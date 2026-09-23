"use client";

import { Select } from "antd";
import { LoginFormCard } from "./components/LoginFormCard";
import { LoginHero } from "./components/LoginHero";
import { useLocale } from "@/i18n/LocaleProvider";

const LOCALE_OPTIONS = [
  { value: "zh-CN", labelKey: "locale.zh-CN" },
  { value: "en-US", labelKey: "locale.en-US" },
] as const;

export default function LoginPage() {
  const { locale, setLocale, t } = useLocale();

  return (
    <main className="manager-login-shell">
      <section className="manager-grid-bg manager-login-panel" style={{ width: "100%" }}>
        <Select
          aria-label={t("locale.label")}
          className="manager-login-locale-select"
          value={locale}
          onChange={(value) => setLocale(value as typeof locale)}
          options={LOCALE_OPTIONS.map((item) => ({ value: item.value, label: t(item.labelKey) }))}
        />
        <div className="manager-login-layout">
          <LoginHero />
          <div className="manager-login-layout__form">
            <LoginFormCard />
          </div>
        </div>
      </section>
    </main>
  );
}
