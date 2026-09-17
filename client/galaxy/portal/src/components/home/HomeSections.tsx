"use client";

/**
 * 首页除首屏之外的几段：三步接入、为什么、模型预览、FAQ、收尾。
 *
 * 都是客户端组件，因为文案要跟着语言开关走；数据由服务端组件取好之后当 props 传下来
 * （见 app/(site)/page.tsx）—— 门户的内容必须进首屏 HTML，不能是一圈转菊花。
 */

import Link from "next/link";
import { familyLabel, useLocale } from "@/i18n/LocaleProvider";
import { Card, Faq, LinkBtn, Page, Section, SectionHead, Tag, TextLink, familyColor } from "@/components/site/kit";
import {
  IconArrowRight,
  IconGauge,
  IconKey,
  IconLock,
  IconPlug,
  IconReceipt,
  IconShield,
  IconSnow,
} from "@/components/site/icons";
import { CodeTabs } from "@/components/home/CodeTabs";
import { formatContext, formatUnitPrice } from "@/utils/format";
import { useSiteConfig } from "@/components/site/SiteConfigProvider";
import type { PortalModel, PortalOverview } from "@/utils/portal";
import type { ReactNode } from "react";

/* ---------- 三步接入 ---------- */

export function Steps({ overview }: { overview: PortalOverview }) {
  const { t } = useLocale();
  const siteConfig = useSiteConfig();
  const sample = overview.models.find((model) => model.featured) ?? overview.models[0];

  return (
    <Section id="start">
      <div className="gp-steps">
        <div>
          <SectionHead eyebrow={t("home.steps.eyebrow")} title={t("home.steps.title")} lead={t("home.steps.lead")} />
          <div>
            {[1, 2, 3].map((no) => (
              <div className="gp-step" key={no}>
                <span className="gp-step__no">{no}</span>
                <div>
                  <h3 className="gp-h3">{t(`home.steps.${no}.title` as "home.steps.1.title")}</h3>
                  <p className="gp-body" style={{ marginTop: 6 }}>
                    {t(`home.steps.${no}.body` as "home.steps.1.body")}
                  </p>
                </div>
              </div>
            ))}
          </div>
          <div style={{ marginTop: 22 }}>
            <LinkBtn href={siteConfig.consoleURL}>
              {t("home.hero.primary")}
              <IconArrowRight size={16} />
            </LinkBtn>
          </div>
        </div>
        <CodeTabs endpoint={overview.endpoint} model={sample?.modelId ?? ""} />
      </div>
    </Section>
  );
}

/* ---------- 为什么是这里 ---------- */

const FEATURE_ICONS: ReactNode[] = [
  <IconPlug key="plug" />,
  <IconGauge key="gauge" />,
  <IconReceipt key="receipt" />,
  <IconKey key="key" />,
  <IconSnow key="snow" />,
  <IconShield key="shield" />,
];

export function Features({ overview }: { overview: PortalOverview }) {
  const { t } = useLocale();
  return (
    <Section>
      <SectionHead eyebrow={t("home.why.eyebrow")} title={t("home.why.title")} lead={t("home.why.lead")} />
      <div className="gp-grid gp-grid--3">
        {[1, 2, 3, 4, 5, 6].map((no, index) => (
          <Card key={no} lift>
            <span
              style={{
                display: "grid",
                placeItems: "center",
                width: 38,
                height: 38,
                borderRadius: 11,
                background: "var(--gp-accent-soft)",
                color: "var(--gp-accent-ink)",
                marginBottom: 16,
              }}
            >
              {FEATURE_ICONS[index]}
            </span>
            <h3 className="gp-h3">{t(`home.why.${no}.title` as "home.why.1.title")}</h3>
            <p className="gp-body" style={{ marginTop: 8 }}>
              {t(`home.why.${no}.body` as "home.why.1.body", { freeze: overview.stats.freezeDays })}
            </p>
          </Card>
        ))}
      </div>
    </Section>
  );
}

/* ---------- 模型预览 ---------- */

export function ModelPeek({ models }: { models: PortalModel[] }) {
  const { t } = useLocale();
  // 先挑精选，不够就按排序补 —— 首页这一排永远是满的。
  const featured = models.filter((model) => model.featured);
  const picked = [...featured, ...models.filter((model) => !model.featured)].slice(0, 3);
  if (picked.length === 0) return null;

  return (
    <Section tight>
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: 16,
          alignItems: "flex-end",
          justifyContent: "space-between",
          marginBottom: 26,
        }}
      >
        <SectionHead eyebrow={t("home.models.eyebrow")} title={t("home.models.title")} lead={t("home.models.lead")} />
        <div style={{ paddingBottom: 6 }}>
          <TextLink href="/models" arrow>
            {t("common.viewModels")}
          </TextLink>
        </div>
      </div>
      <div className="gp-grid gp-grid--3">
        {picked.map((model) => (
          <ModelCard key={model.modelId} model={model} />
        ))}
      </div>
    </Section>
  );
}

