"use client";

/**
 * 密钥。
 *
 * 额度**不在密钥上**：账户里有多少积分，名下几把密钥花的就是同一份钱。所以这一页
 * 顶上先摆余额（那是唯一会用完的东西），下面的卡片只回答「这一把是哪一把、
 * 接在哪台机器上、什么时候到期」。也正因为如此，密钥可以随手新建、随手作废 ——
 * 换一把不会损失任何东西，最多 5 把是怕人自己数不清哪把在哪儿。
 *
 * 默认只摆有效的密钥：过期、冻结、吊销的那些大多只剩「换发」或「看一眼」这两件事，
 * 和能用的混在一起，找能用的那把要先跳过一堆灰卡片。
 *
 * 明文在签发那一刻就存进了本机保险箱（桌面端 SQLite / 浏览器 localStorage，见 api/keyvault.api.ts）。
 * 列表里仍然只有掩码 —— 要明文的四件事（查看、桌面端「使用」、复制密钥、复制带密钥的命令）
 * 各自在点下去的那一刻取一次：先问本机，本机没有才回服务端要，要到了顺手补存一份。
 */

import { Dropdown, Input, Modal, message } from "antd";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { PageHeader } from "@/components/shell/GalaxyShell";
import { IconAlert, IconCopy, IconDownload, IconEye, IconEyeOff, IconKey, IconMonitor, IconPlus, IconRefresh } from "@/components/ui/icons";
import { Btn, Card, CardHead, CopyBtn, EmptyState, IconBtn, Loading, Note, Pill, Seg, Tabs } from "@/components/ui/kit";
import { useLocale, type TranslationKey } from "@/i18n/LocaleProvider";
import { copyText, formatDay, formatPoints } from "@/utils/format";
import {
  acceptNotice,
  // 值，不是类型：取不到接口时要 new 一个空的出来，那几格才都是空串而不是 undefined。
  ConsumerClientDownloads,
  createKey,
  fetchConsumerEndpoint,
  fetchDashboard,
  fetchKeys,
  fetchNotice,
  MAX_KEYS,
  renewKey,
  revealKey,
  revokeKey,
  type ConsumerDashboard,
  type ConsumerKeyView,
  type IssuedKeyView,
  type NoticeStatus,
} from "../../api/consumer.api";
import {
  canApplyLocally,
  clientConfigApi,
  fetchClientStatus,
  TOOL_LABELS,
  type ClientConfigStatus,
  type ClientTool,
} from "../../api/clientconfig.api";
import { forgetKeySecret, listLocalKeyIds, readKeySecret, rememberKeySecret } from "../../api/keyvault.api";
import { IssuedKeyModal } from "./IssuedKeyModal";
import { UsageGuide } from "./UsageGuide";
import { apiBase, buildSnippet, defaultSnippetTab, hostRoot, pinnedModel, SECRET_PLACEHOLDER, type SnippetTab } from "./snippets";

const KEY_FREEZE_DAYS = 30;

type KeyTab = "valid" | "invalid";

/** 服务端的巡检把到期的密钥改成 expired 有延迟，这里按到期时间再判一次，免得一把刚过期的还挂在「有效」里。 */
function isUsable(key: ConsumerKeyView, now: number): boolean {
  if (key.status !== "active") return false;
  const expires = Date.parse(key.expiresAt);
  return Number.isNaN(expires) || expires > now;
}

/** 这把密钥接哪个客户端。视频类不对口任何命令行客户端；范围不限的两个都能接。 */
function toolsFor(key: ConsumerKeyView): ClientTool[] {
  if (key.category === "claude") return ["claude"];
  if (key.category === "codex") return ["codex"];
  if (key.category === "other") return ["claude", "codex"];
  return [];
}

