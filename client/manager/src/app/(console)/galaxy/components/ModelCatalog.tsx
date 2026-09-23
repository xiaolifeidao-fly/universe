"use client";

import { DeleteOutlined, PlusOutlined, ReloadOutlined, WarningOutlined } from "@ant-design/icons";
import {
  Alert,
  Button,
  Card,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Tooltip,
  Typography,
  message,
} from "antd";
import type { ColumnsType } from "antd/es/table";
import dayjs, { type Dayjs } from "dayjs";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useLocale } from "@/i18n/LocaleProvider";
import { ManagerDatePicker } from "@/components/date/DatePickers";
import { useCanWrite } from "@/components/permission/WritePermission";
import {
  deleteGalaxyModel,
  deleteModelGroup,
  fetchGalaxyModels,
  fetchPrices,
  fetchReferralSettings,
  saveGalaxyModel,
  saveModelGroup,
  savePrice,
  saveReferralSettings,
  type GalaxyModelView,
  type ModelGroupView,
  type PriceTableView,
  type PriceView,
  type ReferralSettingsView,
} from "../api/galaxy.api";
import { effortLabel, HIDDEN_UNITS, kindLabel, optionMatches, unitLabel } from "./labels";

/** 单价在库里是「每百万 token 的微元」；表单里填元。 */
const MICRO = 1_000_000;

/** 模型没写 kind 时按它算。和服务端 portalKind 同一个值。 */
const DEFAULT_KIND = "llm.chat";

/** 「全部厂商」在 Select 里用空串表达：undefined 会被 antd 当成没选，显示成占位符。 */
const ALL_VENDORS = "";

/**
 * 「未标厂商」那一档的值。
 *
 * 用一个不可能当厂商名的字符，而不是 "-" / "none" / "未知"：真有个厂商叫那个名字时，
 * 两档会并成一档，而筛出来的表看起来完全正常 —— 少的那几行没有任何地方会提示。
 */
const NO_VENDOR = "\u0000";

/**
 * 对话类能力**一定**要摆出来的计价桶，哪怕价目表里一行都没有 ——
 * 没有价的那一档扣费与结算静默算 0，而「表里没有这一行」和「这一档不要钱」
 * 在界面上长得一模一样。摆出来才看得见「这里是空的」。
 *
 * 三个桶互不重叠：input 只算未命中缓存的新增输入，命中的走 cache_read。
 * 缓存写入是另一回事，见下面的 CACHE_WRITE_UNITS。
 */
const LLM_UNITS = [
  "llm.input_tokens",
  "llm.output_tokens",
  "llm.cache_read_tokens",
] as const;

/**
 * 缓存写入的两个计价桶，按 TTL 分：5 分钟与 1 小时，单价差 1.6 倍
 * （输入价的 1.25 倍 vs 2 倍）。真正进账本的是它们，不是那个合计。
 *
 * 和 LLM_UNITS 分开列，因为它们**只对 Anthropic 一族成立**：按 TTL 分档报
 * cache_creation 的只有 Claude，Codex 一族的 usage 里压根没有这个数。
 * 给 Codex 的模型摆这两行，运营填进去的价永远匹配不到任何一次请求 ——
 * 而匹配不上不报错，只是那两行永远是 0。
 *
 * TTL 是调用方在请求体的 cache_control 里自己写的（不写 = 5 分钟），
 * 平台这边既控制不了也预测不了，所以两档都得有价。
 */
const CACHE_WRITE_UNITS = ["llm.cache_write_5m_tokens", "llm.cache_write_1h_tokens"] as const;



/** 返现比例存万分之一：1000 = 10%。表单里填百分数。折扣也是万分之一，同一个函数。 */
function percent(bps: number): string {
  return `${(bps / 100).toLocaleString("en-US", { maximumFractionDigits: 2 })}%`;
}

/**
 * 目录里的族名（claude / gpt / …）→ 协议族，也就是强度词表的键。
 *
 * 和服务端 portal.go 的 protocolFamily 是同一张表。两套族名不合并：目录那一套是
 * 给人看的分栏，协议族是上游的接口形状（决定请求体里那个强度字段叫什么）。
 * 认不出来的回空串 —— 那时拿不到词表，排序退化成字典序，但不会排成反的。
 */
function protocolFamily(family: string): string {
  switch (family.trim().toLowerCase()) {
    case "claude":
      return "anthropic";
    case "gpt":
      return "openai";
    default:
      return "";
  }
}

/**
 * 这个模型的推理强度该按哪一族的词表 —— 强度下拉、强度胶囊的排序都认它。
 *
 * 先认目录里的族名（claude / gpt），认不出来再拿族名和**厂商**去词表里对：厂商栏里
 * 填的本来就常常是协议族名本身（anthropic / openai），而新接一个 OpenAI 兼容的上游时，
 * 族名多半是它自己的牌子、只有厂商对得上词表。
 *
 * 两个都认不出来回空串，**不猜一族**：那时界面退回摆两族的全集，让运营自己挑。
 * 猜错的后果是给这个模型摆出几档它根本没有的价，而那几行价永远匹配不上任何一次请求。
 */
function effortFamilyOf(family: string, vendor: string, ladders: Record<string, string[]>): string {
  const known = protocolFamily(family);
  if (known) return known;
  for (const candidate of [family, vendor]) {
    const key = candidate.trim().toLowerCase();
    if (key && (ladders[key]?.length ?? 0) > 0) return key;
  }
  return "";
}

/**
 * 强度胶囊的配色，由浅到深逐级加重。
 *
 * 颜色在这里是**排序信息**而不是装饰：一行里并排几个档，光看「低 / 极高」两个词，
 * 「哪档更深」要一个一个读。词表以外的档没有配色，落到默认灰 —— 不猜。
 */
const EFFORT_TONE: Record<string, string> = {
  none: "default",
  minimal: "cyan",
  low: "blue",
  medium: "geekblue",
  high: "purple",
  xhigh: "magenta",
  max: "red",
  // ultra 只有 Codex 有，排在 max 之上。
  ultra: "volcano",
};

/** 毛利率按万分之一算。负数 = 结算价高过对外价，平台在倒贴。 */
function marginText(bps: number) {
  return `${(bps / 100).toFixed(bps % 100 === 0 ? 0 : 1)}%`;
}

/**
 * 角标配色。给的是语义名而不是颜色名：库里存「这是个主推位」，各端按自己的调色板渲染。
 * 顺序就是下拉里的顺序，neutral 排最前 —— 它是不想强调时的那个选择。
 */
const BADGE_TONES = ["neutral", "hot", "new", "value"] as const;
type BadgeTone = (typeof BADGE_TONES)[number];

/** 运营台上的角标预览。用 antd 的 Tag 近似各端胶囊的观感，只为让人一眼认出配色差别。 */
const BADGE_TAG_COLOR: Record<BadgeTone, string> = {
  neutral: "default",
  hot: "cyan",
  new: "gold",
  value: "green",
};

type ModelForm = {
  modelId: string;
  displayName: string;
  vendor: string;
  family: string;
  kind: string;
  contextTokens: number | null;
  maxOutputTokens: number | null;
  listInputYuan: number | null;
  listOutputYuan: number | null;
  listCacheYuan: number | null;
  tags: string[];
  summary: string;
  badgeText: string;
  badgeTone: BadgeTone;
  listed: boolean;
  featured: boolean;
  sortOrder: number | null;
};

function toForm(row: GalaxyModelView | null): ModelForm {
  return {
    modelId: row?.modelId ?? "",
    displayName: row?.displayName ?? "",
    vendor: row?.vendor ?? "",
    family: row?.family ?? "",
    kind: row?.kind ?? DEFAULT_KIND,
    contextTokens: row?.contextTokens ?? 0,
    maxOutputTokens: row?.maxOutputTokens ?? 0,
    listInputYuan: row ? row.listInputPrice / MICRO : 0,
    listOutputYuan: row ? row.listOutputPrice / MICRO : 0,
    listCacheYuan: row ? row.listCachePrice / MICRO : 0,
    tags: row?.tags ?? [],
    summary: row?.summary ?? "",
    badgeText: row?.badgeText ?? "",
    // 服务端在文案为空时把配色一起清掉，回到表单里要给个默认值，
    // 否则 Select 显示空白，存回去的也是空白。
    badgeTone: (BADGE_TONES.find((tone) => tone === row?.badgeTone) ?? "neutral") as BadgeTone,
    listed: row?.listed ?? true,
    featured: row?.featured ?? false,
    sortOrder: row?.sortOrder ?? 0,
  };
}

