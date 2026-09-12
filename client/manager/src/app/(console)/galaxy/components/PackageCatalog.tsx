"use client";

import { DeleteOutlined, PlusOutlined, ReloadOutlined } from "@ant-design/icons";
import {
  AutoComplete,
  Button,
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
  Typography,
  message,
} from "antd";
import type { ColumnsType } from "antd/es/table";
import { useCallback, useEffect, useState } from "react";
import { useLocale } from "@/i18n/LocaleProvider";
import { useCanWrite } from "@/components/permission/WritePermission";
import {
  fetchGalaxyModels,
  fetchGalaxyPackages,
  saveGalaxyPackage,
  type GalaxyModelView,
  type GalaxyPackageView,
} from "../api/galaxy.api";

/** 金额与单价在库里都是整数微元；除以它得到「元」。 */
const MICRO = 1_000_000;

/**
 * 单位建议，不是白名单。
 *
 * 计量单位是注册制的（设计 X-06）：额度引擎本身不认识任何具体单位，只按
 * 「单位 → 上限」这张表算，新增业务自带自己的单位集合。所以这里用 AutoComplete
 * 给提示而不是 Select 锁死 —— 锁死的话，接一种新 kind 就要先改一次运营后台才能上商品。
 */
const UNIT_SUGGESTIONS = [
  "llm.input_tokens",
  "llm.output_tokens",
  "llm.cache_read_tokens",
  "llm.cache_write_tokens",
  "llm.calls",
  "time.seconds",
  "video.output_seconds",
  "video.input_seconds",
  "video.frames",
  "gpu.seconds",
  "cpu.seconds",
  "storage.bytes",
  "egress.bytes",
];

/** 表单里的额度用数组表达：对象在 Form 里没法增删行，也没法留一个空着的 key。 */
type UnitRow = { unit: string; value: number | null };

type PackageForm = {
  packageCode: string;
  title: string;
  units: UnitRow[];
  /** 表单里是「元」，提交前换算成微元 —— 让运营输 9900000 是在给自己找错。 */
  yuan: number | null;
  currency: string;
  ttlDays: number | null;
  concurrency: number | null;
  rpm: number | null;
  allowedKinds: string[];
  modelTier: string[];
  /** 绑定的模型。undefined 是 antd Select 的「没选」，提交时换成空串。 */
  modelId?: string;
  sortOrder: number | null;
  listed: boolean;
};

function toForm(row: GalaxyPackageView | null): PackageForm {
  if (!row) {
    return {
      packageCode: "",
      title: "",
      units: [{ unit: "llm.input_tokens", value: null }],
      yuan: null,
      currency: "CNY",
      ttlDays: 30,
      concurrency: 4,
      rpm: 120,
      allowedKinds: [],
      modelTier: [],
      modelId: undefined,
      sortOrder: 0,
      listed: true,
    };
  }
  return {
    packageCode: row.packageCode,
    title: row.title,
    units: Object.entries(row.units ?? {}).map(([unit, value]) => ({ unit, value })),
    yuan: row.amount / MICRO,
    currency: row.currency || "CNY",
    ttlDays: row.ttlDays,
    concurrency: row.concurrency,
    rpm: row.rpm,
    allowedKinds: row.allowedKinds ?? [],
    modelTier: row.modelTier ?? [],
    modelId: row.modelId || undefined,
    sortOrder: row.sortOrder,
    listed: row.listed,
  };
}

/**
 * 额度商品目录。
 *
 * 这是运营唯一能建、能改、能上下架额度包的地方 —— 在这之前只能写 SQL 或者
 * 直接打接口。几条要紧的语义：
 *
 * - **保存是整行覆盖**，不是打补丁。所以编辑框一律用当前值预填，提交时整份带回去。
 * - **商品码建了就不能改**：历史订单按它记录买的是什么，改掉等于让老订单指向一个
 *   不存在的商品。要换码就新建一个，把旧的下架。
 * - **下架不是删除**，也没有删除。已经引用这个码的订单还要能查到自己买的是什么。
 * - 改价改量**不影响已经下过的单**：额度与价格在下单那一刻就快照进订单了。
 */
