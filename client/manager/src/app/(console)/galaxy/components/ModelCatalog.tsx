"use client";

import { DeleteOutlined, PlusOutlined, ReloadOutlined } from "@ant-design/icons";
import {
  Button,
  Card,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Radio,
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
  deleteGalaxyModel,
  fetchGalaxyModels,
  fetchReferralSettings,
  saveGalaxyModel,
  saveReferralSettings,
  type GalaxyModelView,
  type ReferralSettingsView,
} from "../api/galaxy.api";

/** 单价在库里是「每百万 token 的微元」；表单里填元。 */
const MICRO = 1_000_000;

/** 返现比例存万分之一：1000 = 10%。表单里填百分数。折扣也是万分之一，同一个函数。 */
function percent(bps: number): string {
  return `${(bps / 100).toLocaleString("en-US", { maximumFractionDigits: 2 })}%`;
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
  inputYuan: number | null;
  outputYuan: number | null;
  cacheYuan: number | null;
  cacheWriteYuan: number | null;
  listInputYuan: number | null;
  listOutputYuan: number | null;
  tags: string[];
  summary: string;
  badgeText: string;
  badgeTone: BadgeTone;
  referralMode: "inherit" | "custom";
  referralPercent: number | null;
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
    kind: row?.kind ?? "llm.chat",
    contextTokens: row?.contextTokens ?? 0,
    maxOutputTokens: row?.maxOutputTokens ?? 0,
    // 回落到统一价的模型在运营接口里单价就是 0：填回 0 保存，仍然是「按统一价」。
    inputYuan: row ? row.inputPrice / MICRO : 0,
    outputYuan: row ? row.outputPrice / MICRO : 0,
    cacheYuan: row ? row.cachePrice / MICRO : 0,
    cacheWriteYuan: row ? row.cacheWritePrice / MICRO : 0,
    listInputYuan: row ? row.listInputPrice / MICRO : 0,
    listOutputYuan: row ? row.listOutputPrice / MICRO : 0,
    tags: row?.tags ?? [],
    summary: row?.summary ?? "",
    badgeText: row?.badgeText ?? "",
    // 服务端在文案为空时把配色一起清掉，回到表单里要给个默认值，
    // 否则 Select 显示空白，存回去的也是空白。
    badgeTone: (BADGE_TONES.find((tone) => tone === row?.badgeTone) ?? "neutral") as BadgeTone,
    referralMode: row?.referralBps === undefined || row?.referralBps === null ? "inherit" : "custom",
    referralPercent: row?.referralBps === undefined || row?.referralBps === null ? null : row.referralBps / 100,
    listed: row?.listed ?? true,
    featured: row?.featured ?? false,
    sortOrder: row?.sortOrder ?? 0,
  };
}

/**
 * 模型目录：门户和使用端模型广场上列出来的模型，以及每个模型的分享返现比例。
 *
 * 返现怎么算：被邀请的人用积分买一个套餐，按「实付积分 × 套餐所绑模型的比例」返给邀请人。
 * 模型没单独设比例就走上面的默认比例；通用套餐（没绑模型）也走默认。「单独设成 0」是这个模型不返，
 * 和「走默认」不是一回事。比例改了只影响之后的购买，已经返过的每一笔都记着当时的比例。
 *
 * 保存是整行覆盖（和额度包一样），编辑框一律用当前值预填。
 * 这里的单价只管门户和广场上怎么展示；计费按 kind 统一定价，填了按模型的价、账单不跟着变。
 */
