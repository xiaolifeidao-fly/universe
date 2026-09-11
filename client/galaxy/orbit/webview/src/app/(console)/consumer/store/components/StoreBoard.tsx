"use client";

/**
 * 充值。「商品 → 额度包 → 充到哪把密钥」三栏一步到位。
 *
 * 下单和到账始终是两步，界面上却只有一步之差：
 *
 * - **沙箱渠道**背后没有收银台，下完单立刻调一次沙箱支付就到账，
 *   所以「支付」这一下看起来是一步完成的。它只在部署侧显式配了沙箱渠道时才出现，
 *   而且每一处都带着「沙箱」字样 —— 不标出来的话，运营会以为钱真的进来了。
 * - **真实渠道**下完单只能等渠道回调，界面停在「等待支付」，由回调把它推上去。
 *
 * 服务端那边履约是幂等的，所以重复点、回调重推都只会发一次额度。
 */

import { message } from "antd";
import { useCallback, useEffect, useMemo, useState } from "react";
import { PageHeader } from "@/components/shell/GalaxyShell";
import { IconBag, IconCard, IconChat, IconGpu, IconRefresh } from "@/components/ui/icons";
import { Btn, Card, CardHead, IconBtn, Loading, Note, Pill, Tabs } from "@/components/ui/kit";
import { useLocale } from "@/i18n/LocaleProvider";
import { formatCny, formatCompact, formatInt, unitLabel } from "@/utils/format";
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
import { SecretOnceModal } from "../../keys/components/SecretOnceModal";
import { OrderHistory } from "./OrderHistory";

const CATEGORIES = ["claude", "codex", "video"] as const;

const CATEGORY_ICONS = {
  claude: IconChat,
  codex: IconBag,
  video: IconGpu,
  other: IconCard,
} as const;

