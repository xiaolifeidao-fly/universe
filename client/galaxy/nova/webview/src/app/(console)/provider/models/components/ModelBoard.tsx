"use client";

/**
 * 模型页：平台在卖哪些模型，跑它们各自能记多少积分。
 *
 * 这一页回答的是一个决定：「我该开放哪些模型」。所以每张卡上只有三样东西 ——
 * 跑它记多少积分、你的名单放不放它过、你的机器上有没有它。
 *
 * **没有对外价，也没有平台毛利。** 那两个数摆上来，一相除就是平台抽成，
 * 而抽成不是这里要做的决定。要改开放范围去「共享设置」，这一页只管看。
 *
 * 单价一律按「每百万 token」标。按千 token 标的话小数点后面四五位，
 * 读不出贵还是便宜 —— 和使用端模型广场同一个口径。
 */

import { message } from "antd";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { PageHeader } from "@/components/shell/GalaxyShell";
import { IconRefresh } from "@/components/ui/icons";
import { Card, EmptyState, IconBtn, Loading, Note, Pill, Tabs } from "@/components/ui/kit";
import { VendorMark, vendorLabel } from "@shared/brand/VendorMark";
import { useLocale } from "@/i18n/LocaleProvider";
import { formatCompact, formatPoints } from "@/utils/format";
import { fetchProviderModels, type ProviderModelView } from "../../api/provider.api";

type Tab = "all" | "on" | "off";

/** 角标配色：库里存的是语义名，各端按自己的调色板渲染。 */
const BADGE_TONES: Record<string, "default" | "ok" | "warn" | "err" | "accent"> = {
  hot: "accent",
  new: "warn",
  value: "ok",
  neutral: "default",
};

/** 0 不写成「0」：那一档没有价，写 0 会被读成免费。 */
function points(value: number): string {
  return value > 0 ? formatPoints(value) : "-";
}

export function ModelBoard() {
  const { t } = useLocale();
  const router = useRouter();
  const [rows, setRows] = useState<ProviderModelView[]>([]);
  const [tab, setTab] = useState<Tab>("all");
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setRows(await fetchProviderModels());
    } catch (error) {
      message.error((error as Error).message || t("common.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const models = useMemo(
    () => rows.filter((row) => (tab === "all" ? true : tab === "on" ? row.allowed : !row.allowed)),
    [rows, tab],
  );
  // 有没有一行是回落来的。有就说出来 —— 不说的话所有模型显示同一个数字，
  // 看起来像页面坏了，而它其实是「运营还没给这些模型单独定价」。
  const anyFallback = rows.some((row) => !row.priced);

  return (
    <>
      <PageHeader
        title={t("models.title")}
        meta={t("models.subtitle")}
        actions={
          <>
            <Tabs
              value={tab}
              onChange={setTab}
              options={(["all", "on", "off"] as const).map((value) => ({ value, label: t(`models.tab.${value}`) }))}
            />
            <IconBtn label={t("common.refresh")} onClick={() => void load()}>
              <IconRefresh size={17} />
            </IconBtn>
          </>
        }
      />

      {loading ? (
        <Loading />
      ) : rows.length === 0 ? (
        <EmptyState title={t("models.empty")} hint={t("models.emptyHint")} />
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <Note>
            <b style={{ fontWeight: 600 }}>{t("models.rules")}</b> ·{" "}
            {t("models.rulesBody")}
            {anyFallback ? ` ${t("models.rulesFallback")}` : ""}{" "}
            <button type="button" className="gx-link" onClick={() => router.push("/provider/share")}>
              {t("models.goShare")}
            </button>
          </Note>

          {models.length === 0 ? (
            <EmptyState title={t("models.emptyTab")} hint={t("models.emptyTabHint")} />
          ) : (
            <div
              style={{
                display: "grid",
                gap: 14,
                gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))",
              }}
            >
              {models.map((model) => (
                <ModelCard key={model.modelId} model={model} />
              ))}
            </div>
          )}
        </div>
      )}
    </>
  );
}

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

function ModelCard({ model }: { model: ProviderModelView }) {
  const { t } = useLocale();
  const vendor = vendorLabel(model.vendor);
  // 缓存两档退成小字：卡片第一眼要回答「跑它记多少」，四个数一样大就没有重点了。
  const cache = [
    model.cachePrice > 0 ? `${t("models.price.cache")} ${formatPoints(model.cachePrice)}` : "",
    model.cacheWritePrice > 0 ? `${t("models.price.cacheWrite")} ${formatPoints(model.cacheWritePrice)}` : "",
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <Card className="gx-rise gx-rise--1" style={{ display: "flex", flexDirection: "column" }}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 12, padding: "16px 18px 12px" }}>
        <VendorTile vendor={model.vendor} modelId={model.modelId} />
        <span style={{ minWidth: 0, flex: 1, display: "flex", flexDirection: "column", gap: 3 }}>
          <span style={{ fontSize: 15, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {model.displayName || model.modelId}
          </span>
          <span style={{ fontSize: 12, color: "var(--gx-faint)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {vendor ? `${vendor} · ` : ""}
            <span className="gx-mono">{model.modelId}</span>
          </span>
        </span>
        <span style={{ display: "flex", gap: 6, flexWrap: "wrap", justifyContent: "flex-end" }}>
          {model.badgeText ? <Pill tone={BADGE_TONES[model.badgeTone] ?? "default"}>{model.badgeText}</Pill> : null}
        </span>
      </div>

      <div style={{ padding: "0 18px 18px", display: "flex", flexDirection: "column", gap: 14, flex: 1 }}>
        {model.summary ? <p style={{ margin: 0, fontSize: 12.5, lineHeight: 1.65, color: "var(--gx-soft)" }}>{model.summary}</p> : null}

        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {model.contextTokens > 0 ? <span className="gx-chip">{t("models.context", { value: formatCompact(model.contextTokens) })}</span> : null}
          {(model.tags ?? []).map((tag) => (
            <span key={tag} className="gx-chip">
              {tag}
            </span>
          ))}
        </div>

        {/* 主角是两个大数：跑这个模型，输入和输出各记多少积分。 */}
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
          </div>
          <span className="gx-card__hint">
            {t("models.priceUnit")}
            {cache ? ` · ${cache}` : ""}
            {/* 回落到能力统一价时说出来，否则一屏的模型都是同一个数，读起来像页面坏了。 */}
            {!model.priced ? ` · ${t("models.unifiedPrice")}` : ""}
          </span>
        </div>

        {/* 状态两行：名单放不放它过（你能改），机器上有没有（上游说了算）。
            两件事分开说 —— 允许了但上游没有，照样一单都接不到，而那不是设置错了。 */}
        <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: "auto" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            {model.allowed ? <Pill tone="ok">{t("models.allowed")}</Pill> : <Pill>{t("models.notAllowed")}</Pill>}
            {model.allowed && !model.available ? <Pill tone="warn">{t("models.unavailable")}</Pill> : null}
          </div>
          <span className="gx-card__hint">
            {t("models.earned", { value: formatPoints(model.earned7d) })}
          </span>
        </div>
      </div>
    </Card>
  );
}
