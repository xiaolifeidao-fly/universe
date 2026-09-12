"use client";

/**
 * 模型广场：有哪些模型、每个模型多少钱、有哪些套餐可以买。
 *
 * 这一页只负责「挑」，不负责「付」：套餐上的购买按钮把人送去购买页，
 * 目标密钥、积分够不够、数据告知这些确认都在那一页。两页各写一遍下单，
 * 迟早有一边漏掉一道校验。
 *
 * 数字一律按积分标（1 积分 = ¥1）。单价是「每百万 token」—— 按千 token 标的话，
 * 小数点后面四五位，读不出贵还是便宜。
 */

import { message } from "antd";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { PageHeader } from "@/components/shell/GalaxyShell";
import { IconRefresh } from "@/components/ui/icons";
import { Btn, Card, CardHead, EmptyState, IconBtn, Kpi, Loading, Note, Pill, Tabs } from "@/components/ui/kit";
import { useLocale } from "@/i18n/LocaleProvider";
import { formatBps, formatCompact, formatPoints, formatQuota, unitLabel } from "@/utils/format";
import {
  fetchCatalog,
  fetchPoints,
  type ConsumerCatalog,
  type ConsumerModelView,
  type PackageView,
  type PointsSummary,
} from "../../api/consumer.api";

type CategoryTab = "all" | "claude" | "codex" | "other";

/** 模型的类别只有三种；套餐还多一个视频 —— 视频套餐不挂在任何模型下，归到「其他」那一栏。 */
function inTab(category: string, tab: CategoryTab): boolean {
  if (tab === "all") return true;
  if (tab === "other") return category !== "claude" && category !== "codex";
  return category === tab;
}