export function ConsumerKeys() {
  const { t } = useLocale();
  const router = useRouter();
  // 静态 Modal.confirm 拿不到 ConfigProvider 的主题，按钮会是 antd 默认的蓝色，所以用 hook 版。
  const [modal, modalHolder] = Modal.useModal();
  const [keys, setKeys] = useState<ConsumerKeyView[]>([]);
  const [notice, setNotice] = useState<NoticeStatus | null>(null);
  const [issued, setIssued] = useState<IssuedKeyView | null>(null);
  // 这把新密钥有没有存进本机保险箱。存不下就得让用户当场自己存一份。
  const [issuedSaved, setIssuedSaved] = useState(false);
  const [tab, setTab] = useState<KeyTab>("valid");
  const [selected, setSelected] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  // 账户余额。密钥页要摆它：这一页上唯一会用完的东西就是它，而不是哪一把密钥。
  const [dashboard, setDashboard] = useState<ConsumerDashboard | null>(null);
  // 新建密钥的弹框与里面那个名字。名字是给人看的，用来区分「这把接在哪台机器上」。
  const [creating, setCreating] = useState(false);
  const [newAlias, setNewAlias] = useState("");
  // SDK 要填的 base_url **由服务端给** —— 消费者路由挂在 galaxy-api 的 /v1 上，
  // 那个地址前端猜不出来（控制台和 API 可能不同域、不同端口）。
  const [baseUrl, setBaseUrl] = useState("");
  // 桌面客户端各系统的下载地址，同样由服务端给（运行参数 client.consumer_download_url[.平台]）。
  // 一条都没配就是那一块直接不显示，而不是给一个猜来的地址。
  const [downloads, setDownloads] = useState<ConsumerClientDownloads>(() => new ConsumerClientDownloads());
  // 「使用」只有桌面壳里有。判断依赖 window，挂载之后再定，否则首屏 HTML 和水合结果对不上。
  const [desktop, setDesktop] = useState(false);
  const [clientStatus, setClientStatus] = useState<ClientConfigStatus | null>(null);
  const [applying, setApplying] = useState("");
  // 本机保险箱里存着哪几把。只存 keyId —— 明文要用的时候再单独取一条。
  const [localKeys, setLocalKeys] = useState<ReadonlySet<string>>(() => new Set());
  // 「查看」展开的是哪一把、看到的是什么。切到别的密钥就收起来。
  const [revealed, setRevealed] = useState<{ keyId: string; secret: string } | null>(null);

  const refreshClientStatus = useCallback(async () => {
    setClientStatus(await fetchClientStatus());
  }, []);

  const refreshLocalKeys = useCallback(async () => {
    setLocalKeys(new Set(await listLocalKeyIds()));
  }, []);

  const load = useCallback(async () => {
    try {
      const [list, noticeResult] = await Promise.all([fetchKeys(), fetchNotice()]);
      setKeys(list);
      setNotice(noticeResult);
    } catch (error) {
      message.error((error as Error).message || t("common.loadFailed"));
    } finally {
      setLoading(false);
    }
    // 余额单独取、失败不打断整页：密钥列表出来了却因为余额没取到而整页报错，
    // 是把「次要信息」的故障升级成了「主要功能」的故障。
    void fetchDashboard().then(setDashboard).catch(() => undefined);
    void refreshClientStatus();
    void refreshLocalKeys();
  }, [refreshClientStatus, refreshLocalKeys, t]);

  useEffect(() => {
    setDesktop(canApplyLocally());
    void load();
    // 取不到就不显示这两块，好过显示一个猜来的、打过去 404 的地址。
    void fetchConsumerEndpoint()
      .then((row) => {
        setBaseUrl(row.baseUrl);
        setDownloads(row.clientDownloads ?? new ConsumerClientDownloads());
      })
      .catch(() => {
        setBaseUrl("");
        setDownloads(new ConsumerClientDownloads());
      });
  }, [load]);

  const { valid, invalid } = useMemo(() => {
    const now = Date.now();
    return {
      valid: keys.filter((key) => isUsable(key, now)),
      invalid: keys.filter((key) => !isUsable(key, now)),
    };
  }, [keys]);
  const shown = tab === "valid" ? valid : invalid;

  // 切页签、刷新之后选中的那把可能已经不在这一栏里了，退回这一栏的第一把。
  useEffect(() => {
    setSelected((current) => (shown.some((key) => key.keyId === current) ? current : (shown[0]?.keyId ?? "")));
  }, [shown]);

  const current = useMemo(() => shown.find((key) => key.keyId === selected) ?? null, [shown, selected]);

  // 换了一把密钥就把展开的明文收起来，别让上一把的明文挂在屏幕上。
  useEffect(() => {
    setRevealed((previous) => (previous && previous.keyId === selected ? previous : null));
  }, [selected]);

  /** 这把密钥此刻接在本机哪几个客户端上。只认 Orbit 自己写进去、而且文件里现在还是它的。 */
  const inUse = useCallback(
    (key: ConsumerKeyView): ClientTool[] =>
      clientStatus ? (["claude", "codex"] as const).filter((tool) => clientStatus[tool].keyId === key.keyId) : [],
    [clientStatus],
  );

  /** 这把密钥现在还拿不拿得到明文：本机存着，或者服务端那份密文解得开。 */
  const hasSecret = useCallback(
    (key: ConsumerKeyView) => localKeys.has(key.keyId) || key.revealable,
    [localKeys],
  );

  /**
   * 取这把密钥的明文。先问本机保险箱，没有才回服务端要 —— 要到了顺手补存一份，
   * 换过机器、或者这把是本次改动之前买的，都只用回服务端这一次。
   */
  const secretFor = useCallback(
    async (key: ConsumerKeyView): Promise<{ secret: string; baseUrl: string }> => {
      const local = await readKeySecret(key.keyId);
      if (local) return { secret: local, baseUrl };
      const remote = await revealKey(key.keyId);
      if (await rememberKeySecret(key.keyId, key.alias, remote.secret)) void refreshLocalKeys();
      return { secret: remote.secret, baseUrl: remote.baseUrl || baseUrl };
    },
    [baseUrl, refreshLocalKeys],
  );

  const applyKey = async (key: ConsumerKeyView, tool: ClientTool) => {
    setApplying(key.keyId);
    try {
      const { secret, baseUrl: target } = await secretFor(key);
      if (!target) throw new Error(t("keys.use.noBaseUrl"));
      // 写哪个文件、写什么由主进程在系统确认框里摆给用户看，页面只递过去这三样。
      // 密钥锁了模型就一起写进去：不写的话客户端按它自己的默认模型发请求，
      // 接上去之后每一句都被拒（pinnedModel 只在恰好锁了一个具体模型时给出名字）。
      const result = await clientConfigApi.applyKey({
        tool, baseUrl: target, secret, keyId: key.keyId,
        model: pinnedModel(key.modelTier, key.modelId),
      });
      // 配置写好了，但 Claude Code / Codex 都是**启动时读一次**配置：正在跑的那个会话
      // 里什么都不会变。用弹框而不是 message —— 这一句是「才算接上」的最后一步，
      // 而角落里飘过去的那条提示，恰恰是人转头就去终端里敲命令时看不到的那一条。
      if (result.applied) {
        modal.success({
          title: t("keys.use.applied", { tool: TOOL_LABELS[tool] }),
          content: t("keys.use.restart"),
          okText: t("issued.done"),
        });
      }
      await refreshClientStatus();
    } catch (error) {
      message.error((error as Error).message || t("common.actionFailed"));
    } finally {
      setApplying("");
    }
  };

  const copySecret = async (key: ConsumerKeyView) => {
    try {
      const { secret } = await secretFor(key);
      if (await copyText(secret)) message.success(t("keys.secretCopied"));
      else message.error(t("keys.copyFailed"));
    } catch (error) {
      message.error((error as Error).message || t("common.actionFailed"));
    }
  };

  /** 「查看」：把明文摆在详情里。再点一次收起来 —— 屏幕上多留一秒就是多一秒被看见的机会。 */
  const toggleReveal = async (key: ConsumerKeyView) => {
    if (revealed?.keyId === key.keyId) {
      setRevealed(null);
      return;
    }
    try {
      const { secret } = await secretFor(key);
      setRevealed({ keyId: key.keyId, secret });
    } catch (error) {
      message.error((error as Error).message || t("common.actionFailed"));
    }
  };

  /**
   * 新建一把密钥。
   *
   * 明文只在这一次响应里出现，所以顺序是死的：先存进本机保险箱，再摆给人看。
   * 存不下（浏览器禁了存储、桌面端保险箱打不开）也要摆出来，但弹框会提示
   * 「这一次不存了，自己抄一份」—— 没有第二次机会。
   */
  const create = async () => {
    setBusy(true);
    try {
      const fresh = await createKey(newAlias.trim(), notice?.version ?? "");
      setIssuedSaved(await rememberKeySecret(fresh.keyId, fresh.alias, fresh.secret));
      setIssued(fresh);
      setCreating(false);
      setNewAlias("");
      setTab("valid");
      message.success(t("keys.createdOk"));
      await load();
    } catch (error) {
      message.error((error as Error).message || t("common.actionFailed"));
    } finally {
      setBusy(false);
    }
  };

  const reissue = (key: ConsumerKeyView) => {
    void modal.confirm({
      title: t("keys.reissue"),
      content: t("keys.reissueConfirm"),
      okText: t("common.confirm"),
      cancelText: t("common.cancel"),
      onOk: async () => {
        setBusy(true);
        try {
          const fresh = await renewKey(key.keyId);
          setIssuedSaved(await rememberKeySecret(fresh.keyId, fresh.alias, fresh.secret));
          // 旧的这一刻就作废了，本机那份留着也用不了。
          await forgetKeySecret(key.keyId);
          setIssued(fresh);
          message.success(t("keys.reissued"));
          setTab("valid");
          await load();
        } catch (error) {
          message.error((error as Error).message || t("common.actionFailed"));
        } finally {
          setBusy(false);
        }
      },
    });
  };

  const revoke = (key: ConsumerKeyView) => {
    void modal.confirm({
      title: t("keys.revoke"),
      content: t("keys.revokeConfirm"),
      okText: t("common.confirm"),
      cancelText: t("common.cancel"),
      okButtonProps: { danger: true },
      onOk: async () => {
        setBusy(true);
        try {
          await revokeKey(key.keyId);
          await forgetKeySecret(key.keyId);
          message.success(t("keys.revoked"));
          await load();
        } catch (error) {
          message.error((error as Error).message || t("common.actionFailed"));
        } finally {
          setBusy(false);
        }
      },
    });
  };

  const header = (
    <PageHeader
      title={t("keys.title")}
      meta={t("keys.subtitle")}
      actions={
        <>
          <Tabs
            value={tab}
            onChange={setTab}
            options={[
              { value: "valid" as const, label: t("keys.tab.valid", { count: valid.length }) },
              { value: "invalid" as const, label: t("keys.tab.invalid", { count: invalid.length }) },
            ]}
          />
          <IconBtn label={t("common.refresh")} onClick={() => void load()}>
            <IconRefresh size={17} />
          </IconBtn>
          <Btn
            tone="accent"
            icon={<IconPlus size={16} />}
            disabled={busy || valid.length >= MAX_KEYS}
            title={valid.length >= MAX_KEYS ? t("keys.full", { max: MAX_KEYS }) : undefined}
            onClick={() => setCreating(true)}
          >
            {t("keys.new")}
          </Btn>
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

  const renderUseButton = (key: ConsumerKeyView, small = true) => (
    <UseButton
      keyView={key}
      desktop={desktop}
      available={hasSecret(key)}
      applying={applying === key.keyId}
      disabled={Boolean(applying)}
      small={small}
      onApply={(tool) => void applyKey(key, tool)}
    />
  );

  return (
    <>
      {header}
      {modalHolder}
      <div className="gx-body">
        {/* 数据告知是签发密钥的硬前置：没确认过就买不了，也发不出密钥（C-13）。 */}
        {notice && !notice.accepted ? (
          <Card className="gx-rise" style={{ padding: "16px 20px", display: "flex", alignItems: "center", gap: 14 }}>
            <IconAlert size={18} style={{ color: "var(--gx-warn)", flex: "0 0 auto" }} />
            <span style={{ flex: 1, fontSize: 12.5, lineHeight: 1.65, color: "var(--gx-soft)" }}>{t("notice.body")}</span>
            <Btn
              tone="accent"
              small
              onClick={async () => {
                try {
                  await acceptNotice();
                  void load();
                } catch (error) {
                  message.error((error as Error).message || t("common.actionFailed"));
                }
              }}
            >
              {t("notice.accept")}
            </Btn>
          </Card>
        ) : null}

        {/* 余额摆在最前面。额度不在密钥上，所以这一页上唯一会「用完」的东西就是它。 */}
        <BalanceBar balance={dashboard?.balance ?? 0} onOpenLedger={() => router.push("/consumer/points")} />

        {/* 同一个位置上的两种回答：桌面端说「这台电脑现在接的是哪把」，浏览器里说「客户端从这儿拿」。 */}
        {desktop ? (
          clientStatus ? (
            <LocalClients status={clientStatus} keys={keys} />
          ) : null
        ) : hasDownload(downloads) ? (
          <ClientDownload downloads={downloads} />
        ) : null}

        {shown.length === 0 ? (
          <Card className="gx-rise">
            {tab === "valid" ? (
              <EmptyState
                title={t("keys.emptyTitle")}
                hint={t("keys.emptyHint")}
                action={
                  <Btn tone="accent" disabled={busy} onClick={() => setCreating(true)}>
                    {t("keys.new")}
                  </Btn>
                }
              />
            ) : (
              <EmptyState title={t("keys.invalidEmpty")} />
            )}
          </Card>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))", gap: 14 }}>
            {shown.map((key) => (
              <KeyCard
                key={key.keyId}
                item={key}
                active={key.keyId === selected}
                inUse={inUse(key)}
                onSelect={() => setSelected(key.keyId)}
                action={tab === "valid" ? renderUseButton(key) : null}
              />
            ))}
          </div>
        )}

        {/* 「怎么用」放在列表和详情之间：它回答的是刚签完那一刻最先冒出来的问题，
            而下面那张「接入方式」给的是三条路里最后一条要填的东西。 */}
        {tab === "valid" && valid.length > 0 ? <UsageGuide desktop={desktop} hasDownload={hasDownload(downloads)} /> : null}

        {current ? (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
            <Card className="gx-rise gx-rise--1">
              <CardHead
                title={current.alias || current.keyId}
                hint={`${current.keyId} · ${t("keys.created", { value: formatDay(current.issuedAt) })}`}
                action={
                  <span style={{ display: "flex", gap: 8 }}>
                    {hasSecret(current) && current.status !== "revoked" ? (
                      <>
                        <Btn
                          tone="ghost"
                          small
                          icon={revealed?.keyId === current.keyId ? <IconEyeOff size={14} /> : <IconEye size={14} />}
                          onClick={() => void toggleReveal(current)}
                        >
                          {revealed?.keyId === current.keyId ? t("keys.hideSecret") : t("keys.showSecret")}
                        </Btn>
                        <Btn tone="ghost" small icon={<IconCopy size={14} />} onClick={() => void copySecret(current)}>
                          {t("keys.copySecret")}
                        </Btn>
                      </>
                    ) : null}
                    {current.status !== "revoked" ? (
                      <Btn tone="ghost" small disabled={busy} title={t("keys.reissueHint")} onClick={() => reissue(current)}>
                        {t("keys.reissue")}
                      </Btn>
                    ) : null}
                  </span>
                }
              />
              <div style={{ padding: "0 18px 18px", display: "flex", flexDirection: "column", gap: 16 }}>
                {!hasSecret(current) && current.status !== "revoked" ? <Note>{t("keys.noSecret")}</Note> : null}

                {revealed?.keyId === current.keyId ? <SecretRow key={current.keyId} secret={revealed.secret} /> : null}

                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  <span style={{ fontSize: 13, fontWeight: 600 }}>{t("keys.scope")}</span>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                    {[...(current.allowedKinds ?? []), ...(current.modelTier ?? [])].length === 0 ? (
                      <span className="gx-card__hint">{t("keys.scopeAll")}</span>
                    ) : (
                      [...(current.allowedKinds ?? []), ...(current.modelTier ?? [])].map((item) => (
                        <span className="gx-chip gx-chip--on" key={item}>
                          {item}
                        </span>
                      ))
                    )}
                  </div>
                  <span className="gx-card__hint">
                    {t("keys.concurrency")} · {current.concurrency} / {current.rpm}
                  </span>
                </div>

                <Note>{t("keys.freezeHint", { days: KEY_FREEZE_DAYS })}</Note>

                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span>{tab === "valid" ? renderUseButton(current, false) : null}</span>
                  {current.status !== "revoked" ? (
                    <Btn tone="danger" small disabled={busy} onClick={() => revoke(current)}>
                      {t("keys.revoke")}
                    </Btn>
                  ) : null}
                </div>
              </div>
            </Card>

            <ConnectCard
              key={current.keyId}
              keyView={current}
              baseUrl={baseUrl}
              desktop={desktop}
              available={hasSecret(current)}
              loadSecret={secretFor}
            />
          </div>
        ) : null}
        {valid.length > 0 && tab === "valid" ? <Note>{t("keys.newHint")}</Note> : null}
      </div>

      <Modal
        open={creating}
        title={t("keys.new")}
        okText={t("keys.createOk")}
        cancelText={t("common.cancel")}
        confirmLoading={busy}
        onOk={() => void create()}
        onCancel={() => setCreating(false)}
        destroyOnClose
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 12, paddingBlock: 8 }}>
          <span className="gx-card__hint">{t("keys.createHint", { max: MAX_KEYS })}</span>
          <Input
            value={newAlias}
            maxLength={64}
            placeholder={t("keys.aliasPlaceholder")}
            onChange={(event) => setNewAlias(event.target.value)}
            onPressEnter={() => void create()}
          />
          <span className="gx-card__hint">{t("keys.createSecretHint")}</span>
        </div>
      </Modal>

      <IssuedKeyModal issued={issued} savedLocally={issuedSaved} onClose={() => setIssued(null)} />
    </>
  );
}

