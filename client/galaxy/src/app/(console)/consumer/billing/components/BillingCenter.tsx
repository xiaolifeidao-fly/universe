"use client";

import { ReloadOutlined, ShoppingCartOutlined } from "@ant-design/icons";
import { Alert, Button, Empty, Modal, Popconfirm, Radio, Select, Space, Spin, Table, Tag, message } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useCallback, useEffect, useState } from "react";
import { useLocale } from "@/i18n/LocaleProvider";
import { formatMoney, formatTime, formatUnitValue, unitLabel } from "@/utils/format";
import { SecretOnceModal } from "../../keys/components/SecretOnceModal";
import {
  cancelOrder,
  createOrder,
  fetchKeys,
  fetchNotice,
  fetchOrders,
  fetchPackages,
  fetchPaymentChannels,
  paySandbox,
  type ConsumerKeyView,
  type IssuedKeyView,
  type NoticeStatus,
  type OrderView,
  type PackageView,
  type PaymentChannelView,
} from "../../api/consumer.api";

const ORDER_STATUS: Record<string, { color: string; key: string }> = {
  pending: { color: "processing", key: "consumer.billing.orderStatus.pending" },
  paid: { color: "warning", key: "consumer.billing.orderStatus.paid" },
  fulfilled: { color: "success", key: "consumer.billing.orderStatus.fulfilled" },
  cancelled: { color: "default", key: "consumer.billing.orderStatus.cancelled" },
};

/**
 * 额度与订单。
 *
 * 下单和到账始终是两步，界面上却只有一步之差：
 *
 * - **沙箱渠道**（`sandbox: true`）背后没有收银台，下完单立刻调一次沙箱支付就到账了，
 *   所以「购买」这一下看起来是一步完成的。它只在部署侧显式配了沙箱渠道时才出现，
 *   而且每一处都带着「沙箱」字样 —— 不标出来的话，运营会以为钱真的进来了。
 * - **真实渠道**下完单只能等渠道回调，界面停在「待支付」，由回调把它推到已到账。
 *
 * 服务端那边履约是幂等的，所以重复点、回调重推都只会发一次额度。
 */
