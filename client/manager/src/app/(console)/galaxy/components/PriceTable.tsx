"use client";

import { PlusOutlined, ReloadOutlined, WarningOutlined } from "@ant-design/icons";
import {
  Alert,
  AutoComplete,
  Button,
  Empty,
  Form,
  InputNumber,
  Modal,
  Popconfirm,
  Select,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
  message,
} from "antd";
import type { FormInstance } from "antd";
import type { ColumnsType } from "antd/es/table";
import dayjs, { type Dayjs } from "dayjs";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useLocale } from "@/i18n/LocaleProvider";
import { ManagerDatePicker } from "@/components/date/DatePickers";
import { useCanWrite } from "@/components/permission/WritePermission";
import { deletePrice, fetchPrices, savePrice, type PriceTableView, type PriceView } from "../api/galaxy.api";
import { CodeSelect, CodeText, effortLabel, HIDDEN_UNITS, kindLabel, labeledOptions, optionMatches, unitLabel } from "./labels";

/** 单价在库里是「每百万单位的微分」：3,000,000 就是 ¥3 / 百万 token。 */
const MICRO = 1_000_000;

/**
 * 进来先看「对话与代码」。
 *
 * 价目表是 `能力 × 模型 × 计量单位 × 生效时间` 四维展开的，一眼几十上百行，
 * 而运营九成的调价发生在这一种能力下面。默认摊开全部，等于每次都要先用眼睛筛一遍。
 */
const DEFAULT_KIND = "llm.chat";

/** 「全部能力」在 Select 里用空串表达：undefined 会被 antd 当成没选，显示成占位符。 */
const ALL_KINDS = "";

/**
 * 强度胶囊的配色，由浅到深逐级加重。
 *
 * 颜色在这里是**排序信息**而不是装饰：一张按 (模型 × 强度 × 单位) 展开的表，
 * 同一个模型的几档会被单位插花排开，光看 low / xhigh 两个词，「哪档更深」
 * 要一个一个读。词表以外的档没有配色，落到默认灰 —— 不猜。
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

type PriceForm = {
  kind: string;
  /** 留空 = 该 kind 的兜底价。AutoComplete 的空值是 undefined，提交时归一成空串。 */
  modelId?: string;
  /** 留空 = 这个模型不分强度的价。Select 的空值同样是 undefined。 */
  effort?: string;
  unit: string;
  /** 界面上按元填，提交时乘回微分。 */
  price: number;
  providerPrice: number;
  effectiveFrom?: Dayjs | null;
};

/** 毛利率按万分之一回来。负数 = 结算价高过对外价，平台在倒贴。 */
function marginText(bps: number) {
  return `${(bps / 100).toFixed(bps % 100 === 0 ? 0 : 1)}%`;
}

/**
 * 价目表。
 *
 * 一行**两个价**：对外单价向使用者收，结算单价结给共享者，差额是平台毛利。
 * 两个数各填各的 —— 上游价原先是「对外价 × 分成比例」，于是想给使用者降价
 * 就必然同时砍掉所有共享者的收入，而共享者拿自己的流水一除就反推出平台抽了几成。
 *
 * **没有价可查时扣费与结算静默算 0** —— Usage 查不到单价就把 Cost 留成 0，
 * 不报错也不告警。于是「价目表是空的」这个故障只能从「钱一直对不上」反推，
 * 而在有这一页之前，唯一的填表方式是初始化命令里写死的那份默认价，或者手工 INSERT。
 *
 * 还有一层是**模型**：同一个 kind 下每个模型可以有自己的价，model 留空那行是
 * 「该 kind 的兜底价」。原先整张表只按 kind 定价 —— opus 和 haiku 同样一百万 token
 * 结给共享者的钱一模一样，而门户上两者标价差几十倍，平台毛利于是随使用者
 * 调哪个模型漂移。兜底行排在每个 kind 的最前面（服务端按 model_id 升序给）。
 *
 * 所以这一页做三件事：把两个价都改得动、把毛利算给运营看、
 * 以及把**有用量却没有价**的单位直接摆在最上面。
 *
 * 生效时间在唯一键里：换一个时刻是新增一行、旧行留作历史，已经结过的账不会被追溯改掉。
 */