export function PackageCatalog() {
  const { t } = useLocale();
  // 商品直接决定卖多少钱、发多少额度，只读角色一律看不到入口。
  const canWrite = useCanWrite();
  const [rows, setRows] = useState<GalaxyPackageView[]>([]);
  // 绑定模型的下拉候选。下架的模型也列：套餐可能还挂着它在卖。
  const [models, setModels] = useState<GalaxyModelView[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<GalaxyPackageView | null>(null);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form] = Form.useForm<PackageForm>();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [packages, modelList] = await Promise.all([fetchGalaxyPackages(), fetchGalaxyModels().catch(() => [] as GalaxyModelView[])]);
      setRows(packages);
      setModels(modelList);
    } catch (error) {
      message.error((error as Error).message || t("galaxy.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const edit = (row: GalaxyPackageView | null) => {
    setEditing(row);
    form.setFieldsValue(toForm(row));
    setOpen(true);
  };

  /** 把一行原样存回去，只改 listed。上下架不该顺手动到别的字段。 */
  const toggleListed = async (row: GalaxyPackageView, listed: boolean) => {
    try {
      await saveGalaxyPackage({ ...row, units: row.units ?? {}, modelId: row.modelId ?? "", listed });
      message.success(t("galaxy.package.saved"));
      void load();
    } catch (error) {
      message.error((error as Error).message || t("galaxy.actionFailed"));
    }
  };

  const submit = async () => {
    const values = await form.validateFields();
    const units: Record<string, number> = {};
    for (const row of values.units ?? []) {
      const unit = row.unit?.trim();
      if (!unit || !row.value) continue;
      units[unit] = row.value;
    }
    if (Object.keys(units).length === 0) {
      message.error(t("galaxy.package.unitsRequired"));
      return;
    }
    setSaving(true);
    try {
      await saveGalaxyPackage({
        packageCode: values.packageCode.trim(),
        title: values.title.trim(),
        units,
        // 元 → 微元。四舍五入到整数：0.1 + 0.2 那类浮点误差不能带进金额。
        amount: Math.round((values.yuan ?? 0) * MICRO),
        currency: values.currency || "CNY",
        ttlDays: values.ttlDays ?? 30,
        allowedKinds: values.allowedKinds ?? [],
        modelTier: values.modelTier ?? [],
        concurrency: values.concurrency ?? 0,
        rpm: values.rpm ?? 0,
        modelId: values.modelId ?? "",
        listed: values.listed,
        sortOrder: values.sortOrder ?? 0,
      });
      message.success(t("galaxy.package.saved"));
      setOpen(false);
      void load();
    } catch (error) {
      message.error((error as Error).message || t("galaxy.actionFailed"));
    } finally {
      setSaving(false);
    }
  };

  const columns: ColumnsType<GalaxyPackageView> = [
    {
      title: t("galaxy.package.code"),
      dataIndex: "packageCode",
      width: 200,
      render: (code: string, row) => (
        <Space direction="vertical" size={0}>
          <span style={{ fontWeight: 600 }}>{row.title || code}</span>
          <Typography.Text type="secondary" className="manager-mono" style={{ fontSize: 12 }}>
            {code}
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: t("galaxy.package.model"),
      dataIndex: "modelId",
      width: 180,
      render: (modelId: string) => {
        if (!modelId) return <Typography.Text type="secondary">{t("galaxy.package.modelNone")}</Typography.Text>;
        const model = models.find((item) => item.modelId === modelId);
        return (
          <Space direction="vertical" size={0}>
            <span>{model?.displayName || modelId}</span>
            {/* 目录里删掉了还被套餐绑着：返现会回落到默认比例，运营得看得出来。 */}
            {model ? null : <Tag color="warning">{t("galaxy.package.modelMissing")}</Tag>}
          </Space>
        );
      },
    },
    {
      title: t("galaxy.package.units"),
      dataIndex: "units",
      render: (units: Record<string, number>) => (
        <Space size={6} wrap>
          {Object.entries(units ?? {}).length === 0 ? "-" : null}
          {Object.entries(units ?? {}).map(([unit, value]) => (
            <Tag key={unit}>
              {unit} <b>{value.toLocaleString()}</b>
            </Tag>
          ))}
        </Space>
      ),
    },
    {
      title: t("galaxy.package.amount"),
      dataIndex: "amount",
      width: 110,
      align: "right",
      render: (amount: number, row) => `${row.currency === "CNY" ? "¥" : ""}${(amount / MICRO).toFixed(2)}`,
    },
    {
      title: t("galaxy.package.ttl"),
      dataIndex: "ttlDays",
      width: 90,
      align: "right",
      render: (days: number) => `${days}d`,
    },
    {
      title: t("galaxy.package.limits"),
      dataIndex: "concurrency",
      width: 110,
      align: "right",
      render: (concurrency: number, row) => `${concurrency} / ${row.rpm}`,
    },
    {
      title: t("galaxy.package.status"),
      dataIndex: "listed",
      width: 100,
      render: (listed: boolean) =>
        listed ? (
          <Tag color="success">{t("galaxy.package.listed")}</Tag>
        ) : (
          <Tag>{t("galaxy.package.unlisted")}</Tag>
        ),
    },
    {
      title: t("galaxy.actions"),
      key: "actions",
      width: 160,
      render: (_, row) =>
        canWrite ? (
          <Space size={8}>
            <Button size="small" onClick={() => edit(row)}>
              {t("galaxy.package.edit")}
            </Button>
            <Popconfirm
              title={row.listed ? t("galaxy.package.unlist") : t("galaxy.package.list")}
              description={t("galaxy.package.listHint")}
              okText={t("galaxy.confirm")}
              cancelText={t("galaxy.cancel")}
              onConfirm={() => void toggleListed(row, !row.listed)}
            >
              <Button size="small" danger={row.listed}>
                {row.listed ? t("galaxy.package.unlist") : t("galaxy.package.list")}
              </Button>
            </Popconfirm>
          </Space>
        ) : null,
    },
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <Space>
        {canWrite ? (
          <Button type="primary" icon={<PlusOutlined />} onClick={() => edit(null)}>
            {t("galaxy.package.new")}
          </Button>
        ) : null}
        <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void load()}>
          {t("galaxy.refresh")}
        </Button>
      </Space>

      <Table<GalaxyPackageView>
        rowKey="packageCode"
        size="small"
        loading={loading}
        columns={columns}
        dataSource={rows}
        locale={{ emptyText: t("galaxy.package.empty") }}
        pagination={false}
        scroll={{ x: 1000 }}
      />

      <Modal
        open={open}
        title={editing ? t("galaxy.package.edit") : t("galaxy.package.new")}
        okText={t("galaxy.package.save")}
        cancelText={t("galaxy.cancel")}
        confirmLoading={saving}
        width={720}
        onCancel={() => setOpen(false)}
        onOk={() => void submit()}
        destroyOnClose
      >
        <Form form={form} layout="vertical" initialValues={toForm(null)}>
          <Space size={12} style={{ display: "flex" }} align="start">
            <Form.Item
              name="packageCode"
              label={t("galaxy.package.code")}
              rules={[{ required: true }]}
              // 商品码是历史订单指向商品的唯一线索，建了就不能改。
              extra={editing ? t("galaxy.package.codeLocked") : t("galaxy.package.codeHint")}
              style={{ flex: 1 }}
            >
              <Input disabled={Boolean(editing)} placeholder="starter" />
            </Form.Item>
            <Form.Item name="title" label={t("galaxy.package.title")} rules={[{ required: true }]} style={{ flex: 1 }}>
              <Input />
            </Form.Item>
          </Space>

          <Form.Item label={t("galaxy.package.units")} extra={t("galaxy.package.unitsHint")} required>
            <Form.List name="units">
              {(fields, { add, remove }) => (
                <Space direction="vertical" size={8} style={{ display: "flex" }}>
                  {fields.map((field) => (
                    <Space key={field.key} size={8} align="start" style={{ display: "flex" }}>
                      <Form.Item name={[field.name, "unit"]} noStyle>
                        <AutoComplete
                          style={{ width: 260 }}
                          options={UNIT_SUGGESTIONS.map((unit) => ({ value: unit }))}
                          filterOption={(input, option) => (option?.value ?? "").includes(input)}
                          placeholder="llm.input_tokens"
                        />
                      </Form.Item>
                      <Form.Item name={[field.name, "value"]} noStyle>
                        <InputNumber style={{ width: 200 }} min={1} step={1000} placeholder="5000000" />
                      </Form.Item>
                      <Button
                        type="text"
                        icon={<DeleteOutlined />}
                        disabled={fields.length <= 1}
                        onClick={() => remove(field.name)}
                      />
                    </Space>
                  ))}
                  <Button type="dashed" icon={<PlusOutlined />} onClick={() => add({ unit: "", value: null })}>
                    {t("galaxy.package.addUnit")}
                  </Button>
                </Space>
              )}
            </Form.List>
          </Form.Item>

          <Space size={12} style={{ display: "flex" }} align="start">
            <Form.Item
              name="yuan"
              label={t("galaxy.package.amount")}
              rules={[{ required: true }]}
              extra={t("galaxy.package.amountHint")}
              style={{ flex: 1 }}
            >
              <InputNumber style={{ width: "100%" }} min={0} precision={2} step={1} addonAfter="CNY" />
            </Form.Item>
            <Form.Item name="ttlDays" label={t("galaxy.package.ttl")} style={{ flex: 1 }}>
              <InputNumber style={{ width: "100%" }} min={1} addonAfter="d" />
            </Form.Item>
            <Form.Item name="sortOrder" label={t("galaxy.package.sortOrder")} style={{ flex: 1 }}>
              <InputNumber style={{ width: "100%" }} />
            </Form.Item>
          </Space>

          <Space size={12} style={{ display: "flex" }} align="start">
            <Form.Item name="concurrency" label={t("galaxy.package.concurrency")} style={{ flex: 1 }}>
              <InputNumber style={{ width: "100%" }} min={1} />
            </Form.Item>
            <Form.Item name="rpm" label={t("galaxy.package.rpm")} style={{ flex: 1 }}>
              <InputNumber style={{ width: "100%" }} min={1} />
            </Form.Item>
            <Form.Item name="currency" label={t("galaxy.package.currency")} style={{ flex: 1 }}>
              <Input />
            </Form.Item>
          </Space>

          <Form.Item name="modelId" label={t("galaxy.package.model")} extra={t("galaxy.package.modelHint")}>
            <Select
              allowClear
              showSearch
              placeholder={t("galaxy.package.modelNone")}
              optionFilterProp="label"
              options={models.map((model) => ({
                value: model.modelId,
                label: model.displayName && model.displayName !== model.modelId ? `${model.displayName} · ${model.modelId}` : model.modelId,
              }))}
            />
          </Form.Item>

          <Space size={12} style={{ display: "flex" }} align="start">
            <Form.Item
              name="allowedKinds"
              label={t("galaxy.package.allowedKinds")}
              extra={t("galaxy.package.scopeHint")}
              style={{ flex: 1 }}
            >
              <Select mode="tags" tokenSeparators={[","]} placeholder="llm.chat" />
            </Form.Item>
            <Form.Item
              name="modelTier"
              label={t("galaxy.package.modelTier")}
              extra={t("galaxy.package.scopeHint")}
              style={{ flex: 1 }}
            >
              <Select mode="tags" tokenSeparators={[","]} />
            </Form.Item>
          </Space>

          <Form.Item
            name="listed"
            label={t("galaxy.package.status")}
            valuePropName="checked"
            extra={t("galaxy.package.saveHint")}
          >
            <Switch checkedChildren={t("galaxy.package.listed")} unCheckedChildren={t("galaxy.package.unlisted")} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
