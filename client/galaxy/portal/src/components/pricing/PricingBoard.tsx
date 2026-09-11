"use client";

/**
 * 定价页。三段：怎么算 → 买哪个包 → 单价表。
 *
 * 顺序是故意的：先让人明白「按 token 分项计费」这件事，再看包，最后才是那张
 * 谁都不会逐行读的单价表。反过来排的话，第一眼就是一张表，人会直接关掉。
 *
 * 包与单价全部来自服务端，一个数字都不在前端写死 —— 门户上写的和控制台下单时
 * 收的必须是同一份数据，否则用户会在付款页上第一次发现价格不一样。
 */

import { kindLabel, unitLabel, useLocale } from "@/i18n/LocaleProvider";
import { Card, Empty, Faq, LinkBtn, Section, SectionHead, Tag } from "@/components/site/kit";
import { IconArrowRight, IconGauge, IconReceipt, IconShield } from "@/components/site/icons";
import { CtaBand, PageHero } from "@/components/home/HomeSections";
import { formatAmount, formatUnitPrice, formatUnitValue } from "@/utils/format";
import { siteConfig } from "@/utils/site";
import type { PortalOverview, PortalPackage } from "@/utils/portal";

const HOW_ICONS = [<IconGauge key="1" />, <IconReceipt key="2" />, <IconShield key="3" />];

export function PricingBoard({ overview }: { overview: PortalOverview }) {
  const { t } = useLocale();
  const { packages, prices } = overview;

  // 「最常买」标在运营自己排的第二个上。
  //
  // 不按价格排序去找第二便宜的：目录里混着视频渲染这种另一个计价维度的包，
  // 按价格排会把它顶到主推位。服务端已经按 (sort_order, package_code) 给好了顺序，
  // 那就是运营想让人看到的顺序，第二个通常正是「试过之后真的会买」的那一档。
  // 少于三个包就不标 —— 一共两个还挑一个主推，那只是在替人做选择。
  const featuredCode = packages.length >= 3 ? packages[1].packageCode : "";

  return (
    <>
      <PageHero eyebrow={t("nav.pricing")} title={t("pricing.title")} lead={t("pricing.lead")} />

      <Section>
        <div className="gp-grid gp-grid--3">
          {[1, 2, 3].map((no, index) => (
            <Card key={no}>
              <span
                style={{
                  display: "grid",
                  placeItems: "center",
                  width: 36,
                  height: 36,
                  borderRadius: 11,
                  background: "var(--gp-accent-soft)",
                  color: "var(--gp-accent-ink)",
                  marginBottom: 14,
                }}
              >
                {HOW_ICONS[index]}
              </span>
              <h3 className="gp-h3">{t(`pricing.how.${no}.title` as "pricing.how.1.title")}</h3>
              <p className="gp-body" style={{ marginTop: 8, fontSize: 13.5 }}>
                {t(`pricing.how.${no}.body` as "pricing.how.1.body")}
              </p>
            </Card>
          ))}
        </div>
      </Section>

      <Section tight>
        <SectionHead title={t("pricing.packages")} lead={t("pricing.packagesLead")} />
        {packages.length === 0 ? (
          <Empty title={t("pricing.emptyPackages")} hint={t("pricing.emptyPackagesHint")} />
        ) : (
          <div className={`gp-grid gp-grid--${Math.min(packages.length, 4) === 4 ? "4" : "3"}`}>
            {packages.map((item) => (
              <PlanCard key={item.packageCode} plan={item} featured={item.packageCode === featuredCode} />
            ))}
          </div>
        )}
      </Section>

      <Section tight>
        <SectionHead title={t("pricing.unitPrices")} lead={t("pricing.unitPricesLead")} />
        {prices.length === 0 ? (
          <Empty title={t("pricing.emptyPrices")} hint={t("pricing.emptyPricesHint")} />
        ) : (
          <Card style={{ padding: "20px 10px 10px" }}>
            <div className="gp-scroll-x">
              <table className="gp-table">
                <thead>
                  <tr>
                    <th>{t("pricing.table.kind")}</th>
                    <th>{t("pricing.table.unit")}</th>
                    <th style={{ textAlign: "right" }}>{t("pricing.table.price")}</th>
                  </tr>
                </thead>
                <tbody>
                  {prices.map((line) => (
                    <tr key={`${line.kind}-${line.unit}`}>
                      <td>
                        {kindLabel(line.kind, t)}
                        <span className="gp-mono" style={{ display: "block", fontSize: 11, color: "var(--gp-faint)", fontWeight: 400 }}>
                          {line.kind}
                        </span>
                      </td>
                      <td>{unitLabel(line.unit, t)}</td>
                      <td className="num">{formatUnitPrice(line.price, line.currency)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        )}
      </Section>

      <Section id="faq" tight>
        <SectionHead title={t("pricing.faqTitle")} />
        <Faq
          items={[4, 1, 5, 6].map((no) => ({
            q: t(`home.faq.${no}.q` as "home.faq.1.q"),
            a: t(`home.faq.${no}.a` as "home.faq.1.a"),
          }))}
        />
      </Section>

      <div style={{ paddingBottom: "clamp(32px, 5vw, 72px)" }}>
        <CtaBand />
      </div>
    </>
  );
}

function PlanCard({ plan, featured }: { plan: PortalPackage; featured: boolean }) {
  const { t } = useLocale();
  const units = Object.entries(plan.units ?? {});

  return (
    <div className="gp-card gp-card--lift gp-plan" data-featured={featured}>
      {featured ? <span className="gp-plan__flag">{t("pricing.featured")}</span> : null}

      <div>
        <h3 className="gp-h3">{plan.title}</h3>
        <div className="gp-plan__price" style={{ marginTop: 10 }}>
          <b>{formatAmount(plan.amount, plan.currency)}</b>
          <span>{t("pricing.ttl", { days: plan.ttlDays })}</span>
        </div>
      </div>

      <hr className="gp-rule" />

      <div className="gp-plan__units">
        <span style={{ fontSize: 11.5, letterSpacing: "0.04em", textTransform: "uppercase", color: "var(--gp-faint)", fontWeight: 650 }}>
          {t("pricing.includes")}
        </span>
        {units.map(([unit, amount]) => (
          <div className="gp-plan__unit" key={unit}>
            <span>{unitLabel(unit, t)}</span>
            <b>{formatUnitValue(unit, amount)}</b>
          </div>
        ))}
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        <Tag>{t("pricing.limits", { concurrency: plan.concurrency, rpm: plan.rpm })}</Tag>
        {(plan.allowedKinds ?? []).map((kind) => (
          <Tag key={kind}>{kind}</Tag>
        ))}
      </div>

      <div style={{ marginTop: "auto" }}>
        <LinkBtn href={siteConfig.consoleURL} tone={featured ? "primary" : "ghost"} className="gp-plan__buy">
          {t("pricing.buy")}
          <IconArrowRight size={16} />
        </LinkBtn>
      </div>
    </div>
  );
}