export function StoreBoard() {
  const { t } = useLocale();
  const [tab, setTab] = useState<"packages" | "orders">("packages");
  const [packages, setPackages] = useState<PackageView[]>([]);
  const [orders, setOrders] = useState<OrderView[]>([]);
  const [keys, setKeys] = useState<ConsumerKeyView[]>([]);
  const [notice, setNotice] = useState<NoticeStatus | null>(null);
  const [channels, setChannels] = useState<PaymentChannelView[]>([]);
  const [loading, setLoading] = useState(true);

  const [category, setCategory] = useState<string>("claude");
  const [picked, setPicked] = useState<string>("");
  const [target, setTarget] = useState<string>("");
  const [channel, setChannel] = useState<string>("");
  const [pending, setPending] = useState<OrderView | null>(null);
  const [busy, setBusy] = useState(false);
  const [issued, setIssued] = useState<IssuedKeyView | null>(null);

  const load = useCallback(async () => {
    try {
      const [packageList, orderList, keyList, noticeResult, channelList] = await Promise.all([
        fetchPackages(),
        fetchOrders(),
        fetchKeys(),
        fetchNotice(),
        // 渠道表是这一页里唯一可以缺席的东西：拿不到就退回「由平台确认到账」的
        // 老话术，额度包和订单照常显示。不兜住的话，一个还没更新的服务端
        // 会让整页空掉 —— 代价和它带来的信息完全不成比例。
        fetchPaymentChannels().catch(() => [] as PaymentChannelView[]),
      ]);
      setPackages(packageList);
      setOrders(orderList);
      setKeys(keyList);
      setNotice(noticeResult);
      setChannels(channelList);
      // 渠道表是部署侧定的，可能整个换掉。选中的那个不在了就退回第一个，
      // 否则下单会带着一个服务端不认识的渠道码过去。
      setChannel((current) => (channelList.some((item) => item.code === current) ? current : (channelList[0]?.code ?? "")));
    } catch (error) {
      message.error((error as Error).message || t("common.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  // 从密钥页点「续额」过来时带着 ?key=，直接把充值目标选好。
  //
  // 用 window.location 而不是 useSearchParams()：后者在 App Router 里要求外面
  // 套一层 <Suspense>，否则 next build 直接报错 —— 为一个可选的预填值付这个代价
  // 不值当。读一次就够，之后目标由用户自己选。
  useEffect(() => {
    const preset = new URLSearchParams(window.location.search).get("key");
    if (preset) setTarget(preset);
  }, []);

  const grouped = useMemo(() => {
    const map = new Map<string, PackageView[]>();
    for (const item of packages) {
      const list = map.get(item.category) ?? [];
      list.push(item);
      map.set(item.category, list);
    }
    return map;
  }, [packages]);

  // 商品栏默认落在真的有货的那一类上，而不是死写 claude ——
  // 只上架了 codex 包的部署会看到一个空栏，还得自己点一下才发现东西在隔壁。
  useEffect(() => {
    if (grouped.size === 0 || grouped.has(category)) return;
    setCategory(Array.from(grouped.keys())[0]);
  }, [category, grouped]);

  const shown = grouped.get(category) ?? [];
  const chosen = shown.find((item) => item.packageCode === picked) ?? shown[0] ?? null;
  const chosenChannel = channels.find((item) => item.code === channel);

  /** 履约签发出新密钥的那一次，明文只在这个响应里出现一次，必须立刻弹出来。 */
  const revealSecret = (order: OrderView) => {
    if (!order.issuedSecret) return;
    setIssued({ keyId: order.keyId, secret: order.issuedSecret, alias: order.packageCode, expiresAt: "" });
  };

  const submit = async () => {
    if (!chosen || !notice) return;
    setBusy(true);
    try {
      const order = await createOrder(chosen.packageCode, target, notice.version);
      if (chosenChannel?.sandbox) {
        // 沙箱背后没有收银台，下单之后马上把这一单付掉，用户看到的就是「买完即到账」。
        const paid = await paySandbox(order.orderId, chosenChannel.code);
        message.success(t("store.paid"));
        revealSecret(paid);
        setPending(null);
      } else {
        // 真渠道到这里就结束了：状态停在待支付，等渠道回调把它推上去。
        message.success(t(chosenChannel ? "store.awaiting" : "store.ordered"));
        setPending(order);
        // 没接渠道的部署里，管理员可能已经确认过到账，那就同样立刻弹明文。
        revealSecret(order);
      }
      await load();
    } catch (error) {
      message.error((error as Error).message || t("common.actionFailed"));
    } finally {
      setBusy(false);
    }
  };

  const abandon = async (order: OrderView) => {
    try {
      await cancelOrder(order.orderId);
      message.success(t("store.cancelled"));
      setPending(null);
      await load();
    } catch (error) {
      message.error((error as Error).message || t("common.actionFailed"));
    }
  };

  if (loading) {
    return (
      <>
        <PageHeader title={t("store.title")} meta={t("store.subtitle")} />
        <div className="gx-body">
          <Loading />
        </div>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title={t("store.title")}
        meta={t("store.subtitle")}
        actions={
          <>
            <Tabs
              value={tab}
              onChange={setTab}
              options={[
                { value: "packages" as const, label: t("store.tab.packages") },
                { value: "orders" as const, label: t("store.tab.orders") },
              ]}
            />
            <IconBtn label={t("common.refresh")} onClick={() => void load()}>
              <IconRefresh size={17} />
            </IconBtn>
          </>
        }
      />

      {tab === "orders" ? (
        <OrderHistory
          orders={orders}
          keys={keys}
          channels={channels}
          onPay={async (order) => {
            const sandbox = channels.find((item) => item.sandbox);
            if (!sandbox) {
              setPending(order);
              setTab("packages");
              return;
            }
            try {
              const paid = await paySandbox(order.orderId, sandbox.code);
              message.success(t("store.paid"));
              revealSecret(paid);
              await load();
            } catch (error) {
              message.error((error as Error).message || t("common.actionFailed"));
            }
          }}
          onCancel={(order) => void abandon(order)}
        />
      ) : (
        <div className="gx-body">
          <div style={{ display: "grid", gridTemplateColumns: "200px minmax(0, 1fr) 340px", gap: 14, alignItems: "start" }}>
            <Card className="gx-rise">
              <CardHead title={t("store.category")} />
              <div style={{ padding: "0 10px 14px", display: "flex", flexDirection: "column", gap: 2 }}>
                {CATEGORIES.filter((item) => grouped.has(item) || item === "video").map((item) => {
                  const Icon = CATEGORY_ICONS[item];
                  const count = grouped.get(item)?.length ?? 0;
                  return (
                    <button
                      key={item}
                      type="button"
                      className={`gx-nav${item === category ? " is-active" : ""}`}
                      disabled={count === 0}
                      style={count === 0 ? { opacity: 0.5, cursor: "default" } : undefined}
                      onClick={() => {
                        setCategory(item);
                        setPicked("");
                      }}
                    >
                      <Icon size={17} />
                      <span>{t(`store.category.${item}`)}</span>
                      {count === 0 ? <span className="gx-nav__badge">{t("store.comingSoon")}</span> : null}
                    </button>
                  );
                })}
                {grouped.has("other") ? (
                  <button
                    type="button"
                    className={`gx-nav${category === "other" ? " is-active" : ""}`}
                    onClick={() => {
                      setCategory("other");
                      setPicked("");
                    }}
                  >
                    <IconCard size={17} />
                    <span>{t("store.category.other")}</span>
                  </button>
                ) : null}
                <div style={{ padding: "10px 12px 0" }}>
                  <span className="gx-card__hint">{t("store.categoryHint")}</span>
                </div>
              </div>
            </Card>

            <Card className="gx-rise gx-rise--1">
              {/* 计费规则整段放在页脚那条提示里，标题旁只留一句能一眼看完的 ——
                  同一段话在一屏里出现两次，读者会以为自己看错了地方。 */}
              <CardHead title={t("store.packages", { category: t(`store.category.${category}`) })} hint={t("store.billing")} />
              <div style={{ padding: "0 18px 18px", display: "grid", gap: 12 }}>
                {shown.length === 0 ? (
                  <span className="gx-card__hint">{t("store.packagesEmpty")}</span>
                ) : (
                  shown.map((item) => (
                    <PackageRow
                      key={item.packageCode}
                      item={item}
                      best={bestValue(shown) === item.packageCode}
                      active={chosen?.packageCode === item.packageCode}
                      onPick={() => setPicked(item.packageCode)}
                    />
                  ))
                )}
              </div>
            </Card>

            <Card className="gx-rise gx-rise--2">
              <CardHead title={t("store.confirm")} />
              <div style={{ padding: "0 18px 18px", display: "flex", flexDirection: "column", gap: 16 }}>
                {pending ? (
                  <PendingPayment
                    order={pending}
                    channel={chosenChannel}
                    onCancel={() => void abandon(pending)}
                    onSwitch={() => setPending(null)}
                  />
                ) : (
                  <>
                    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                      <span className="gx-label">{t("store.target")}</span>
                      <select className="gx-input" value={target} onChange={(event) => setTarget(event.target.value)}>
                        <option value="">{t("store.targetNew")}</option>
                        {keys.map((key) => (
                          <option key={key.keyId} value={key.keyId}>
                            {key.alias || key.keyId}
                          </option>
                        ))}
                      </select>
                      {keys.length === 0 ? <span className="gx-card__hint">{t("store.emptyKeys")}</span> : null}
                    </div>

                    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                      <span className="gx-label">{t("store.channel")}</span>
                      {channels.length === 0 ? (
                        <span className="gx-card__hint">{t("store.channelEmpty")}</span>
                      ) : (
                        channels.map((item) => (
                          <label
                            key={item.code}
                            style={{
                              display: "flex",
                              alignItems: "flex-start",
                              gap: 10,
                              padding: "10px 12px",
                              borderRadius: 10,
                              border: `1px solid ${item.code === channel ? "var(--gx-accent)" : "var(--gx-line)"}`,
                              cursor: "pointer",
                              fontSize: 13,
                            }}
                          >
                            <input
                              type="radio"
                              name="channel"
                              checked={item.code === channel}
                              onChange={() => setChannel(item.code)}
                              style={{ accentColor: "var(--gx-accent)", marginTop: 3 }}
                            />
                            {/*
                              渠道名和沙箱标记上下排，不并排。
                              并排时标记的宽度由文案长度决定（英文「Sandbox · no real money」
                              比中文长一截），会把 flex:1 的渠道名挤到只剩几个像素宽 ——
                              中文能逐字换行，于是「支付宝（沙箱）」竖着掉下来。
                            */}
                            <span style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 0, flex: 1 }}>
                              <span>{item.title}</span>
                              {/* 沙箱一律带标记。一个「点一下就到账」的渠道混在真渠道里
                                  而不标出来，运营看着订单变成已到账，会以为钱进来了。 */}
                              {item.sandbox ? (
                                <span>
                                  <Pill tone="warn">{t("store.channelSandbox")}</Pill>
                                </span>
                              ) : null}
                            </span>
                          </label>
                        ))
                      )}
                    </div>

                    {chosen ? (
                      <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: "12px 14px", borderRadius: 10, background: "var(--gx-muted)" }}>
                        <Line label={`${chosen.title} × 1`} value={formatCny(chosen.amount)} />
                        <Line
                          label={t("store.getsUnits")}
                          value={Object.entries(chosen.units ?? {})
                            .map(([unit, value]) => `${formatCompact(value)} ${unitLabel(unit, t)}`)
                            .join(" · ")}
                        />
                        <div style={{ height: 1, background: "var(--gx-line)", margin: "4px 0" }} />
                        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between" }}>
                          <span style={{ fontSize: 12.5, color: "var(--gx-soft)" }}>{t("store.total")}</span>
                          <span className="gx-serif" style={{ fontSize: 26 }}>
                            {formatCny(chosen.amount)}
                          </span>
                        </div>
                      </div>
                    ) : null}

                    <Btn
                      tone="accent"
                      loading={busy}
                      disabled={!chosen || !notice?.accepted}
                      onClick={() => void submit()}
                    >
                      {t(chosenChannel?.sandbox ? "store.paySandbox" : "store.pay")}
                    </Btn>
                    {!notice?.accepted ? (
                      <Note tone="warn">{t("notice.body")}</Note>
                    ) : (
                      <span className="gx-card__hint" style={{ textAlign: "center" }}>
                        {t("store.terms")} {notice?.version}
                      </span>
                    )}
                  </>
                )}
              </div>
            </Card>
          </div>

          <Note>{t("store.billingBody")}</Note>
        </div>
      )}

      <SecretOnceModal issued={issued} onClose={() => setIssued(null)} />
    </>
  );
}

function PackageRow({
  item,
  best,
  active,
  onPick,
}: {
  item: PackageView;
  best: boolean;
  active: boolean;
  onPick: () => void;
}) {
  const { t } = useLocale();
  const tokens = item.units["llm.output_tokens"] ?? Object.values(item.units ?? {})[0] ?? 0;
  return (
    <button
      type="button"
      onClick={onPick}
      style={{
        display: "grid",
        gridTemplateColumns: "1fr auto",
        alignItems: "center",
        gap: 16,
        padding: "16px 18px",
        borderRadius: 12,
        border: `1px solid ${active ? "var(--gx-accent)" : "var(--gx-line)"}`,
        background: active ? "var(--gx-accent-soft)" : "var(--gx-surface)",
        cursor: "pointer",
        font: "inherit",
        color: "inherit",
        textAlign: "left",
      }}
    >
      <span>
        <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 14, fontWeight: 600 }}>{item.title}</span>
          {best ? <Pill tone="accent">{t("store.best")}</Pill> : null}
        </span>
        <span className="gx-mono" style={{ display: "block", fontSize: 12, color: "var(--gx-faint)", marginTop: 4 }}>
          {formatInt(tokens)} tokens ·{" "}
          {t("store.priceHint", { price: perMillion(item.amount, tokens), days: item.ttlDays })}
        </span>
      </span>
      <span className="gx-serif" style={{ fontSize: 30, lineHeight: 1 }}>
        {formatCny(item.amount)}
      </span>
    </button>
  );
}

