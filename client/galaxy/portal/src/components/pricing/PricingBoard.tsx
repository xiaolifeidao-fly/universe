"use client";

/**
 * 定价页。两段：怎么算 → 单价表。
 *
 * 顺序是故意的：先让人明白「按 token 分项计费」这件事，再看那张谁都不会逐行读的
 * 单价表。反过来排的话，第一眼就是一张表，人会直接关掉。
 *
 * 没有套餐：额度不是打包卖的，账户里充多少积分就能用多少，调一次按单价扣一次。
 *
 * 单价全部来自服务端，一个数字都不在前端写死 —— 门户上写的和真正扣的必须是
 * 同一份数据，否则用户会在账单上第一次发现价格不一样。
 */

import { kindLabel, unitLabel, useLocale } from "@/i18n/LocaleProvider";
import { Card, Empty, Faq, Section, SectionHead } from "@/components/site/kit";
import { IconGauge, IconReceipt, IconShield } from "@/components/site/icons";
import { CtaBand, PageHero } from "@/components/home/HomeSections";
import { formatUnitPrice } from "@/utils/format";
import type { PortalOverview } from "@/utils/portal";

const HOW_ICONS = [<IconGauge key="1" />, <IconReceipt key="2" />, <IconShield key="3" />];

export function PricingBoard({ overview }: { overview: PortalOverview }) {
  const { t } = useLocale();
  const { prices } = overview;

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
