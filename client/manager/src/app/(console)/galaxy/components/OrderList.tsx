"use client";

import { CheckCircleOutlined, ReloadOutlined, SearchOutlined } from "@ant-design/icons";
import { Alert, Badge, Button, Empty, Form, Input, Modal, Segmented, Space, Table, Tag, Typography, message } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useCallback, useEffect, useRef, useState } from "react";
import { useLocale } from "@/i18n/LocaleProvider";
import { useCanWrite } from "@/components/permission/WritePermission";
import { fetchOrders, payOrder, type AdminOrderPage, type AdminOrderView, type OrderStatus } from "../api/galaxy.api";

const PAGE_SIZE = 20;
/** 金额在库里是微分：除以它得到元。 */
const MICRO = 1_000_000;

const STATUS_COLOR: Record<string, string> = {
  pending: "warning",
  paid: "processing",
  fulfilled: "success",
  cancelled: "default",
};

/** 1.21M / 316k。token 这种大基数要一眼读出量级。 */
function compact(value: number): string {
  if (Math.abs(value) >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (Math.abs(value) >= 10_000) return `${Math.round(value / 1000)}k`;
  return value.toLocaleString("en-US");
}

/**
 * 订单。
 *
 * 「人工确认到账」这条接口（/orders/pay）一直都在，用来补线下转账和丢掉的渠道回调 ——
 * 但**从来没有地方列得出订单**：运营手上是一个渠道流水号，而那条接口要的是单号，
 * 中间没有桥。于是那两种补单场景实际上办不了，除非有人去库里 SELECT 一遍。
 *
 * 所以这一页的搜索认单号、认下单人，也**认流水号**。
 *
 * 状态是一条单行道：pending →（收到钱）paid →（发额度）fulfilled。确认到账做的是
 * 第一跳，随后由服务端接着履约；流水号同时是幂等键，同一个号补两次不会发两次额度。
 */
export function OrderList() {
  const { t } = useLocale();
  // 确认到账会真的把额度发出去，只读角色看不到入口。
  const canWrite = useCanWrite();
  const [status, setStatus] = useState<OrderStatus | "all">("pending");
  const [keyword, setKeyword] = useState("");
  const [pageIndex, setPageIndex] = useState(1);
  const [page, setPage] = useState<AdminOrderPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [target, setTarget] = useState<AdminOrderView | null>(null);
  const latest = useRef(0);

  const load = useCallback(async () => {
    const seq = ++latest.current;
    setLoading(true);
    try {
      const result = await fetchOrders({
        status: status === "all" ? "" : status,
        keyword,
        offset: (pageIndex - 1) * PAGE_SIZE,
        limit: PAGE_SIZE,
      });
      if (seq !== latest.current) return;
      setPage(result);
    } catch (error) {
      if (seq !== latest.current) return;
      message.error((error as Error).message || t("galaxy.loadFailed"));
    } finally {
      if (seq === latest.current) setLoading(false);
    }
  }, [status, keyword, pageIndex, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const pending = page?.counts?.pending ?? 0;

  const columns: ColumnsType<AdminOrderView> = [
    {
      title: t("galaxy.order.buyer"),
      dataIndex: "userId",
      width: 220,
      render: (userId: string, row) => (
        <Space direction="vertical" size={0}>
          <span style={{ fontWeight: 600 }}>{row.userName || userId}</span>
          <Typography.Text type="secondary" className="manager-mono" style={{ fontSize: 12 }}>
            {row.orderId}
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: t("galaxy.order.package"),
      dataIndex: "packageCode",
      width: 200,
      render: (packageCode: string, row) => (
        <Space direction="vertical" size={0}>
          <span>{packageCode || "-"}</span>
          {row.modelId ? (
            <Typography.Text type="secondary" className="manager-mono" style={{ fontSize: 12 }}>
              {row.modelId}
            </Typography.Text>
          ) : null}
        </Space>
      ),
    },
    {
      title: t("galaxy.order.units"),
      dataIndex: "units",
      width: 130,
      align: "right",
      // 头条只看输出 token：计费按它走，把输入加进来是一个谁都用不上的大数。
      render: (units: Record<string, number>) => {
        const value = units?.["llm.output_tokens"] ?? Object.values(units ?? {})[0] ?? 0;
        return <span className="manager-mono">{compact(value)}</span>;
      },
    },
    {
      title: t("galaxy.order.amount"),
      dataIndex: "amount",
      width: 130,
      align: "right",
      render: (amount: number, row) => (
        <Space direction="vertical" size={0} style={{ alignItems: "flex-end" }}>
          <span className="manager-mono">¥{(amount / MICRO).toFixed(2)}</span>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {t(`galaxy.order.payMethod.${row.payMethod || "channel"}`)}
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: t("galaxy.order.status"),
      dataIndex: "status",
      width: 105,
      render: (value: string) => <Tag color={STATUS_COLOR[value] ?? "default"}>{t(`galaxy.order.status.${value}`)}</Tag>,
    },
    {
      title: t("galaxy.order.createdAt"),
      dataIndex: "createdTime",
      width: 165,
      render: (value: string) => (value ? new Date(value).toLocaleString() : "-"),
    },
    {
      title: t("galaxy.actions"),
      key: "actions",
      width: 140,
      fixed: "right",
      render: (_, row) =>
        // 只有还没收到钱的单子要补。paid 之后由服务端接着履约，再点一次也只会被幂等挡回来。
        canWrite && row.status === "pending" ? (
          <Button type="link" size="small" icon={<CheckCircleOutlined />} onClick={() => setTarget(row)}>
            {t("galaxy.order.markPaid")}
          </Button>
        ) : null,
    },
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <Alert type="info" showIcon message={t("galaxy.order.hint")} />

      <Space wrap>
        <Segmented
          value={status}
          onChange={(value) => {
            setStatus(value as OrderStatus | "all");
            setPageIndex(1);
          }}
          options={[
            {
              value: "pending",
              label: (
                <Badge count={pending} size="small" offset={[8, -2]}>
                  {t("galaxy.order.status.pending")}
                </Badge>
              ),
            },
            { value: "paid", label: t("galaxy.order.status.paid") },
            { value: "fulfilled", label: t("galaxy.order.status.fulfilled") },
            { value: "cancelled", label: t("galaxy.order.status.cancelled") },
            { value: "all", label: t("galaxy.order.all") },
          ]}
        />
        {/* 补单时手上常常只有一个流水号，所以它也在搜索范围里。 */}
        <Input.Search
          allowClear
          style={{ width: 300 }}
          placeholder={t("galaxy.order.keyword")}
          enterButton={<SearchOutlined />}
          onSearch={(value) => {
            setKeyword(value.trim());
            setPageIndex(1);
          }}
        />
        <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void load()}>
          {t("galaxy.refresh")}
        </Button>
      </Space>

      <Table<AdminOrderView>
        rowKey="orderId"
        size="small"
        loading={loading}
        columns={columns}
        dataSource={page?.orders ?? []}
        scroll={{ x: 1190 }}
        pagination={{
          current: pageIndex,
          pageSize: PAGE_SIZE,
          total: page?.total ?? 0,
          showSizeChanger: false,
          onChange: setPageIndex,
        }}
        expandable={{
          rowExpandable: (row) => Boolean(row.paymentRef || row.keyId || row.targetKeyId),
          expandedRowRender: (row) => (
            <Space direction="vertical" size={4} style={{ width: "100%" }}>
              {row.paymentRef ? (
                <Typography.Text style={{ fontSize: 12 }}>
                  {`${t("galaxy.order.paymentRef")}：`}
                  <span className="manager-mono">{row.paymentRef}</span>
                </Typography.Text>
              ) : null}
              {row.keyId || row.targetKeyId ? (
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {`${row.targetKeyId ? t("galaxy.order.targetKey") : t("galaxy.order.issuedKey")}：`}
                  <span className="manager-mono">{row.targetKeyId || row.keyId}</span>
                </Typography.Text>
              ) : null}
            </Space>
          ),
        }}
        locale={{ emptyText: <Empty description={t("galaxy.order.empty")} /> }}
      />

      <MarkPaidModal order={target} onClose={() => setTarget(null)} onPaid={load} />
    </div>
  );
}

function MarkPaidModal({
  order,
  onClose,
  onPaid,
}: {
  order: AdminOrderView | null;
  onClose: () => void;
  onPaid: () => void;
}) {
  const { t } = useLocale();
  const [form] = Form.useForm<{ paymentRef: string }>();
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (order) form.setFieldsValue({ paymentRef: "" });
  }, [order, form]);

  const submit = async () => {
    if (!order) return;
    const values = await form.validateFields();
    setSubmitting(true);
    try {
      await payOrder(order.orderId, values.paymentRef.trim());
      message.success(t("galaxy.order.paid"));
      onClose();
      onPaid();
    } catch (error) {
      message.error((error as Error).message || t("galaxy.actionFailed"));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={order !== null}
      title={t("galaxy.order.markPaidTitle")}
      okText={t("galaxy.confirm")}
      cancelText={t("galaxy.cancel")}
      confirmLoading={submitting}
      onOk={() => void submit()}
      onCancel={onClose}
      destroyOnClose
    >
      <Alert
        type="warning"
        showIcon
        style={{ marginBottom: 16 }}
        message={t("galaxy.order.markPaidHint").replace("{amount}", ((order?.amount ?? 0) / MICRO).toFixed(2))}
      />
      <Form form={form} layout="vertical">
        {/* 流水号同时是幂等键：同一个号补两次不会发两次额度，所以它必填，也别随手编一个。 */}
        <Form.Item
          name="paymentRef"
          label={t("galaxy.order.paymentRef")}
          rules={[{ required: true, message: t("galaxy.order.paymentRefRequired") }]}
          extra={t("galaxy.order.paymentRefHint")}
        >
          <Input className="manager-mono" maxLength={128} placeholder={t("galaxy.order.paymentRefPlaceholder")} />
        </Form.Item>
      </Form>
    </Modal>
  );
}
