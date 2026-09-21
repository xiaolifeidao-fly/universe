"use client";

/**
 * 模型页：平台在卖哪些模型，跑它们各自能记多少积分。
 *
 * 这一页回答的是一个决定：「我该开放哪些模型」。所以每一行只有三样东西 ——
 * 跑它记多少积分、你的名单放不放它过、你的机器上有没有它。
 *
 * **没有对外价，也没有平台毛利。** 那两个数摆上来，一相除就是平台抽成，
 * 而抽成不是这里要做的决定。要改开放范围去「共享设置」，这一页只管看。
 *
 * **先选厂商，再看列表。** 卡片墙换成列表的理由和使用端一样：加上推理强度这一维之后，
 * 一个模型不再是一个数而是一小张价目表，卡片里塞不下；而这一页的用法本来就是
 * 「在同一家的几个模型之间比一比哪个更值得开」—— 比较要求几个数上下对齐。
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
import { fetchProviderModels, type ModelEffortPrice, type ProviderModelView } from "../../api/provider.api";

type Tab = "all" | "on" | "off";

/** 「全部厂商」用空串表达 —— 厂商名本身不可能是空串（认不出来的归到 other 那一档）。 */
const ALL_VENDORS = "";

/** 角标配色：库里存的是语义名，各端按自己的调色板渲染。 */
const BADGE_TONES: Record<string, "default" | "ok" | "warn" | "err" | "accent"> = {
  hot: "accent",
  new: "warn",
  value: "ok",
  neutral: "default",
};

/** 列表的列宽。表头和每一行共用同一份 —— 各写一份迟早错开一列。 */
const COLUMNS = "minmax(0, 1.6fr) 96px 96px 96px 104px 110px 28px";

/** 0 不写成「0」：那一档没有价，写 0 会被读成免费。 */
function points(value: number): string {
  return value > 0 ? formatPoints(value) : "-";
}

export function ModelBoard() {
  const { t } = useLocale();
  const router = useRouter();
  const [rows, setRows] = useState<ProviderModelView[]>([]);
  const [tab, setTab] = useState<Tab>("all");
  const [vendor, setVendor] = useState<string>(ALL_VENDORS);
  const [expanded, setExpanded] = useState("");
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

  const vendors = useMemo(() => vendorFacets(rows), [rows]);
  // 选中的厂商在这一批数据里没有了（目录换了、或者那一家下架了）就退回全部。
  // 不退的话是一张空列表，而主人看到的是「模型没了」。
  const activeVendor = vendors.some((facet) => facet.vendor === vendor) ? vendor : ALL_VENDORS;
  const models = useMemo(
    () =>
      rows
        .filter((row) => (activeVendor === ALL_VENDORS ? true : vendorKey(row) === activeVendor))
        .filter((row) => (tab === "all" ? true : tab === "on" ? row.allowed : !row.allowed)),
    [rows, activeVendor, tab],
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
            <b style={{ fontWeight: 600 }}>{t("models.rules")}</b> · {t("models.rulesBody")}
            {anyFallback ? ` ${t("models.rulesFallback")}` : ""}{" "}
            <button type="button" className="gx-link" onClick={() => router.push("/provider/share")}>
              {t("models.goShare")}
            </button>
          </Note>

          <VendorPicker facets={vendors} total={rows.length} value={activeVendor} onChange={setVendor} />

          <Card className="gx-rise gx-rise--1">
            <div className="gx-table">
              <div className="gx-th" style={{ gridTemplateColumns: COLUMNS }}>
                <span>{t("models.col.model")}</span>
                <span style={{ textAlign: "right" }}>{t("models.price.input")}</span>
                <span style={{ textAlign: "right" }}>{t("models.price.output")}</span>
                <span style={{ textAlign: "right" }}>{t("models.price.cache")}</span>
                <span style={{ textAlign: "right" }}>{t("models.col.effort")}</span>
                <span style={{ textAlign: "right" }}>{t("models.col.status")}</span>
                <span />
              </div>
              <div className="gx-rows">
                {models.length === 0 ? (
                  <div className="gx-empty">{t("models.emptyTab")}</div>
                ) : (
                  models.map((model) => (
                    <ModelRow
                      key={model.modelId}
                      model={model}
                      open={expanded === model.modelId}
                      onToggle={() => setExpanded(expanded === model.modelId ? "" : model.modelId)}
                    />
                  ))
                )}
              </div>
            </div>
          </Card>
        </div>
      )}
    </>
  );
}

/** 这个模型算哪一家。厂商没填时回落到族名，两个都没有就归「其他」—— 不猜。 */
function vendorKey(model: ProviderModelView): string {
  return (model.vendor || model.family || "other").trim().toLowerCase();
}

