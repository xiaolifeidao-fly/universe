"use client";

/**
 * 模型页：有哪些模型、每个多少钱。
 *
 * **列表，不是卡片墙。** 加上分组这一维之后，一个模型不再是一个价而是一小张
 * 价目表（同一个模型最深那档能是最浅那档的十几倍），卡片里塞不下；而来访者在这一页
 * 真正在做的事是「在几个模型之间比价」—— 比价要求数字上下对齐，一排卡片做不到。
 *
 * 分档那张表收在行里，点开才展开：先看的总是那三个主价，「这一档要多少」是追问。
 * 但收起来的那一行要把**分档的输出价区间**说出来 —— 只写一个「6 档」，等于让人
 * 一个个点开才知道有没有必要点开。
 *
 * 筛选与搜索都在浏览器里做：整份清单也就几十条，一次全给、本地过滤，
 * 比每敲一个字母打一次接口快得多，也不会在搜索时把页面刷白。
 *
 * 分栏的计数由服务端算好（overview.families）—— 门户算一遍、控制台再算一遍，
 * 同一个模型迟早会在两处落进不同的栏。
 */

import { useMemo, useState } from "react";
import { familyLabel, useLocale } from "@/i18n/LocaleProvider";
import { BADGE_TONES, Btn, Card, Empty, Section, Tag, familyColor, useCopy } from "@/components/site/kit";
import { IconCheck, IconChevron, IconCopy, IconSearch } from "@/components/site/icons";
import { CtaBand, PageHero } from "@/components/home/HomeSections";
import { VendorMark } from "@shared/brand/VendorMark";
import { formatBps, formatContext, formatUnitPrice } from "@/utils/format";
import type { PortalGroupPrice, PortalModel, PortalOverview } from "@/utils/portal";

const ALL = "__all__";

/** Claude 一族的族键。只有它会按 TTL 分档报缓存写入，缓存写那两格只给它摆。 */
const CLAUDE_FAMILY = "claude";


