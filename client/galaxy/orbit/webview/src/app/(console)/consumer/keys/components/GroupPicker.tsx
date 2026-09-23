"use client";

/**
 * 新建密钥时挑档次：厂商 → 模型 → 档次，一路点下去。
 *
 * 为什么是三级联动，而不是原来那张平铺的清单：平铺那一版把「所有模型 × 所有档次」
 * 摞在一个 280px 高的滚动框里，上架到十几个模型之后，人得在里面上下翻着找自家那一个。
 * 而使用者心里的顺序恰恰是反过来的 —— 先想起「我用 Claude」，再想起「Sonnet」，
 * 最后才挑档次。三级就是把这个顺序照抄进界面。
 *
 * 三级各有各的形状，不是三排一样的胶囊：
 *   · 厂商一共就两三家，摊成一排点一下就到，带上自家的标比读名字快；
 *   · 模型是一列名字，底下压着 modelId —— 那串字使用者要一个字不差填进客户端；
 *   · 档次是右边的卡片：只有它要同时说清价和思考深度，胶囊里塞不下。
 *
 * 文案一律用 keys.* 自己的 key，不借模型广场的 models.*：两页同一个词（「输出」「{n} 组」）
 * 看着能共用，但那一页随时会为自己的排版改写它们，改完这里就跟着变，而这里根本没人在看。
 *
 * **一把密钥只认一个模型的一档**：挑了别的就直接替换，不做多选。密钥本来就是随手建、
 * 随手废的东西（额度在账户上，最多 5 把），与其让人在一屏里勾出一套组合、事后再回想
 * 「这把到底能调哪几个」，不如一把对一个 —— 名字起成「MacBook 上的 Sonnet」就够认。
 *
 * 也正因为只有一个，三级会把它藏进另外两级里（选完切到别家就看不见了），所以底下
 * 常摆一条「已选」：点「生成」之前，人得有一个地方能一眼确认买的是什么，也能就地改。
 */

import { useMemo, useState } from "react";
import { IconCheck } from "@/components/ui/icons";
import { useLocale } from "@/i18n/LocaleProvider";
import { formatPoints } from "@/utils/format";
import { VendorMark, vendorLabel } from "@shared/brand/VendorMark";
import type { ConsumerGroupOption } from "../../api/consumer.api";

/**
 * 两栏的高度写死：换个模型档次多一张少一张，弹框不该跟着上下跳。
 *
 * 244 不是随手取的：整个弹框连页脚一共 684 高，加上 antd 默认的 100 顶距，
 * 一台 1280×800 的笔记本上按钮还在屏幕里 —— 再高一点，「生成」就要滚动才点得到。
 */
const PANE_HEIGHT = 244;

/** 0 不显示成「0」：那一档没定价，写 0 会被读成免费。和模型广场同一个口径。 */
function points(value: number): string {
  return value > 0 ? formatPoints(value) : "-";
}

interface ModelNode {
  modelId: string;
  modelName: string;
  options: ConsumerGroupOption[];
}

interface VendorNode {
  vendor: string;
  models: ModelNode[];
}

/** 这个候选算哪一家。和模型广场同一套回落：厂商没填看族名，两个都没有就归「其他」—— 不猜。 */
function vendorKey(option: ConsumerGroupOption): string {
  return (option.vendor || option.family || "other").trim().toLowerCase();
}

/**
 * 摊平的候选 → 厂商 / 模型 / 档次三层。
 *
 * 每一层的顺序都跟着服务端给的先后（运营排过的目录顺序）：按字母或者按档次数重排，
 * 会把「哪个该摆在前面」这个决定悄悄抹掉。
 */
function toTree(options: ConsumerGroupOption[]): VendorNode[] {
  const vendors: VendorNode[] = [];
  const vendorIndex = new Map<string, VendorNode>();
  const modelIndex = new Map<string, ModelNode>();
  for (const option of options) {
    const key = vendorKey(option);
    let vendorNode = vendorIndex.get(key);
    if (!vendorNode) {
      vendorNode = { vendor: key, models: [] };
      vendorIndex.set(key, vendorNode);
      vendors.push(vendorNode);
    }
    // 模型键带上厂商：同名 modelId 不该被并进别家（真出现了也是两行，各归各家）。
    const modelKey = `${key}/${option.modelId}`;
    let modelNode = modelIndex.get(modelKey);
    if (!modelNode) {
      modelNode = { modelId: option.modelId, modelName: option.modelName || option.modelId, options: [] };
      modelIndex.set(modelKey, modelNode);
      vendorNode.models.push(modelNode);
    }
    modelNode.options.push(option);
  }
  return vendors;
}

