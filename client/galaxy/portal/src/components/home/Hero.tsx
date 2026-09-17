"use client";

/**
 * 首屏。
 *
 * 那排数字全部来自服务端真有的事实（模型数、上游厂商数、最低充值、可用性承诺）。
 * 「5000+ 开发者」这种没有出处的数字一个都不放 —— 门户上第一眼看到的数字如果是编的，
 * 后面写什么都不作数了。可用性那格没配就换成起步并发，宁可少说也不许诺。
 */

import { useLocale } from "@/i18n/LocaleProvider";
import { Btn, LinkBtn, Page, useCopy } from "@/components/site/kit";
import { IconArrowRight, IconCheck, IconCopy } from "@/components/site/icons";
import { OrbitDiagram } from "@/components/home/OrbitDiagram";
import { formatAmount, formatInt } from "@/utils/format";
import { useSiteConfig } from "@/components/site/SiteConfigProvider";
import type { PortalOverview } from "@/utils/portal";

interface StatItem {
  value: string;
  unit?: string;
  label: string;
}

export function Hero({ overview }: { overview: PortalOverview }) {
  const { t } = useLocale();
  const siteConfig = useSiteConfig();
  const { stats } = overview;
  const copier = useCopy();

  const items: StatItem[] = [
    { value: formatInt(stats.models), unit: t("home.stat.unitModel"), label: t("home.stat.models") },
    { value: formatInt(stats.vendors), unit: t("home.stat.unitVendor"), label: t("home.stat.vendors") },
    {
      value: stats.minTopup > 0 ? formatAmount(stats.minTopup, stats.currency) : "—",
      label: t("home.stat.minTopup"),
    },
    stats.availability
      ? { value: stats.availability, label: t("home.stat.availability") }
      : {
          value: formatInt(stats.concurrency),
          unit: t("home.stat.unitConcurrency"),
          label: t("home.stat.concurrency"),
        },
  ];

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
              <LinkBtn href="/pricing" tone="ghost" size="lg">
                {t("home.hero.secondary")}
              </LinkBtn>
            </div>

            {/* 服务地址：陌生人最想知道的技术事实之一，直接摆出来，还能一键复制。 */}
            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              <span style={{ fontSize: 12, color: "var(--gp-faint)", fontWeight: 600 }}>
                {t("home.hero.endpoint")}
              </span>
              <code
                className="gp-mono"
                style={{
                  fontSize: 12.5,
                  padding: "6px 10px",
                  borderRadius: 8,
                  border: "1px solid var(--gp-line)",
                  background: "var(--gp-surface)",
                  color: overview.endpoint ? "var(--gp-ink)" : "var(--gp-faint)",
                }}
              >
                {overview.endpoint || t("home.hero.endpointEmpty")}
              </code>
              {overview.endpoint ? (
                <Btn tone="quiet" size="sm" onClick={() => copier.copy(overview.endpoint)}>
                  {copier.state === "ok" ? <IconCheck /> : <IconCopy />}
                  {copier.state === "ok"
                    ? t("common.copied")
                    : copier.state === "fail"
                      ? t("common.copyFailed")
                      : t("common.copy")}
                </Btn>
              ) : null}
            </div>

            <div className="gp-hero__stats">
              {items.map((item) => (
                <div key={item.label} className="gp-stat">
                  <div className="gp-stat__value">
                    <span>{item.value}</span>
                    {item.unit ? <span className="gp-stat__unit">{item.unit}</span> : null}
                  </div>
                  <div className="gp-stat__label" title={item.label}>
                    {item.label}
                  </div>
                </div>
              ))}
            </div>
          </div>

          <OrbitDiagram vendors={vendors} />
        </div>
      </Page>
    </section>
  );
}