export function ModelSquare() {
  const { t } = useLocale();
  const router = useRouter();
  const [catalog, setCatalog] = useState<ConsumerCatalog | null>(null);
  const [points, setPoints] = useState<PointsSummary | null>(null);
  const [tab, setTab] = useState<CategoryTab>("all");
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      // 积分拿不到只少显示一格，不该让整页空掉。
      const [catalogResult, pointsResult] = await Promise.all([fetchCatalog(), fetchPoints().catch(() => null)]);
      setCatalog(catalogResult);
      setPoints(pointsResult);
    } catch (error) {
      message.error((error as Error).message || t("common.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const models = useMemo(() => (catalog?.models ?? []).filter((model) => inTab(model.category, tab)), [catalog, tab]);
  const general = useMemo(() => (catalog?.packages ?? []).filter((item) => inTab(item.category, tab)), [catalog, tab]);
  const packageCount = (catalog?.models ?? []).reduce((sum, model) => sum + (model.packages?.length ?? 0), 0) + (catalog?.packages?.length ?? 0);
  const topRate = Math.max(catalog?.defaultBps ?? 0, ...(catalog?.models ?? []).map((model) => model.referralBps));

  const buy = (item: PackageView) => router.push(`/consumer/store?package=${encodeURIComponent(item.packageCode)}`);

  const header = (
    <PageHeader
      title={t("models.title")}
      meta={t("models.subtitle")}
      actions={
        <>
          <Tabs
            value={tab}
            onChange={setTab}
            options={(["all", "claude", "codex", "other"] as const).map((value) => ({ value, label: t(`models.tab.${value}`) }))}
          />
          <IconBtn label={t("common.refresh")} onClick={() => void load()}>
            <IconRefresh size={17} />
          </IconBtn>
        </>
      }
    />
  );

  if (loading) {
    return (
      <>
        {header}
        <div className="gx-body">
          <Loading />
        </div>
      </>
    );
  }

  return (
    <>
      {header}
      <div className="gx-body">
        <div className="gx-kpi gx-rise" style={{ gridTemplateColumns: "repeat(4, minmax(0, 1fr))" }}>
          <Kpi
            label={t("models.kpi.points")}
            value={points ? formatPoints(points.balance) : "-"}
            hint={
              <button type="button" className="gx-link" onClick={() => router.push("/consumer/points")}>
                {t("models.kpi.pointsHint")}
              </button>
            }
          />
          <Kpi label={t("models.kpi.models")} value={catalog?.models.length ?? 0} />
          <Kpi label={t("models.kpi.packages")} value={packageCount} />
          <Kpi
            label={t("models.kpi.referral")}
            value={topRate > 0 ? t("models.kpi.referralUpTo", { rate: formatBps(topRate) }) : "-"}
            hint={
              <button type="button" className="gx-link" onClick={() => router.push("/consumer/points")}>
                {t("models.kpi.referralHint")}
              </button>
            }
          />
        </div>

        {models.length === 0 && general.length === 0 ? (
          <Card className="gx-rise gx-rise--1">
            <EmptyState title={t("models.empty")} />
          </Card>
        ) : null}

        {models.length > 0 ? (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(420px, 1fr))", gap: 14 }}>
            {models.map((model) => (
              <ModelCard key={model.modelId} model={model} onBuy={buy} />
            ))}
          </div>
        ) : null}

        {general.length > 0 ? (
          <Card className="gx-rise gx-rise--2">
            <CardHead title={t("models.general")} hint={t("models.generalHint")} />
            <div style={{ padding: "0 18px 18px", display: "grid", gap: 10 }}>
              {general.map((item) => (
                <PackageLine key={item.packageCode} item={item} onBuy={buy} showCategory />
              ))}
            </div>
          </Card>
        ) : null}

        <Note>{t("models.billing")}</Note>
      </div>
    </>
  );
}

function ModelCard({ model, onBuy }: { model: ConsumerModelView; onBuy: (item: PackageView) => void }) {
  const { t } = useLocale();
  const prices = [
    { key: "input", label: t("models.price.input"), value: model.inputPrice },
    { key: "output", label: t("models.price.output"), value: model.outputPrice },
    { key: "cache", label: t("models.price.cache"), value: model.cachePrice },
  ];
  return (
    <Card className="gx-rise gx-rise--1" style={{ display: "flex", flexDirection: "column" }}>
      <CardHead
        title={model.displayName || model.modelId}
        hint={<span className="gx-mono">{model.modelId}</span>}
        action={
          <span style={{ display: "flex", gap: 6 }}>
            {model.referralBps > 0 ? <Pill tone="accent">{t("models.referral", { rate: formatBps(model.referralBps) })}</Pill> : null}
            <Pill>{t(`models.tab.${model.category === "claude" || model.category === "codex" ? model.category : "other"}`)}</Pill>
          </span>
        }
      />
      <div style={{ padding: "0 18px 18px", display: "flex", flexDirection: "column", gap: 14, flex: 1 }}>
        {model.summary ? <p style={{ margin: 0, fontSize: 12.5, lineHeight: 1.65, color: "var(--gx-soft)" }}>{model.summary}</p> : null}
        {(model.tags?.length ?? 0) > 0 || model.contextTokens > 0 ? (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {model.contextTokens > 0 ? <span className="gx-chip">{t("models.context", { value: formatCompact(model.contextTokens) })}</span> : null}
            {(model.tags ?? []).map((tag) => (
              <span key={tag} className="gx-chip">
                {tag}
              </span>
            ))}
          </div>
        ) : null}

        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 10, padding: "12px 14px", borderRadius: 10, background: "var(--gx-muted)" }}>
          {prices.map((price) => (
            <span key={price.key} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <span className="gx-label">{price.label}</span>
              <span className="gx-mono" style={{ fontSize: 15, fontWeight: 500 }}>
                {price.value > 0 ? formatPoints(price.value) : "-"}
              </span>
            </span>
          ))}
          <span className="gx-card__hint" style={{ gridColumn: "1 / -1" }}>
            {t("models.priceUnit")}
            {/* 回落到统一价时说出来：不说的话所有模型显示同一个数，看起来像页面坏了。 */}
            {!model.priced ? ` · ${t("models.unifiedPrice")}` : ""}
          </span>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <span className="gx-label">{t("models.packages")}</span>
          {(model.packages?.length ?? 0) === 0 ? (
            <span className="gx-card__hint">{t("models.noPackages")}</span>
          ) : (
            model.packages.map((item) => <PackageLine key={item.packageCode} item={item} onBuy={onBuy} />)
          )}
        </div>
      </div>
    </Card>
  );
}

/** 一个套餐一行：名字、给多少、多久有效、多少积分、买。 */
function PackageLine({ item, onBuy, showCategory }: { item: PackageView; onBuy: (item: PackageView) => void; showCategory?: boolean }) {
  const { t } = useLocale();
  const units = Object.entries(item.units ?? {})
    .map(([unit, value]) => `${formatQuota(unit, value)} ${unitLabel(unit, t)}`)
    .join(" · ");
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "minmax(0, 1fr) auto auto",
        alignItems: "center",
        gap: 14,
        padding: "12px 14px",
        borderRadius: 10,
        border: "1px solid var(--gx-line)",
      }}
    >
      <span style={{ minWidth: 0 }}>
        <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 13.5, fontWeight: 600 }}>{item.title}</span>
          {showCategory ? <Pill>{t(`store.category.${item.category}`)}</Pill> : null}
        </span>
        <span className="gx-mono" style={{ display: "block", marginTop: 4, fontSize: 11.5, color: "var(--gx-faint)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {units} · {t("models.ttl", { days: item.ttlDays })}
        </span>
      </span>
      <span style={{ display: "flex", alignItems: "baseline", gap: 4 }}>
        <span className="gx-serif" style={{ fontSize: 24, lineHeight: 1 }}>
          {formatPoints(item.amount)}
        </span>
        <span style={{ fontSize: 12, color: "var(--gx-faint)" }}>{t("points.unit")}</span>
      </span>
      <Btn tone="accent" small onClick={() => onBuy(item)}>
        {t("models.buy")}
      </Btn>
    </div>
  );
}
