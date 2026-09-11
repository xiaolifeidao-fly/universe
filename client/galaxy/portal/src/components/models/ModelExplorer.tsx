"use client";

/**
 * 模型页。
 *
 * 筛选与搜索都在浏览器里做：整份清单也就几十条，一次全给、本地过滤，
 * 比每敲一个字母打一次接口快得多，也不会在搜索时把页面刷白。
 *
 * 分栏的计数由服务端算好（overview.families）—— 门户算一遍、控制台再算一遍，
 * 同一个模型迟早会在两处落进不同的栏。
 */

import { useMemo, useState } from "react";
import { familyLabel, useLocale } from "@/i18n/LocaleProvider";
import { Btn, Card, Empty, Section, useCopy } from "@/components/site/kit";
import { IconCheck, IconCopy, IconSearch } from "@/components/site/icons";
import { CtaBand, ModelCard, PageHero } from "@/components/home/HomeSections";
import type { PortalOverview } from "@/utils/portal";

const ALL = "__all__";

export function ModelExplorer({ overview }: { overview: PortalOverview }) {
  const { t } = useLocale();
  const [family, setFamily] = useState<string>(ALL);
  const [keyword, setKeyword] = useState("");
  const copier = useCopy();

  const models = useMemo(() => {
    const needle = keyword.trim().toLowerCase();
    return overview.models.filter((model) => {
      if (family !== ALL && model.family !== family) return false;
      if (!needle) return true;
      return (
        model.modelId.toLowerCase().includes(needle) ||
        model.displayName.toLowerCase().includes(needle) ||
        (model.summary ?? "").toLowerCase().includes(needle) ||
        (model.tags ?? []).some((tag) => tag.toLowerCase().includes(needle))
      );
    });
  }, [overview.models, family, keyword]);

  return (
    <>
      <PageHero
        eyebrow={t("nav.models")}
        title={t("models.title")}
        lead={t("models.lead")}
        aside={
          overview.endpoint ? (
            <Card style={{ padding: 16, minWidth: 280 }}>
              <div style={{ fontSize: 12, color: "var(--gp-faint)", fontWeight: 600, marginBottom: 8 }}>
                {t("models.endpointTitle")}
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <code className="gp-mono" style={{ fontSize: 12.5, wordBreak: "break-all" }}>
                  {overview.endpoint}
                </code>
                <Btn
                  tone="quiet"
                  size="sm"
                  title={copier.state === "fail" ? t("common.copyFailed") : t("common.copy")}
                  onClick={() => copier.copy(overview.endpoint)}
                >
                  {copier.state === "ok" ? <IconCheck /> : <IconCopy />}
                </Btn>
              </div>
            </Card>
          ) : null
        }
      />

      <Section>
        <div className="gp-filters">
          <div className="gp-chips">
            <button type="button" className="gp-chip" data-active={family === ALL} onClick={() => setFamily(ALL)}>
              {t("family.all")}
              <span className="gp-chip__count">{overview.models.length}</span>
            </button>
            {overview.families.map((item) => (
              <button
                key={item.family}
                type="button"
                className="gp-chip"
                data-active={family === item.family}
                onClick={() => setFamily(item.family)}
              >
                {familyLabel(item.family, t)}
                <span className="gp-chip__count">{item.count}</span>
              </button>
            ))}
          </div>

          <div className="gp-search">
            <IconSearch />
            <input
              type="search"
              value={keyword}
              placeholder={t("models.search")}
              aria-label={t("models.search")}
              onChange={(event) => setKeyword(event.target.value)}
            />
          </div>
        </div>

        {models.length === 0 ? (
          <Empty
            title={overview.models.length === 0 ? t("common.empty") : t("models.none")}
            hint={overview.models.length === 0 ? t("common.emptyHint") : t("models.noneHint")}
          />
        ) : (
          <>
            <div className="gp-grid gp-grid--3">
              {models.map((model) => (
                <ModelCard key={model.modelId} model={model} />
              ))}
            </div>
            <p className="gp-body" style={{ marginTop: 22, fontSize: 13, maxWidth: "76ch" }}>
              {/* 「与具体模型无关」这句只有在**没有任何模型自己定价**时才成立。
                  运营一旦给某个模型填了价，这句话就会和它上面那排卡片自相矛盾。 */}
              {overview.models.every((model) => !model.priced)
                ? t("models.priceNoteFlat")
                : t("models.priceNoteBase")}
            </p>
          </>
        )}
      </Section>

      <div style={{ paddingBottom: "clamp(32px, 5vw, 72px)" }}>
        <CtaBand />
      </div>
    </>
  );
}
