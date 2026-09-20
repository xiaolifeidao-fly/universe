"use client";

import { ReloadOutlined, SearchOutlined } from "@ant-design/icons";
import { Alert, Badge, Button, Empty, Input, Segmented, Space, Table, Tag, Typography, message } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useCallback, useEffect, useRef, useState } from "react";
import { useLocale } from "@/i18n/LocaleProvider";
import { fetchOrders, type AdminOrderPage, type AdminOrderView, type OrderStatus } from "../api/galaxy.api";

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
 * 订单：**只读的历史**。
 *
 * 额度包已经下架，不会再有新订单 —— 使用端不下单，也没有支付渠道可确认。
 * 这一页留着是因为库里还有买过的记录：运营要答得出「这个人当初买的是什么、
 * 花了多少、发到哪把密钥上」。
 *
 * 搜索认单号、认下单人，也认流水号 —— 运营手上常常只有渠道那边的一串号。
 */
export function OrderList() {
  const { t } = useLocale();
  const [status, setStatus] = useState<OrderStatus | "all">("all");
  const [keyword, setKeyword] = useState("");
  const [pageIndex, setPageIndex] = useState(1);
  const [page, setPage] = useState<AdminOrderPage | null>(null);
  const [loading, setLoading] = useState(true);
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

    </div>
  );
}