interface VendorFacet {
  vendor: string;
  count: number;
}

/**
 * 有哪几家、各有几个模型。
 *
 * 顺序跟着目录本身（服务端已经按 sortOrder 排过）：运营把主推的模型排在前面，
 * 那一家自然也就排在前面。按模型数或者字母排会把这个决定抹掉。
 */
function vendorFacets(models: ProviderModelView[]): VendorFacet[] {
  const order: string[] = [];
  const counts = new Map<string, number>();
  for (const model of models) {
    const key = vendorKey(model);
    if (!counts.has(key)) order.push(key);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return order.map((key) => ({ vendor: key, count: counts.get(key) ?? 0 }));
}

/**
 * 厂商筛选。
 *
 * 做成一排方块而不是下拉：一共就两三家，摊开来点一下就到，而下拉要先点开再选。
 * 每一格带上模型数 —— 点进去才发现只有一个模型，是白跑一趟。
 */
function VendorPicker({
  facets,
  total,
  value,
  onChange,
}: {
  facets: VendorFacet[];
  total: number;
  value: string;
  onChange: (next: string) => void;
}) {
  const { t } = useLocale();
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
      <VendorChip label={t("models.vendorAll")} count={total} active={value === ALL_VENDORS} onClick={() => onChange(ALL_VENDORS)} />
      {facets.map((facet) => (
        <VendorChip
          key={facet.vendor}
          vendor={facet.vendor}
          label={vendorLabel(facet.vendor)}
          count={facet.count}
          active={value === facet.vendor}
          onClick={() => onChange(facet.vendor)}
        />
      ))}
    </div>
  );
}

function VendorChip({
  vendor,
  label,
  count,
  active,
  onClick,
}: {
  vendor?: string;
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className="gx-rise"
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 9,
        padding: "9px 14px",
        borderRadius: 11,
        cursor: "pointer",
        font: "inherit",
        fontSize: 13,
        // 选中态靠底色和描边一起说，不只靠一个颜色 —— 这一端有深色模式，
        // 只改文字色的话，选中和未选中在暗背景上几乎分不出来。
        border: `1px solid ${active ? "var(--gx-accent)" : "var(--gx-line)"}`,
        background: active ? "var(--gx-accent-soft, var(--gx-muted))" : "var(--gx-card, transparent)",
        color: active ? "var(--gx-accent)" : "inherit",
      }}
    >
      {vendor ? <VendorMark vendor={vendor} fallback={label} size={16} /> : null}
      <span style={{ fontWeight: active ? 600 : 500 }}>{label}</span>
      <span className="gx-mono" style={{ fontSize: 11.5, color: "var(--gx-faint)" }}>
        {count}
      </span>
    </button>
  );
}

