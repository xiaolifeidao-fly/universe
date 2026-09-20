"use client";

import { PlusOutlined, ReloadOutlined, WarningOutlined } from "@ant-design/icons";
import {
  Alert,
  AutoComplete,
  Button,
  DatePicker,
  Empty,
  Form,
  InputNumber,
  Modal,
  Popconfirm,
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
import { useCanWrite } from "@/components/permission/WritePermission";
import { deletePrice, fetchPrices, savePrice, type PriceTableView, type PriceView } from "../api/galaxy.api";

/** 单价在库里是「每百万单位的微分」：3,000,000 就是 ¥3 / 百万 token。 */
const MICRO = 1_000_000;

type PriceForm = {
  kind: string;
  /** 留空 = 该 kind 的兜底价。AutoComplete 的空值是 undefined，提交时归一成空串。 */
  modelId?: string;
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

  const prices = table?.prices ?? [];
  const unpriced = table?.unpriced ?? [];

  const columns: ColumnsType<PriceView> = useMemo(
    () => [
      { title: t("galaxy.price.kind"), dataIndex: "kind", width: 150 },
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
        title: t("galaxy.price.unit"),
        dataIndex: "unit",
        width: 210,
        render: (unit: string) => <span className="manager-mono">{unit}</span>,
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
                      // modelId 在唯一键里。漏掉它删的是兜底价那一行 ——
                      // 而兜底价一没，这个 kind 下所有没单独定价的模型立刻按 0 计费。
                      modelId: row.modelId,
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
                  >
                    {row.kind} · {row.unit}
                    {canWrite ? ` · ${t("galaxy.price.fix")}` : ""}
                  </Tag>
                ))}
              </Space>
            </Space>
          }
        />
      ) : null}

      <Space>
        {canWrite ? (
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setEditing({})}>
            {t("galaxy.price.add")}
          </Button>
        ) : null}
        <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void load()}>
          {t("galaxy.refresh")}
        </Button>
      </Space>

      <Table<PriceView>
        // 主键跟唯一键走。漏掉 modelId 的话，同一个 kind、同一个单位、
        // 同一个生效时刻的兜底价和模型价会撞成一个 key，React 只画得出一行。
        rowKey={(row) => `${row.kind}:${row.modelId}:${row.unit}:${row.effectiveFrom}`}
        size="small"
        loading={loading}
        columns={columns}
        dataSource={prices}
        pagination={false}
        scroll={{ x: 1385 }}
        locale={{ emptyText: <Empty description={t("galaxy.price.empty")} /> }}
      />

      <PriceModal
        draft={editing}
        kinds={table?.kinds ?? []}
        models={table?.models ?? []}
        units={table?.units ?? []}
        onClose={() => setEditing(null)}
        onSaved={load}
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
  onClose,
  onSaved,
}: {
  draft: Partial<PriceView> | null;
  kinds: string[];
  models: string[];
  units: string[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useLocale();
  const [form] = Form.useForm<PriceForm>();
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!draft) return;
    form.setFieldsValue({
      kind: draft.kind ?? "",
      modelId: draft.modelId ?? "",
      unit: draft.unit ?? "",
      price: (draft.price ?? 0) / MICRO,
      // 拿 settlePrice 而不是 providerPrice 预填：还没迁移的行 providerPrice 是 0，
      // 照着它预填的话，运营只是进来改个生效时间，保存出去就把这行从
      // 「按七成结」变成了「一分不结」—— 而且没有任何地方会报错。
      providerPrice: (draft.settlePrice || draft.providerPrice || 0) / MICRO,
      // 改已有的一行时带上它自己的生效时间 —— 不带就等于新建了一行「现在起生效」，
      // 旧行还在，两行并存，运营看到的是「改了但没改动」。
      effectiveFrom: draft.effectiveFrom ? dayjs(draft.effectiveFrom) : null,
    });
  }, [draft, form]);

  const submit = async () => {
    const values = await form.validateFields();
    setSubmitting(true);
    try {
      await savePrice({
        kind: values.kind.trim(),
        modelId: (values.modelId ?? "").trim(),
        unit: values.unit.trim(),
        // 界面按元填，库里存微分。中间这一步乘法漏掉的话价格会差一百万倍。
        price: Math.round(values.price * MICRO),
        providerPrice: Math.round((values.providerPrice ?? 0) * MICRO),
        effectiveFrom: values.effectiveFrom ? values.effectiveFrom.toISOString() : undefined,
      });
      message.success(t("galaxy.price.saved"));
      onClose();
      onSaved();
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
        {/* 候选值来自已有的价与真实跑过的用量。可以手填 —— 单位是注册制的，
            新业务自带自己的单位，写死一张白名单反而会把它们挡在外面。 */}
        <Form.Item name="kind" label={t("galaxy.price.kind")} rules={[{ required: true }]}>
          <AutoComplete
            options={kinds.map((value) => ({ value }))}
            filterOption={(input, option) => (option?.value ?? "").toLowerCase().includes(input.toLowerCase())}
            placeholder="llm.chat"
          />
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
        <Form.Item name="unit" label={t("galaxy.price.unit")} rules={[{ required: true }]}>
          <AutoComplete
            options={units.map((value) => ({ value }))}
            filterOption={(input, option) => (option?.value ?? "").toLowerCase().includes(input.toLowerCase())}
            placeholder="llm.input_tokens"
          />
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
          <DatePicker showTime style={{ width: "100%" }} />
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