/** 「定价」弹窗打开时锁定的目标。modelId 为空串 = 改这个能力的兜底价。 */
type PriceTarget = {
  kind: string;
  modelId: string;
  title: string;
  /**
   * 这个模型的族与厂商。弹窗里只拿它们定一件事：强度下拉摆哪一族的档。
   *
   * 兜底价那一行（modelId 为空）不带 —— 它跨模型，不属于任何一族。
   */
  family?: string;
  vendor?: string;
  /**
   * 打开时落在哪个**分组**上。不填 = 这个模型的通价（没单独定价的分组都按它收）。
   *
   * 有它才能从列表上那几个分组胶囊直接点进对应的分组 —— 否则运营得先点「定价」、
   * 再在弹框里把分组切一遍，而那一步正是最容易切错的地方（一屏四个桶长得一样）。
   */
  groupId?: string;
};

/**
 * 模型目录：门户和使用端模型广场上列出来的模型、它们的单价，以及分享返现比例。
 *
 * 一行两个入口，对应两类完全不同的东西：
 *
 *   · **基础配置** 改「这个模型是什么」—— 名字、族、上下文、标签、角标、上下架，
 *     外加官方参考价（**别人家**的价，模型广场上划掉的那道线）。
 *   · **定价** 改「我们收多少」—— 输入 / 输出 / 缓存各一行，每行两个价：
 *     对外单价向使用者收，结算单价结给共享者，差额是平台毛利。
 *
 * 这两样在库里也是分开的：前者存在模型行上，后者只有价目表
 * （`能力 × 模型 × 计量单位 × 生效时间`）一个出处。同一个数在两处各填一遍的后果，
 * 是门户标一个价、账上扣另一个价，而两边都不会报错。
 *
 * 表上那一列「对外单价」是**服务端按当前价目表现算的**，和门户卡片、使用端模型广场
 * 走同一段代码：这一页要回答的正是「门户上会标成多少」。标着「统一价」的那些行
 * 用的是该能力的兜底价，不是这个模型自己的行。
 *
 * 返现怎么算：被邀请的人充值，按「实付 × 比例」返给邀请人。模型没单独设比例就走默认。
 * 「单独设成 0」是这个模型不返，和「走默认」不是一回事。比例改了只影响之后的充值。
 */
