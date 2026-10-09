"use client";

import { GlobalOutlined, KeyOutlined, SettingOutlined, StarFilled } from "@ant-design/icons";
import { useLocale } from "@/i18n/LocaleProvider";

const FEATURES = [
  { icon: <KeyOutlined />, titleKey: "login.hero.feature1.title", descKey: "login.hero.feature1.desc" },
  { icon: <SettingOutlined />, titleKey: "login.hero.feature2.title", descKey: "login.hero.feature2.desc" },
  { icon: <GlobalOutlined />, titleKey: "login.hero.feature3.title", descKey: "login.hero.feature3.desc" },
] as const;

/** 登录页左侧的品牌面板：深色星轨底 + 一句话 + 三个能力点。窄屏整块隐藏，只留表单。 */
export function LoginHero() {
  const { t } = useLocale();

  return (
    <aside className="manager-login-art" aria-hidden="true">
      <div className="manager-login-orbit">
        <i />
        <i />
      </div>

      <div className="manager-login-art-brand">
        <div className="manager-crest">
          <GlobalOutlined className="manager-crest-planet" />
          <StarFilled className="manager-crest-star" />
        </div>
        {t("brand.name")}
      </div>

      <div className="manager-login-art-copy">
        <h2>{t("login.hero.tagline")}</h2>
        <ul className="manager-login-art-features">
          {FEATURES.map((feature) => (
            <li key={feature.titleKey}>
              {feature.icon}
              <span>
                <b>{t(feature.titleKey)}</b>
                <small>{t(feature.descKey)}</small>
              </span>
            </li>
          ))}
        </ul>
      </div>

      <div className="manager-login-art-foot">© {new Date().getFullYear()} Galaxy</div>
    </aside>
  );
}