/** 这把密钥挑中的那一档：哪个模型、哪一档。一把密钥只有一条，没挑是 null。 */
export interface PickedGroup {
  modelId: string;
  groupId: string;
}

export function GroupPicker({
  options,
  picked,
  onPick,
}: {
  options: ConsumerGroupOption[];
  picked: PickedGroup | null;
  onPick: (next: PickedGroup | null) => void;
}) {
  const { t } = useLocale();
  const tree = useMemo(() => toTree(options), [options]);
  // 这两个只是「点到哪儿了」，不是选中的结果 —— 结果全在 picked 里。
  const [vendor, setVendor] = useState("");
  const [modelId, setModelId] = useState("");

  // 取不到就退回第一个，而不是留一片空白：候选换了一批（切语言、重新拉目录）之后，
  // 上次点中的那家可能已经不在了，空白会被读成「没有模型」。
  const activeVendor = tree.find((node) => node.vendor === vendor) ?? tree[0];
  const models = activeVendor?.models ?? [];
  const activeModel = models.find((model) => model.modelId === modelId) ?? models[0];

  /**
   * 挑中的那一档在目录里对应的是谁：哪一家、哪个模型、这一档叫什么。
   *
   * 回目录里找而不是把名字一起存进 picked：目录随时可能换一批（切语言、重新拉），
   * 存下来的名字会变成一条对不上任何东西的旧字符串，而这里找不到就该当作没挑。
   */
  const chosen = useMemo(() => {
    if (!picked) return null;
    for (const node of tree) {
      for (const model of node.models) {
        if (model.modelId !== picked.modelId) continue;
        const option = model.options.find((row) => row.group.groupId === picked.groupId);
        if (option) {
          return { vendor: node.vendor, modelId: model.modelId, modelName: model.modelName, groupName: option.group.name };
        }
      }
    }
    return null;
  }, [tree, picked]);

  const toggle = (model: ModelNode, groupId: string) => {
    // 再点一次 = 取消（选错了不必关掉重来）；挑别的 = 直接替换 —— 一把密钥只认一档。
    const same = picked?.modelId === model.modelId && picked?.groupId === groupId;
    onPick(same ? null : { modelId: model.modelId, groupId });
  };

  if (options.length === 0) {
    // 平台一档都没上架时这里是空的 —— 直说，而不是留一片空白让人以为在加载。
    return <span className="gx-card__hint">{t("keys.groupsEmpty")}</span>;
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <span className="gx-label">{t("keys.groups")}</span>
      <span className="gx-card__hint">{t("keys.groupsHint")}</span>

      {/* 一级：厂商。摊成一排而不是下拉 —— 一共就两三家，点一下就到。 */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        {tree.map((node) => {
          const label = vendorLabel(node.vendor);
          // 选中的那一档在不在这家。只有一档可挑，所以是「在 / 不在」，不再是数目。
          const holdsPick = chosen?.vendor === node.vendor;
          const active = node.vendor === activeVendor?.vendor;
          return (
            <button
              key={node.vendor}
              type="button"
              aria-pressed={active}
              title={t("keys.groupsVendorTitle", { total: node.models.length })}
              onClick={() => {
                setVendor(node.vendor);
                // 换一家就把模型退回这家的第一个：留着上一家的 modelId，右边那栏会空掉。
                setModelId("");
              }}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 8,
                padding: "8px 12px",
                borderRadius: 11,
                cursor: "pointer",
                font: "inherit",
                fontSize: 13,
                // 选中态靠底色和描边一起说：只改文字色的话，两种状态挨在一起几乎分不出来。
                border: `1px solid ${active ? "var(--gx-accent)" : "var(--gx-line)"}`,
                background: active ? "var(--gx-accent-soft)" : "var(--gx-surface)",
                color: active ? "var(--gx-accent-ink)" : "inherit",
              }}
            >
              <VendorMark vendor={node.vendor} fallback={label} size={15} />
              <span style={{ fontWeight: active ? 600 : 500 }}>{label}</span>
              {holdsPick ? (
                <span
                  style={{
                    display: "inline-flex",
                    width: 16,
                    height: 16,
                    alignItems: "center",
                    justifyContent: "center",
                    borderRadius: "50%",
                    background: "var(--gx-accent)",
                    color: "var(--gx-on-ink)",
                  }}
                >
                  <IconCheck size={10} strokeWidth={2.8} />
                </span>
              ) : (
                <span className="gx-mono" style={{ fontSize: 11.5, color: "var(--gx-faint)" }}>
                  {node.models.length}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* 二级 + 三级：左边挑模型，右边挑它的档次。两栏同高、各自滚动。 */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(0, 224px) minmax(0, 1fr)",
          height: PANE_HEIGHT,
          borderRadius: 12,
          border: "1px solid var(--gx-line)",
          background: "var(--gx-surface)",
          overflow: "hidden",
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", minWidth: 0, borderRight: "1px solid var(--gx-line)" }}>
          <PaneHead title={t("keys.groupsModelPane")} meta={String(models.length)} />
          <div className="gx-scroll" style={{ flex: 1, overflowY: "auto", padding: "4px 6px 8px" }}>
            {models.map((model) => {
              const active = model.modelId === activeModel?.modelId;
              const groupName = chosen?.modelId === model.modelId ? chosen.groupName : "";
              return (
                <button
                  key={model.modelId}
                  type="button"
                  aria-current={active}
                  title={`${model.modelName} · ${model.modelId}`}
                  className={`gx-pick${active ? " is-active" : ""}`}
                  // 宽度写死成撑满：.gx-pick 在窄窗口下有一条 width: 236px 的规则（那是给
                  // 共享设置那种「窄了就横过来划」的主列用的），弹框里的这一列不横过来，
                  // 让它生效只会把右边那颗计数挤出可视区 —— 而且只在某些窗口宽度下挤。
                  style={{ width: "100%" }}
                  onClick={() => setModelId(model.modelId)}
                >
                  <span className="gx-pick__body">
                    <span className="gx-pick__name">
                      <b>{model.modelName}</b>
                    </span>
                    {/* 模型名照原样摆出来：这串字要一个字不差填进客户端。 */}
                    <span className="gx-pick__meta gx-mono">{model.modelId}</span>
                  </span>
                  {/* 选了什么就写什么，没选写还有几档可挑 —— 左边这一列因此不必点进去也读得懂。 */}
                  {groupName ? (
                    // 自己写一颗而不是用 gx-pill：档次名是运营填的，长到一定程度它只会把
                    // 这一行撑开（它 nowrap、不省略），模型名反倒先被挤没。
                    <span
                      className="gx-pill gx-pill--accent"
                      style={{
                        display: "block",
                        flex: "0 0 auto",
                        maxWidth: 84,
                        marginTop: 1,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        lineHeight: "24px",
                      }}
                    >
                      {groupName}
                    </span>
                  ) : (
                    <span className="gx-mono" style={{ flex: "0 0 auto", marginTop: 2, fontSize: 11, color: "var(--gx-faint)" }}>
                      {model.options.length}
                    </span>
                  )}
                </button>
              );
            })}
            {models.length === 0 ? <div className="gx-pick__empty">{t("keys.groupsModelEmpty")}</div> : null}
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
          <PaneHead
            title={activeModel?.modelName ?? ""}
            meta={activeModel ? t("keys.groupsCount", { count: activeModel.options.length }) : ""}
          />
          <div className="gx-scroll" style={{ flex: 1, overflowY: "auto", display: "flex", flexDirection: "column", gap: 8, padding: "8px 10px 10px" }}>
            {(activeModel?.options ?? []).map((option) => (
              <GroupCard
                key={option.group.groupId}
                option={option}
                active={picked?.modelId === option.modelId && picked?.groupId === option.group.groupId}
                onToggle={() => (activeModel ? toggle(activeModel, option.group.groupId) : undefined)}
              />
            ))}
          </div>
        </div>
      </div>

      {/* 已选。三级联动会把选好的东西藏进另外两级，这一条是唯一一处能一次看全的地方，
          所以它一直在 —— 空的时候也占着这一行，免得第一次选完整个弹框往下跳一格。 */}
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          gap: 8,
          minHeight: 30,
        }}
      >
        {chosen ? (
          <>
            <span className="gx-label">{t("keys.groupsPickedLabel")}</span>
            <span className="gx-chip gx-chip--on">
              {/* 点名字回到那个模型：改主意时不用自己再从厂商一级点回去。 */}
              <button
                type="button"
                title={t("keys.groupsJump")}
                onClick={() => {
                  setVendor(chosen.vendor);
                  setModelId(chosen.modelId);
                }}
                style={{ border: 0, padding: 0, background: "none", font: "inherit", color: "inherit", cursor: "pointer" }}
              >
                {chosen.modelName} · {chosen.groupName}
              </button>
              <button type="button" className="gx-chip__x" aria-label={t("keys.groupsDrop")} onClick={() => onPick(null)}>
                ×
              </button>
            </span>
          </>
        ) : (
          <span className="gx-card__hint">{t("keys.groupsTrayEmpty")}</span>
        )}
      </div>
    </div>
  );
}

/** 两栏各自的小抬头。右边那个摆的是模型名 —— 不摆的话，那几张卡片是谁的档次要靠记。 */
function PaneHead({ title, meta }: { title: string; meta: string }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "9px 12px",
        borderBottom: "1px solid var(--gx-line)",
        background: "var(--gx-muted)",
      }}
    >
      <span
        className="gx-label"
        style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
      >
        {title}
      </span>
      <span className="gx-mono" style={{ marginLeft: "auto", flex: "0 0 auto", fontSize: 11, color: "var(--gx-faint)" }}>
        {meta}
      </span>
    </div>
  );
}