export function ModelCatalog() {
  const { t } = useLocale();
  const canWrite = useCanWrite();
  const [rows, setRows] = useState<GalaxyModelView[]>([]);
  const [settings, setSettings] = useState<ReferralSettingsView | null>(null);
  const [defaultPercent, setDefaultPercent] = useState<number | null>(0);
  const [loading, setLoading] = useState(true);
  const [savingDefault, setSavingDefault] = useState(false);
  const [editing, setEditing] = useState<GalaxyModelView | null>(null);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form] = Form.useForm<ModelForm>();
  const referralMode = Form.useWatch("referralMode", form);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [models, referral] = await Promise.all([fetchGalaxyModels(), fetchReferralSettings()]);
      setRows(models);
      setSettings(referral);
      setDefaultPercent(referral.defaultBps / 100);
    } catch (error) {
      message.error((error as Error).message || t("galaxy.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

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
        inputPrice: Math.round((values.inputYuan ?? 0) * MICRO),
        outputPrice: Math.round((values.outputYuan ?? 0) * MICRO),
        cachePrice: Math.round((values.cacheYuan ?? 0) * MICRO),
        cacheWritePrice: Math.round((values.cacheWriteYuan ?? 0) * MICRO),
        listInputPrice: Math.round((values.listInputYuan ?? 0) * MICRO),
        listOutputPrice: Math.round((values.listOutputYuan ?? 0) * MICRO),
        currency: "CNY",
        tags: values.tags ?? [],
        summary: values.summary?.trim() ?? "",
        badgeText: values.badgeText?.trim() ?? "",
        badgeTone: values.badgeTone ?? "neutral",
        referralBps: values.referralMode === "custom" ? Math.round((values.referralPercent ?? 0) * 100) : null,
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
      title: t("galaxy.model.prices"),
      key: "prices",
      width: 260,
      render: (_, row) =>
        row.inputPrice > 0 || row.outputPrice > 0 ? (
          <span className="manager-mono">
            {price(row.inputPrice)} / {price(row.outputPrice)} / {price(row.cachePrice)} / {price(row.cacheWritePrice)}
          </span>
        ) : (
          <Typography.Text type="secondary">{t("galaxy.model.unifiedPrice")}</Typography.Text>
        ),
    },
    {
      // 划线价单独一列，不并进上面那格：它是对外声明的**别人家的价**，
      // 和我们自己的四档混在一行，核对的时候第一眼分不清哪个是哪个。
      title: t("galaxy.model.listPrices"),
      key: "listPrices",
      width: 190,
      render: (_, row) =>
        row.listInputPrice > 0 || row.listOutputPrice > 0 ? (
          <Space size={6} wrap>
            <span className="manager-mono">
              {price(row.listInputPrice)} / {price(row.listOutputPrice)}
            </span>
            {/* 折扣是服务端按输出价算好的。填了官方价却显示「-」，
                多半是官方价没比自家价高 —— 让运营在这里就看见，而不是等卡片上少一块。 */}
            {row.discountBps > 0 ? <Tag color="green">{t("galaxy.model.discount").replace("{rate}", percent(row.discountBps))}</Tag> : <Typography.Text type="secondary">-</Typography.Text>}
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
      title: t("galaxy.model.referral"),
      dataIndex: "referralBps",
      width: 150,
      render: (value?: number) =>
        value === undefined || value === null ? (
          <Typography.Text type="secondary">
            {t("galaxy.model.referralInherit").replace("{rate}", percent(settings?.defaultBps ?? 0))}
          </Typography.Text>
        ) : (
          <Tag color={value > 0 ? "gold" : "default"}>{percent(value)}</Tag>
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
      width: 150,
      render: (_, row) =>
        canWrite ? (
          <Space size={8}>
            <Button size="small" onClick={() => edit(row)}>
              {t("galaxy.package.edit")}
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

      <Space>
        {canWrite ? (
          <Button type="primary" icon={<PlusOutlined />} onClick={() => edit(null)}>
            {t("galaxy.model.new")}
          </Button>
        ) : null}
        <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void load()}>
          {t("galaxy.refresh")}
        </Button>
      </Space>

      <Table<GalaxyModelView>
        rowKey="modelId"
        size="small"
        loading={loading}
        columns={columns}
        dataSource={rows}
        locale={{ emptyText: t("galaxy.model.empty") }}
        pagination={false}
        scroll={{ x: 1450 }}
      />

      <Modal
        open={open}
        title={editing ? t("galaxy.package.edit") : t("galaxy.model.new")}
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
            <Form.Item name="kind" label="kind" style={{ flex: 1 }}>
              <Input placeholder="llm.chat" />
            </Form.Item>
          </Space>

          <Form.Item label={t("galaxy.model.referral")} extra={t("galaxy.model.referralHint")}>
            <Space wrap>
              <Form.Item name="referralMode" noStyle>
                <Radio.Group>
                  <Radio value="inherit">{t("galaxy.model.referralInherit").replace("{rate}", percent(settings?.defaultBps ?? 0))}</Radio>
                  <Radio value="custom">{t("galaxy.model.referralCustom")}</Radio>
                </Radio.Group>
              </Form.Item>
              <Form.Item name="referralPercent" noStyle>
                <InputNumber min={0} max={100} precision={2} addonAfter="%" disabled={referralMode !== "custom"} style={{ width: 140 }} />
              </Form.Item>
            </Space>
          </Form.Item>

          {/* 四档摆成两行而不是并排四格：弹窗 760 宽，四格各剩 170 上下，
              「缓存写入单价 [____] ¥/1M」在中文下就已经贴边，切到英文直接换行。
              分两行还顺手把语义分了组 —— 上行是这次真正读进模型的新内容，下行是缓存。 */}
          <Space size={12} style={{ display: "flex" }} align="start">
            <Form.Item name="inputYuan" label={t("galaxy.model.inputPrice")} style={{ flex: 1 }}>
              <InputNumber style={{ width: "100%" }} min={0} precision={2} addonAfter="¥/1M" />
            </Form.Item>
            <Form.Item name="outputYuan" label={t("galaxy.model.outputPrice")} style={{ flex: 1 }}>
              <InputNumber style={{ width: "100%" }} min={0} precision={2} addonAfter="¥/1M" />
            </Form.Item>
          </Space>
          <Space size={12} style={{ display: "flex" }} align="start">
            <Form.Item name="cacheYuan" label={t("galaxy.model.cachePrice")} style={{ flex: 1 }}>
              <InputNumber style={{ width: "100%" }} min={0} precision={2} addonAfter="¥/1M" />
            </Form.Item>
            <Form.Item name="cacheWriteYuan" label={t("galaxy.model.cacheWritePrice")} style={{ flex: 1 }}>
              <InputNumber style={{ width: "100%" }} min={0} precision={2} addonAfter="¥/1M" />
            </Form.Item>
          </Space>
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
