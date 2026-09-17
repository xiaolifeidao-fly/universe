"use client";

/**
 * 顶栏。吸顶 + 滚动后才出下边框 —— 首屏不该被一条横线切开。
 *
 * 「控制台」是**站外**链接：它指向控制台（Orbit），通常部署在另一个域。
 * 所以它是普通 <a>，不走 next/link（见 kit.tsx 里 LinkBtn 的注释）。
 */

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { useLocale } from "@/i18n/LocaleProvider";
import { NAV_ITEMS } from "@/utils/site";
import { useSiteConfig } from "@/components/site/SiteConfigProvider";
import { BrandMark, IconArrowRight, IconClose, IconGlobe, IconMenu } from "./icons";
import { LinkBtn } from "./kit";

function isActive(pathname: string, href: string): boolean {
  return href === "/" ? pathname === "/" : pathname.startsWith(href);
}

export function Header() {
  const pathname = usePathname() ?? "/";
  const { locale, setLocale, t } = useLocale();
  const siteConfig = useSiteConfig();
  const [scrolled, setScrolled] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  // 换页就把抽屉收起来。不收的话点完一条导航，抽屉还盖在新页面上。
  useEffect(() => setMenuOpen(false), [pathname]);

  return (
    <header className="gp-header" data-scrolled={scrolled}>
      <div className="gp-page">
        <div className="gp-header__bar">
          <Link className="gp-brand" href="/" aria-label={t("brand.name")}>
            <BrandMark className="gp-brand__mark" />
            <span className="gp-brand__name">{t("brand.name")}</span>
            <span className="gp-brand__tag">{t("brand.tag")}</span>
          </Link>

          <nav className="gp-nav">
            {NAV_ITEMS.map((item) => (
              <Link
                key={item.href}
                className="gp-nav__link"
                href={item.href}
                data-active={isActive(pathname, item.href)}
              >
                {t(item.key)}
              </Link>
            ))}
          </nav>

          <div className="gp-header__actions">
            <button
              type="button"
              className="gp-btn gp-btn--quiet gp-btn--sm gp-lang"
              onClick={() => setLocale(locale === "zh-CN" ? "en-US" : "zh-CN")}
              aria-label={t("locale.switch")}
              title={t("locale.switch")}
            >
              <IconGlobe size={17} />
              <span>{locale === "zh-CN" ? "EN" : "中"}</span>
            </button>
            <LinkBtn href={siteConfig.consoleURL} size="sm">
              {t("nav.console")}
              <IconArrowRight size={15} />
            </LinkBtn>
            <button
              type="button"
              className="gp-burger"
              aria-label={t("nav.menu")}
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((open) => !open)}
            >
              {menuOpen ? <IconClose size={19} /> : <IconMenu size={19} />}
            </button>
          </div>
        </div>

        <div className="gp-drawer" data-open={menuOpen}>
          <div className="gp-drawer__inner">
            <div className="gp-drawer__list">
              {NAV_ITEMS.map((item) => (
                <Link key={item.href} className="gp-drawer__link" href={item.href}>
                  {t(item.key)}
                </Link>
              ))}
              <a className="gp-drawer__link" href={siteConfig.consoleURL}>
                {t("nav.console")}
              </a>
              {/* 窄屏顶栏放不下语言开关，收到抽屉里 —— 藏起来不等于拿掉。 */}
              <div className="gp-drawer__lang">
                <button
                  type="button"
                  className="gp-btn gp-btn--quiet gp-btn--sm"
                  onClick={() => setLocale(locale === "zh-CN" ? "en-US" : "zh-CN")}
                >
                  <IconGlobe size={17} />
                  <span>{t(locale === "zh-CN" ? "locale.en-US" : "locale.zh-CN")}</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </header>
  );
}
