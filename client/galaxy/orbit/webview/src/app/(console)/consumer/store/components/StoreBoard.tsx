"use client";

/**
 * 购买：用积分买套餐。「类别 → 套餐 → 充到哪把密钥」三栏一步到位。
 *
 * 钱不在这一页进来：积分由平台运营充值（线下付款之后），这里只花。积分不够时
 * 停在这一页把差多少、找谁充说清楚，而不是让人点下去再收一个报错。
 *
 * 扣积分、签发或充值在服务端是同一个事务，发不出去就连积分一起回滚，
 * 所以这一页没有「已扣款、待发货」这种中间态要展示。
 */

import { message } from "antd";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PageHeader } from "@/components/shell/GalaxyShell";
import { IconBag, IconCard, IconChat, IconGpu, IconRefresh } from "@/components/ui/icons";
import { Btn, Card, CardHead, IconBtn, Loading, Note, Pill, Tabs } from "@/components/ui/kit";
import { useLocale } from "@/i18n/LocaleProvider";
import { formatInt, formatPoints, formatQuota, unitLabel } from "@/utils/format";
import {
  fetchCatalog,
  fetchKeys,
  fetchNotice,
  fetchOrders,
  fetchPoints,
  purchaseWithPoints,
  type ConsumerCatalog,
  type ConsumerKeyView,
  type IssuedKeyView,
  type NoticeStatus,
  type OrderView,
  type PackageView,
  type PointsSummary,
} from "../../api/consumer.api";
import { rememberKeySecret } from "../../api/keyvault.api";
import { IssuedKeyModal } from "../../keys/components/IssuedKeyModal";
import { OrderHistory } from "./OrderHistory";

const CATEGORIES = ["claude", "codex", "video", "other"] as const;

const CATEGORY_ICONS = {
  claude: IconChat,
  codex: IconBag,
  video: IconGpu,
  other: IconCard,
} as const;

/** 每一单一个请求号：点两下、超时重试都只扣一次积分，服务端按它认出是同一单。http 下没有 crypto.randomUUID。 */
function newRequestId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/** 只能充进还能用的密钥：给一把过期或冻结的密钥加额度，加完也用不了。 */
function isUsable(key: ConsumerKeyView, now: number): boolean {
  if (key.status !== "active") return false;
  const expires = Date.parse(key.expiresAt);
  return Number.isNaN(expires) || expires > now;
}