export function BillingCenter() {
  const { t } = useLocale();
  const [packages, setPackages] = useState<PackageView[]>([]);
  const [orders, setOrders] = useState<OrderView[]>([]);
  const [keys, setKeys] = useState<ConsumerKeyView[]>([]);
  const [notice, setNotice] = useState<NoticeStatus | null>(null);
  const [channels, setChannels] = useState<PaymentChannelView[]>([]);
  const [loading, setLoading] = useState(true);

  const [buying, setBuying] = useState<PackageView | null>(null);
  const [target, setTarget] = useState<string>("");
  const [channel, setChannel] = useState<string>("");
  const [submitting, setSubmitting] = useState(false);
  const [paying, setPaying] = useState<string>("");
  const [issued, setIssued] = useState<IssuedKeyView | null>(null);

  const chosen = channels.find((item) => item.code === channel);
  // 有沙箱渠道，未支付的订单才补得上「去支付」；真实渠道的到账只能等回调。
  const sandbox = channels.find((item) => item.sandbox);

  const load = useCallback(async () => {
    try {
      const [packageList, orderList, keyList, noticeResult, channelList] = await Promise.all([
        fetchPackages(),
        fetchOrders(),
        fetchKeys(),
        fetchNotice(),
        // 渠道表是这一页里唯一可以缺席的东西：拿不到就退回「由平台确认到账」的
        // 老话术，额度包和订单照常显示。放进 Promise.all 不兜住的话，
        // 一个还没更新的服务端会让整页空掉 —— 代价和它带来的信息完全不成比例。
        fetchPaymentChannels().catch(() => [] as PaymentChannelView[]),
      ]);
      setPackages(packageList);
      setOrders(orderList);
      setKeys(keyList);
      setNotice(noticeResult);
      setChannels(channelList);
      // 渠道表是部署侧定的，可能整个换掉。选中的那个不在了就退回第一个，
      // 否则下单会带着一个服务端不认识的渠道码过去。
      setChannel((current) =>
        channelList.some((item) => item.code === current) ? current : (channelList[0]?.code ?? ""),
      );
    } catch (error) {
      message.error((error as Error).message || t("common.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  /** 履约签发出新密钥的那一次，明文只在这个响应里出现一次，必须立刻弹出来。 */
  const revealSecret = (order: OrderView) => {
    if (!order.issuedSecret) return;
    setIssued({ keyId: order.keyId, secret: order.issuedSecret, alias: order.packageCode, expiresAt: "" });
  };

  const submit = async () => {
    if (!buying || !notice) return;
    setSubmitting(true);
    try {
      const order = await createOrder(buying.packageCode, target, notice.version);
      // 沙箱渠道背后没有收银台，下单之后马上把这一单付掉，用户看到的就是「买完即到账」。
      // 真实渠道到这里就结束了：状态停在待支付，等渠道回调把它推上去。
      if (chosen?.sandbox) {
        const paid = await paySandbox(order.orderId, chosen.code);
        message.success(t("consumer.billing.paid"));
        revealSecret(paid);
      } else {
        message.success(t(chosen ? "consumer.billing.awaitCallback" : "consumer.billing.ordered"));
        // 没接渠道的部署里，管理员可能已经确认过到账，那就同样立刻弹明文。
        revealSecret(order);
      }
      setBuying(null);
      setTarget("");
      void load();
    } catch (error) {
      message.error((error as Error).message || t("common.loadFailed"));
    } finally {
      setSubmitting(false);
    }
  };

  /** 补付一张已经躺在列表里的待支付订单。只有配了沙箱渠道时才出现。 */
  const pay = async (order: OrderView) => {
    if (!sandbox) return;
    setPaying(order.orderId);
    try {
      const paid = await paySandbox(order.orderId, sandbox.code);
      message.success(t("consumer.billing.paid"));
      revealSecret(paid);
      void load();
    } catch (error) {
      message.error((error as Error).message || t("common.loadFailed"));
    } finally {
      setPaying("");
    }
  };

  const cancel = async (orderId: string) => {
    try {
      await cancelOrder(orderId);
      message.success(t("consumer.billing.cancelled"));
      void load();
    } catch (error) {
      message.error((error as Error).message || t("common.loadFailed"));
    }
  };

  const orderColumns: ColumnsType<OrderView> = [
    { title: t("consumer.billing.packages"), dataIndex: "packageCode", width: 160 },
    {
      title: t("consumer.usage.amount"),
      dataIndex: "units",
      render: (units: Record<string, number>) => (
        <Space size={12} wrap>
          {Object.entries(units ?? {}).map(([unit, value]) => (
            <span key={unit} style={{ color: "var(--manager-text-muted)" }}>
              {unitLabel(unit)} <b style={{ color: "var(--manager-text)" }}>{formatUnitValue(unit, value)}</b>
            </span>
          ))}
        </Space>
      ),
    },
    {
      title: t("consumer.usage.cost"),
      dataIndex: "amount",
      width: 120,
      render: (amount: number, row) => formatMoney(amount, row.currency),
    },
    {
      title: t("common.status"),
      dataIndex: "status",
      width: 120,
      render: (status: string) => {
        const tag = ORDER_STATUS[status] ?? { color: "default", key: "common.empty" };
        return <Tag color={tag.color}>{t(tag.key)}</Tag>;
      },
    },
    { title: t("common.createdAt"), dataIndex: "createdTime", width: 190, render: (value: string) => formatTime(value) },
    {
      title: t("common.actions"),
      key: "actions",
      width: sandbox ? 190 : 120,
      render: (_, row) =>
        row.status === "pending" ? (
          <Space size={8}>
            {sandbox ? (
              // 确认框里把「付多少、走哪个渠道」摆出来。沙箱不扣真钱，但它会真的
              // 发额度、真的签出一把密钥，所以不做成点一下就走的按钮。
              <Popconfirm
                title={`${t("consumer.billing.pay")} ${formatMoney(row.amount, row.currency)}`}
                description={`${sandbox.title} · ${t("consumer.billing.sandboxHint")}`}
                okText={t("consumer.billing.paySandbox")}
                cancelText={t("common.cancel")}
                onConfirm={() => void pay(row)}
              >
                <Button size="small" type="primary" loading={paying === row.orderId}>
                  {t("consumer.billing.pay")}
                </Button>
              </Popconfirm>
            ) : null}
            <Button size="small" danger onClick={() => void cancel(row.orderId)}>
              {t("consumer.billing.cancel")}
            </Button>
          </Space>
        ) : null,
    },
  ];

  if (loading) {
    return (
      <div style={{ padding: 60, display: "grid", placeItems: "center" }}>
        <Spin />
      </div>
    );
  }

  return (
    <div className="galaxy-page">
      <section className="galaxy-card">
        <div className="galaxy-card__head">
          <div style={{ flex: 1, minWidth: 0 }}>
            <h2>{t("consumer.billing.packages")}</h2>
            <p>{t(channels.length === 0 ? "consumer.billing.payHint" : "consumer.billing.channelHint")}</p>
          </div>
          <Button icon={<ReloadOutlined />} onClick={() => void load()}>
            {t("common.refresh")}
          </Button>
        </div>

        {notice && !notice.accepted ? (
          <Alert type="warning" showIcon message={t("consumer.keys.notice")} style={{ marginBottom: 14 }} />
        ) : null}

        {packages.length === 0 ? (
          <Empty description={t("consumer.billing.packagesEmpty")} />
        ) : (
          <div className="galaxy-grid">
            {packages.map((item) => (
              <div className="galaxy-contribution" key={item.packageCode}>
                <div className="galaxy-contribution__title">
                  <strong>{item.title}</strong>
                  <span style={{ flex: 1 }} />
                  <b style={{ fontSize: 18 }}>{formatMoney(item.amount, item.currency)}</b>
                </div>
                <div className="galaxy-meta">
                  {Object.entries(item.units ?? {}).map(([unit, value]) => (
                    <span key={unit}>
                      {unitLabel(unit)} <b>{formatUnitValue(unit, value)}</b>
                    </span>
                  ))}
                </div>
                <div className="galaxy-meta">
                  <span>
                    {t("consumer.keys.expiresAt")} <b>{item.ttlDays}d</b>
                  </span>
                  <span>
                    {t("consumer.keys.concurrency")}{" "}
                    <b>
                      {item.concurrency} / {item.rpm}
                    </b>
                  </span>
                </div>
                <Button
                  type="primary"
                  icon={<ShoppingCartOutlined />}
                  disabled={!notice?.accepted}
                  onClick={() => setBuying(item)}
                >
                  {t("consumer.billing.buy")}
                </Button>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="galaxy-card">
        <div className="galaxy-card__head">
          <div style={{ flex: 1, minWidth: 0 }}>
            <h2>{t("consumer.billing.orders")}</h2>
          </div>
        </div>
        <Table<OrderView>
          rowKey="orderId"
          size="small"
          columns={orderColumns}
          dataSource={orders}
          locale={{ emptyText: t("consumer.billing.ordersEmpty") }}
          pagination={{ pageSize: 10, showSizeChanger: false }}
          scroll={{ x: 900 }}
        />
      </section>

      <Modal
        open={Boolean(buying)}
        title={buying?.title}
        okText={t(chosen?.sandbox ? "consumer.billing.paySandbox" : "consumer.billing.buy")}
        cancelText={t("common.cancel")}
        confirmLoading={submitting}
        onCancel={() => setBuying(null)}
        onOk={() => void submit()}
      >
        {/* 充值到已有密钥 vs 签发新密钥：前者不换明文，后者要重新保存一次 */}
        <Radio.Group
          value={target ? "existing" : "new"}
          onChange={(event) => setTarget(event.target.value === "new" ? "" : (keys[0]?.keyId ?? ""))}
          style={{ marginBottom: 12 }}
        >
          <Radio.Button value="new">{t("consumer.billing.buyNew")}</Radio.Button>
          <Radio.Button value="existing" disabled={keys.length === 0}>
            {t("consumer.billing.buyInto")}
          </Radio.Button>
        </Radio.Group>
        {target ? (
          <Select
            value={target}
            style={{ width: "100%" }}
            onChange={(value) => setTarget(value)}
            options={keys.map((key) => ({ value: key.keyId, label: `${key.alias || key.keyId}` }))}
          />
        ) : null}

        {channels.length > 0 ? (
          <div style={{ marginTop: 16 }}>
            <div style={{ marginBottom: 8, color: "var(--manager-text-muted)" }}>
              {t("consumer.billing.channel")}
            </div>
            {/* 沙箱一律带标记。一个「点一下就到账」的渠道混在真渠道里而不标出来，
                运营看着订单变成已到账，会以为钱进来了。 */}
            <Radio.Group value={channel} onChange={(event) => setChannel(event.target.value)}>
              <Space direction="vertical" size={6}>
                {channels.map((item) => (
                  <Radio key={item.code} value={item.code}>
                    {item.title}
                    {item.sandbox ? (
                      <Tag color="warning" style={{ marginLeft: 8 }}>
                        {t("consumer.billing.channelSandbox")}
                      </Tag>
                    ) : null}
                  </Radio>
                ))}
              </Space>
            </Radio.Group>
          </div>
        ) : null}

        <p style={{ marginTop: 12, marginBottom: 0, color: "var(--manager-text-muted)" }}>
          {t(
            channels.length === 0
              ? "consumer.billing.payHint"
              : chosen?.sandbox
                ? "consumer.billing.sandboxHint"
                : "consumer.billing.channelHint",
          )}
        </p>
      </Modal>

      <SecretOnceModal issued={issued} onClose={() => setIssued(null)} />
    </div>
  );
}
