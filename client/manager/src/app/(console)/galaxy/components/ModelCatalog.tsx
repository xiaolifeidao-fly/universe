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
  fetchGalaxyModels,
  fetchPrices,
  fetchReferralSettings,
  saveGalaxyModel,
  savePrice,
  saveReferralSettings,
  type GalaxyModelView,
  type PriceTableView,
  type PriceView,
  type ReferralSettingsView,
} from "../api/galaxy.api";
import { effortLabel, HIDDEN_UNITS, kindLabel, unitLabel } from "./labels";

/** 单价在库里是「每百万 token 的微元」；表单里填元。 */
const MICRO = 1_000_000;

/** 模型没写 kind 时按它算。和服务端 portalKind 同一个值。 */
const DEFAULT_KIND = "llm.chat";

/**
 * 对话类能力**一定**要摆出来的计价桶，哪怕价目表里一行都没有 ——
 * 没有价的那一档扣费与结算静默算 0，而「表里没有这一行」和「这一档不要钱」
 * 在界面上长得一模一样。摆出来才看得见「这里是空的」。
 *
 * 三个桶互不重叠：input 只算未命中缓存的新增输入，命中的走 cache_read。
 * 缓存写入不在其中，见下面的 HIDDEN_UNITS。
 */
const LLM_UNITS = [
  "llm.input_tokens",
  "llm.output_tokens",
  "llm.cache_read_tokens",
] as const;


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
   * 打开时落在哪一档推理强度上。不填 = 不分强度那一档。
   *
   * 有它才能从列表上那几个胶囊直接点进对应的档 —— 否则运营得先点「定价」、
   * 再在弹框里把档位切一遍，而那一步正是最容易切错的地方（一屏四个桶长得一样）。
   */
  effort?: string;
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
   * 每个 (模型, 能力) 真的单独定过价的强度档，按族的词表由浅到深。
   *
   * 一次把整张表折出来，而不是每行各扫一遍价目行：价目表是 `能力 × 模型 × 强度 × 单位
   * × 生效时间` 五维展开的，几十个模型各扫一遍就是几十趟全表。
   *
   * 兜底行（modelId 为空）的强度档对每个模型都成立 —— 「所有模型的 max 档加价」
   * 是一条合法的定价，漏掉它这些模型会全部显示成「不分强度」，而它们其实分了档。
   */
  const effortsByModel = useMemo(() => {
    /**
     * 排序用**这个模型自己那一族**的词表，不是两族并起来的那一张。
     *
     * 并起来会撞：两族都有 none / low / medium / high，而 Map 后写的覆盖先写的，
     * 于是 anthropic 的 low 拿到 openai 那张表里的下标（8），排到了 max（5）后面 ——
     * 界面上就是「最深」排在「低」前面。而这一列的全部意义就是让人一眼看出深浅。
     */
    const rankOf = (family: string) => {
      const ladder = table?.efforts?.[protocolFamily(family)] ?? [];
      return new Map(ladder.map((effort, index) => [effort, index]));
    };
    const shared = new Map<string, Set<string>>();
    const own = new Map<string, Set<string>>();
    for (const row of table?.prices ?? []) {
      if (row.effort === "" || !row.effective) continue;
      const bucket = row.modelId === "" ? shared : own;
      const key = row.modelId === "" ? row.kind : `${row.kind}\u0000${row.modelId}`;
      if (!bucket.has(key)) bucket.set(key, new Set());
      bucket.get(key)?.add(row.effort);
    }
    return (modelId: string, kind: string, family: string) => {
      const merged = new Set([
        ...Array.from(shared.get(kind) ?? []),
        ...Array.from(own.get(`${kind}\u0000${modelId}`) ?? []),
      ]);
      const rank = rankOf(family);
      // 词表里没有的档（历史上填错、上游加了新档而我们还没跟上、或者这个模型的族
      // 根本不认这一档）排在最后按字典序。丢掉它们会让运营看着库里有价、列表上没有，
      // 而那种不一致没有任何地方会报错。
      return Array.from(merged).sort(
        (left, right) => (rank.get(left) ?? 999) - (rank.get(right) ?? 999) || left.localeCompare(right),
      );
    };
  }, [table]);
  const pricedEffortsOf = effortsByModel;

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
  // 「有量无价」告警也要跟着藏：藏掉缓存写入的定价入口之后，还留着一条
  // 「缓存写入 token 有用量、没有价 · 去定价」的橙色胶囊，点过去却找不到那一行，
  // 是把「我们不收这笔钱」说成了「你忘了填」。
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
      // 我们自己收的价。三档并排，顺序和模型卡片上那三格一致 ——
      // 运营在这一页核对的就是「门户上会标成多少」，两处顺序不同就得逐个认。
      title: t("galaxy.model.ourPrices"),
      key: "ourPrices",
      width: 230,
      render: (_, row) =>
        row.inputPrice > 0 || row.outputPrice > 0 || row.cachePrice > 0 ? (
          <Space size={6} wrap>
            <span className="manager-mono">
              {price(row.inputPrice)} / {price(row.outputPrice)} / {price(row.cachePrice)}
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
      // 这个模型按推理强度单独定过价的那几档。
      //
      // 必须摆在列表上，不能只藏在「定价」弹框里：深思考那一档的输出价可以是常规档的
      // 两三倍，而这一页是运营唯一会逐行扫的地方 —— 看不见的话，「哪些模型分了档、
      // 哪些还没分」只能一个一个点开弹框去数，而漏掉一个的代价是那一档一直按常规价在收。
      //
      // 胶囊可以直接点进对应的档，省掉「先点定价、再切档」这一步 —— 那一步切错不报错。
      title: t("galaxy.price.effort"),
      key: "efforts",
      width: 190,
      render: (_, row) => {
        const efforts = pricedEffortsOf(row.modelId, row.kind || DEFAULT_KIND, row.family);
        if (efforts.length === 0) {
          // 「没分档」是绝大多数模型的常态，不是缺了什么，所以用灰字而不是红字。
          return (
            <Tooltip title={t("galaxy.model.effortNoneHint")}>
              <Typography.Text type="secondary">{t("galaxy.price.anyEffort")}</Typography.Text>
            </Tooltip>
          );
        }
        return (
          <Space size={4} wrap>
            {efforts.map((effort) => (
              <Tag
                key={effort}
                color={EFFORT_TONE[effort] ?? "default"}
                style={canWrite ? { cursor: "pointer", marginInlineEnd: 0 } : { marginInlineEnd: 0 }}
                onClick={
                  canWrite
                    ? () =>
                        setPricing({
                          kind: row.kind || DEFAULT_KIND,
                          modelId: row.modelId,
                          title: row.displayName || row.modelId,
                          effort,
                        })
                    : undefined
                }
              >
                {effortLabel(effort, t)}
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
      width: 220,
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
                })
              }
            >
              {t("galaxy.model.pricing")}
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
        dataSource={rows}
        locale={{ emptyText: t("galaxy.model.empty") }}
        pagination={false}
        // 加了 190px 的强度列，横向总宽跟着走；不跟的话最后几列会被挤成两行。
        scroll={{ x: 1880 }}
      />

      <ModelPricing
        target={pricing}
        prices={prices}
        kinds={kinds}
        unitCandidates={table?.units ?? []}
        efforts={table?.efforts ?? {}}
        onClose={() => setPricing(null)}
        onSaved={() => void load()}
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
  efforts,
  onClose,
  onSaved,
}: {
  target: PriceTarget | null;
  prices: PriceView[];
  kinds: string[];
  /** 服务端给的计量单位候选：已有的价加上真实跑过的用量。是提示，不是白名单。 */
  unitCandidates: string[];
  /** 协议族 → 它认识的推理强度档位，由浅到深。服务端给的，前端不自己维护一份。 */
  efforts: Record<string, string[]>;
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
   * 这一屏此刻在改哪一档推理强度。空串 = 不分强度，也就是「没单独定价的强度都按它收」。
   *
   * 做成这一屏里的一个切换，而不是另开一页：一档的内容和不分强度那一档是同一张表
   * （同样四个桶、同样两个价），只是键多了一维。分两处填，运营就得自己记住
   * 「我刚才在哪一档填的」，而填错档不报错 —— 那行价只是永远匹配不上任何一次请求。
   */
  const [effort, setEffort] = useState("");
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
    // 落在点进来的那一档：从列表上的强度胶囊点进来时它带着档位，从「定价」按钮
    // 进来时是空的，也就是「不分强度」—— 绝大多数改价要动的那一档。
    //
    // 不能留着上一次选的档：那样运营会在没注意的情况下改到 max 上去，而一屏四个桶
    // 长得一模一样，只有标题说得出自己在改哪一档。
    setEffort(target?.effort ?? "");
  }, [target]);

  /** 这个能力下要摆出来的计量单位。对话类固定四个桶，别的能力照价目表里已有的来。 */
  const units = useMemo(() => {
    const seen = new Set<string>();
    if (kind.startsWith("llm.")) for (const unit of LLM_UNITS) seen.add(unit);
    for (const row of prices) if (row.kind === kind) seen.add(row.unit);
    for (const unit of extraUnits) seen.add(unit);
    // 藏起来的那几个即使价目表里已经有行，也不摆出来（见 HIDDEN_UNITS）。
    return Array.from(seen).filter((unit) => !HIDDEN_UNITS.has(unit));
  }, [kind, prices, extraUnits]);

  /**
   * 这个模型自己此刻生效的那条价，按单位索引。没有就是它没单独定过价。
   *
   * **只认不分强度那一行（effort 为空）。** 这一屏改的就是它 —— 按推理强度分档的价
   * 在「单价」那一页上改，那里一行一档看得见。不筛的话，同一个模型同一个单位的
   * max 档行会按遍历顺序盖掉这一行，于是运营打开看到的是 max 档的数字，
   * 保存出去却写进了「不分强度」那一行：两档的价一次操作全错，而且不报错。
   */
  const own = useMemo(() => {
    const index: Record<string, PriceView> = {};
    if (!target) return index;
    for (const row of prices) {
      if (row.kind !== kind || row.modelId !== target.modelId || row.effort !== effort || !row.effective) continue;
      index[row.unit] = row;
    }
    return index;
  }, [prices, kind, target, effort]);

  /**
   * 没填的那行此刻按什么算。
   *
   * 改的是某一档强度时，它「继承」的是**这个模型不分强度的价**而不是 kind 的兜底价 ——
   * 取价的回落是四级的（kind 兜底 → 强度通价 → 模型不分强度 → 模型这一档），
   * 越具体越晚盖。这里显示得和取价不一致的话，运营会按一个不会发生的数做决定。
   */
  const inherited = useMemo(() => {
    const index: Record<string, PriceView> = {};
    const layers = effort === "" ? [""] : ["", effort];
    for (const layer of layers) {
      for (const row of prices) {
        if (row.kind !== kind || !row.effective) continue;
        // 第一遍铺 kind 兜底（modelId 与 effort 都空），第二遍盖这个模型不分强度那一层。
        const isFallback = row.modelId === "" && row.effort === layer;
        const isModelWide = effort !== "" && row.modelId === (target?.modelId ?? "") && row.effort === "";
        if (!isFallback && !isModelWide) continue;
        index[row.unit] = row;
      }
    }
    return index;
  }, [prices, kind, effort, target]);

  /**
   * 这个模型已经单独定过价的强度档。摆在切换器旁边 ——
   * 不摆的话，「这个模型到底分没分档」得一档一档点过去才知道。
   */
  const pricedEfforts = useMemo(() => {
    const seen = new Set<string>();
    for (const row of prices) {
      if (row.kind !== kind || row.effort === "" || !row.effective) continue;
      if (row.modelId !== "" && row.modelId !== (target?.modelId ?? "")) continue;
      seen.add(row.effort);
    }
    return seen;
  }, [prices, kind, target]);

  /** 强度候选，按族分组。分组的理由见 PriceTable 里那段同样的注释。 */
  const effortOptions = useMemo(
    () => [
      { value: "", label: t("galaxy.price.anyEffort") },
      ...Object.entries(efforts)
        .filter(([, levels]) => levels.length > 0)
        .map(([family, levels]) => ({
          label: t(`galaxy.price.family.${family}`),
          options: levels.map((level) => ({
            value: level,
            // 已经定过价的档标一下：一眼看出这个模型分了哪几档。
            label: pricedEfforts.has(level) ? `${effortLabel(level, t)} ·` : effortLabel(level, t),
          })),
        })),
    ],
    [efforts, pricedEfforts, t],
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
          effort,
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
      // 标题要带上当前这一档：一屏四个桶长得一模一样，只有标题说得出
      // 「我现在填的是 max 那一档」。不带的话，改完 max 保存，运营以为自己改的是常规价。
      title={
        target
          ? (fallback
              ? t("galaxy.model.fallbackTitle").replace("{kind}", kindLabel(kind, t))
              : t("galaxy.model.pricingTitle").replace("{model}", target.title)) +
            (effort ? ` · ${effortLabel(effort, t)}` : "")
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
          <Form.Item label={t("galaxy.price.effort")} extra={t("galaxy.price.effortHint")} style={{ minWidth: 220 }}>
            <Select value={effort} onChange={setEffort} options={effortOptions} style={{ width: "100%" }} />
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
              // fallback 的意思是「这一行底下没有别的了」，所以选了某一档强度时它就不成立：
              // 那一档没填的单位会回落到这个 kind 不分强度的价，而不是按 0 计费。
              // 不收窄的话，改 max 档时每一行都红字写着「没单独定价的模型都按 0 计费」——
              // 那句话是错的，而它恰恰会吓得运营去把四个桶都填一遍。
              fallback={fallback && effort === ""}
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
}: {
  unit: string;
  form: ReturnType<typeof Form.useForm<PricingForm>>[0];
  own?: PriceView;
  inherited?: PriceView;
  fallback: boolean;
}) {
  const { t } = useLocale();
  const price = Form.useWatch([unit, "price"], form);
  const providerPrice = Form.useWatch([unit, "providerPrice"], form);
  const bps = price && price > 0 ? Math.round(((price - (providerPrice ?? 0)) / price) * 10000) : null;

  // 这一档此刻到底按什么算，三种情况说三句不同的话 —— 都写成「-」的话，
  // 「这个模型自己定过价」「在用兜底价」「根本没有价（静默算 0）」看起来一模一样。
  const state = own ? (
    <Typography.Text type="secondary">
      {t(fallback ? "galaxy.model.pricingCurrent" : "galaxy.model.pricingOwn").replace(
        "{price}",
        `¥${(own.price / MICRO).toLocaleString("en-US", { maximumFractionDigits: 6 })}`,
      )}
    </Typography.Text>
  ) : inherited && !fallback ? (
    <Typography.Text type="secondary">
      {t("galaxy.model.pricingInherit").replace(
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
