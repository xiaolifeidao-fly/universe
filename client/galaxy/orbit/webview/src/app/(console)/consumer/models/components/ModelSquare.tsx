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
import { VendorMark, vendorLabel } from "@shared/brand/VendorMark";
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

/**
 * 角标配色：库里存的是语义（主推 / 新上 / 划算 / 中性），这里落到本端的胶囊配色。
 * 库里存「红色」的话，换一套主题就得改数据 —— Nova 那边是暖铜，同一条记录没处安放。
 */
const BADGE_TONES: Record<string, "accent" | "warn" | "ok" | "default"> = {
  hot: "accent",
  new: "warn",
  value: "ok",
  neutral: "default",
};

/**
 * 厂商标的底座。图形本身在 @shared/brand/VendorMark（门户站也用同一份），
 * 这里只管这一端的方块：纸感底 + 墨色线，官方标按 currentColor 落成单色，
 * 和这一页其余的线条图标是同一套观感。
 */
function VendorTile({ vendor, modelId }: { vendor: string; modelId: string }) {
  return (
    <span
      className="gx-serif"
      style={{
        flex: "0 0 auto",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: 34,
        height: 34,
        borderRadius: 9,
        background: "var(--gx-muted)",
        border: "1px solid var(--gx-line)",
        color: "var(--gx-soft)",
        fontSize: 17,
        lineHeight: 1,
      }}
    >
      <VendorMark vendor={vendor} fallback={modelId} size={18} />
    </span>
  );
}

/** 0 不显示成「0」：那一档没定价，写 0 会被读成免费。 */
function points(value: number): string {
  return value > 0 ? formatPoints(value) : "-";
}

function ModelCard({ model, onBuy }: { model: ConsumerModelView; onBuy: (item: PackageView) => void }) {
  const { t } = useLocale();
  const vendor = vendorLabel(model.vendor);
  // 划线价两档只要有一档填了就显示：只填了输出价的那一行也该看得见对比，
  // 缺的那一档写成「-」比整行藏起来诚实。
  //
  // 但自家价一个都没有时（模型没定价、kind 统一价也还是空的）不显示：
  // 划掉官方价却给不出替代的数，等于说「这个价不算数」然后没有下文。
  const listed = (model.listInputPrice > 0 || model.listOutputPrice > 0) && (model.inputPrice > 0 || model.outputPrice > 0);
  // 缓存两档退到小字。它们是「便宜在哪」的注脚，而卡片第一眼要回答的是「多少钱」——
  // 四个数一样大的时候，没有一个数是重点。
  const cache = [
    model.cachePrice > 0 ? `${t("models.price.cache")} ${formatPoints(model.cachePrice)}` : "",
    model.cacheWritePrice > 0 ? `${t("models.price.cacheWrite")} ${formatPoints(model.cacheWritePrice)}` : "",
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <Card className="gx-rise gx-rise--1" style={{ display: "flex", flexDirection: "column" }}>
      {/* 不用 CardHead：那个是标题与副标题并排的基线布局，这里要的是
          「图标 + 两行 + 右上角标」，塞进去只能靠负 margin 硬掰。 */}
      <div style={{ display: "flex", alignItems: "flex-start", gap: 12, padding: "16px 18px 12px" }}>
        <VendorTile vendor={model.vendor} modelId={model.modelId} />
        <span style={{ minWidth: 0, flex: 1, display: "flex", flexDirection: "column", gap: 3 }}>
          <span style={{ fontSize: 15, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {model.displayName || model.modelId}
          </span>
          <span style={{ fontSize: 12, color: "var(--gx-faint)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {vendor ? `${vendor} · ` : ""}
            {/* 模型名照原样给出来：使用者要把它一个字不差地填进自己的客户端。 */}
            <span className="gx-mono">{model.modelId}</span>
          </span>
        </span>
        <span style={{ display: "flex", gap: 6, flexWrap: "wrap", justifyContent: "flex-end" }}>
          {model.referralBps > 0 ? <Pill tone="accent">{t("models.referral", { rate: formatBps(model.referralBps) })}</Pill> : null}
          {model.badgeText ? <Pill tone={BADGE_TONES[model.badgeTone] ?? "default"}>{model.badgeText}</Pill> : null}
        </span>
      </div>

      <div style={{ padding: "0 18px 18px", display: "flex", flexDirection: "column", gap: 14, flex: 1 }}>
        {model.summary ? <p style={{ margin: 0, fontSize: 12.5, lineHeight: 1.65, color: "var(--gx-soft)" }}>{model.summary}</p> : null}
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {model.contextTokens > 0 ? <span className="gx-chip">{t("models.context", { value: formatCompact(model.contextTokens) })}</span> : null}
          <span className="gx-chip">{t(`models.tab.${model.category === "claude" || model.category === "codex" ? model.category : "other"}`)}</span>
          {(model.tags ?? []).map((tag) => (
            <span key={tag} className="gx-chip">
              {tag}
            </span>
          ))}
        </div>

        {/* 价格是这张卡的主角：输入、输出两个大数，划线价和缓存两档退成小字。 */}
        <div style={{ display: "flex", flexDirection: "column", gap: 6, padding: "12px 14px", borderRadius: 10, background: "var(--gx-muted)" }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
            <span style={{ display: "flex", alignItems: "baseline", gap: 4 }}>
              <span className="gx-serif" style={{ fontSize: 23, lineHeight: 1 }}>
                {points(model.inputPrice)}
              </span>
              <span style={{ fontSize: 11.5, color: "var(--gx-faint)" }}>{t("models.perIn")}</span>
            </span>
            <span style={{ color: "var(--gx-faint)" }}>·</span>
            <span style={{ display: "flex", alignItems: "baseline", gap: 4 }}>
              <span className="gx-serif" style={{ fontSize: 23, lineHeight: 1 }}>
                {points(model.outputPrice)}
              </span>
              <span style={{ fontSize: 11.5, color: "var(--gx-faint)" }}>{t("models.perOut")}</span>
            </span>
            {/* 折扣是服务端按输出价算好的。前端再减一遍的话，门户和这里迟早标出两个数。 */}
            {model.discountBps > 0 ? (
              <span style={{ marginLeft: "auto" }}>
                <Pill tone="ok">{t("models.discount", { rate: formatBps(model.discountBps) })}</Pill>
              </span>
            ) : null}
          </div>
          {listed ? (
            <span className="gx-mono" style={{ fontSize: 11.5, color: "var(--gx-faint)" }}>
              {t("models.listPrice")}{" "}
              <s>
                {points(model.listInputPrice)} / {points(model.listOutputPrice)}
              </s>
            </span>
          ) : null}
          <span className="gx-card__hint">
            {t("models.priceUnit")}
            {cache ? ` · ${cache}` : ""}
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
