"use client";

/**
 * 模型广场：有哪些模型、每个模型什么价。
 *
 * 这一页只回答「多少钱」，没有任何可以点的买卖：额度就是账户里的积分余额，
 * 由运营充进来，调一次扣一次。所以读它的方式是「我这些余额大概能跑多久」，
 * 而不是「我该买哪个包」。
 *
 * **先选厂商，再看列表。** 卡片墙换成列表是因为这一页的用法变了：加上推理强度这一维之后，
 * 一个模型不再是一个价而是一小张价目表，卡片里塞不下；而使用者真正在做的事是
 * 「在同一家的几个模型之间比价」—— 比价要求几个数上下对齐，卡片做不到这件事。
 * 厂商摆在最上面而不是做成下拉：一共就两三家，摊开来点一下，比先展开再选快。
 *
 * 数字一律按积分标（1 积分 = ¥1）。单价是「每百万 token」—— 按千 token 标的话，
 * 小数点后面四五位，读不出贵还是便宜。
 */

import { message } from "antd";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { PageHeader } from "@/components/shell/GalaxyShell";
import { IconRefresh } from "@/components/ui/icons";
import { Card, EmptyState, IconBtn, Kpi, Loading, Note, Pill } from "@/components/ui/kit";
import { VendorMark, vendorLabel } from "@shared/brand/VendorMark";
import { useLocale } from "@/i18n/LocaleProvider";
import { formatBps, formatCompact, formatPoints } from "@/utils/format";
import {
  fetchCatalog,
  fetchPoints,
  type ConsumerModelView,
  type ModelEffortPrice,
  type PointsSummary,
} from "../../api/consumer.api";

/** 「全部厂商」用空串表达 —— 厂商名本身不可能是空串（认不出来的归到 other 那一档）。 */
const ALL_VENDORS = "";

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

/** 列表的列宽。表头和每一行共用同一份 —— 各写一份迟早错开一列。 */
const COLUMNS = "minmax(0, 1.7fr) 96px 104px 104px 104px 96px 28px";

/** 0 不显示成「0」：那一档没定价，写 0 会被读成免费。 */
function points(value: number): string {
  return value > 0 ? formatPoints(value) : "-";
}