/**
 * 一个档次。
 *
 * 三个价一起摆：档次之间差的往往不只是输出价，只给一个数，人得回模型广场对着看。
 */
function GroupCard({ option, active, onToggle }: { option: ConsumerGroupOption; active: boolean; onToggle: () => void }) {
  const { t } = useLocale();
  const group = option.group;
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onToggle}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 7,
        width: "100%",
        padding: "10px 13px",
        borderRadius: 12,
        cursor: "pointer",
        font: "inherit",
        textAlign: "left",
        color: "inherit",
        border: `1px solid ${active ? "var(--gx-accent)" : "var(--gx-line)"}`,
        background: active ? "var(--gx-accent-soft)" : "var(--gx-surface)",
      }}
    >
      <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span
          aria-hidden
          style={{
            display: "inline-flex",
            width: 16,
            height: 16,
            flex: "0 0 auto",
            alignItems: "center",
            justifyContent: "center",
            borderRadius: "50%",
            border: `1px solid ${active ? "var(--gx-accent)" : "var(--gx-border)"}`,
            background: active ? "var(--gx-accent)" : "transparent",
            color: "var(--gx-on-ink)",
          }}
        >
          {active ? <IconCheck size={10} strokeWidth={2.6} /> : null}
        </span>
        <span style={{ fontSize: 13.5, fontWeight: 600, color: active ? "var(--gx-accent-ink)" : undefined }}>{group.name}</span>
      </span>
      {group.summary ? (
        <span style={{ fontSize: 11.5, lineHeight: 1.55, color: "var(--gx-faint)" }}>{group.summary}</span>
      ) : null}
      <span style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 8 }}>
        <Price label={t("keys.groupPriceIn")} value={points(group.inputPrice)} />
        <Price label={t("keys.groupPriceOut")} value={points(group.outputPrice)} />
        <Price label={t("keys.groupPriceCache")} value={points(group.cachePrice)} />
      </span>
    </button>
  );
}

/**
 * 单价一格。标和数并排、三格等宽：并排是为了省一行（右边这一栏一屏要摆得下两张卡片），
 * 等宽是为了几张卡片的同一项上下对齐 —— 对不齐就比不出哪一档贵。
 */
function Price({ label, value }: { label: string; value: string }) {
  return (
    <span style={{ display: "flex", alignItems: "baseline", gap: 5, minWidth: 0 }}>
      <span style={{ fontSize: 11, color: "var(--gx-faint)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {label}
      </span>
      <span className="gx-mono" style={{ fontSize: 12.5 }}>
        {value}
      </span>
    </span>
  );
}
