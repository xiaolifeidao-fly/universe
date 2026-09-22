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

/**
 * 公开单价表上一律不露出的计量单位：缓存写入的**合计**。
 *
 * 它是 5m 与 1h 两档加出来的数，服务端的 derivedUnits 永远不让它进账本 ——
 * 标一个不会被收的价，等于在价目表上多报一笔钱。
 *
 * 两个 TTL 分项照常标价：它们是真正进账本的那一层，而且金额不小
 * （5 分钟档是输入价的 1.25 倍，1 小时档是 2 倍）。不标的话，一个大量用缓存的人
 * 按这张表算出来的成本会明显低于他真会付的数 —— 那比多两行更容易让人算错。
 */
const HIDDEN_UNITS = new Set(["llm.cache_write_tokens"]);

/**
 * 只对 Claude 一族成立的计量单位：按 TTL 分档报 cache_creation 的只有 Anthropic，
 * Codex 一族的 usage 里压根没有这个数。
 *
 * 这张表是跨模型的一张通用表，没有「按族筛」这回事，所以行照摆、旁边标一句
 * 「仅 Claude」。不标的话，用 Codex 的人会以为自己也要付这两笔。
 */
const CLAUDE_ONLY_UNITS = new Set(["llm.cache_write_5m_tokens", "llm.cache_write_1h_tokens"]);


export function PricingBoard({ overview }: { overview: PortalOverview }) {
  const { t } = useLocale();
  const prices = overview.prices.filter((line) => !HIDDEN_UNITS.has(line.unit));

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
                      <td>
                        {unitLabel(line.unit, t)}
                        {CLAUDE_ONLY_UNITS.has(line.unit) ? (
                          <span style={{ display: "block", fontSize: 11, color: "var(--gp-faint)", fontWeight: 400 }}>
                            {t("pricing.claudeOnly")}
                          </span>
                        ) : null}
                      </td>

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
