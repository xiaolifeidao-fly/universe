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
  Typography,
  message,
} from "antd";
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
  unit: string;
  /** 界面上按元填，提交时乘回微分。 */
  price: number;
  providerShare: number;
  effectiveFrom?: Dayjs | null;
};

/**
 * 价目表。
 *
 * **没有价可查时扣费与分成静默算 0** —— Usage 查不到单价就把 Cost 留成 0，
 * 不报错也不告警。于是「价目表是空的」这个故障只能从「钱一直对不上」反推，
 * 而在有这一页之前，唯一的填表方式是初始化命令里写死的那份默认价，或者手工 INSERT。
 *
 * 所以这一页做两件事：把价改得动，以及把**有用量却没有价**的单位直接摆在最上面。
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
      { title: t("galaxy.price.kind"), dataIndex: "kind", width: 170 },
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
        width: 170,
        render: (value: number, row) => (
          <Space direction="vertical" size={0} style={{ alignItems: "flex-end" }}>
            <span className="manager-mono">
              {row.currency === "CNY" ? "¥" : `${row.currency} `}
              {(value / MICRO).toLocaleString("en-US", { maximumFractionDigits: 6 })}
            </span>
            {/* 这里不能再写「元 / 百万」—— 上面已经有 ¥ 了，两个货币符号叠在一起读起来是两笔钱。 */}
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {t("galaxy.price.perMillionUnit")}
            </Typography.Text>
          </Space>
        ),
      },
      {
        title: t("galaxy.price.providerShare"),
        dataIndex: "providerShare",
        align: "right",
        width: 120,
        render: (value: number) => `${Math.round(value * 100)}%`,
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
                    await deletePrice({ kind: row.kind, unit: row.unit, effectiveFrom: row.effectiveFrom });
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
                    onClick={canWrite ? () => setEditing({ kind: row.kind, unit: row.unit, providerShare: 0.7 }) : undefined}
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
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setEditing({ providerShare: 0.7 })}>
            {t("galaxy.price.add")}
          </Button>
        ) : null}
        <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void load()}>
          {t("galaxy.refresh")}
        </Button>
      </Space>

      <Table<PriceView>
        rowKey={(row) => `${row.kind}:${row.unit}:${row.effectiveFrom}`}
        size="small"
        loading={loading}
        columns={columns}
        dataSource={prices}
        pagination={false}
        scroll={{ x: 1090 }}
        locale={{ emptyText: <Empty description={t("galaxy.price.empty")} /> }}
      />

      <PriceModal
        draft={editing}
        kinds={table?.kinds ?? []}
        units={table?.units ?? []}
        onClose={() => setEditing(null)}
        onSaved={load}
      />
    </div>
  );
}

function PriceModal({
  draft,
  kinds,
  units,
  onClose,
  onSaved,
}: {
  draft: Partial<PriceView> | null;
  kinds: string[];
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
      unit: draft.unit ?? "",
      price: (draft.price ?? 0) / MICRO,
      providerShare: draft.providerShare ?? 0.7,
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
        unit: values.unit.trim(),
        // 界面按元填，库里存微分。中间这一步乘法漏掉的话价格会差一百万倍。
        price: Math.round(values.price * MICRO),
        providerShare: values.providerShare,
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
          name="providerShare"
          label={t("galaxy.price.providerShare")}
          extra={t("galaxy.price.shareHint")}
          rules={[{ required: true }]}
        >
          <InputNumber min={0} max={1} step={0.05} style={{ width: "100%" }} />
        </Form.Item>
        <Form.Item name="effectiveFrom" label={t("galaxy.price.effectiveFrom")} extra={t("galaxy.price.effectiveFromHint")}>
          <DatePicker showTime style={{ width: "100%" }} />
        </Form.Item>
      </Form>
    </Modal>
  );
}
