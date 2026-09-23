"use client";

/**
 * 首屏。
 *
 * 这一屏只回答一件事：这里能调哪些模型、怎么调。
 * 原来挂在按钮下面的服务地址和那排统计数字都撤了 —— 地址在「三步接入」的代码块和模型页里
 * 各有一份，而模型数、厂商数这类数字是运营口径，不是陌生人第一眼该读的东西。
 * 剩下这三条要点仍然只写服务端真有的事实，「5000+ 开发者」这种没有出处的话一句都不放。
 */

import { useLocale } from "@/i18n/LocaleProvider";
import { LinkBtn, Page } from "@/components/site/kit";
import { IconArrowRight, IconCheck } from "@/components/site/icons";
import { OrbitDiagram } from "@/components/home/OrbitDiagram";
import { useSiteConfig } from "@/components/site/SiteConfigProvider";
import type { PortalOverview } from "@/utils/portal";

export function Hero({ overview }: { overview: PortalOverview }) {
  const { t } = useLocale();
  const siteConfig = useSiteConfig();

  const points = [t("home.hero.point1"), t("home.hero.point2"), t("home.hero.point3")];
  const vendors = Array.from(new Set(overview.models.map((model) => model.vendor).filter(Boolean))) as string[];

  return (
    <section className="gp-hero">
      <div className="gp-hero__wash" />
      <div className="gp-hero__grid" />
      <Page>
        <div className="gp-hero__inner">
          <div className="gp-hero__copy">
            <span className="gp-eyebrow">
              <span className="gp-dot" />
              {t("home.hero.eyebrow")}
            </span>

            {/* 标题写死两行：交给浏览器断行会在中文的「和」后面断开，
                一个悬着的连词是排版事故，不是随机结果。 */}
            <h1 className="gp-h1">
              {t("home.hero.title")}
              <br />
              {t("home.hero.title2")}
            </h1>
            <p className="gp-lead">{t("home.hero.lead")}</p>

            <div className="gp-hero__cta">
              <LinkBtn href={siteConfig.consoleURL} size="lg">
                {t("home.hero.primary")}
                <IconArrowRight size={17} />
              </LinkBtn>
            </div>

            <ul className="gp-hero__points">
              {points.map((point) => (
                <li className="gp-hero__point" key={point}>
                  <IconCheck className="gp-hero__point-mark" />
                  <span>{point}</span>
                </li>
              ))}
            </ul>
          </div>

          <OrbitDiagram vendors={vendors} />
        </div>
      </Page>
    </section>
  );
}
