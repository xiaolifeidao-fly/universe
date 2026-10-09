"use client";

import { TranslationOutlined } from "@ant-design/icons";
import { Dropdown } from "antd";
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
    <main className="manager-login">
      <LoginHero />
      <section className="manager-login-main">
        <div className="manager-login-locale">
          <Dropdown
            trigger={["click"]}
            placement="bottomRight"
            menu={{
              selectable: true,
              selectedKeys: [locale],
              items: LOCALE_OPTIONS.map((item) => ({ key: item.value, label: t(item.labelKey) })),
              onClick: ({ key }) => setLocale(key as typeof locale),
            }}
          >
            <button type="button" className="manager-icon-button" aria-label={t("locale.label")} style={{ width: "auto", padding: "0 10px", gap: 6, display: "inline-flex", alignItems: "center", fontSize: 13 }}>
              <TranslationOutlined />
              {t(locale === "zh-CN" ? "locale.zh-CN" : "locale.en-US")}
            </button>
          </Dropdown>
        </div>
        <LoginFormCard />
      </section>
    </main>
  );
}
