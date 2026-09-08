"use client";

import { GlobalOutlined, KeyOutlined, SettingOutlined, StarFilled } from "@ant-design/icons";
import { useLocale } from "@/i18n/LocaleProvider";

const FEATURES = [
  { icon: <KeyOutlined />, titleKey: "login.hero.feature1.title", descKey: "login.hero.feature1.desc" },
  { icon: <SettingOutlined />, titleKey: "login.hero.feature2.title", descKey: "login.hero.feature2.desc" },
  { icon: <GlobalOutlined />, titleKey: "login.hero.feature3.title", descKey: "login.hero.feature3.desc" },
] as const;

/** 视觉上和 client/web 的 LoginHero 是同一套语言（品牌区 + slogan + 功能亮点），文案是 manager 自己的。 */
export function LoginHero() {
  const { t } = useLocale();

  return (
    <div className="manager-login-hero">
      <div className="manager-login-hero__glow" aria-hidden="true" />
      <div className="manager-login-hero__grid" aria-hidden="true" />

      <div className="manager-login-hero__brand">
        <div className="manager-crest" aria-hidden="true">
          <GlobalOutlined className="manager-crest-planet" />
          <StarFilled className="manager-crest-star" />
        </div>
        <div className="manager-wordmark">
          <strong>{t("brand.name")}</strong>
          <small>{t("brand.subtitle")}</small>
        </div>
      </div>

      <p className="manager-login-hero__tagline">{t("login.hero.tagline")}</p>

      <ul className="manager-login-hero__features">
        {FEATURES.map((feature) => (
          <li key={feature.titleKey}>
            <span className="manager-login-hero__feature-icon">{feature.icon}</span>
            <span>
              <b>{t(feature.titleKey)}</b>
              <small>{t(feature.descKey)}</small>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