export function ModelExplorer({ overview }: { overview: PortalOverview }) {
  const { t } = useLocale();
  const [family, setFamily] = useState<string>(ALL);
  const [keyword, setKeyword] = useState("");
  /** 展开的那一行，一次只开一个：同时摊开几张分档表，上下相邻的价就又对不齐了。 */
  const [open, setOpen] = useState("");
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
            <Card style={{ padding: "18px 6px 6px" }}>
              <div className="gp-list">
                {/* 表头在窄屏上整条不显示 —— 那时每个数字自己带标签（见 globals.css）。 */}
                <div className="gp-list__head">
                  <span>{t("models.col.model")}</span>
                  <span className="gp-list__right">{t("models.context")}</span>
                  <span className="gp-list__right">{t("models.input")}</span>
                  <span className="gp-list__right">{t("models.output")}</span>
                  <span className="gp-list__right">{t("models.cache")}</span>
                  <span>{t("models.col.group")}</span>
                  <span />
                </div>
                {models.map((model) => (
                  <ModelRow
                    key={model.modelId}
                    model={model}
                    open={open === model.modelId}
                    onToggle={() => setOpen(open === model.modelId ? "" : model.modelId)}
                  />
                ))}
              </div>
            </Card>
            <p className="gp-body" style={{ marginTop: 22, fontSize: 13, maxWidth: "76ch" }}>
              {/* 「与具体模型无关」这句只有在**没有任何模型自己定价**时才成立。
                  运营一旦给某个模型填了价，这句话就会和它上面那张表自相矛盾。 */}
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

/**
 * 分档里最便宜和最贵的输出价。
 *
 * 只看输出：输入与缓存读取在各档之间基本是同一个数，摆出区间等于说了句废话，
 * 而账单的大头本来就在输出这一桶。
 *
 * 各档都一个价时返 null —— 「¥15.00 – ¥15.00」既占地方又读不出任何信息。
 */
function outputRange(groups: PortalGroupPrice[]): [number, number] | null {
  const values = groups.map((row) => row.outputPrice).filter((value) => value > 0);
  if (values.length === 0) return null;
  const low = Math.min(...values);
  const high = Math.max(...values);
  return high > low ? [low, high] : null;
}

/** 官方参考价至少填了一档，而且自家真有价可比 —— 两个条件缺一个就不划线。 */
function hasListPrice(model: PortalModel): boolean {
  const listed = (model.listInputPrice ?? 0) > 0 || (model.listOutputPrice ?? 0) > 0 || (model.listCachePrice ?? 0) > 0;
  return listed && (model.inputPrice > 0 || model.outputPrice > 0);
}

/**
 * 这一行点开之后有没有东西可看。
 *
 * 什么都没有的模型（目录表空着、靠 galaxy.models 兜底出来的那几行）就不做成按钮：
 * 一个点下去什么也不展开的箭头，比没有箭头更让人以为页面坏了。
 */
function hasDetail(model: PortalModel): boolean {
  return (
    (model.groups?.length ?? 0) > 0 ||
    !!model.summary ||
    (model.tags?.length ?? 0) > 0 ||
    hasListPrice(model) ||
    !model.priced
  );
}

function ModelRow({ model, open, onToggle }: { model: PortalModel; open: boolean; onToggle: () => void }) {
  const { t } = useLocale();
  const groups = model.groups ?? [];
  const context = formatContext(model.contextTokens ?? 0);
  const range = outputRange(groups);
  const detail = hasDetail(model);

  const cells = (
    <>
      <span className="gp-list__name">
        {/* 方块底色按族走，官方标在上面落成白色单色版 —— 只等比缩放、只改颜色。 */}
        <span className="gp-list__mark" style={{ background: familyColor(model.family) }}>
          <VendorMark vendor={model.vendor ?? ""} fallback={model.displayName || model.modelId} size={15} />
        </span>
        <span className="gp-list__title">
          <span className="gp-list__label">
            {/* 角标和胶囊定宽、不让步；该被省略号截掉的是名字。 */}
            <b>{model.displayName || model.modelId}</b>
            <span className="gp-list__marks">
              {model.badgeText ? (
                <Tag tone={BADGE_TONES[model.badgeTone ?? "neutral"] ?? "default"}>{model.badgeText}</Tag>
              ) : null}
              {!model.priced ? (
                <span className="gp-tag" title={t("common.unifiedHint")}>
                  {t("common.unified")}
                </span>
              ) : null}
            </span>
          </span>
          {/* 模型名照原样给出来：来访者要把它一个字不差地填进自己的客户端。 */}
          <span className="gp-mono gp-list__id">{model.modelId}</span>
        </span>
      </span>
      <span className="gp-list__num gp-list__num--soft" data-label={t("models.context")}>
        {context || "—"}
      </span>
      <span className="gp-list__num" data-label={t("models.input")}>
        {formatUnitPrice(model.inputPrice, model.currency)}
      </span>
      <span className="gp-list__num" data-label={t("models.output")}>
        {formatUnitPrice(model.outputPrice, model.currency)}
      </span>
      <span className="gp-list__num gp-list__num--soft" data-label={t("models.cache")}>
        {formatUnitPrice(model.cachePrice, model.currency)}
      </span>
      <span className="gp-list__group" data-label={t("models.col.group")}>
        {/* 有分组才说。一个分组都没有的模型是还没开卖的，那时写「—」比编一句话诚实。 */}
        {groups.length > 0 ? (
          <>
            <Tag tone="accent">{t("models.groupCount", { count: groups.length })}</Tag>
            {range ? (
              <span className="gp-mono gp-list__range">
                {formatUnitPrice(range[0], model.currency)} – {formatUnitPrice(range[1], model.currency)}
              </span>
            ) : null}
          </>
        ) : (
          <span style={{ color: "var(--gp-faint)" }}>—</span>
        )}
      </span>
      <span className="gp-list__caret" data-open={open} aria-hidden="true">
        {detail ? <IconChevron /> : null}
      </span>
    </>
  );

  return (
    <div className="gp-list__item">
      {detail ? (
        <button type="button" className="gp-list__row" onClick={onToggle} aria-expanded={open} title={t("models.expand")}>
          {cells}
        </button>
      ) : (
        <div className="gp-list__row" data-static="true">
          {cells}
        </div>
      )}
      {detail && open ? <ModelDetail model={model} /> : null}
    </div>
  );
}

/** 展开之后的那一块：介绍、标签、各个分组的价，以及划线价那一行小字。 */
function ModelDetail({ model }: { model: PortalModel }) {
  const { t } = useLocale();
  const groups = model.groups ?? [];
  const listed = hasListPrice(model);
  const discountBps = model.discountBps ?? 0;

  return (
    <div className="gp-list__detail">
      {model.summary ? (
        <p className="gp-body" style={{ fontSize: 13.5, lineHeight: 1.65 }}>
          {model.summary}
        </p>
      ) : null}

      {model.tags && model.tags.length > 0 ? (
        <div className="gp-model__tags">
          {model.tags.map((tag) => (
            <Tag key={tag}>{tag}</Tag>
          ))}
        </div>
      ) : null}

      {/* 缓存写入两档：只有 Claude 一族按 TTL 分档报 cache_creation，别的族这两个数恒为 0，
          摆出来等于把「上游没有这个概念」说成「这一档免费」。
          放在展开里而不是主表上：主表那几列是 CSS 网格排的，手机上六列挤不下，
          而这两个数又恰恰是重度用缓存的人最需要看清的。 */}
      {model.family === CLAUDE_FAMILY ? (
        <div className="gp-list__hint">
          {t("models.cacheWrite", {
            price5m: formatUnitPrice(model.cacheWritePrice, model.currency),
            price1h: formatUnitPrice(model.cacheWrite1hPrice, model.currency),
          })}
          <span style={{ display: "block", marginTop: 2 }}>{t("models.cacheWriteHint")}</span>
        </div>
      ) : null}

      {groups.length > 0 ? <GroupTable groups={groups} currency={model.currency} /> : null}


      {/* 这一行只剩数：划线价和折扣都没有时整行不出现，否则留下一个空行的 gap。 */}
      {listed || discountBps > 0 ? (
        <div className="gp-list__foot">
          {listed ? (
            <span>
              {t("models.listPrice")}{" "}
              {/* 划线价按主价那几列的顺序排。缓存那一段只在真声明了官方缓存价时才出现：
                  绝大多数模型没有这个数，平白多一个「-」等于让人以为我们漏填了。 */}
              <s className="gp-mono">
                {formatUnitPrice(model.listInputPrice ?? 0, model.currency)} /{" "}
                {formatUnitPrice(model.listOutputPrice ?? 0, model.currency)}
                {(model.listCachePrice ?? 0) > 0 ? ` / ${formatUnitPrice(model.listCachePrice ?? 0, model.currency)}` : ""}
              </s>
            </span>
          ) : null}
          {/* 折扣是服务端按输出价算好的。门户再减一遍的话，这里和使用端迟早标出两个数。 */}
          {discountBps > 0 ? <Tag tone="ok">{t("models.discount", { rate: formatBps(discountBps) })}</Tag> : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * 这个模型在卖的分组。
 *
 * 分组是平台真正在卖的单位：价挂在它上面，建密钥时选的也是它。
 * 「快速」单独一列 —— 它不是价，是能力：买了不支持快速的分组，客户端开了快速也不算数。
 */
function GroupTable({ groups, currency }: { groups: PortalGroupPrice[]; currency: string }) {
  const { t } = useLocale();
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <span className="gp-list__caption">{t("models.groupTitle")}</span>
      <div className="gp-groups">
        <div className="gp-groups__head">
          <span>{t("models.col.group")}</span>
          <span className="gp-list__right">{t("models.input")}</span>
          <span className="gp-list__right">{t("models.output")}</span>
          <span className="gp-list__right">{t("models.cache")}</span>
        </div>
        {groups.map((row) => (
          <div className="gp-groups__row" key={row.groupId}>
            <span>
              {row.name}
              {row.allowFast ? (
                <>
                  {" "}
                  <Tag tone="accent">{t("models.fastOn")}</Tag>
                </>
              ) : null}
              {row.summary ? <span className="gp-groups__note">{row.summary}</span> : null}
            </span>
            <span className="gp-mono gp-list__right">{formatUnitPrice(row.inputPrice, currency)}</span>
            <span className="gp-mono gp-list__right">{formatUnitPrice(row.outputPrice, currency)}</span>
            <span className="gp-mono gp-list__right gp-list__num--soft">{formatUnitPrice(row.cachePrice, currency)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