function ModelRow({ model, open, onToggle }: { model: ProviderModelView; open: boolean; onToggle: () => void }) {
  const { t } = useLocale();
  const efforts = model.efforts ?? [];
  return (
    <>
      <button
        type="button"
        className="gx-row"
        style={{ gridTemplateColumns: COLUMNS, cursor: "pointer" }}
        onClick={onToggle}
        aria-expanded={open}
      >
        <span style={{ minWidth: 0, display: "flex", alignItems: "center", gap: 10 }}>
          {/* 厂商标和角标都 flexShrink: 0 —— 它们是定宽的，被压扁只会糊成一团；
              该让步的是名字，它有省略号兜着。不写的话 flex 会先压最长的那个孩子，
              于是「有角标的那一行连模型名都不见了」，而没角标的行看着好好的。 */}
          <span style={{ flexShrink: 0, display: "inline-flex" }}>
            <VendorMark vendor={model.vendor} fallback={model.modelId} size={16} />
          </span>
          <span style={{ minWidth: 0, flex: 1, display: "flex", flexDirection: "column", gap: 2 }}>
            <span style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
              <span style={{ fontWeight: 600, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {model.displayName || model.modelId}
              </span>
              <span style={{ display: "inline-flex", gap: 6, flexShrink: 0 }}>
                {model.badgeText ? <Pill tone={BADGE_TONES[model.badgeTone] ?? "default"}>{model.badgeText}</Pill> : null}
              </span>
            </span>
            <span className="gx-mono" style={{ fontSize: 11.5, color: "var(--gx-faint)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {model.modelId}
            </span>
          </span>
        </span>
        <span className="gx-mono" style={{ textAlign: "right" }}>{points(model.inputPrice)}</span>
        <span className="gx-mono" style={{ textAlign: "right" }}>{points(model.outputPrice)}</span>
        <span className="gx-mono" style={{ textAlign: "right", color: "var(--gx-soft)" }}>{points(model.cachePrice)}</span>
        <span style={{ textAlign: "right", fontSize: 12 }}>
          {/* 分档了才说。没分档的写「不分强度」会让人以为这里本来该有点什么，
              而绝大多数模型本来就是一个价走到底。 */}
          {efforts.length > 0 ? (
            <Pill tone="accent">{t("models.effortCount", { count: efforts.length })}</Pill>
          ) : (
            <span style={{ color: "var(--gx-faint)" }}>—</span>
          )}
        </span>
        {/* 状态两件事分开说：名单放不放它过（你能改），机器上有没有（上游说了算）。
            允许了但上游没有，照样一单都接不到，而那不是设置错了。 */}
        <span style={{ display: "flex", gap: 4, justifyContent: "flex-end", flexWrap: "wrap" }}>
          {model.allowed ? <Pill tone="ok">{t("models.allowed")}</Pill> : <Pill>{t("models.notAllowed")}</Pill>}
          {model.allowed && !model.available ? <Pill tone="warn">{t("models.unavailable")}</Pill> : null}
        </span>
        <span style={{ textAlign: "right", color: "var(--gx-faint)", transition: "transform 0.15s ease", transform: open ? "rotate(90deg)" : undefined }}>
          ›
        </span>
      </button>
      {open ? <ModelDetail model={model} /> : null}
    </>
  );
}

/**
 * 展开之后的那一块：介绍、标签、最近赚了多少，以及按推理强度分档的结算价。
 *
 * 强度这一小张表只在真的分过档时出现。一档都没有的模型摆一张「所有档都一样」的表，
 * 是把「不分档」说成了「分了档但都一样」—— 后者会让人以为运营填漏了。
 */
function ModelDetail({ model }: { model: ProviderModelView }) {
  const { t } = useLocale();
  const efforts = model.efforts ?? [];
  return (
    <div style={{ padding: "4px 16px 18px 42px", display: "flex", flexDirection: "column", gap: 12, borderTop: "1px solid var(--gx-line)" }}>
      {model.summary ? <p style={{ margin: 0, fontSize: 12.5, lineHeight: 1.65, color: "var(--gx-soft)" }}>{model.summary}</p> : null}

      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        {model.contextTokens > 0 ? <span className="gx-chip">{t("models.context", { value: formatCompact(model.contextTokens) })}</span> : null}
        {(model.tags ?? []).map((tag) => (
          <span key={tag} className="gx-chip">
            {tag}
          </span>
        ))}
      </div>

      {efforts.length > 0 ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <span className="gx-label">{t("models.effortTitle")}</span>
          <div style={{ borderRadius: 10, background: "var(--gx-muted)", padding: "4px 12px" }}>
            <div className="gx-th" style={{ gridTemplateColumns: "minmax(0, 1fr) 96px 96px 96px", padding: "8px 0" }}>
              <span>{t("models.col.effort")}</span>
              <span style={{ textAlign: "right" }}>{t("models.price.input")}</span>
              <span style={{ textAlign: "right" }}>{t("models.price.output")}</span>
              <span style={{ textAlign: "right" }}>{t("models.price.cache")}</span>
            </div>
            {efforts.map((row: ModelEffortPrice) => (
              <div key={row.effort} className="gx-row" style={{ gridTemplateColumns: "minmax(0, 1fr) 96px 96px 96px", padding: "9px 0" }}>
                <span>{effortLabel(row.effort, t)}</span>
                <span className="gx-mono" style={{ textAlign: "right" }}>{points(row.inputPrice)}</span>
                <span className="gx-mono" style={{ textAlign: "right" }}>{points(row.outputPrice)}</span>
                <span className="gx-mono" style={{ textAlign: "right", color: "var(--gx-soft)" }}>{points(row.cachePrice)}</span>
              </div>
            ))}
          </div>
          <span className="gx-card__hint">{t("models.effortHint")}</span>
        </div>
      ) : null}

      <span className="gx-card__hint">
        {t("models.priceUnit")} · {t("models.earned", { value: formatPoints(model.earned7d) })}
        {/* 回落到能力统一价时说出来，否则一屏的模型都是同一个数，读起来像页面坏了。 */}
        {!model.priced ? ` · ${t("models.unifiedPrice")}` : ""}
      </span>
    </div>
  );
}

/**
 * 档位的中文名。认不出来的原样显示 —— 上游加了新档而我们还没跟上时，
 * 显示成空白会让这一行看起来是坏的，而它照常在结算。
 */
function effortLabel(effort: string, t: (key: string) => string): string {
  const key = `models.effort.${effort}`;
  const label = t(key);
  return label === key ? effort : label;
}