function PendingPayment({
  order,
  channel,
  onCancel,
  onSwitch,
}: {
  order: OrderView;
  channel?: PaymentChannelView;
  onCancel: () => void;
  onSwitch: () => void;
}) {
  const { t } = useLocale();
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14, alignItems: "center", textAlign: "center" }}>
      <span className="gx-label">{channel?.title ?? t("store.channel")}</span>
      <span className="gx-serif" style={{ fontSize: 34, lineHeight: 1 }}>
        {formatCny(order.amount)}
      </span>
      <span className="gx-card__hint">{t("store.awaitingOrder", { order: order.orderId })}</span>
      {/*
        真渠道的收银台由渠道自己出（扫码页、跳转页）。平台这一侧只知道
        「这单还没付」，所以这里不画一个假的二维码 —— 画了会让人对着它扫。
      */}
      <div
        style={{
          width: "100%",
          padding: "22px 16px",
          borderRadius: 12,
          border: "1px dashed var(--gx-border)",
          background: "var(--gx-muted)",
          fontSize: 12.5,
          lineHeight: 1.7,
          color: "var(--gx-soft)",
        }}
      >
        {t("store.awaiting")}
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <Btn tone="ghost" small onClick={onSwitch}>
          {t("store.switchChannel")}
        </Btn>
        <Btn tone="danger" small onClick={onCancel}>
          {t("store.cancelOrder")}
        </Btn>
      </div>
    </div>
  );
}