/**
 * 余额条。
 *
 * 只有一个数字：账户里还剩多少积分。它不按密钥分、也不按模型分 ——
 * 谁调都扣这一份，扣光了所有密钥一起停。所以它值得占满一行，
 * 而不是塞进某张密钥卡片的角落里。
 */
function BalanceBar({ balance, onOpenLedger }: { balance: number; onOpenLedger: () => void }) {
  const { t } = useLocale();
  const empty = balance <= 0;
  return (
    <Card className="gx-rise" style={{ padding: "16px 20px", display: "flex", alignItems: "center", gap: 16 }}>
      <span style={{ display: "flex", flexDirection: "column", gap: 4, flex: 1 }}>
        <span className="gx-label">{t("keys.accountBalance")}</span>
        <span style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
          <span className="gx-serif" style={{ fontSize: 30, lineHeight: 1, color: empty ? "var(--gx-warn)" : undefined }}>
            {formatPoints(balance)}
          </span>
          <span style={{ fontSize: 12, color: "var(--gx-faint)" }}>{t("points.unit")}</span>
        </span>
      </span>
      <span style={{ flex: 2, fontSize: 12.5, lineHeight: 1.65, color: "var(--gx-soft)" }}>
        {empty ? t("keys.balanceEmpty") : t("keys.balanceHint")}
      </span>
      <Btn tone="ghost" small onClick={onOpenLedger}>
        {t("keys.balanceLedger")}
      </Btn>
    </Card>
  );
}