export function ModelCatalog() {
  const { t } = useLocale();
  const canWrite = useCanWrite();
  const [rows, setRows] = useState<GalaxyModelView[]>([]);
  const [table, setTable] = useState<PriceTableView | null>(null);
  const [settings, setSettings] = useState<ReferralSettingsView | null>(null);
  const [defaultPercent, setDefaultPercent] = useState<number | null>(0);
  const [loading, setLoading] = useState(true);
  const [savingDefault, setSavingDefault] = useState(false);
  const [editing, setEditing] = useState<GalaxyModelView | null>(null);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [pricing, setPricing] = useState<PriceTarget | null>(null);
  /** 正在管分组的那个模型。分组是平台在卖的单位，所以入口在模型行上，而不是另开一页。 */
  const [grouping, setGrouping] = useState<GalaxyModelView | null>(null);
  /** 只按厂商筛。空串 = 全部厂商（见 ALL_VENDORS）。 */
  const [vendorFilter, setVendorFilter] = useState(ALL_VENDORS);
  const [form] = Form.useForm<ModelForm>();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      // 价目表和模型目录一起取：那一列「对外单价」由服务端算好挂在模型上，
      // 而「定价」弹窗要回显这个模型自己填了什么（不回落），得看原始的价目行。
      const [models, referral, prices] = await Promise.all([
        fetchGalaxyModels(),
        fetchReferralSettings(),
        fetchPrices(),
      ]);
      setRows(models);
      setSettings(referral);
      setDefaultPercent(referral.defaultBps / 100);
      setTable(prices);
    } catch (error) {
      message.error((error as Error).message || t("galaxy.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * 每个模型底下的分组，按运营排的顺序。
   *
   * 一次把整张表折出来，而不是每行各扫一遍分组清单：这一页会逐行渲染几十个模型，
   * 每行都 filter 一遍整份分组等于几十趟全表。
   */
  const groupsByModel = useMemo(() => {
    const index = new Map<string, ModelGroupView[]>();
    for (const group of table?.groups ?? []) {
      const bucket = index.get(group.modelId);
      if (bucket) bucket.push(group);
      else index.set(group.modelId, [group]);
    }
    return index;
  }, [table]);

  const saveDefault = async () => {
    setSavingDefault(true);
    try {
      await saveReferralSettings(Math.round((defaultPercent ?? 0) * 100));
      message.success(t("galaxy.model.saved"));
      void load();
    } catch (error) {
      message.error((error as Error).message || t("galaxy.actionFailed"));
    } finally {
      setSavingDefault(false);
    }
  };

  const edit = (row: GalaxyModelView | null) => {
    setEditing(row);
    form.setFieldsValue(toForm(row));
    setOpen(true);
  };

  const submit = async () => {
    const values = await form.validateFields();
    setSaving(true);
    try {
      await saveGalaxyModel({
        modelId: values.modelId.trim(),
        displayName: values.displayName?.trim() ?? "",
        vendor: values.vendor?.trim() ?? "",
        family: values.family?.trim() ?? "",
        kind: values.kind?.trim() ?? "",
        contextTokens: values.contextTokens ?? 0,
        maxOutputTokens: values.maxOutputTokens ?? 0,
        listInputPrice: Math.round((values.listInputYuan ?? 0) * MICRO),
        listOutputPrice: Math.round((values.listOutputYuan ?? 0) * MICRO),
        listCachePrice: Math.round((values.listCacheYuan ?? 0) * MICRO),
        currency: "CNY",
        tags: values.tags ?? [],
        summary: values.summary?.trim() ?? "",
        badgeText: values.badgeText?.trim() ?? "",
        badgeTone: values.badgeTone ?? "neutral",
        listed: values.listed,
        featured: values.featured,
        sortOrder: values.sortOrder ?? 0,
      });
      message.success(t("galaxy.model.saved"));
      setOpen(false);
      void load();
    } catch (error) {
      message.error((error as Error).message || t("galaxy.actionFailed"));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (row: GalaxyModelView) => {
    try {
      await deleteGalaxyModel(row.modelId);
      message.success(t("galaxy.model.deleted"));
      void load();
    } catch (error) {
      message.error((error as Error).message || t("galaxy.actionFailed"));
    }
  };

  const price = (value: number) => (value > 0 ? `¥${(value / MICRO).toFixed(2)}` : "-");

  const prices = useMemo(() => table?.prices ?? [], [table]);
  // 「有量无价」告警跟着 HIDDEN_UNITS 走：藏起来的单位没有定价入口，
  // 留着一条「有用量、没有价 · 去定价」的橙色胶囊，点过去却找不到那一行，
  // 是把「我们不收这笔钱」说成了「你忘了填」。
  //
  // 现在只藏合计。缓存写入的 5m / 1h 两档会在这里告警，而那正是要的 ——
  // 它们真有量也真该有价，静默按 0 收才是问题。
  const unpriced = (table?.unpriced ?? []).filter((row) => !HIDDEN_UNITS.has(row.unit));


  /**
   * 兜底价能改哪些能力：价目表里出现过的，加上模型目录里声明过的。
   * 两边取并集 —— 只看价目表的话，一个刚接进来、还一行价都没有的能力
   * 就永远进不了这个下拉，而它恰恰是最需要定价的那个。
   */
  const kinds = useMemo(() => {
    const seen = new Set<string>([DEFAULT_KIND]);
    // 服务端给的候选最全：它含着「跑过用量但一行价都没有」的能力 ——
    // 那些恰恰是最需要配兜底价的，只看价目表的话它们永远进不了这个下拉。
    for (const kind of table?.kinds ?? []) seen.add(kind);
    for (const row of prices) seen.add(row.kind);
    for (const row of rows) seen.add(row.kind || DEFAULT_KIND);
    return Array.from(seen).sort();
  }, [table, prices, rows]);

  /**
   * 厂商候选：目录里**真出现过**的那几个。
   *
   * 不写死一张厂商表 —— 接一个新上游只是 vendor 这一列多一个值，写死的话它永远进不了
   * 这个下拉，而运营看到的是「筛选器里没有我刚加的那家」。没填厂商的模型单独归一档：
   * 它们最容易在「按厂商核一遍价」时被整批漏掉，而漏掉的那些照常在计费。
   */
  const vendors = useMemo(() => {
    const seen = new Set<string>();
    let blank = false;
    for (const row of rows) {
      const value = row.vendor?.trim() ?? "";
      if (value) seen.add(value);
      else blank = true;
    }
    const list = Array.from(seen).sort();
    return blank ? [...list, NO_VENDOR] : list;
  }, [rows]);

  // 选中的厂商在这批数据里已经没有了（改过厂商名、模型下架），退回「全部」——
  // 不退的话是一张空表，而空表和「模型目录没了」长得一模一样。
  const vendor = vendors.includes(vendorFilter) ? vendorFilter : ALL_VENDORS;

  const visibleRows = useMemo(() => {
    if (vendor === ALL_VENDORS) return rows;
    return rows.filter((row) => (row.vendor?.trim() ? row.vendor.trim() === vendor : vendor === NO_VENDOR));
  }, [rows, vendor]);

  /**
   * 当前筛出来的这批模型是不是**清一色 Claude**。
   *
   * 缓存写入那两档只对 Anthropic 一族成立，而这张表是各厂商混排的。逐行判断的话，
   * 同一列在 Claude 行有两个数、在 Codex 行是破折号，一列三种形态比看不见还难读。
   * 所以按**视图**给：把厂商筛到只剩 Claude，这一列才多出那两格。
   *
   * 空表不算 —— 筛出零行时列跟着变宽，看起来像是筛选器把列也改了。
   */
  const claudeView = useMemo(
    () => visibleRows.length > 0 && visibleRows.every((row) => protocolFamily(row.family ?? "") === "anthropic"),
    [visibleRows],
  );


  const columns: ColumnsType<GalaxyModelView> = [
    {
      title: t("galaxy.model.model"),
      dataIndex: "modelId",
      width: 240,
      render: (modelId: string, row) => (
        <Space direction="vertical" size={0}>
          <span style={{ fontWeight: 600 }}>{row.displayName || modelId}</span>
          <Typography.Text type="secondary" className="manager-mono" style={{ fontSize: 12 }}>
            {modelId}
          </Typography.Text>
          {row.id > 0 ? (
            <Typography.Text type="secondary" className="manager-mono" style={{ fontSize: 12 }}>
              {t("galaxy.model.recordId")}: {row.id}
            </Typography.Text>
          ) : null}
        </Space>
      ),
    },
    {
      title: t("galaxy.model.family"),
      dataIndex: "family",
      width: 140,
      render: (family: string, row) => (
        <Space size={4} wrap>
          <Tag>{family || "-"}</Tag>
          {row.vendor ? <Typography.Text type="secondary">{row.vendor}</Typography.Text> : null}
        </Space>
      ),
    },
    {
      // 我们自己收的价。几档并排，顺序和模型卡片上那几格一致 ——
      // 运营在这一页核对的就是「门户上会标成多少」，两处顺序不同就得逐个认。
      //
      // 筛到只剩 Claude 时多出缓存写入两档（5 分钟 / 1 小时），见 claudeView。
      // 那一档的 tooltip 要把 TTL 是谁定的说清楚：五个数并排，光看表头认不出
      // 后两个为什么有两档，更认不出它由调用方决定、运营这边只能两档都备着价。
      title: claudeView ? (
        <Tooltip title={t("galaxy.model.ourPricesClaudeHint")}>
          <span>{t("galaxy.model.ourPricesClaude")}</span>
        </Tooltip>
      ) : (
        t("galaxy.model.ourPrices")
      ),

      key: "ourPrices",
      width: claudeView ? 320 : 230,
      render: (_, row) =>
        row.inputPrice > 0 || row.outputPrice > 0 || row.cachePrice > 0 ? (
          <Space size={6} wrap>
            <span className="manager-mono">
              {price(row.inputPrice)} / {price(row.outputPrice)} / {price(row.cachePrice)}
              {claudeView ? ` / ${price(row.cacheWritePrice)} / ${price(row.cacheWrite1hPrice)}` : ""}
            </span>

            {/* 回落到兜底价时必须说出来：不说的话，一屏模型显示同一个数看起来像页面坏了，
                而运营会以为这些模型都单独定过价。 */}
            {!row.priced ? (
              <Tooltip title={t("galaxy.model.unifiedHint")}>
                <Tag color="blue">{t("galaxy.model.unified")}</Tag>
              </Tooltip>
            ) : null}
          </Space>
        ) : (
          // 一档价都查不到 = 这个模型的用量在静默按 0 计费。这句话不能写成「-」。
          <Tooltip title={t("galaxy.model.ourPriceNoneHint")}>
            <Typography.Text type="danger">{t("galaxy.model.ourPriceNone")}</Typography.Text>
          </Tooltip>
        ),
    },
    {
      // 这个模型底下的分组：平台在这个模型上真正在卖的几个档次。
      //
      // 必须摆在列表上，不能只藏在弹框里：分组之间的输出价可以差两三倍，而这一页是
      // 运营唯一会逐行扫的地方 —— 看不见的话，「哪些模型分了档、哪些还没建分组」
      // 只能一个一个点开去数，而**一个分组都没有的模型，使用端根本签不出能用它的密钥**。
      //
      // 胶囊直接点进这个分组的定价，省掉「先点定价、再切分组」这一步 —— 那一步切错不报错。
      title: t("galaxy.group.column"),
      key: "groups",
      width: 240,
      render: (_, row) => {
        const groups = groupsByModel.get(row.modelId) ?? [];
        if (groups.length === 0) {
          // 这不是「常态」，是**卖不出去**：使用端建密钥要选分组，一个都没有就选不到它。
          return (
            <Tooltip title={t("galaxy.group.noneHint")}>
              <Typography.Text type="danger">{t("galaxy.group.none")}</Typography.Text>
            </Tooltip>
          );
        }
        return (
          <Space size={4} wrap>
            {groups.map((group) => (
              <Tag
                key={group.groupId}
                color={group.listed ? (group.priced ? "blue" : "default") : "warning"}
                style={canWrite ? { cursor: "pointer", marginInlineEnd: 0 } : { marginInlineEnd: 0 }}
                onClick={
                  canWrite
                    ? () =>
                        setPricing({
                          kind: row.kind || DEFAULT_KIND,
                          modelId: row.modelId,
                          title: row.displayName || row.modelId,
                          family: row.family,
                          vendor: row.vendor,
                          groupId: group.groupId,
                        })
                    : undefined
                }
                title={[
                  group.summary,
                  group.listed ? "" : t("galaxy.group.unlisted"),
                  group.priced ? "" : t("galaxy.group.inherits"),
                  group.allowFast ? t("galaxy.group.fastOn") : t("galaxy.group.fastOff"),
                ]
                  .filter(Boolean)
                  .join(" · ")}
              >
                {group.name}
                {group.isDefault ? ` ${t("galaxy.group.defaultMark")}` : ""}
                {group.allowFast ? " ⚡" : ""}
              </Tag>
            ))}
          </Space>
        );
      },
    },
    {
      // 划线价单独一列，不并进上面那格：它是对外声明的**别人家的价**，
      // 和我们自己的三档混在一行，核对的时候第一眼分不清哪个是哪个。
      title: t("galaxy.model.listPrices"),
      key: "listPrices",
      width: 230,
      render: (_, row) =>
        row.listInputPrice > 0 || row.listOutputPrice > 0 || row.listCachePrice > 0 ? (
          <Space size={6} wrap>
            <span className="manager-mono">
              {price(row.listInputPrice)} / {price(row.listOutputPrice)} / {price(row.listCachePrice)}
            </span>
            {/* 折扣是服务端按输出价算好的。填了官方价却显示「-」，
                多半是官方价没比自家价高 —— 让运营在这里就看见，而不是等卡片上少一块。 */}
            {row.discountBps > 0 ? (
              <Tag color="green">{t("galaxy.model.discount").replace("{rate}", percent(row.discountBps))}</Tag>
            ) : (
              <Typography.Text type="secondary">-</Typography.Text>
            )}
          </Space>
        ) : (
          <Typography.Text type="secondary">{t("galaxy.model.listPriceNone")}</Typography.Text>
        ),
    },
    {
      title: t("galaxy.model.badge"),
      dataIndex: "badgeText",
      width: 120,
      render: (text: string, row) =>
        text ? (
          <Tag color={BADGE_TAG_COLOR[(BADGE_TONES.find((tone) => tone === row.badgeTone) ?? "neutral") as BadgeTone]}>{text}</Tag>
        ) : (
          <Typography.Text type="secondary">-</Typography.Text>
        ),
    },
    {
      title: t("galaxy.model.status"),
      dataIndex: "listed",
      width: 120,
      render: (listed: boolean | undefined, row) => (
        <Space size={4} wrap>
          {listed ? <Tag color="success">{t("galaxy.package.listed")}</Tag> : <Tag>{t("galaxy.package.unlisted")}</Tag>}
          {row.featured ? <Tag color="blue">{t("galaxy.model.featured")}</Tag> : null}
        </Space>
      ),
    },
    { title: t("galaxy.package.sortOrder"), dataIndex: "sortOrder", width: 80, align: "right" },
    {
      title: t("galaxy.actions"),
      key: "actions",
      width: 300,
      fixed: "right",
      render: (_, row) =>
        canWrite ? (
          <Space size={8}>
            <Button
              size="small"
              type="primary"
              ghost
              onClick={() =>
                setPricing({
                  kind: row.kind || DEFAULT_KIND,
                  modelId: row.modelId,
                  title: row.displayName || row.modelId,
                  family: row.family,
                  vendor: row.vendor,
                })
              }
            >
              {t("galaxy.model.pricing")}
            </Button>
            <Button size="small" onClick={() => setGrouping(row)}>
              {t("galaxy.group.manage")}
            </Button>
            <Button size="small" onClick={() => edit(row)}>
              {t("galaxy.model.basics")}
            </Button>
            <Popconfirm
              title={t("galaxy.model.delete")}
              description={<div style={{ maxWidth: 300 }}>{t("galaxy.model.deleteHint")}</div>}
              okText={t("galaxy.confirm")}
              cancelText={t("galaxy.cancel")}
              onConfirm={() => void remove(row)}
            >
              <Button size="small" danger icon={<DeleteOutlined />} />
            </Popconfirm>
          </Space>
        ) : null,
    },
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {/* 一行价都没有 = 全站扣费与分成都是 0。这句话必须排在最前面。 */}
      {!loading && prices.length === 0 ? (
        <Alert type="error" showIcon message={t("galaxy.price.empty")} description={t("galaxy.price.emptyHint")} />
      ) : null}

      {/* 有量无价：这些用量的钱正在被静默算成 0。原先挂在「单价」页签上，
          那一页收起来之后它必须跟着搬到这里 —— 不然这个故障只能从「钱对不上」反推。 */}
      {unpriced.length > 0 ? (
        <Alert
          type="warning"
          showIcon
          icon={<WarningOutlined />}
          message={t("galaxy.price.unpricedTitle").replace("{count}", String(unpriced.length))}
          description={
            <Space direction="vertical" size={8} style={{ width: "100%" }}>
              <span>{t("galaxy.price.unpricedHint")}</span>
              <Space wrap size={[8, 8]}>
                {unpriced.map((row) => (
                  <Tag
                    key={`${row.kind}:${row.unit}`}
                    color="warning"
                    style={{ cursor: canWrite ? "pointer" : "default" }}
                    onClick={
                      canWrite
                        ? () =>
                            setPricing({
                              kind: row.kind,
                              modelId: "",
                              title: t("galaxy.model.fallbackTitle").replace("{kind}", kindLabel(row.kind, t)),
                            })
                        : undefined
                    }
                    title={`${row.kind} · ${row.unit}`}
                  >
                    {kindLabel(row.kind, t)} · {unitLabel(row.unit, t)}
                    {canWrite ? ` · ${t("galaxy.price.fix")}` : ""}
                  </Tag>
                ))}
              </Space>
            </Space>
          }
        />
      ) : null}

      <Card size="small" title={t("galaxy.model.defaultTitle")}>
        <Space wrap align="center">
          <InputNumber
            min={0}
            max={100}
            precision={2}
            value={defaultPercent}
            onChange={setDefaultPercent}
            addonAfter="%"
            disabled={!canWrite}
            style={{ width: 160 }}
          />
          {canWrite ? (
            <Button type="primary" loading={savingDefault} onClick={() => void saveDefault()}>
              {t("galaxy.package.save")}
            </Button>
          ) : null}
          <Typography.Text type="secondary">{t("galaxy.model.defaultHint")}</Typography.Text>
          {settings?.updatedBy ? (
            <Typography.Text type="secondary">
              {t("galaxy.model.defaultUpdated")
                .replace("{by}", settings.updatedBy)
                .replace("{at}", settings.updatedAt ? new Date(settings.updatedAt).toLocaleString() : "-")}
            </Typography.Text>
          ) : null}
        </Space>
      </Card>

      <Space wrap>
        {canWrite ? (
          <Button type="primary" icon={<PlusOutlined />} onClick={() => edit(null)}>
            {t("galaxy.model.new")}
          </Button>
        ) : null}
        <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void load()}>
          {t("galaxy.refresh")}
        </Button>
        {/* 按厂商筛。核价是按厂商一批一批核的（同一家的几个模型共用一份上游价表），
            而这张表默认是全量的几十行 —— 不筛就得每次先用眼睛过一遍。 */}
        <Select
          showSearch
          style={{ width: 200 }}
          value={vendor}
          onChange={setVendorFilter}
          filterOption={optionMatches}
          options={[
            { value: ALL_VENDORS, label: t("galaxy.model.vendorAll") },
            ...vendors.map((value) => {
              const label = value === NO_VENDOR ? t("galaxy.model.vendorNone") : value;
              return { value, title: label, label };
            }),
          ]}
        />
        {/* 藏了多少行要说出来：不说的话，少掉的那几十行看着就像没存进去。 */}
        {vendor === ALL_VENDORS ? null : (
          <Typography.Text type="secondary">
            {t("galaxy.model.filtered", { shown: visibleRows.length, total: rows.length })}
          </Typography.Text>
        )}
        {/* 兜底价不属于任何模型（价目行的 modelId 是空串），所以它进不了上面任何一行的
            「定价」。没有这个入口的话，没单独定价的模型全部退回「查不到价」，
            而查不到价是静默算 0。 */}
        {canWrite ? (
          <Tooltip title={t("galaxy.model.fallbackHint")}>
            <Button
              onClick={() =>
                setPricing({
                  kind: DEFAULT_KIND,
                  modelId: "",
                  title: t("galaxy.model.fallbackTitle").replace("{kind}", kindLabel(DEFAULT_KIND, t)),
                })
              }
            >
              {t("galaxy.model.fallback")}
            </Button>
          </Tooltip>
        ) : null}
      </Space>

      <Table<GalaxyModelView>
        rowKey="modelId"
        size="small"
        loading={loading}
        columns={columns}
        dataSource={visibleRows}
        // 筛空了和「目录是空的」要说两句话：后者那句写着「门户会回落到 galaxy.models」,
        // 在只是筛掉了的时候念出来，是在报一个并不存在的故障。
        locale={{ emptyText: rows.length > 0 ? t("galaxy.model.vendorEmpty") : t("galaxy.model.empty") }}
        pagination={false}
        // 分组列 240px + 操作列宽了 80px，横向总宽跟着走；不跟的话最后几列会被挤成两行。
        scroll={{ x: 2010 }}
      />

      <ModelPricing
        target={pricing}
        prices={prices}
        kinds={kinds}
        unitCandidates={table?.units ?? []}
        groups={pricing ? (groupsByModel.get(pricing.modelId) ?? []) : []}
        onClose={() => setPricing(null)}
        onSaved={() => void load()}
      />

      <ModelGroups
        model={grouping}
        groups={grouping ? (groupsByModel.get(grouping.modelId) ?? []) : []}
        efforts={table?.efforts ?? {}}
        onClose={() => setGrouping(null)}
        onSaved={() => void load()}
        onPrice={(group) =>
          grouping
            ? setPricing({
                kind: grouping.kind || DEFAULT_KIND,
                modelId: grouping.modelId,
                title: grouping.displayName || grouping.modelId,
                family: grouping.family,
                vendor: grouping.vendor,
                groupId: group.groupId,
              })
            : undefined
        }
      />

      <Modal
        open={open}
        title={editing ? t("galaxy.model.basics") : t("galaxy.model.new")}
        okText={t("galaxy.package.save")}
        cancelText={t("galaxy.cancel")}
        confirmLoading={saving}
        width={760}
        onCancel={() => setOpen(false)}
        onOk={() => void submit()}
        destroyOnClose
      >
        <Form form={form} layout="vertical" initialValues={toForm(null)}>
          <Space size={12} style={{ display: "flex" }} align="start">
            <Form.Item
              name="modelId"
              label={t("galaxy.model.modelId")}
              rules={[{ required: true }]}
              extra={editing ? t("galaxy.model.modelIdLocked") : t("galaxy.model.modelIdHint")}
              style={{ flex: 1 }}
            >
              <Input disabled={Boolean(editing)} className="manager-mono" placeholder="claude-sonnet-5" />
            </Form.Item>
            <Form.Item name="displayName" label={t("galaxy.model.displayName")} style={{ flex: 1 }}>
              <Input placeholder="Claude Sonnet 5" />
            </Form.Item>
          </Space>
          <Space size={12} style={{ display: "flex" }} align="start">
            <Form.Item name="family" label={t("galaxy.model.family")} extra={t("galaxy.model.familyHint")} style={{ flex: 1 }}>
              <Input placeholder="claude" />
            </Form.Item>
            <Form.Item name="vendor" label={t("galaxy.model.vendor")} style={{ flex: 1 }}>
              <Input placeholder="anthropic" />
            </Form.Item>
            <Form.Item name="kind" label="kind" extra={t("galaxy.model.kindHint")} style={{ flex: 1 }}>
              <Input placeholder={DEFAULT_KIND} />
            </Form.Item>
          </Space>

          {/* 我们自己的单价不在这个弹窗里。它按「能力 × 模型 × 计量单位」维护在
              价目表上，入口是这一行的「定价」—— 同一个数在两处各填一遍，
              迟早门户标一个价、账上扣另一个价，而两边都不会报错。 */}
          <Typography.Paragraph type="secondary" style={{ marginTop: -12 }}>
            {t("galaxy.model.priceHint")}
          </Typography.Paragraph>

          <Space size={12} style={{ display: "flex" }} align="start">
            <Form.Item name="listInputYuan" label={t("galaxy.model.listInputPrice")} style={{ flex: 1 }}>
              <InputNumber style={{ width: "100%" }} min={0} precision={2} addonAfter="¥/1M" />
            </Form.Item>
            <Form.Item name="listOutputYuan" label={t("galaxy.model.listOutputPrice")} style={{ flex: 1 }}>
              <InputNumber style={{ width: "100%" }} min={0} precision={2} addonAfter="¥/1M" />
            </Form.Item>
            {/* 缓存这一档的精度要到四位：官方缓存价常在 ¥0.2x 这个量级，
                两位小数会把 ¥0.2160 抹成 ¥0.22，而这是对外的比价声明。 */}
            <Form.Item name="listCacheYuan" label={t("galaxy.model.listCachePrice")} style={{ flex: 1 }}>
              <InputNumber style={{ width: "100%" }} min={0} precision={4} addonAfter="¥/1M" />
            </Form.Item>
          </Space>
          <Typography.Paragraph type="secondary" style={{ marginTop: -12 }}>
            {t("galaxy.model.listPriceHint")}
          </Typography.Paragraph>

          <Space size={12} style={{ display: "flex" }} align="start">
            <Form.Item name="contextTokens" label={t("galaxy.model.contextTokens")} style={{ flex: 1 }}>
              <InputNumber style={{ width: "100%" }} min={0} step={1000} />
            </Form.Item>
            <Form.Item name="maxOutputTokens" label={t("galaxy.model.maxOutputTokens")} style={{ flex: 1 }}>
              <InputNumber style={{ width: "100%" }} min={0} step={1000} />
            </Form.Item>
            <Form.Item name="sortOrder" label={t("galaxy.package.sortOrder")} style={{ flex: 1 }}>
              <InputNumber style={{ width: "100%" }} />
            </Form.Item>
          </Space>
          <Form.Item name="tags" label={t("galaxy.model.tags")}>
            <Select mode="tags" tokenSeparators={[","]} />
          </Form.Item>
          <Form.Item name="summary" label={t("galaxy.model.summary")}>
            <Input.TextArea rows={2} maxLength={256} showCount />
          </Form.Item>
          <Space size={12} style={{ display: "flex" }} align="start">
            <Form.Item name="badgeText" label={t("galaxy.model.badge")} extra={t("galaxy.model.badgeHint")} style={{ flex: 1 }}>
              {/* 16 个字符和库里那一列同宽，但真正的限制是版面：角标再长就把模型名挤到换行。 */}
              <Input maxLength={16} showCount placeholder={t("galaxy.model.badgePlaceholder")} />
            </Form.Item>
            <Form.Item name="badgeTone" label={t("galaxy.model.badgeTone")} style={{ flex: 1 }}>
              <Select
                options={BADGE_TONES.map((tone) => ({
                  value: tone,
                  label: (
                    <Tag color={BADGE_TAG_COLOR[tone]} style={{ marginInlineEnd: 0 }}>
                      {t(`galaxy.model.badgeTone.${tone}`)}
                    </Tag>
                  ),
                }))}
              />
            </Form.Item>
          </Space>
          <Space size={24}>
            <Form.Item name="listed" label={t("galaxy.model.status")} valuePropName="checked">
              <Switch checkedChildren={t("galaxy.package.listed")} unCheckedChildren={t("galaxy.package.unlisted")} />
            </Form.Item>
            <Form.Item name="featured" label={t("galaxy.model.featured")} valuePropName="checked">
              <Switch />
            </Form.Item>
          </Space>
        </Form>
      </Modal>
    </div>
  );
}

/** 一个计量单位在弹窗里的一行：当前生效的那条价，加上运营正在填的两个数。 */
type PriceRowForm = { price: number | null; providerPrice: number | null };
type PricingForm = Record<string, PriceRowForm> & { kind?: string; effectiveFrom?: Dayjs | null };

/**
 * 给一个模型（或一个能力的兜底）定价。
 *
 * 一屏之内把这个模型的几个计价桶排成几行，每行两个价：
 * **对外单价**向使用者收，**结算单价**结给共享者，差额是平台毛利。两个价各填各的 ——
 * 上游价原先是「对外价 × 分成比例」，于是想给使用者降价就必然同时砍掉共享者的收入。
 *
 * 回显只认**这个模型自己的行**，不回落到兜底价：填着数的格子必须是这个模型真填过的，
 * 否则运营点开一看四行都有数，保存一下就把兜底价复制成了四条模型专属价，
 * 而以后调兜底价对这个模型再也不生效。没填的那行灰字说明它此刻按什么算。
 *
 * 留空 = 这一档不动。**不是填 0** —— 0 是一个有含义的价（免费），
 * 而空着的格子只是「我这次没打算改它」。
 *
 * 保存是**新增一行**：生效时间在唯一键里，旧行留作历史，已经结过的账不会被追溯改掉。
 */
function ModelPricing({
  target,
  prices,
  kinds,
  unitCandidates,
  groups,
  onClose,
  onSaved,
}: {
  target: PriceTarget | null;
  prices: PriceView[];
  kinds: string[];
  /** 服务端给的计量单位候选：已有的价加上真实跑过的用量。是提示，不是白名单。 */
  unitCandidates: string[];
  /** 这个模型底下的分组。价挂在分组上，这一屏就是给分组填价的地方。 */
  groups: ModelGroupView[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useLocale();
  const [form] = Form.useForm<PricingForm>();
  const [submitting, setSubmitting] = useState(false);
  // 兜底价可以换能力（一个能力一份兜底）；模型的能力由它自己的 kind 决定，不给改。
  const fallback = target?.modelId === "";
  const [kind, setKind] = useState(DEFAULT_KIND);
  /**
   * 这一屏此刻在改哪个分组。空串 = 这个模型的**通价**，也就是「没单独定价的分组都按它收」。
   *
   * 做成这一屏里的一个切换，而不是另开一页：一个分组的内容和通价那一档是同一张表
   * （同样四个桶、同样两个价），只是键多了一维。分两处填，运营就得自己记住
   * 「我刚才在哪个分组填的」，而填错分组不报错 —— 那行价只是永远匹配不上任何一次请求。
   */
  const [groupId, setGroupId] = useState("");
  /**
   * 运营手工加进来的计量单位。
   *
   * 单位是**注册制**的（额度引擎只认「单位 → 上限」这张表），所以这一屏不能只摆
   * 价目表里已经有的那几行 —— 一个刚接进来、还一行价都没有的能力（视频渲染那种）
   * 打开就是空的，而它恰恰是最需要定价的那个。旧的「单价」页靠一个可以手填的
   * 下拉解决这件事，那一页收起来之后这个能力得跟着搬过来。
   */
  const [extraUnits, setExtraUnits] = useState<string[]>([]);

  useEffect(() => {
    if (target) setKind(target.kind || DEFAULT_KIND);
    setExtraUnits([]);
    // 落在点进来的那个分组：从列表上的分组胶囊点进来时它带着分组，从「定价」按钮
    // 进来时是空的，也就是「模型通价」—— 绝大多数改价要动的那一档。
    //
    // 不能留着上一次选的分组：那样运营会在没注意的情况下改到「深度」上去，而一屏四个桶
    // 长得一模一样，只有标题说得出自己在改哪一个。
    setGroupId(target?.groupId ?? "");
  }, [target]);

  /**
   * 这个能力下要摆出来的计量单位。对话类固定三个桶，别的能力照价目表里已有的来。
   *
   * 缓存写入那两档只在 **Claude 一族**和**兜底价**上多摆出来（见 CACHE_WRITE_UNITS）：
   * 兜底价跨模型、也管着 Claude，它那一行不摆，Claude 就只能一个个单独定价。
   *
   * 这里只管「默认摆哪几行」。价目表里真有的行照常并进来 —— 历史上给 Codex 模型
   * 填过的缓存写入价不会因为这条规则凭空消失，运营还得看得见才能把它清掉。
   */
  const units = useMemo(() => {
    const seen = new Set<string>();
    if (kind.startsWith("llm.")) {
      for (const unit of LLM_UNITS) seen.add(unit);
      if (fallback || protocolFamily(target?.family ?? "") === "anthropic") {
        for (const unit of CACHE_WRITE_UNITS) seen.add(unit);
      }
    }
    for (const row of prices) if (row.kind === kind) seen.add(row.unit);
    for (const unit of extraUnits) seen.add(unit);
    // 藏起来的那个（缓存写入的合计）即使价目表里已经有行，也不摆出来（见 HIDDEN_UNITS）。
    return Array.from(seen).filter((unit) => !HIDDEN_UNITS.has(unit));
  }, [kind, prices, extraUnits, fallback, target?.family]);


  /**
   * 此刻这一屏这个键（模型 + 分组）上生效的那条价，按单位索引。没有就是它没单独定过价。
   *
   * **分组这一维要筛准。** 不筛的话，同一个模型同一个单位的「深度」分组行会按遍历顺序
   * 盖掉通价那一行，于是运营打开看到的是深度的数字，保存出去却写进了通价那一行：
   * 两档的价一次操作全错，而且不报错。
   */
  const own = useMemo(() => {
    const index: Record<string, PriceView> = {};
    if (!target) return index;
    for (const row of prices) {
      if (row.kind !== kind || row.modelId !== target.modelId || row.groupId !== groupId || !row.effective) continue;
      index[row.unit] = row;
    }
    return index;
  }, [prices, kind, target, groupId]);

  /**
   * 没填的那行此刻按什么算。
   *
   * 改的是某个分组时，它「继承」的是**这个模型的通价**而不是 kind 的兜底价 ——
   * 取价的回落是三级的（kind 兜底 → 模型通价 → 分组价），越具体越晚盖。
   * 这里显示得和取价不一致的话，运营会按一个不会发生的数做决定。
   */
  const inherited = useMemo(() => {
    const index: Record<string, PriceView> = {};
    for (const row of prices) {
      if (row.kind !== kind || !row.effective) continue;
      // 先铺 kind 兜底（modelId 与 groupId 都空）。
      if (row.modelId === "" && row.groupId === "") index[row.unit] = row;
    }
    if (groupId !== "") {
      // 再盖这个模型的通价那一层 —— 只有在改某个分组时它才是「上一层」。
      for (const row of prices) {
        if (row.kind !== kind || !row.effective) continue;
        if (row.modelId === (target?.modelId ?? "") && row.groupId === "") index[row.unit] = row;
      }
    }
    return index;
  }, [prices, kind, groupId, target]);

  /**
   * 分组候选：这个模型底下的分组，外加「模型通价」那一项。
   *
   * 已经单独定过价的分组标一下：一眼看出这个模型有几个分组是自己定了价的、
   * 哪几个还跟着通价走 —— 后者改通价会连它们一起改，那正是最容易误伤的地方。
   *
   * 兜底价那一屏（modelId 为空）没有分组可选：分组属于某一个模型，
   * 跨模型的分组价落不到任何一层取价上（见服务端 resolvePrices）。
   */
  const groupOptions = useMemo(() => {
    const mine = fallback ? [] : groups;
    return [
      { value: "", label: t("galaxy.group.modelWide") },
      ...mine.map((group) => ({
        value: group.groupId,
        label: [
          group.name,
          group.priced ? "·" : "",
          group.listed ? "" : `(${t("galaxy.group.unlisted")})`,
        ]
          .filter(Boolean)
          .join(" "),
      })),
    ];
  }, [groups, fallback, t]);

  /** 当前这一屏改的是哪个分组（用来拼标题）。空 = 模型通价。 */
  const currentGroup = useMemo(
    () => groups.find((group) => group.groupId === groupId),
    [groups, groupId],
  );

  useEffect(() => {
    if (!target) return;
    // 生效时间预填成打开这个弹窗的此刻：留空跟填「现在」是同一个结果（服务端
    // 拿当下的时间），预填出来只是让运营看得见自己正在改的是哪一刻的价 —— 空着
    // 的框和「预约到下周一」的框长得一样，而这两件事的账是不一样的。
    const next: PricingForm = { kind, effectiveFrom: dayjs() } as PricingForm;
    for (const unit of units) {
      const row = own[unit];
      next[unit] = {
        price: row ? row.price / MICRO : null,
        // 拿 settlePrice 而不是 providerPrice 预填：还没迁移的行 providerPrice 是 0，
        // 照着它预填的话，运营只是进来改个对外价，保存出去就把这一档从
        // 「按七成结」变成了「一分不结」—— 而且没有任何地方会报错。
        providerPrice: row ? (row.settlePrice || row.providerPrice || 0) / MICRO : null,
      };
    }
    form.setFieldsValue(next);
  }, [target, units, own, kind, form]);

  const submit = async () => {
    if (!target) return;
    const values = await form.validateFields();
    const effectiveFrom = values.effectiveFrom ? values.effectiveFrom.toISOString() : undefined;
    // 只发**填了数**的那几行。空着的格子是「这次不动这一档」——
    // 当成 0 发出去就是把它改成免费，而那件事不会有任何地方报错。
    const changed = units
      .map((unit) => ({ unit, row: values[unit] }))
      .filter(({ row }) => row && row.price !== null && row.price !== undefined);
    if (changed.length === 0) {
      message.info(t("galaxy.model.pricingNoChange"));
      return;
    }
    setSubmitting(true);
    try {
      // 串行发：逐条保存，中途失败时已经存下的那几档是真的存住了，
      // 而失败的那条会把错误原样抛出来。并发发出去的话，报错弹一条、
      // 存住几条，运营不知道现在库里到底是什么状态。
      for (const { unit, row } of changed) {
        await savePrice({
          kind,
          modelId: target.modelId,
          groupId,
          unit,
          // 界面按元填，库里存微元。中间这一步乘法漏掉的话价格会差一百万倍。
          price: Math.round((row.price ?? 0) * MICRO),
          providerPrice: Math.round((row.providerPrice ?? 0) * MICRO),
          effectiveFrom,
        });
      }
      message.success(t("galaxy.price.saved"));
      onClose();
      onSaved();
    } catch (error) {
      message.error((error as Error).message || t("galaxy.actionFailed"));
      // 存到一半失败也要刷新：前几档已经落库了，界面还照着旧数据会骗人。
      onSaved();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={target !== null}
      // 兜底那一版的标题自己就说全了（「统一价（兜底）· 对话与代码」），再套一层
      // 「定价 · 」读起来是两个标题叠在一起。它跟着**当前选中的能力**现拼，
      // 不用打开时那份 —— 换过能力之后标题还写着上一个，是在说错自己在改什么。
      // 标题要带上当前这个分组：一屏四个桶长得一模一样，只有标题说得出
      // 「我现在填的是深度那一组」。不带的话，改完深度保存，运营以为自己改的是通价。
      title={
        target
          ? (fallback
              ? t("galaxy.model.fallbackTitle").replace("{kind}", kindLabel(kind, t))
              : t("galaxy.model.pricingTitle").replace("{model}", target.title)) +
            (currentGroup ? ` · ${currentGroup.name}` : "")
          : ""
      }
      okText={t("galaxy.package.save")}
      cancelText={t("galaxy.cancel")}
      confirmLoading={submitting}
      width={820}
      onOk={() => void submit()}
      onCancel={onClose}
      destroyOnClose
    >
      <Form form={form} layout="vertical">
        <Space size={12} style={{ display: "flex" }} align="start" wrap>
          <Form.Item label={t("galaxy.price.kind")} style={{ minWidth: 260 }}>
            {fallback ? (
              <Select
                value={kind}
                onChange={(next) => {
                  setKind(next);
                  // 手工加的单位属于上一个能力，跟着一起清掉。
                  setExtraUnits([]);
                }}
                options={kinds.map((value) => ({ value, label: `${kindLabel(value, t)} · ${value}` }))}
                style={{ width: "100%" }}
              />
            ) : (
              <Input value={kind} disabled className="manager-mono" />
            )}
          </Form.Item>
          {/* 分组是平台在卖的那个单位：价挂在它上面。选「模型通价」时改的是
              所有没单独定价的分组共用的那一份。 */}
          <Form.Item
            label={t("galaxy.group.label")}
            extra={fallback ? t("galaxy.group.fallbackNoGroup") : t("galaxy.group.pricingHint")}
            style={{ minWidth: 240 }}
          >
            <Select
              value={groupId}
              onChange={setGroupId}
              options={groupOptions}
              disabled={fallback}
              style={{ width: "100%" }}
            />
          </Form.Item>
          <Form.Item
            name="effectiveFrom"
            label={t("galaxy.price.effectiveFrom")}
            extra={t("galaxy.price.effectiveFromHint")}
            style={{ minWidth: 300 }}
          >
            <ManagerDatePicker showTime style={{ width: "100%" }} />
          </Form.Item>
        </Space>

        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 16 }}
          message={fallback ? t("galaxy.model.fallbackHint") : t("galaxy.model.pricingHint")}
        />

        {units.length === 0 ? (
          <Typography.Paragraph type="secondary">{t("galaxy.model.pricingNoUnit")}</Typography.Paragraph>
        ) : (
          units.map((unit) => (
            <PricingRow
              key={unit}
              unit={unit}
              form={form}
              own={own[unit]}
              inherited={inherited[unit]}
              // fallback 的意思是「这一行底下没有别的了」，所以选了某个分组时它就不成立：
              // 那个分组没填的单位会回落到这个模型的通价，而不是按 0 计费。
              // 不收窄的话，改分组时每一行都红字写着「没单独定价的模型都按 0 计费」——
              // 那句话是错的，而它恰恰会吓得运营去把四个桶都填一遍。
              fallback={fallback && groupId === ""}
              // 这一屏改的是分组还是模型：两者的「此刻按什么算」要说两句不同的话，
              // 都写成「这个模型自己的价」的话，运营会以为自己在改整个模型。
              scope={groupId === "" ? "model" : "group"}
            />
          ))
        )}

        {/* 候选之外的单位也能填：写死一张白名单会把新接的业务挡在外面。 */}
        <div style={{ marginTop: 12 }}>
          <Select
            showSearch
            mode="tags"
            value={[]}
            maxTagCount={0}
            style={{ width: 320 }}
            placeholder={t("galaxy.model.pricingAddUnit")}
            options={unitCandidates
              .filter((unit) => !units.includes(unit) && !HIDDEN_UNITS.has(unit))
              .map((unit) => ({ value: unit, label: `${unitLabel(unit, t)} · ${unit}` }))}
            onChange={(next: string[]) => {
              const picked = next[next.length - 1]?.trim();
              if (picked) setExtraUnits((list) => (list.includes(picked) ? list : [...list, picked]));
            }}
          />
        </div>
      </Form>
    </Modal>
  );
}

/** 一个计量单位一行：左边说这一档此刻按什么算，右边两个价。 */
function PricingRow({
  unit,
  form,
  own,
  inherited,
  fallback,
  scope,
}: {
  unit: string;
  form: ReturnType<typeof Form.useForm<PricingForm>>[0];
  own?: PriceView;
  inherited?: PriceView;
  fallback: boolean;
  /** 这一行此刻在改谁的价：这个模型的通价，还是某一个分组的价。 */
  scope: "model" | "group";
}) {
  const { t } = useLocale();
  const price = Form.useWatch([unit, "price"], form);
  const providerPrice = Form.useWatch([unit, "providerPrice"], form);
  const bps = price && price > 0 ? Math.round(((price - (providerPrice ?? 0)) / price) * 10000) : null;

  // 这一档此刻到底按什么算，三种情况说三句不同的话 —— 都写成「-」的话，
  // 「这个模型自己定过价」「在用兜底价」「根本没有价（静默算 0）」看起来一模一样。
  const state = own ? (
    <Typography.Text type="secondary">
      {t(
        fallback
          ? "galaxy.model.pricingCurrent"
          : scope === "group"
            ? "galaxy.model.pricingOwnGroup"
            : "galaxy.model.pricingOwn",
      ).replace(
        "{price}",
        `¥${(own.price / MICRO).toLocaleString("en-US", { maximumFractionDigits: 6 })}`,
      )}
    </Typography.Text>
  ) : inherited && !fallback ? (
    <Typography.Text type="secondary">
      {t(scope === "group" ? "galaxy.model.pricingInheritGroup" : "galaxy.model.pricingInherit").replace(
        "{price}",
        `¥${(inherited.price / MICRO).toLocaleString("en-US", { maximumFractionDigits: 6 })}`,
      )}
    </Typography.Text>
  ) : (
    <Typography.Text type="danger">
      {t(fallback ? "galaxy.model.pricingFallbackMissing" : "galaxy.model.pricingMissing")}
    </Typography.Text>
  );

  return (
    <div
      style={{
        display: "flex",
        gap: 12,
        alignItems: "flex-start",
        flexWrap: "wrap",
        padding: "10px 0",
        borderTop: "1px solid var(--manager-border)",
      }}
    >
      <div style={{ minWidth: 200, flex: "1 1 200px", paddingTop: 4 }}>
        <div style={{ fontWeight: 600 }}>{unitLabel(unit, t)}</div>
        <Typography.Text type="secondary" className="manager-mono" style={{ fontSize: 12, display: "block" }}>
          {unit}
        </Typography.Text>
        <div style={{ marginTop: 4 }}>{state}</div>
      </div>
      <Form.Item
        name={[unit, "price"]}
        label={t("galaxy.price.price")}
        style={{ flex: "0 0 200px", marginBottom: 0 }}
        // 对外价填了、结算价空着就是把这一档的结算清成 0（共享者白跑）。
        // 让它在点保存之前就报出来，而不是存完在收益页上才发现。
        rules={[
          ({ getFieldValue }) => ({
            validator: (_, value) =>
              value === null || value === undefined || getFieldValue([unit, "providerPrice"]) !== null
                ? Promise.resolve()
                : Promise.reject(new Error(t("galaxy.model.pricingBothRequired"))),
          }),
        ]}
      >
        <InputNumber min={0} step={0.1} precision={6} style={{ width: "100%" }} placeholder={t("galaxy.model.pricingKeep")} />
      </Form.Item>
      <Form.Item name={[unit, "providerPrice"]} label={t("galaxy.price.providerPrice")} style={{ flex: "0 0 200px", marginBottom: 0 }}>
        <InputNumber min={0} step={0.1} precision={6} style={{ width: "100%" }} placeholder={t("galaxy.model.pricingKeep")} />
      </Form.Item>
      <div style={{ flex: "0 0 110px", paddingTop: 32 }}>
        {bps === null ? null : bps < 0 ? (
          <Tooltip title={t("galaxy.price.subsidyHint")}>
            <Typography.Text type="danger" className="manager-mono">
              {marginText(bps)}
            </Typography.Text>
          </Tooltip>
        ) : (
          <Typography.Text type="secondary" className="manager-mono">
            {marginText(bps)}
          </Typography.Text>
        )}
      </div>
    </div>
  );
}

/**
 * 一个模型底下的**分组**：平台在这个模型上真正在卖的几个档次。
 *
 * 为什么要有这一层（2026-09-22）：同一个模型可以用得很不一样 —— 想得浅一点、深一点、
 * 要不要走快速通道 —— 而这几种用法在上游那边的成本能差好几倍。原先这两个旋钮由客户端
 * 在请求体里自己拨，平台按一份价收，差额全由平台垫。
 *
 * 分组把它翻过来：**旋钮是商品的属性，不是调用方的自由**。这一屏定的就是那几条属性：
 *
 *   · 绑定哪几档推理强度 —— 请求带来的档不在表里，就夹到表里**最浅**的一档再打上游。
 *     一档都不绑 = 不限，请求带什么就按什么跑。
 *   · 卖不卖「快速」—— 不卖时，客户端开了快速也会被改写掉。
 *   · 价（在「定价」那一屏填，键是 模型 + 分组）。
 *
 * 两件必须说清楚的事：
 *
 *   · **档位名只在这一页出现**。使用端、共享端、官网一律不显示它 —— 那是上游的内部刻度，
 *     摆给外面看，等于让上游的字段名替平台解释自己在卖什么。所以分组名要自己说清楚
 *     卖的是什么（「标准」「深度思考」「快速」），别写成「max 档」。
 *   · **一个分组都没有的模型卖不出去**：使用端建密钥要选分组，选不到就用不了这个模型。
 */
function ModelGroups({
  model,
  groups,
  efforts,
  onClose,
  onSaved,
  onPrice,
}: {
  model: GalaxyModelView | null;
  groups: ModelGroupView[];
  /** 协议族 → 它认识的推理强度档位，由浅到深。服务端给的，前端不自己维护一份。 */
  efforts: Record<string, string[]>;
  onClose: () => void;
  onSaved: () => void;
  onPrice: (group: ModelGroupView) => void;
}) {
  const { t } = useLocale();
  const canWrite = useCanWrite();
  const [form] = Form.useForm<GroupForm>();
  const [editing, setEditing] = useState<ModelGroupView | null>(null);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  /** 这个模型的强度词表按哪一族给。认不出来就摆两族的全集，让运营自己挑。 */
  const family = useMemo(
    () => effortFamilyOf(model?.family ?? "", model?.vendor ?? "", efforts),
    [model, efforts],
  );

  /**
   * 强度候选。认得出族就**只摆那一族**：两族的档位名只是长得像 ——
   * none / minimal / ultra 只有 Codex 有，xhigh 只有 Claude 有。给一个 Claude 模型
   * 绑上 minimal，服务端会直接拒（它按族校验），但运营要到点保存才知道。
   */
  const effortOptions = useMemo(() => {
    const ladders = Object.entries(efforts).filter(([, levels]) => levels.length > 0);
    const scoped = family ? ladders.filter(([key]) => key === family) : ladders;
    return scoped.map(([key, levels]) => ({
      label: t(`galaxy.price.family.${key}`),
      options: levels.map((level) => ({ value: level, label: effortLabel(level, t) })),
    }));
  }, [efforts, family, t]);

  const edit = (row: ModelGroupView | null) => {
    setEditing(row);
    form.setFieldsValue({
      name: row?.name ?? "",
      summary: row?.summary ?? "",
      efforts: row?.efforts ?? [],
      allowFast: row?.allowFast ?? false,
      listed: row?.listed ?? true,
      isDefault: row?.isDefault ?? false,
      sortOrder: row?.sortOrder ?? 0,
    });
    setOpen(true);
  };

  const submit = async () => {
    if (!model) return;
    const values = await form.validateFields();
    setSaving(true);
    try {
      await saveModelGroup({
        groupId: editing?.groupId,
        modelId: model.modelId,
        name: values.name.trim(),
        summary: values.summary?.trim() ?? "",
        efforts: values.efforts ?? [],
        allowFast: values.allowFast,
        listed: values.listed,
        isDefault: values.isDefault,
        sortOrder: values.sortOrder ?? 0,
      });
      message.success(t("galaxy.model.saved"));
      setOpen(false);
      onSaved();
    } catch (error) {
      message.error((error as Error).message || t("galaxy.actionFailed"));
    } finally {
      setSaving(false);
    }
  };

  /**
   * 删分组。还有密钥选着它时服务端先拦一道 —— 那不是一个可以「再点一次」糊过去的提示：
   * 删掉之后那些密钥的每一次请求都会报「模型不允许」，而使用者看不出为什么。
   * 所以强删要单独确认一次，并且把「有几把」原样说出来。
   */
  const remove = async (row: ModelGroupView, force: boolean) => {
    try {
      await deleteModelGroup({ groupId: row.groupId, force });
      message.success(t("galaxy.model.deleted"));
      onSaved();
    } catch (error) {
      message.error((error as Error).message || t("galaxy.actionFailed"));
    }
  };

  const price = (value: number) => (value > 0 ? `¥${(value / MICRO).toFixed(2)}` : "-");

  const columns: ColumnsType<ModelGroupView> = [
    {
      title: t("galaxy.group.name"),
      dataIndex: "name",
      width: 200,
      render: (name: string, row) => (
        <Space direction="vertical" size={0}>
          <Space size={4} wrap>
            <span style={{ fontWeight: 600 }}>{name}</span>
            {row.isDefault ? <Tag color="blue">{t("galaxy.group.default")}</Tag> : null}
            {row.listed ? null : <Tag>{t("galaxy.group.unlisted")}</Tag>}
          </Space>
          {row.summary ? (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {row.summary}
            </Typography.Text>
          ) : null}
        </Space>
      ),
    },
    {
      // 绑定的强度。空 = 不限：请求带什么档就按什么打上游 —— 这和「一档都不卖」
      // 不是一回事，所以不能显示成「-」。
      title: t("galaxy.group.efforts"),
      dataIndex: "efforts",
      width: 240,
      render: (levels: string[]) =>
        levels.length === 0 ? (
          <Tooltip title={t("galaxy.group.anyEffortHint")}>
            <Typography.Text type="secondary">{t("galaxy.group.anyEffort")}</Typography.Text>
          </Tooltip>
        ) : (
          <Space size={4} wrap>
            {levels.map((level, index) => (
              <Tooltip key={level} title={index === 0 ? t("galaxy.group.lowestHint") : undefined}>
                <Tag color={EFFORT_TONE[level] ?? "default"} style={{ marginInlineEnd: 0 }}>
                  {effortLabel(level, t)}
                </Tag>
              </Tooltip>
            ))}
          </Space>
        ),
    },
    {
      title: t("galaxy.group.fast"),
      dataIndex: "allowFast",
      width: 100,
      render: (allow: boolean) =>
        allow ? <Tag color="gold">{t("galaxy.group.fastOn")}</Tag> : <Tag>{t("galaxy.group.fastOff")}</Tag>,
    },
    {
      // 这个分组收多少。没自己的价就跟着模型通价走 —— 要说出来，
      // 否则一屏分组显示同一个数，看起来像页面坏了。
      title: t("galaxy.group.price"),
      key: "price",
      width: 220,
      render: (_, row) => (
        <Space size={6} wrap>
          <span className="manager-mono">
            {price(row.inputPrice)} / {price(row.outputPrice)} / {price(row.cachePrice)}
          </span>
          {row.priced ? null : (
            <Tooltip title={t("galaxy.group.inheritsHint")}>
              <Tag color="blue">{t("galaxy.group.inherits")}</Tag>
            </Tooltip>
          )}
        </Space>
      ),
    },
    {
      // 毛利按输出价算。负数是平台在倒贴 —— 标红让它自己跳出来。
      title: t("galaxy.price.margin"),
      dataIndex: "marginBps",
      width: 100,
      align: "right",
      render: (bps: number) =>
        bps < 0 ? (
          <Typography.Text type="danger" className="manager-mono">
            {marginText(bps)}
          </Typography.Text>
        ) : (
          <span className="manager-mono">{marginText(bps)}</span>
        ),
    },
    {
      title: t("galaxy.group.keys"),
      dataIndex: "keys",
      width: 90,
      align: "right",
      render: (keys: number) => <span className="manager-mono">{keys}</span>,
    },
    {
      title: t("galaxy.actions"),
      key: "actions",
      width: 200,
      render: (_, row) =>
        canWrite ? (
          <Space size={8}>
            <Button size="small" type="primary" ghost onClick={() => onPrice(row)}>
              {t("galaxy.model.pricing")}
            </Button>
            <Button size="small" onClick={() => edit(row)}>
              {t("galaxy.group.edit")}
            </Button>
            <Popconfirm
              title={t("galaxy.group.delete")}
              description={
                <div style={{ maxWidth: 320 }}>
                  {row.keys > 0
                    ? t("galaxy.group.deleteInUse", { count: row.keys })
                    : t("galaxy.group.deleteHint")}
                </div>
              }
              okText={t("galaxy.confirm")}
              cancelText={t("galaxy.cancel")}
              onConfirm={() => void remove(row, row.keys > 0)}
            >
              <Button size="small" danger icon={<DeleteOutlined />} />
            </Popconfirm>
          </Space>
        ) : null,
    },
  ];

  return (
    <>
      <Modal
        open={model !== null}
        title={t("galaxy.group.title", { model: model?.displayName || model?.modelId || "" })}
        footer={null}
        width={1080}
        onCancel={onClose}
        destroyOnClose
      >
        <Space direction="vertical" size={12} style={{ width: "100%" }}>
          <Alert type="info" showIcon message={t("galaxy.group.hint")} />
          {groups.length === 0 ? (
            // 一个分组都没有 = 这个模型在使用端选不到，也就卖不出去。红字，不是灰字。
            <Alert type="error" showIcon message={t("galaxy.group.none")} description={t("galaxy.group.noneHint")} />
          ) : null}
          {canWrite ? (
            <Button type="primary" icon={<PlusOutlined />} onClick={() => edit(null)}>
              {t("galaxy.group.new")}
            </Button>
          ) : null}
          <Table<ModelGroupView>
            rowKey="groupId"
            size="small"
            columns={columns}
            dataSource={groups}
            pagination={false}
            scroll={{ x: 1150 }}
          />
        </Space>
      </Modal>

      <Modal
        open={open}
        title={editing ? t("galaxy.group.edit") : t("galaxy.group.new")}
        okText={t("galaxy.package.save")}
        cancelText={t("galaxy.cancel")}
        confirmLoading={saving}
        width={640}
        onCancel={() => setOpen(false)}
        onOk={() => void submit()}
        destroyOnClose
      >
        <Form form={form} layout="vertical">
          <Form.Item
            name="name"
            label={t("galaxy.group.name")}
            rules={[{ required: true }]}
            extra={t("galaxy.group.nameHint")}
          >
            <Input placeholder={t("galaxy.group.namePlaceholder")} />
          </Form.Item>
          <Form.Item name="summary" label={t("galaxy.group.summary")} extra={t("galaxy.group.summaryHint")}>
            <Input.TextArea rows={2} maxLength={256} showCount />
          </Form.Item>
          <Form.Item name="efforts" label={t("galaxy.group.efforts")} extra={t("galaxy.group.effortsHint")}>
            <Select mode="multiple" allowClear options={effortOptions} placeholder={t("galaxy.group.anyEffort")} />
          </Form.Item>
          <Space size={16} wrap>
            <Form.Item
              name="allowFast"
              label={t("galaxy.group.fast")}
              valuePropName="checked"
              extra={t("galaxy.group.fastHint")}
            >
              <Switch />
            </Form.Item>
            <Form.Item name="listed" label={t("galaxy.group.listed")} valuePropName="checked" extra={t("galaxy.group.listedHint")}>
              <Switch />
            </Form.Item>
            <Form.Item
              name="isDefault"
              label={t("galaxy.group.default")}
              valuePropName="checked"
              extra={t("galaxy.group.defaultHint")}
            >
              <Switch />
            </Form.Item>
            <Form.Item name="sortOrder" label={t("galaxy.package.sortOrder")}>
              <InputNumber min={0} style={{ width: 120 }} />
            </Form.Item>
          </Space>
        </Form>
      </Modal>
    </>
  );
}

type GroupForm = {
  name: string;
  summary: string;
  efforts: string[];
  allowFast: boolean;
  listed: boolean;
  isDefault: boolean;
  sortOrder: number | null;
};