/** 模型卡片。首页和模型页共用一份 —— 同一个东西在两处长得不一样是最廉价的不一致。 */
export function ModelCard({ model }: { model: PortalModel }) {
  const { t } = useLocale();
  const context = formatContext(model.contextTokens ?? 0);

  return (
    <Card lift className="gp-model">
      <div className="gp-model__head">
        <span className="gp-model__mark" style={{ background: familyColor(model.family) }}>
          {(model.displayName || model.modelId).slice(0, 1).toUpperCase()}
        </span>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="gp-model__id">{model.modelId}</div>
          <div className="gp-model__vendor">
            {familyLabel(model.family, t)}
            {context ? ` · ${t("models.context")} ${context}` : ""}
          </div>
        </div>
        {!model.priced ? (
          <span className="gp-tag" title={t("common.unifiedHint")}>
            {t("common.unified")}
          </span>
        ) : null}
      </div>

      {model.summary ? (
        <p className="gp-body" style={{ fontSize: 13.5, lineHeight: 1.65 }}>
          {model.summary}
        </p>
      ) : null}

      <div className="gp-model__price">
        <div className="gp-model__cell">
          <span>{t("models.input")}</span>
          <b>{formatUnitPrice(model.inputPrice, model.currency)}</b>
          <em>/ 1M</em>
        </div>
        <div className="gp-model__cell">
          <span>{t("models.output")}</span>
          <b>{formatUnitPrice(model.outputPrice, model.currency)}</b>
          <em>/ 1M</em>
        </div>
      </div>

      {model.tags && model.tags.length > 0 ? (
        <div className="gp-model__tags">
          {model.tags.map((tag) => (
            <Tag key={tag}>{tag}</Tag>
          ))}
        </div>
      ) : null}
    </Card>
  );
}

/* ---------- FAQ ---------- */

export function HomeFaq() {
  const { t } = useLocale();
  const items = [1, 2, 3, 4, 5, 6].map((no) => ({
    q: t(`home.faq.${no}.q` as "home.faq.1.q"),
    a: t(`home.faq.${no}.a` as "home.faq.1.a"),
  }));
  return (
    <Section id="faq">
      <SectionHead eyebrow={t("home.faq.eyebrow")} title={t("home.faq.title")} />
      <Faq items={items} />
    </Section>
  );
}

/* ---------- 收尾 ---------- */

export function CtaBand() {
  const { t } = useLocale();
  const siteConfig = useSiteConfig();
  return (
    <Page>
      <div className="gp-cta">
        <div className="gp-cta__grid" />
        <div className="gp-cta__copy">
          <h2 className="gp-h2" style={{ color: "#ffffff" }}>
            {t("home.cta.title")}
          </h2>
          <p>{t("home.cta.body")}</p>
        </div>
        <div className="gp-cta__actions">
          <LinkBtn href={siteConfig.consoleURL} size="lg">
            {t("home.cta.primary")}
            <IconArrowRight size={17} />
          </LinkBtn>
          <Link className="gp-btn gp-btn--ghost gp-btn--lg" href="/contact">
            {t("home.cta.secondary")}
          </Link>
        </div>
      </div>
    </Page>
  );
}

/* ---------- 通用页头 ---------- */

/** 模型页 / 定价页 / 联系页共用的那条页头。 */
export function PageHero({
  eyebrow,
  title,
  lead,
  aside,
}: {
  eyebrow?: ReactNode;
  title: ReactNode;
  lead?: ReactNode;
  aside?: ReactNode;
}) {
  return (
    <section className="gp-hero" style={{ paddingBottom: 0 }}>
      <div className="gp-hero__wash" style={{ height: 420 }} />
      <Page>
        <div style={{ position: "relative", display: "flex", flexWrap: "wrap", gap: 24, justifyContent: "space-between", alignItems: "flex-end" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 14, maxWidth: "60ch" }}>
            {eyebrow ? (
              <span className="gp-eyebrow">
                <span className="gp-dot" />
                {eyebrow}
              </span>
            ) : null}
            <h1 className="gp-h1" style={{ fontSize: "clamp(32px, 4vw, 48px)" }}>
              {title}
            </h1>
            {lead ? <p className="gp-lead">{lead}</p> : null}
          </div>
          {aside}
        </div>
      </Page>
    </section>
  );
}
