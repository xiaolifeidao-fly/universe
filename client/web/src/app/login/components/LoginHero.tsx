"use client";

import {
  ClockCircleOutlined,
  FileTextOutlined,
  GlobalOutlined,
  StarFilled,
  TableOutlined,
} from "@ant-design/icons";
import { useLocale } from "@/i18n/LocaleProvider";

const FEATURES = [
  { icon: <FileTextOutlined />, titleKey: "login.hero.feature1.title", descKey: "login.hero.feature1.desc" },
  { icon: <TableOutlined />, titleKey: "login.hero.feature2.title", descKey: "login.hero.feature2.desc" },
  { icon: <ClockCircleOutlined />, titleKey: "login.hero.feature3.title", descKey: "login.hero.feature3.desc" },
  { icon: <GlobalOutlined />, titleKey: "login.hero.feature4.title", descKey: "login.hero.feature4.desc" },
] as const;

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