export function ModelSquare() {
  const { t } = useLocale();
  const router = useRouter();
  const [rows, setRows] = useState<ConsumerModelView[]>([]);
  const [defaultBps, setDefaultBps] = useState(0);
  const [points_, setPoints] = useState<PointsSummary | null>(null);
  const [vendor, setVendor] = useState<string>(ALL_VENDORS);
  const [expanded, setExpanded] = useState("");
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      // 积分拿不到只少显示一格，不该让整页空掉。
      const [catalog, pointsResult] = await Promise.all([fetchCatalog(), fetchPoints().catch(() => null)]);
      setRows(catalog.models ?? []);
      setDefaultBps(catalog.defaultBps ?? 0);
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

  const vendors = useMemo(() => vendorFacets(rows), [rows]);
  // 选中的厂商在这一批数据里没有了（换了目录、或者上一次选的那家下架了）就退回全部。
  // 不退的话是一张空列表，而使用者看到的是「模型没了」。
  const activeVendor = vendors.some((facet) => facet.vendor === vendor) ? vendor : ALL_VENDORS;
  const models = useMemo(
    () => (activeVendor === ALL_VENDORS ? rows : rows.filter((row) => vendorKey(row) === activeVendor)),
    [rows, activeVendor],
  );

  const header = (
    <PageHeader
      title={t("models.title")}
      meta={t("models.subtitle")}
      actions={
        <IconBtn label={t("common.refresh")} onClick={() => void load()}>
          <IconRefresh size={17} />
        </IconBtn>
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
        <div className="gx-kpi gx-rise" style={{ gridTemplateColumns: "repeat(3, minmax(0, 1fr))" }}>
          <Kpi
            label={t("models.kpi.points")}
            value={points_ ? formatPoints(points_.balance) : "-"}
            hint={
              <button type="button" className="gx-link" onClick={() => router.push("/consumer/points")}>
                {t("models.kpi.pointsHint")}
              </button>
            }
          />
          <Kpi label={t("models.kpi.models")} value={rows.length} />
          <Kpi
            label={t("models.kpi.referral")}
            value={defaultBps > 0 ? formatBps(defaultBps) : "-"}
            hint={
              <button type="button" className="gx-link" onClick={() => router.push("/consumer/points")}>
                {t("models.kpi.referralHint")}
              </button>
            }
          />
        </div>

        {rows.length === 0 ? (
          <Card className="gx-rise gx-rise--1">
            <EmptyState title={t("models.empty")} />
          </Card>
        ) : (
          <>
            <VendorPicker facets={vendors} total={rows.length} value={activeVendor} onChange={setVendor} />
            <Card className="gx-rise gx-rise--1">
              <div className="gx-table">
                <div className="gx-th" style={{ gridTemplateColumns: COLUMNS }}>
                  <span>{t("models.col.model")}</span>
                  <span style={{ textAlign: "right" }}>{t("models.col.context")}</span>
                  <span style={{ textAlign: "right" }}>{t("models.price.input")}</span>
                  <span style={{ textAlign: "right" }}>{t("models.price.output")}</span>
                  <span style={{ textAlign: "right" }}>{t("models.price.cache")}</span>
                  <span style={{ textAlign: "right" }}>{t("models.col.effort")}</span>
                  <span />
                </div>
                <div className="gx-rows">
                  {models.length === 0 ? (
                    <div className="gx-empty">{t("models.emptyVendor")}</div>
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
          </>
        )}

        <Note>{t("models.billing")}</Note>
      </div>
    </>
  );
}

/** 这个模型算哪一家。厂商没填时回落到族名，两个都没有就归「其他」—— 不猜。 */
function vendorKey(model: ConsumerModelView): string {
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
function vendorFacets(models: ConsumerModelView[]): VendorFacet[] {
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
        // 选中态靠底色和描边一起说，不只靠一个颜色 —— 两个端都有深色模式，
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

function ModelRow({ model, open, onToggle }: { model: ConsumerModelView; open: boolean; onToggle: () => void }) {
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
          {/* 厂商标和胶囊都 flexShrink: 0 —— 它们是定宽的，被压扁只会糊成一团；
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
                {/* 折扣是服务端按输出价算好的。前端再减一遍的话，门户和这里迟早标出两个数。 */}
                {model.discountBps > 0 ? <Pill tone="ok">{t("models.discount", { rate: formatBps(model.discountBps) })}</Pill> : null}
              </span>
            </span>
            {/* 模型名照原样给出来：使用者要把它一个字不差地填进自己的客户端。 */}
            <span className="gx-mono" style={{ fontSize: 11.5, color: "var(--gx-faint)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {model.modelId}
            </span>
          </span>
        </span>
        <span className="gx-mono" style={{ textAlign: "right", fontSize: 12, color: "var(--gx-soft)" }}>
          {model.contextTokens > 0 ? formatCompact(model.contextTokens) : "-"}
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
        <span style={{ textAlign: "right", color: "var(--gx-faint)", transition: "transform 0.15s ease", transform: open ? "rotate(90deg)" : undefined }}>
          ›
        </span>
      </button>
      {open ? <ModelDetail model={model} /> : null}
    </>
  );
}

/**
 * 展开之后的那一块：介绍、标签、划线价，以及按推理强度分档的价。
 *
 * 强度这一小张表只在真的分过档时出现。一档都没有的模型摆一张「所有档都一样」的表，
 * 是把「不分档」说成了「分了档但都一样」—— 后者会让人以为运营填漏了。
 */
function ModelDetail({ model }: { model: ConsumerModelView }) {
  const { t } = useLocale();
  const efforts = model.efforts ?? [];
  // 划线价两档只要有一档填了就显示：只填了输出价的那一行也该看得见对比，
  // 缺的那一档写成「-」比整行藏起来诚实。
  //
  // 但自家价一个都没有时（模型没定价、kind 统一价也还是空的）不显示：
  // 划掉官方价却给不出替代的数，等于说「这个价不算数」然后没有下文。
  const listed =
    (model.listInputPrice > 0 || model.listOutputPrice > 0 || model.listCachePrice > 0) &&
    (model.inputPrice > 0 || model.outputPrice > 0);

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

      {efforts.length > 0 ? <EffortTable efforts={efforts} caption={t("models.effortTitle")} hint={t("models.effortHint")} /> : null}

      <span className="gx-card__hint">
        {t("models.priceUnit")}
        {listed ? (
          <>
            {" · "}
            {t("models.listPrice")}{" "}
            <s className="gx-mono">
              {points(model.listInputPrice)} / {points(model.listOutputPrice)}
              {model.listCachePrice > 0 ? ` / ${points(model.listCachePrice)}` : ""}
            </s>
          </>
        ) : null}
        {/* 回落到统一价时说出来：不说的话所有模型显示同一个数，看起来像页面坏了。 */}
        {!model.priced ? ` · ${t("models.unifiedPrice")}` : ""}
      </span>
    </div>
  );
}

/**
 * 按推理强度分档的价。两个端共用同一种形状（Nova 那边是结算价），
 * 但各自放在自己的文件里 —— 两端的单价口径不同，合成一个组件只会让
 * 「这张表说的是哪个数」变成一个要翻代码才能回答的问题。
 */
export function EffortTable({ efforts, caption, hint }: { efforts: ModelEffortPrice[]; caption: string; hint: string }) {
  const { t } = useLocale();
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <span className="gx-label">{caption}</span>
      <div style={{ borderRadius: 10, background: "var(--gx-muted)", padding: "4px 12px" }}>
        <div
          className="gx-th"
          style={{ gridTemplateColumns: "minmax(0, 1fr) 104px 104px 104px", padding: "8px 0" }}
        >
          <span>{t("models.col.effort")}</span>
          <span style={{ textAlign: "right" }}>{t("models.price.input")}</span>
          <span style={{ textAlign: "right" }}>{t("models.price.output")}</span>
          <span style={{ textAlign: "right" }}>{t("models.price.cache")}</span>
        </div>
        {efforts.map((row) => (
          <div
            key={row.effort}
            className="gx-row"
            style={{ gridTemplateColumns: "minmax(0, 1fr) 104px 104px 104px", padding: "9px 0" }}
          >
            <span>{effortLabel(row.effort, t)}</span>
            <span className="gx-mono" style={{ textAlign: "right" }}>{points(row.inputPrice)}</span>
            <span className="gx-mono" style={{ textAlign: "right" }}>{points(row.outputPrice)}</span>
            <span className="gx-mono" style={{ textAlign: "right", color: "var(--gx-soft)" }}>{points(row.cachePrice)}</span>
          </div>
        ))}
      </div>
      <span className="gx-card__hint">{hint}</span>
    </div>
  );
}

/**
 * 档位的中文名。认不出来的原样显示 —— 上游加了新档而我们还没跟上时，
 * 显示成空白会让这一行看起来是坏的，而它照常在计价。
 */
export function effortLabel(effort: string, t: (key: string) => string): string {
  const key = `models.effort.${effort}`;
  const label = t(key);
  return label === key ? effort : label;
}