function KeyCard({
  item,
  active,
  inUse,
  onSelect,
  action,
}: {
  item: ConsumerKeyView;
  active: boolean;
  inUse: ClientTool[];
  onSelect: () => void;
  action: React.ReactNode;
}) {
  const { t } = useLocale();
  return (
    // 选中和「使用」是两件事：外层用 div，选中的热区是里面那个按钮 —— 按钮里再套按钮是非法的 HTML。
    <div
      style={{
        borderRadius: 14,
        border: `1px solid ${active ? "var(--gx-accent)" : "var(--gx-line)"}`,
        background: "var(--gx-surface)",
        boxShadow: active ? "0 0 0 3px var(--gx-accent-soft)" : "none",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
    >
      <button
        type="button"
        onClick={onSelect}
        style={{
          textAlign: "left",
          padding: "18px 20px",
          border: 0,
          background: "transparent",
          cursor: "pointer",
          display: "flex",
          flexDirection: "column",
          gap: 14,
          font: "inherit",
          color: "inherit",
        }}
      >
        <span style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <IconKey size={16} style={{ color: active ? "var(--gx-accent)" : "var(--gx-faint)" }} />
          <span style={{ fontSize: 14, fontWeight: 600, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {item.alias || item.keyId}
          </span>
          <Pill tone={item.status === "active" ? "ok" : item.status === "revoked" ? "err" : "warn"}>
            {t(`keys.status.${item.status}`)}
          </Pill>
        </span>
        <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span className="gx-mono" style={{ flex: 1, fontSize: 12, color: "var(--gx-faint)", letterSpacing: "0.02em" }}>
            sk-galaxy-••••••••••••••••
          </span>
          <span className="gx-chip">{t(`keys.category.${item.category}`)}</span>
        </span>
        {/* 卡片上没有数字可摆了 —— 额度在账户上，一把密钥本身只有「是哪把、什么时候到期」。
            硬凑一个数（比如这把花了多少）只会让人以为那是它自己的额度。 */}
        <span style={{ display: "flex", alignItems: "baseline", gap: 8, fontSize: 11.5, color: "var(--gx-faint)" }}>
          <span>{t("keys.created", { value: formatDay(item.issuedAt) })}</span>
          <span style={{ marginLeft: "auto" }}>{t("keys.expiresAt", { value: formatDay(item.expiresAt) })}</span>
        </span>
      </button>
      {action || inUse.length > 0 ? (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 8,
            padding: "10px 20px",
            borderTop: "1px solid var(--gx-line)",
          }}
        >
          <span style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {inUse.map((tool) => (
              <Pill key={tool} tone="accent">
                {t("keys.use.inUse", { tool: TOOL_LABELS[tool] })}
              </Pill>
            ))}
          </span>
          {action}
        </div>
      ) : null}
    </div>
  );
}

/** 展开的明文。复制状态归它自己管 —— 换一把密钥这个组件整个换掉，勾也跟着没了。 */
function SecretRow({ secret }: { secret: string }) {
  const { t } = useLocale();
  const [copied, setCopied] = useState(false);
  return (
    <div className="gx-secret">
      <span style={{ flex: 1 }}>{secret}</span>
      <CopyBtn value={secret} label={t("common.copy")} copied={copied} onCopied={() => setCopied(true)} />
    </div>
  );
}

/**
 * 「使用」按钮。桌面壳里才画；本机和服务端都拿不到明文的老密钥给一个灰按钮，悬停说原因 ——
 * 直接不画的话，用户会以为这把密钥和别的不一样是出了什么问题。
 */
function UseButton({
  keyView,
  desktop,
  available,
  applying,
  disabled,
  small,
  onApply,
}: {
  keyView: ConsumerKeyView;
  desktop: boolean;
  /** 明文取得到（本机存着，或者服务端解得开）。取不到时按钮是灰的。 */
  available: boolean;
  applying: boolean;
  disabled: boolean;
  small: boolean;
  onApply: (tool: ClientTool) => void;
}) {
  const { t } = useLocale();
  const tools = toolsFor(keyView);
  if (!desktop || tools.length === 0) return null;
  if (!available) {
    return (
      <Btn tone="soft" small={small} disabled title={t("keys.noSecret")}>
        {t("keys.use.button")}
      </Btn>
    );
  }
  if (tools.length === 1) {
    return (
      <Btn tone="soft" small={small} loading={applying} disabled={disabled} onClick={() => onApply(tools[0])}>
        {t("keys.use.buttonFor", { tool: TOOL_LABELS[tools[0]] })}
      </Btn>
    );
  }
  return (
    <Dropdown
      trigger={["click"]}
      disabled={disabled}
      menu={{
        items: tools.map((tool) => ({ key: tool, label: t("keys.use.buttonFor", { tool: TOOL_LABELS[tool] }) })),
        onClick: ({ key }) => onApply(key as ClientTool),
      }}
    >
      {/* Dropdown 要往子元素上挂 ref 定位弹层，Btn 是函数组件接不住，外面垫一层 span。 */}
      <span>
        <Btn tone="soft" small={small} loading={applying} disabled={disabled}>
          {t("keys.use.button")}
        </Btn>
      </span>
    </Dropdown>
  );
}

/** 这台电脑上的 Claude Code / Codex 现在接的是什么。「使用」改的就是这两个文件。 */
function LocalClients({ status, keys }: { status: ClientConfigStatus; keys: ConsumerKeyView[] }) {
  const { t } = useLocale();
  const alias = new Map(keys.map((key) => [key.keyId, key.alias || key.keyId]));
  return (
    <Card className="gx-rise" style={{ padding: "14px 20px", display: "flex", flexDirection: "column", gap: 8 }}>
      <span style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, fontWeight: 600 }}>
        <IconMonitor size={16} style={{ color: "var(--gx-faint)" }} />
        {t("keys.local.title")}
        <span className="gx-card__hint" style={{ fontWeight: 400 }}>
          {t("keys.local.hint")}
        </span>
      </span>
      {(["claude", "codex"] as const).map((tool) => {
        const row = status[tool];
        const text = row.keyId
          ? t("keys.local.usingKey", { alias: alias.get(row.keyId) ?? row.keyId })
          : row.keyTail
            ? t("keys.local.otherKey", { tail: row.keyTail })
            : t("keys.local.notConnected");
        return (
          <span key={tool} style={{ display: "grid", gridTemplateColumns: "110px minmax(0, 1fr) auto", gap: 12, fontSize: 12.5, alignItems: "baseline" }}>
            <span className="gx-soft">{TOOL_LABELS[tool]}</span>
            <span className="gx-mono gx-muted" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={row.file}>
              {row.file}
            </span>
            <span style={{ color: row.keyId ? "var(--gx-accent)" : "var(--gx-soft)" }}>{text}</span>
          </span>
        );
      })}
    </Card>
  );
}