export function PriceTable() {
  const { t } = useLocale();
  // 改价是改钱，只读角色看不到入口。
  const canWrite = useCanWrite();
  const [table, setTable] = useState<PriceTableView | null>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Partial<PriceView> | null>(null);
  /** null = 运营还没自己选过，这时按默认能力落位。选过之后一切以他选的为准。 */
  const [kindFilter, setKindFilter] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setTable(await fetchPrices());
    } catch (error) {
      message.error((error as Error).message || t("galaxy.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const prices = useMemo(() => table?.prices ?? [], [table]);
  const unpriced = (table?.unpriced ?? []).filter((row) => !HIDDEN_UNITS.has(row.unit));

  /**
   * 筛选里只给**表里真有行**的能力。
   *
   * 候选表（table.kinds）还含着「跑过用量但一行价都没有」的能力 —— 拿它当筛选项，
   * 选中就是一张空表，而空表和「这个能力没定价」长得一模一样。那件事由上面的
   * 有量无价告警来说，不该让筛选器再演一遍。
   */
  const kinds = useMemo(() => {
    const seen = new Set<string>();
    for (const row of prices) seen.add(row.kind);
    const list: string[] = [];
    seen.forEach((value) => list.push(value));
    return list.sort();
  }, [prices]);

  // 没选过就落在默认能力上；这批价目里压根没有它（比如只接了视频业务），退回「全部」——
  // 不退的话首屏是一张空表，运营看到的是「价目表没了」。
  const kind = kindFilter ?? (kinds.includes(DEFAULT_KIND) ? DEFAULT_KIND : ALL_KINDS);
  // 缓存写入那几行整个不露出（见 labels.tsx 的 HIDDEN_UNITS）。过滤的是**行**不是列：
  // 只把列删掉，行还在，只是看不出它是哪个单位的价。
  const rows = useMemo(
    () => (kind ? prices.filter((row) => row.kind === kind) : prices).filter((row) => !HIDDEN_UNITS.has(row.unit)),
    [kind, prices],
  );

  const columns: ColumnsType<PriceView> = useMemo(
    () => [
      {
        title: t("galaxy.price.kind"),
        dataIndex: "kind",
        width: 170,
        render: (value: string) => <CodeText value={value} label={kindLabel(value, t)} />,
      },
      {
        title: t("galaxy.price.model"),
        dataIndex: "modelId",
        width: 180,
        render: (modelId: string) =>
          modelId ? (
            <span className="manager-mono">{modelId}</span>
          ) : (
            // 空串不是「没填」，是一个有含义的值：没单独定价的模型都按这行算。
            // 显示成空白的话，运营会以为这行还差点什么。
            <Tooltip title={t("galaxy.price.fallbackHint")}>
              <Tag color="blue">{t("galaxy.price.fallback")}</Tag>
            </Tooltip>
          ),
      },
      {
        title: t("galaxy.price.effort"),
        dataIndex: "effort",
        width: 130,
        render: (effort: string) =>
          effort ? (
            <Tag color={EFFORT_TONE[effort] ?? "default"}>{effortLabel(effort, t)}</Tag>
          ) : (
            // 和模型那一列同理：空串不是「没填」，是「这个模型的所有强度都按这行算」。
            <Tooltip title={t("galaxy.price.anyEffortHint")}>
              <Tag>{t("galaxy.price.anyEffort")}</Tag>
            </Tooltip>
          ),
      },
      {
        title: t("galaxy.price.unit"),
        dataIndex: "unit",
        width: 210,
        render: (value: string) => <CodeText value={value} label={unitLabel(value, t)} />,
      },
      {
        title: t("galaxy.price.price"),
        dataIndex: "price",
        align: "right",
        width: 150,
        render: (value: number, row) => <Money value={value} currency={row.currency} />,
      },
      {
        // 显示的是 settlePrice（共享者**实际**按多少结），不是运营填了什么：
        // 还没迁移的行 providerPrice 是 0，照着它显示等于告诉运营「这行不发钱」。
        title: t("galaxy.price.providerPrice"),
        dataIndex: "settlePrice",
        align: "right",
        width: 170,
        render: (value: number, row) => (
          <Space direction="vertical" size={0} style={{ alignItems: "flex-end" }}>
            <Money value={value} currency={row.currency} />
            {row.providerPrice === 0 && value > 0 ? (
              <Tooltip
                title={t("galaxy.price.legacyShareHint").replace(/\{rate\}/g, `${Math.round(row.providerShare * 100)}%`)}
              >
                <Tag color="warning" style={{ marginInlineEnd: 0 }}>
                  {t("galaxy.price.legacyShare").replace("{rate}", `${Math.round(row.providerShare * 100)}%`)}
                </Tag>
              </Tooltip>
            ) : null}
          </Space>
        ),
      },
      {
        title: t("galaxy.price.margin"),
        dataIndex: "marginBps",
        align: "right",
        width: 110,
        render: (value: number, row) => {
          if (row.price <= 0) {
            return <Typography.Text type="secondary">{t("galaxy.price.marginNone")}</Typography.Text>;
          }
          if (value < 0) {
            return (
              <Tooltip title={t("galaxy.price.subsidyHint")}>
                <Typography.Text type="danger" className="manager-mono">
                  {marginText(value)}
                </Typography.Text>
              </Tooltip>
            );
          }
          return <span className="manager-mono">{marginText(value)}</span>;
        },
      },
      {
        title: t("galaxy.price.effectiveFrom"),
        dataIndex: "effectiveFrom",
        width: 175,
        render: (value: string) => (value ? new Date(value).toLocaleString() : "-"),
      },
      {
        title: t("galaxy.price.state"),
        key: "state",
        width: 100,
        render: (_, row) => {
          if (row.effective) return <Tag color="success">{t("galaxy.price.effective")}</Tag>;
          // 还没到点的是「待生效」，到过点但被更新的那行是「历史」。两者都不该被当成当前价。
          if (dayjs(row.effectiveFrom).isAfter(dayjs())) return <Tag color="processing">{t("galaxy.price.scheduled")}</Tag>;
          return <Tag>{t("galaxy.price.superseded")}</Tag>;
        },
      },
      {
        title: t("galaxy.actions"),
        key: "actions",
        width: 140,
        fixed: "right",
        render: (_, row) =>
          canWrite ? (
            <Space size={4}>
              <Button type="link" size="small" onClick={() => setEditing(row)}>
                {t("galaxy.price.edit")}
              </Button>
              <Popconfirm
                title={t("galaxy.price.deleteConfirm")}
                // 删掉正在生效的那一行，这个单位立刻退回「查不到价」，扣费与分成静默归零。
                description={row.effective ? t("galaxy.price.deleteEffective") : undefined}
                okText={t("galaxy.confirm")}
                cancelText={t("galaxy.cancel")}
                okButtonProps={{ danger: true }}
                onConfirm={async () => {
                  try {
                    await deletePrice({
                      kind: row.kind,
                      // modelId 与 effort 都在唯一键里。漏掉任意一个删的都是另一行 ——
                      // 漏掉 modelId 删的是兜底价，那个 kind 下所有没单独定价的模型
                      // 立刻按 0 计费；漏掉 effort 删的是「不分强度」那条，同样是一大片。
                      modelId: row.modelId,
                      effort: row.effort,
                      unit: row.unit,
                      effectiveFrom: row.effectiveFrom,
                    });
                    message.success(t("galaxy.price.deleted"));
                    await load();
                  } catch (error) {
                    message.error((error as Error).message || t("galaxy.actionFailed"));
                  }
                }}
              >
                <Button type="link" size="small" danger>
                  {t("galaxy.price.delete")}
                </Button>
              </Popconfirm>
            </Space>
          ) : null,
      },
    ],
    [canWrite, load, t],
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {/* 一行价都没有 = 全站扣费与分成都是 0。这句话必须排在最前面。 */}
      {!loading && prices.length === 0 ? (
        <Alert type="error" showIcon message={t("galaxy.price.empty")} description={t("galaxy.price.emptyHint")} />
      ) : null}

      {/* 有量无价：这些用量的钱正在被静默算成 0。 */}
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
                    onClick={canWrite ? () => setEditing({ kind: row.kind, unit: row.unit }) : undefined}
                    // 标签里放中文名，原始 id 交给悬停 —— 两个 id 并排（llm.chat · llm.calls）
                    // 挤在一行里，读起来像一串路径，而这句话是说给运营听的。
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

      <Space wrap>
        {canWrite ? (
          // 带着当前筛选的能力进弹窗：在「对话与代码」下面点新增，八成就是给它加一行。
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setEditing({ kind })}>
            {t("galaxy.price.add")}
          </Button>
        ) : null}
        <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void load()}>
          {t("galaxy.refresh")}
        </Button>
        <Select
          showSearch
          style={{ width: 260 }}
          value={kind}
          onChange={setKindFilter}
          filterOption={optionMatches}
          options={[
            { value: ALL_KINDS, label: t("galaxy.price.kindAll") },
            ...labeledOptions(kinds, (value) => kindLabel(value, t)),
          ]}
        />
        {/* 藏了多少行要说出来：不说的话，少掉的那几十行看着就像没存进去。 */}
        {kind ? (
          <Typography.Text type="secondary">
            {t("galaxy.price.filtered")
              .replace("{shown}", String(rows.length))
              .replace("{total}", String(prices.length))}
          </Typography.Text>
        ) : null}
      </Space>

      <Table<PriceView>
        // 主键跟唯一键走。少一列就会让两行撞成一个 key，React 只画得出其中一行 ——
        // 表面上是「我明明存进去了，列表里没有」。
        rowKey={(row) => `${row.kind}:${row.modelId}:${row.effort}:${row.unit}:${row.effectiveFrom}`}
        size="small"
        loading={loading}
        columns={columns}
        dataSource={rows}
        pagination={false}
        scroll={{ x: 1405 }}
        locale={{
          // 「这个能力下没有价」和「一行价都没有」是两件事：前者点一下就看得到，
          // 后者是全站扣费归零。空表上写错一句，运营会朝着错的方向排查。
          emptyText: prices.length ? (
            <Empty description={t("galaxy.price.emptyKind")}>
              <Button size="small" onClick={() => setKindFilter(ALL_KINDS)}>
                {t("galaxy.price.kindAll")}
              </Button>
            </Empty>
          ) : (
            <Empty description={t("galaxy.price.empty")} />
          ),
        }}
      />

      <PriceModal
        draft={editing}
        kinds={table?.kinds ?? []}
        models={table?.models ?? []}
        units={(table?.units ?? []).filter((unit) => !HIDDEN_UNITS.has(unit))}
        efforts={table?.efforts ?? {}}
        onClose={() => setEditing(null)}
        onSaved={(saved) => {
          // 在「对话与代码」下面给别的能力加了一行，存完表里什么都没多 ——
          // 看起来和「没存上」一模一样。所以跟着刚存的那个能力走。
          if (kind && saved && saved !== kind) setKindFilter(saved);
          void load();
        }}
      />
    </div>
  );
}