export function StoreBoard() {
  const { t } = useLocale();
  const router = useRouter();
  const [tab, setTab] = useState<"packages" | "orders">("packages");
  const [catalog, setCatalog] = useState<ConsumerCatalog | null>(null);
  const [orders, setOrders] = useState<OrderView[]>([]);
  const [keys, setKeys] = useState<ConsumerKeyView[]>([]);
  const [notice, setNotice] = useState<NoticeStatus | null>(null);
  const [points, setPoints] = useState<PointsSummary | null>(null);
  const [loading, setLoading] = useState(true);

  const [category, setCategory] = useState<string>("claude");
  const [picked, setPicked] = useState<string>("");
  const [target, setTarget] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [issued, setIssued] = useState<IssuedKeyView | null>(null);
  // 这把新密钥有没有存进本机保险箱。存不下就得让用户当场自己存一份。
  const [issuedSaved, setIssuedSaved] = useState(false);
  // 这一单的请求号。买成了才换新的：失败的那次事务整个回滚了，原样重试不会被当成重复。
  const requestId = useRef(newRequestId());

  const load = useCallback(async () => {
    try {
      const [catalogResult, orderList, keyList, noticeResult, pointsResult] = await Promise.all([
        fetchCatalog(),
        fetchOrders(),
        fetchKeys(),
        fetchNotice(),
        fetchPoints(),
      ]);
      setCatalog(catalogResult);
      setOrders(orderList);
      setKeys(keyList);
      setNotice(noticeResult);
      setPoints(pointsResult);
    } catch (error) {
      message.error((error as Error).message || t("common.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  /** 广场上的套餐挂在模型下面，这一页按类别平铺，所以先摊平；模型名留着给套餐行用。 */
  const { packages, modelNames } = useMemo(() => {
    const names = new Map<string, string>();
    const list: PackageView[] = [];
    for (const model of catalog?.models ?? []) {
      names.set(model.modelId, model.displayName || model.modelId);
      list.push(...(model.packages ?? []));
    }
    list.push(...(catalog?.packages ?? []));
    return { packages: list, modelNames: names };
  }, [catalog]);

  const usableKeys = useMemo(() => {
    const now = Date.now();
    return keys.filter((key) => isUsable(key, now));
  }, [keys]);

  // 从密钥页点「续额」带着 ?key=，从模型广场点「购买」带着 ?package=，直接把选择摆好。
  //
  // 用 window.location 而不是 useSearchParams()：后者在 App Router 里要求外面
  // 套一层 <Suspense>，否则 next build 直接报错 —— 为一个可选的预填值付这个代价
  // 不值当。读一次就够，之后由用户自己选。
  const [preset, setPreset] = useState<{ key: string; packageCode: string } | null>(null);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setPreset({ key: params.get("key") ?? "", packageCode: params.get("package") ?? "" });
  }, []);
  useEffect(() => {
    if (!preset || !catalog) return;
    if (preset.key && usableKeys.some((key) => key.keyId === preset.key)) setTarget(preset.key);
    const item = packages.find((candidate) => candidate.packageCode === preset.packageCode);
    if (item) {
      setCategory(item.category);
      setPicked(item.packageCode);
    }
    setPreset(null);
  }, [preset, catalog, packages, usableKeys]);

  // 选中的那把密钥过期、被吊销之后就不在下拉里了：下拉显示「签发新密钥」，
  // 请求却还带着它的 id，买下去就充进了一把用不了的密钥。
  useEffect(() => {
    if (target && !usableKeys.some((key) => key.keyId === target)) setTarget("");
  }, [target, usableKeys]);

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
  //
  // 预填还没用掉时先不动：两个副作用在同一次渲染里跑，这里看到的还是旧的类别，
  // 抢先改掉的话，从广场点进来的那个套餐会被换成隔壁栏的第一个。
  useEffect(() => {
    if (preset || grouped.size === 0 || grouped.has(category)) return;
    setCategory(Array.from(grouped.keys())[0]);
  }, [preset, category, grouped]);

  const shown = grouped.get(category) ?? [];
  const chosen = shown.find((item) => item.packageCode === picked) ?? shown[0] ?? null;
  const balance = points?.balance ?? 0;
  const shortfall = chosen ? chosen.amount - balance : 0;

  const submit = async () => {
    if (!chosen || !notice || busy) return;
    setBusy(true);
    try {
      const order = await purchaseWithPoints(chosen.packageCode, target, notice.version, requestId.current);
      requestId.current = newRequestId();
      message.success(t("store.bought"));
      // 签发新密钥的那一单顺带回来明文；充进已有密钥的没有，不弹。
      if (order.issuedSecret) {
        // 存本机要在弹框之前：框里那句「已存好」得是真的。
        setIssuedSaved(await rememberKeySecret(order.keyId, order.packageCode, order.issuedSecret));
        setIssued({ keyId: order.keyId, secret: order.issuedSecret, alias: order.packageCode, expiresAt: "" });
      }
      await load();
    } catch (error) {
      message.error((error as Error).message || t("common.actionFailed"));
    } finally {
      setBusy(false);
    }
  };

  const header = (
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
  );

  if (loading) {
    return (
      <>
        {header}
        <div className="gx-body">
          <Loading />
        </div>
      </>
    );
  }

  return (
    <>
      {header}

      {tab === "orders" ? (
        <OrderHistory orders={orders} keys={keys} points={points} onChanged={() => void load()} />
      ) : (
        <div className="gx-body">
          <div style={{ display: "grid", gridTemplateColumns: "200px minmax(0, 1fr) 340px", gap: 14, alignItems: "start" }}>
            <Card className="gx-rise">
              <CardHead title={t("store.category")} />
              <div style={{ padding: "0 10px 14px", display: "flex", flexDirection: "column", gap: 2 }}>
                {CATEGORIES.filter((item) => grouped.has(item) || item === "claude" || item === "codex").map((item) => {
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
                <div style={{ padding: "10px 12px 0" }}>
                  <button type="button" className="gx-link" onClick={() => router.push("/consumer/models")}>
                    {t("store.goModels")}
                  </button>
                </div>
              </div>
            </Card>

            <Card className="gx-rise gx-rise--1">
              <CardHead title={t("store.packages", { category: t(`store.category.${category}`) })} hint={t("store.billing")} />
              <div style={{ padding: "0 18px 18px", display: "grid", gap: 12 }}>
                {shown.length === 0 ? (
                  <span className="gx-card__hint">{t("store.packagesEmpty")}</span>
                ) : (
                  shown.map((item) => (
                    <PackageRow
                      key={item.packageCode}
                      item={item}
                      modelName={modelNames.get(item.modelId) ?? item.modelId}
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
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  <span className="gx-label">{t("store.target")}</span>
                  <select className="gx-input" value={target} onChange={(event) => setTarget(event.target.value)}>
                    <option value="">{t("store.targetNew")}</option>
                    {usableKeys.map((key) => (
                      <option key={key.keyId} value={key.keyId}>
                        {key.alias || key.keyId}
                      </option>
                    ))}
                  </select>
                  {usableKeys.length === 0 ? <span className="gx-card__hint">{t("store.emptyKeys")}</span> : null}
                </div>

                {chosen ? (
                  <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: "12px 14px", borderRadius: 10, background: "var(--gx-muted)" }}>
                    <Line label={`${chosen.title} × 1`} value={`${formatPoints(chosen.amount)} ${t("points.unit")}`} />
                    <Line
                      label={t("store.getsUnits")}
                      value={Object.entries(chosen.units ?? {})
                        .map(([unit, value]) => `${formatQuota(unit, value)} ${unitLabel(unit, t)}`)
                        .join(" · ")}
                    />
                    <Line label={t("store.balance")} value={`${formatPoints(balance)} ${t("points.unit")}`} />
                    <div style={{ height: 1, background: "var(--gx-line)", margin: "4px 0" }} />
                    <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between" }}>
                      <span style={{ fontSize: 12.5, color: "var(--gx-soft)" }}>{t("store.total")}</span>
                      <span className="gx-serif" style={{ fontSize: 26 }}>
                        {formatPoints(chosen.amount)} <span style={{ fontSize: 13, color: "var(--gx-faint)" }}>{t("points.unit")}</span>
                      </span>
                    </div>
                    <Line
                      label={t("store.after")}
                      value={shortfall > 0 ? t("store.short", { value: formatPoints(shortfall) }) : `${formatPoints(balance - chosen.amount)} ${t("points.unit")}`}
                    />
                  </div>
                ) : null}

                <Btn tone="accent" loading={busy} disabled={!chosen || !notice?.accepted || shortfall > 0} onClick={() => void submit()}>
                  {t("store.pay")}
                </Btn>
                {!notice?.accepted ? (
                  <Note tone="warn">{t("notice.body")}</Note>
                ) : shortfall > 0 ? (
                  <Note tone="warn">{t("store.shortHint", { value: formatPoints(shortfall) })}</Note>
                ) : (
                  <span className="gx-card__hint" style={{ textAlign: "center" }}>
                    {t("store.terms")} {notice?.version}
                  </span>
                )}
              </div>
            </Card>
          </div>

          <Note>{t("store.billingBody")}</Note>
        </div>
      )}

      <IssuedKeyModal issued={issued} savedLocally={issuedSaved} onClose={() => setIssued(null)} />
    </>
  );
}

function PackageRow({
  item,
  modelName,
  best,
  active,
  onPick,
}: {
  item: PackageView;
  modelName: string;
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
        <span style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <span style={{ fontSize: 14, fontWeight: 600 }}>{item.title}</span>
          {modelName ? <Pill>{modelName}</Pill> : null}
          {best ? <Pill tone="accent">{t("store.best")}</Pill> : null}
        </span>
        <span className="gx-mono" style={{ display: "block", fontSize: 12, color: "var(--gx-faint)", marginTop: 4 }}>
          {formatInt(tokens)} tokens · {t("store.priceHint", { price: perMillion(item.amount, tokens), days: item.ttlDays })}
        </span>
      </span>
      <span style={{ display: "flex", alignItems: "baseline", gap: 4 }}>
        <span className="gx-serif" style={{ fontSize: 30, lineHeight: 1 }}>
          {formatPoints(item.amount)}
        </span>
        <span style={{ fontSize: 12, color: "var(--gx-faint)" }}>{t("points.unit")}</span>
      </span>
    </button>
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

/** 每百万 token 多少积分。用它挑「最划算」，而不是挑最便宜的那个包。 */
function unitPrice(item: PackageView): number {
  const tokens = item.units["llm.output_tokens"] ?? Object.values(item.units ?? {})[0] ?? 0;
  return tokens > 0 ? item.amount / tokens : Number.POSITIVE_INFINITY;
}

function bestValue(items: PackageView[]): string {
  if (items.length < 2) return "";
  return items.reduce((best, item) => (unitPrice(item) < unitPrice(best) ? item : best)).packageCode;
}

function perMillion(amount: number, tokens: number): string {
  if (tokens <= 0) return "-";
  return formatPoints((amount / tokens) * 1_000_000);
}