/** 填过的那几条里有没有东西。全空就是那一块不显示 —— 空着不是故障，是这套部署没登记安装包。 */
function hasDownload(downloads: ConsumerClientDownloads) {
  return Boolean(downloads.default || downloads.windows || downloads.macX64 || downloads.macArm64);
}

/**
 * 浏览器认得出的只有「是不是 Windows / 是不是 Mac」。
 *
 * 认不出的是 Mac 的芯片：navigator.platform 在 Intel 和 Apple 芯片上**都报 MacIntel**，
 * userAgent 里也没有这一条（能分出来的只有 userAgentData 的高熵字段，Safari 上没有）。
 * 所以这里只排个顺序 —— 把对面那个系统的按钮放前面 —— 而不是替人挑一个包：
 * 挑错给出 arm64 的包，Intel 机器上装完直接起不来。
 */
function guessOS(): "windows" | "mac" | "" {
  if (typeof navigator === "undefined") return "";
  const hint = `${navigator.userAgent} ${navigator.platform ?? ""}`.toLowerCase();
  if (hint.includes("win")) return "windows";
  if (hint.includes("mac")) return "mac";
  return "";
}

/** 一个下载按钮：标题的翻译键 + 地址。 */
type DownloadOption = { key: string; labelKey: TranslationKey; url: string };