/**
 * 明细里的一行。
 *
 * 标签固定宽度不换行、值靠右换行 —— 两边都可伸缩的话，值一长（「1.00M 输入
 * token · 1.00M 输出 token」）就会把标签也挤散，「You get」被折成两行。
 */
function Line({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 12, fontSize: 12.5, color: "var(--gx-soft)" }}>
      <span style={{ flex: "0 0 auto", whiteSpace: "nowrap" }}>{label}</span>
      <span className="gx-mono" style={{ minWidth: 0, textAlign: "right" }}>
        {value}
      </span>
    </div>
  );
}

/** 每百万 token 多少钱。用它挑「最划算」，而不是挑最便宜的那个包。 */
function unitPrice(item: PackageView): number {
  const tokens = item.units["llm.output_tokens"] ?? Object.values(item.units ?? {})[0] ?? 0;
  return tokens > 0 ? item.amount / tokens : Number.POSITIVE_INFINITY;
}

function bestValue(items: PackageView[]): string {
  if (items.length === 0) return "";
  return items.reduce((best, item) => (unitPrice(item) < unitPrice(best) ? item : best)).packageCode;
}

function perMillion(amount: number, tokens: number): string {
  if (tokens <= 0) return "-";
  return formatCny((amount / tokens) * 1_000_000);
}