/** 一个价的显示：货币符号 + 元，下面一行说明量纲。两个价共用，免得两处写法漂。 */
function Money({ value, currency }: { value: number; currency: string }) {
  const { t } = useLocale();
  return (
    <Space direction="vertical" size={0} style={{ alignItems: "flex-end" }}>
      <span className="manager-mono">
        {currency === "CNY" ? "¥" : `${currency} `}
        {(value / MICRO).toLocaleString("en-US", { maximumFractionDigits: 6 })}
      </span>
      {/* 这里不能再写「元 / 百万」—— 上面已经有 ¥ 了，两个货币符号叠在一起读起来是两笔钱。 */}
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        {t("galaxy.price.perMillionUnit")}
      </Typography.Text>
    </Space>
  );
}

function PriceModal({
  draft,
  kinds,
  models,
  units,
  efforts,
  onClose,
  onSaved,
}: {
  draft: Partial<PriceView> | null;
  kinds: string[];
  models: string[];
  units: string[];
  /** 协议族 → 它认识的档位，由浅到深。服务端给的，前端不自己维护一份。 */
  efforts: Record<string, string[]>;
  onClose: () => void;
  /** 带上刚存下的能力：外面要靠它把筛选跟过去。 */
  onSaved: (kind: string) => void;
}) {
  const { t } = useLocale();
  const [form] = Form.useForm<PriceForm>();
  const [submitting, setSubmitting] = useState(false);

  /**
   * 强度候选：两族的档并成一张下拉，按族分组。
   *
   * 分组不是排版 —— 一行价上没有「族」这一列，也不该有（族是模型的属性，而一行价
   * 可以是跨模型的兜底行）。所以必须由这张下拉告诉运营「minimal 只有 Codex 有、
   * xhigh 只有 Claude 有」，否则给一个 Claude 模型配上 minimal 档这种搭配错误，
   * 服务端拦不住（它只校验档位名真实存在），表现是那行价匹配不上任何用量。
   */
  const effortOptions = useMemo(
    () =>
      Object.entries(efforts)
        .filter(([, levels]) => levels.length > 0)
        .map(([family, levels]) => ({
          label: t(`galaxy.price.family.${family}`),
          options: levels.map((effort) => ({ value: effort, label: effortLabel(effort, t) })),
        })),
    [efforts, t],
  );

  useEffect(() => {
    if (!draft) return;
    form.setFieldsValue({
      kind: draft.kind ?? "",
      modelId: draft.modelId ?? "",
      effort: draft.effort ?? "",
      unit: draft.unit ?? "",
      price: (draft.price ?? 0) / MICRO,
      // 拿 settlePrice 而不是 providerPrice 预填：还没迁移的行 providerPrice 是 0，
      // 照着它预填的话，运营只是进来改个生效时间，保存出去就把这行从
      // 「按七成结」变成了「一分不结」—— 而且没有任何地方会报错。
      providerPrice: (draft.settlePrice || draft.providerPrice || 0) / MICRO,
      // 改已有的一行时带上它自己的生效时间 —— 不带就等于新建了一行「现在起生效」，
      // 旧行还在，两行并存，运营看到的是「改了但没改动」。新增的那一行预填此刻：
      // 跟留空是同一个结果，只是让「现在生效」和「预约到将来」看起来不一样。
      effectiveFrom: draft.effectiveFrom ? dayjs(draft.effectiveFrom) : dayjs(),
    });
  }, [draft, form]);

  const submit = async () => {
    const values = await form.validateFields();
    setSubmitting(true);
    // 存进库的始终是 id —— 下拉里显示的中文名只活在界面上。
    const kind = (values.kind ?? "").trim();
    try {
      await savePrice({
        kind,
        modelId: (values.modelId ?? "").trim(),
        effort: (values.effort ?? "").trim(),
        unit: (values.unit ?? "").trim(),
        // 界面按元填，库里存微分。中间这一步乘法漏掉的话价格会差一百万倍。
        price: Math.round(values.price * MICRO),
        providerPrice: Math.round((values.providerPrice ?? 0) * MICRO),
        effectiveFrom: values.effectiveFrom ? values.effectiveFrom.toISOString() : undefined,
      });
      message.success(t("galaxy.price.saved"));
      onClose();
      onSaved(kind);
    } catch (error) {
      message.error((error as Error).message || t("galaxy.actionFailed"));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={draft !== null}
      title={draft?.effectiveFrom ? t("galaxy.price.edit") : t("galaxy.price.add")}
      okText={t("galaxy.confirm")}
      cancelText={t("galaxy.cancel")}
      confirmLoading={submitting}
      onOk={() => void submit()}
      onCancel={onClose}
      destroyOnClose
    >
      <Form form={form} layout="vertical">
        {/* 候选值来自已有的价与真实跑过的用量，也可以手填 —— 能力和单位都是注册制的，
            写死一张白名单反而会把新接的业务挡在外面。选中之后框里只剩中文名，
            下拉和表格里 id 一直露着，而**存出去的始终是 id**。 */}
        <Form.Item name="kind" label={t("galaxy.price.kind")} rules={[{ required: true }]}>
          <CodeSelect candidates={kinds} label={(value) => kindLabel(value, t)} placeholder="llm.chat" />
        </Form.Item>
        {/* 可清空、可手填：模型目录是门户的展示清单，计价表是账。一个模型可以
            先接进来跑、后补目录，也可以从目录里下架而老账还要按它算。 */}
        <Form.Item name="modelId" label={t("galaxy.price.model")} extra={t("galaxy.price.modelHint")}>
          <AutoComplete
            allowClear
            options={models.filter(Boolean).map((value) => ({ value }))}
            filterOption={(input, option) => (option?.value ?? "").toLowerCase().includes(input.toLowerCase())}
            placeholder={t("galaxy.price.fallbackPlaceholder")}
          />
        </Form.Item>
        {/* 强度是一个**封闭词表**，所以这里是 Select 而不是 AutoComplete —— 和上面的模型正相反。
            理由在于错了会怎样：模型名填错很快会有人反馈「这个模型没按我定的价收」，
            而强度填错（"High"、"medium-high"）匹配不上任何一次请求，这行价会永远躺在表里，
            运营以为自己给 max 档加过价。服务端也会拒，但那时人已经填完一整张表了。 */}
        <Form.Item name="effort" label={t("galaxy.price.effort")} extra={t("galaxy.price.effortHint")}>
          <Select allowClear options={effortOptions} placeholder={t("galaxy.price.anyEffortPlaceholder")} />
        </Form.Item>
        <Form.Item name="unit" label={t("galaxy.price.unit")} rules={[{ required: true }]}>
          <CodeSelect candidates={units} label={(value) => unitLabel(value, t)} placeholder="llm.input_tokens" />
        </Form.Item>
        <Form.Item
          name="price"
          label={t("galaxy.price.price")}
          extra={t("galaxy.price.priceHint")}
          rules={[{ required: true }]}
        >
          <InputNumber min={0} step={0.1} precision={6} style={{ width: "100%" }} addonAfter={t("galaxy.price.perMillion")} />
        </Form.Item>
        <Form.Item
          name="providerPrice"
          label={t("galaxy.price.providerPrice")}
          extra={t("galaxy.price.providerPriceHint")}
          rules={[{ required: true }]}
        >
          <InputNumber min={0} step={0.1} precision={6} style={{ width: "100%" }} addonAfter={t("galaxy.price.perMillion")} />
        </Form.Item>
        <MarginPreview form={form} />
        <Form.Item name="effectiveFrom" label={t("galaxy.price.effectiveFrom")} extra={t("galaxy.price.effectiveFromHint")}>
          <ManagerDatePicker showTime style={{ width: "100%" }} />
        </Form.Item>
      </Form>
    </Modal>
  );
}

/**
 * 两个价之间的毛利，边填边算。
 *
 * 不算出来的话，运营脑子里要做的那步除法就是「这次调价平台还剩多少」——
 * 而填错一位数的代价是每一笔都在倒贴，且账上不会报错，只会安静地记一串负的 fee。
 */
function MarginPreview({ form }: { form: FormInstance<PriceForm> }) {
  const { t } = useLocale();
  const price = Form.useWatch("price", form) ?? 0;
  const providerPrice = Form.useWatch("providerPrice", form) ?? 0;
  if (!price || price <= 0) return null;
  const bps = Math.round(((price - providerPrice) / price) * 10000);
  return bps < 0 ? (
    <Alert type="error" showIcon message={`${t("galaxy.price.subsidy")} ${marginText(bps)}`} description={t("galaxy.price.subsidyHint")} />
  ) : (
    <Typography.Text type="secondary">
      {t("galaxy.price.margin")} · <span className="manager-mono">{marginText(bps)}</span>
    </Typography.Text>
  );
}