/**
 * 摆哪几个按钮、按什么顺序。
 *
 * 只摆填过的：没登记地址的系统给一个按钮，点下去就是 404，比没有按钮更糟。
 * 通用下载页排在最后，标题也不一样 —— 有分系统的按钮时它是「其他版本」，
 * 一个分系统的都没有时它就是**那个**下载按钮。
 */
function downloadOptions(downloads: ConsumerClientDownloads): DownloadOption[] {
  const byPlatform: DownloadOption[] = (
    [
      { key: "windows", labelKey: "keys.client.windows", url: downloads.windows },
      { key: "mac-arm64", labelKey: "keys.client.macArm64", url: downloads.macArm64 },
      { key: "mac-x64", labelKey: "keys.client.macX64", url: downloads.macX64 },
    ] as DownloadOption[]
  ).filter((option) => Boolean(option.url));

  if (guessOS() === "mac") {
    // Mac 上把两个 mac 的包提到前面，两者之间的顺序不动（Apple 芯片在前）。
    byPlatform.sort((left, right) => Number(right.key.startsWith("mac")) - Number(left.key.startsWith("mac")));
  }

  if (byPlatform.length === 0) {
    return downloads.default ? [{ key: "default", labelKey: "keys.client.download", url: downloads.default }] : [];
  }
  if (downloads.default) {
    byPlatform.push({ key: "default", labelKey: "keys.client.other", url: downloads.default });
  }
  return byPlatform;
}

/**
 * 浏览器里看控制台时的那一块：把桌面客户端拿到手。
 *
 * 它占的就是桌面端「这台电脑」那一块的位置 —— 两边回答的是同一件事（本机的
 * Claude Code / Codex 接没接上），只是浏览器里的答案还停在前一步：一键写本机配置的
 * 「使用」按钮只有桌面壳里有，没装客户端的人得先装上（不装也行，照下面「接入方式」手填）。
 *
 * 一个系统一个按钮，而不是一个「下载」了事：Windows 的 exe、mac 的两种包互不通用，
 * 而浏览器分不出 Mac 的芯片（见 guessOS），所以由本人挑 —— 他知道自己那台是什么。
 *
 * 用 <a> 而不是 Btn + window.open：这一块只在浏览器里渲染，而浏览器里一条真链接才能
 * 右键另存、复制地址、中键新开一个页 —— 弹窗拦截也拦不到它。
 */
function ClientDownload({ downloads }: { downloads: ConsumerClientDownloads }) {
  const { t } = useLocale();
  const options = downloadOptions(downloads);
  if (options.length === 0) return null;
  return (
    <Card className="gx-rise" style={{ padding: "14px 20px", display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
      <IconMonitor size={16} style={{ color: "var(--gx-faint)", flex: "0 0 auto" }} />
      {/* 基准宽度 220 而不是 flex:1：一排四个按钮在窄窗口里放不下时，要让**按钮整排**
          换到下一行，而不是把这段说明挤成每行两个字。 */}
      <span style={{ display: "flex", flexDirection: "column", gap: 3, minWidth: 0, flex: "1 1 220px" }}>
        <span style={{ fontSize: 13, fontWeight: 600 }}>{t("keys.client.title")}</span>
        <span className="gx-card__hint">{t("keys.client.hint")}</span>
      </span>
      <span style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", flex: "0 1 auto", maxWidth: "100%" }}>
        {options.map((option, index) => (
          <a
            key={option.key}
            // 第一个按对面那个系统排过序，所以它是最可能被点的那个 —— 只给它重色，
            // 四个一样重的按钮等于没有推荐。
            className={`gx-btn ${index === 0 ? "gx-btn--accent" : "gx-btn--ghost"} gx-btn--sm`}
            href={option.url}
            target="_blank"
            rel="noreferrer"
            style={{ textDecoration: "none" }}
          >
            {index === 0 ? <IconDownload size={14} /> : null}
            {t(option.labelKey)}
          </a>
        ))}
      </span>
    </Card>
  );
}

/**
 * 手动接入。三段各一份，因为「改哪个文件、填哪个地址」在每个客户端里都不一样，
 * 而这一步是新用户最容易卡住的地方。屏幕上显示的是占位符，「复制（含密钥）」那一下才去取明文。
 */
function ConnectCard({
  keyView,
  baseUrl,
  desktop,
  available,
  loadSecret,
}: {
  keyView: ConsumerKeyView;
  baseUrl: string;
  desktop: boolean;
  /** 明文取得到。取不到就只给不含密钥的那份命令。 */
  available: boolean;
  loadSecret: (key: ConsumerKeyView) => Promise<{ secret: string; baseUrl: string }>;
}) {
  const { t } = useLocale();
  const [tab, setTab] = useState<SnippetTab>(defaultSnippetTab(keyView.category));
  const [copied, setCopied] = useState("");
  const shownBase = tab === "claude" ? hostRoot(baseUrl) : apiBase(baseUrl);

  const copyWithSecret = async () => {
    try {
      const secret = await loadSecret(keyView);
      const ok = await copyText(buildSnippet(tab, secret.baseUrl || baseUrl, secret.secret, keyView.category, keyView.modelId, keyView.modelTier));
      if (ok) message.success(t("keys.snippetCopied"));
      else message.error(t("keys.copyFailed"));
    } catch (error) {
      message.error((error as Error).message || t("common.actionFailed"));
    }
  };

  return (
    <Card className="gx-rise gx-rise--2">
      <CardHead
        title={t("keys.connect")}
        action={
          <Seg
            value={tab}
            onChange={setTab}
            options={[
              { value: "claude" as const, label: "Claude Code" },
              { value: "codex" as const, label: "Codex" },
              { value: "curl" as const, label: "cURL" },
            ]}
          />
        }
      />
      <div style={{ padding: "0 18px 18px", display: "flex", flexDirection: "column", gap: 12 }}>
        {baseUrl ? (
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span className="gx-label" style={{ flex: "0 0 auto" }}>
              {t("keys.baseUrl")}
            </span>
            <code className="gx-mono" style={{ flex: 1, fontSize: 12.5, overflow: "hidden", textOverflow: "ellipsis" }}>
              {shownBase}
            </code>
            <CopyBtn value={shownBase} label={t("common.copy")} copied={copied === "base"} onCopied={() => setCopied("base")} />
          </div>
        ) : null}
        <pre className="gx-code" style={{ margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
          {buildSnippet(tab, baseUrl, SECRET_PLACEHOLDER, keyView.category, keyView.modelId, keyView.modelTier)}
        </pre>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <CopyBtn
            value={buildSnippet(tab, baseUrl, SECRET_PLACEHOLDER, keyView.category, keyView.modelId, keyView.modelTier)}
            label={t("keys.copySnippet")}
            copied={copied === tab}
            onCopied={() => setCopied(tab)}
          />
          {available && keyView.status !== "revoked" ? (
            <Btn tone="ghost" small icon={<IconCopy size={14} />} onClick={() => void copyWithSecret()}>
              {t("keys.copySnippetWithSecret")}
            </Btn>
          ) : null}
        </div>
        <span className="gx-card__hint">
          {tab === "claude" ? t("keys.connectHint.claude") : tab === "codex" ? t("keys.connectHint.codex") : t("keys.connectHint")}
          {desktop && tab !== "curl" ? ` ${t("keys.connectHint.desktop")}` : ""}
        </span>
      </div>
    </Card>
  );
}
