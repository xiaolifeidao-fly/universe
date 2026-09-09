"use client";

import { CheckCircleFilled, CopyOutlined } from "@ant-design/icons";
import { Alert, Button, Space, Steps, Tag, Typography, message } from "antd";
import Link from "next/link";
import { useEffect, useState } from "react";
import { useLocale } from "@/i18n/LocaleProvider";
import { copyText, formatTime } from "@/utils/format";
import {
  BRIDGE_PORT,
  clearBridgeConnFromUrl,
  pingBridge,
  readBridgeConn,
  type BridgeConn,
} from "../../api/bridge.api";
import {
  acceptTerms,
  fetchProviderEndpoint,
  issuePairingCode,
  type NodeView,
  type PairingCode,
  type TermsStatus,
} from "../../api/provider.api";
import { BridgeSetupPanel } from "./BridgeSetupPanel";
import { InstallGuide } from "./InstallGuide";

const { Paragraph } = Typography;

/** 「我装好了」记在本地：装在哪台机器上平台无从知道，刷新一次就重来会很烦人。 */
const INSTALLED_KEY = "galaxy-provider-installed";

/**
 * 加入共享池，三步走：装插件 → 同意条款 → 配对并勾选要共享的能力。
 *
 * 横向 Steps 当导航用，下面是当前那一步的正文。**没走完的下一步点不进去** ——
 * 顺序不是装饰：没同意条款拿不到配对码（服务端在签发和 pair 两处各拒一次），
 * 没装插件拿到码也没地方粘。让人点进一个必然卡住的步骤，只会让他以为是页面坏了。
 *
 * 三步的完成信号强弱不同，界面上如实区分：
 *
 * - **装插件**没有任何可核实的信号 —— 装在别人的机器上，hello 之前平台什么都看不见。
 *   所以这一步靠用户自己点「我装好了」，记在 localStorage 里。这是自述，不是校验。
 * - **同意条款**有服务端的同意记录，可信。
 * - **配对**以「名下真的有机器加入」为准 —— 那是整条链路走通唯一的证据。
 *
 * 第三步有两副面孔，取决于地址栏里有没有本机向导的连接参数（?bridge=&t=）：
 *   · 有 —— 本机 `ai-bridge pool setup --console <本站>` 打开的就是这个地址。
 *     配对码在这里生成、就地粘、直接打到本机 bridge，全程不用离开控制台。
 *   · 没有 —— 退回老路子：给码 + 告诉他去那台机器上跑哪条命令。离线机器、
 *     或者浏览器拦了跨源请求时，本机那个页面始终是能走通的兜底。
 *
 * 名下已经有机器在线时，第三步换成第三副面孔：只说明现状，配对的入口一个都不给。
 * 服务端在签发配对码那里也拒（见 IssuePairingCode）—— 这里藏起来是为了不让人白点，
 * 真正的闸在那边。
 */
export function JoinPoolCard({
  terms,
  joined,
  online,
  onAccepted,
  onPaired,
}: {
  terms: TermsStatus | null;
  /** 名下已经有机器加入。它是「三步都走完了」唯一可信的信号。 */
  joined: boolean;
  /** 名下第一台在线的机器。非空就不再放出任何配对入口。 */
  online: NodeView | null;
  onAccepted: () => void;
  /** 刚在本页完成配对。父级据此立刻重拉一次机器列表，不必等 20 秒轮询。 */
  onPaired: () => void;
}) {
  const { t } = useLocale();
  const [accepting, setAccepting] = useState(false);
  const [pairing, setPairing] = useState(false);
  const [code, setCode] = useState<PairingCode | null>(null);
  const [installed, setInstalled] = useState(false);
  const [step, setStep] = useState(0);
  const [conn, setConn] = useState<BridgeConn | null>(null);
  const [origin, setOrigin] = useState("");
  // 平台自报的对外地址，以及本机 ai-bridge 连的是不是它。两个都可能拿不到：
  // 前者要部署方配、后者要本机在跑且是新版 bridge，所以 hubMatches 用三态
  // （undefined = 没结论，不显示任何比对文案）。
  const [hubUrl, setHubUrl] = useState("");
  const [hubMatches, setHubMatches] = useState<boolean | undefined>(undefined);

  // 连接参数和 origin 都只有浏览器里才有。和下面的 localStorage 一样必须放 effect：
  // 首屏是在服务端渲染的，直接读会让首次客户端渲染和服务端产物对不上。
  useEffect(() => {
    setOrigin(window.location.origin);
    // 优先用地址里带的连接参数（首次引导那一档，带令牌）。
    const fromUrl = readBridgeConn();
    if (fromUrl) setConn(fromUrl);

    // 平台地址每一档都要问 —— 向导那一档更需要，它下面那个 hubURL 输入框
    // 要填的就是这个值。拿不到就不显示那一块：没配 provider_hub_url 的部署
    // 宁可什么都不说，也不该显示一个猜出来的地址让人照着填。
    //
    // 没带连接参数时还要接着探本机的常驻接口。**那才是「随时打开控制台就能配」
    // 的入口** —— 只认 URL 参数的话，就只有刚跑完安装命令那一次能进配对界面，
    // 之后想重新配对只能回终端再跑一遍。串在平台地址后面，是因为这一探要顺便
    // 拿它问一句「你连的是不是这个」；前一问失败也要继续探，探测是「显不显示
    // 配对表单」的前提，不能被一个可选的展示字段拖垮。
    void fetchProviderEndpoint()
      .then((result) => result?.hubUrl ?? "")
      .catch(() => "")
      .then((url) => {
        setHubUrl(url);
        if (fromUrl) return null;
        return pingBridge(url ? { hubUrl: url } : {});
      })
      .then((ping) => {
        if (!ping?.running) return;
        setConn({ port: BRIDGE_PORT, resident: true });
        setHubMatches(ping.hubMatches);
      });
  }, []);

  // 有机器在线时这一页不再配对，向导令牌留在地址栏就只剩坏处：抹掉它，免得跟着
  // 浏览器历史和「复制当前网址」跑出去。依赖写成布尔量 —— online 每轮轮询都是
  // 一个新对象，直接依赖它会让这个 effect 每 20 秒空跑一次。
  const hasOnline = online !== null;
  useEffect(() => {
    if (hasOnline) clearBridgeConnFromUrl();
  }, [hasOnline]);

  // localStorage 只能在浏览器里读，所以放 effect 里；读到之后把光标挪到第一个没做完的步骤。
  useEffect(() => {
    const done = typeof window !== "undefined" && window.localStorage.getItem(INSTALLED_KEY) === "1";
    // 带着连接参数进来的人显然已经装好、而且已经把向导跑起来了，
    // 第一步不用再问他一遍「装好了吗」。
    const ready = done || joined || conn !== null;
    setInstalled(ready);
    setStep(joined || terms?.accepted ? 2 : ready ? 1 : 0);
  }, [joined, terms?.accepted, conn]);

  const accepted = Boolean(terms?.accepted);
  // 带上 --console 本站地址：向导会打印/打开一个带连接参数的控制台地址，
  // 用户点进来就落回这一步，配对直接在这儿完成。origin 还没读到时退回裸命令。
  const setupCommand = origin ? `ai-bridge pool setup --console ${origin}` : "ai-bridge pool setup";
  // 每一步的完成状态。joined 为真说明三步显然都走完了，逐个再判一遍没有意义。
  const done = [installed || joined, accepted || joined, joined];
  // 能走到第几步：前面全做完才解锁下一步。
  const reachable = done[0] ? (done[1] ? 2 : 1) : 0;

  const markInstalled = () => {
    try {
      window.localStorage.setItem(INSTALLED_KEY, "1");
    } catch {
      // 隐私模式下写不进去。不影响这一次的流程，下次刷新退回第一步而已。
    }
    setInstalled(true);
    setStep(1);
  };

  const accept = async () => {
    setAccepting(true);
    try {
      await acceptTerms();
      onAccepted();
      setStep(2);
    } catch (error) {
      message.error((error as Error).message || t("common.loadFailed"));
    } finally {
      setAccepting(false);
    }
  };

  const pair = async () => {
    setPairing(true);
    try {
      setCode(await issuePairingCode());
    } catch (error) {
      message.error((error as Error).message || t("common.loadFailed"));
    } finally {
      setPairing(false);
    }
  };

  const copy = async (value: string) => {
    const ok = await copyText(value);
    if (ok) message.success(t("common.copied"));
    else message.warning(t("common.copyFailed"));
  };

  const goto = (next: number) => {
    if (next <= reachable) {
      setStep(next);
      return;
    }
    // 报**真正卡住的那一步**，不是被点的那一步：还没装插件的人点第三步，
    // 回一句「先同意条款」会把他支到一个同样走不通的地方。
    message.info(t(!done[0] ? "provider.step.needInstall" : "provider.step.needAccept"));
  };

  return (
    <section className="galaxy-card">
      <div className="galaxy-card__head">
        <div style={{ flex: 1, minWidth: 0 }}>
          <h2>{t("provider.join.title")}</h2>
          <p>{t("provider.join.terms")}</p>
        </div>
        {terms?.accepted ? (
          <Tag icon={<CheckCircleFilled />} color="success">
            {t("provider.join.accepted").replace("{version}", terms.version)}
          </Tag>
        ) : null}
      </div>

      {/* 条款原文摆在三步之上，不折叠、不藏在链接后面：被封的是主人自己的账号，
          这件事必须在他动手之前就看见。 */}
      <Alert type="warning" showIcon message={t("provider.join.termsBody")} style={{ marginBottom: 18 }} />

      {/* 正在看的那一步永远是 process（高亮），其余按完成与否给 finish / wait。
          不能写成「完成了就 finish」—— 回头看一个已完成的步骤时，三步会全是
          finish/wait，一个高亮都没有，看不出自己停在哪儿。

          刻意**不**设 disabled：antd 会连 onChange 都不触发，点上去毫无反应，
          用户只会以为页面坏了。wait 状态已经把它渲染成灰的（够表达「还没轮到」），
          真点了则由 goto 说清楚卡在哪一步。 */}
      <Steps
        size="small"
        current={step}
        onChange={goto}
        style={{ marginBottom: 20 }}
        items={[t("provider.install.title"), t("provider.join.accept"), t("provider.join.pair")].map(
          (title, index) => ({
            title,
            status: index === step ? "process" : done[index] ? "finish" : "wait",
          }),
        )}
      />

      {step === 0 ? (
        <Panel hint={t("provider.install.hint")}>
          <InstallGuide />
          <div style={{ marginTop: 14 }}>
            <Button type="primary" onClick={markInstalled}>
              {t("provider.install.done")}
            </Button>
            {/* 说明白这一步是自述而不是校验，免得用户以为平台已经确认过了。 */}
            <span style={{ marginLeft: 10, color: "var(--manager-text-muted)" }}>
              {t("provider.install.doneHint")}
            </span>
          </div>
        </Panel>
      ) : null}

      {step === 1 ? (
        <Panel hint={t("provider.join.acceptHint")}>
          <Button type="primary" loading={accepting} disabled={accepted} onClick={() => void accept()}>
            {accepted ? t("provider.join.acceptDone") : t("provider.join.accept")}
          </Button>
        </Panel>
      ) : null}

      {/* 已经有机器在线：配对的东西一个都不出现 —— 不是灰掉，是不渲染。
          灰着的按钮还得让人猜为什么点不动，而这里的原因（已经有一台在跑）
          一句话就说得完，说完也就没有什么可点的了。 */}
      {step === 2 && online ? (
        <Panel hint={t("provider.join.onlineHint")}>
          <Alert
            type="success"
            showIcon
            message={t("provider.join.onlineTitle").replace("{name}", online.displayName || online.nodeId)}
            description={
              <>
                <Paragraph style={{ marginBottom: 8 }}>{t("provider.join.onlineSwitch")}</Paragraph>
                <Link href="/provider/contributions">{t("provider.bridge.next")}</Link>
              </>
            }
          />
        </Panel>
      ) : null}

      {step === 2 && !online ? (
        <Panel hint={t(conn ? "provider.join.pairHintBridge" : "provider.join.pairHint")}>
          <Space wrap>
            <Button type="primary" loading={pairing} onClick={() => void pair()}>
              {t("provider.join.pairAction")}
            </Button>
          </Space>

          {/* 连上本机 bridge 时**不**单独显示配对码：它会直接填进下面表单里的只读框。
              同一个码显示两遍，只会让人以为还得自己复制粘贴一次。
              没连上时才需要这一块 —— 那种情况下码是要拿去别的机器上用的。 */}
          {code && !conn ? (
            <div style={{ marginTop: 14 }}>
              {/* 配对码是粘进本机那个配置向导页面的，不是敲在命令行上的 ——
                  所以复制按钮复制的是**码本身**，不是一整条命令。 */}
              <Paragraph style={{ marginBottom: 6, color: "var(--manager-text-muted)" }}>
                {t("provider.join.codeLabel")}
              </Paragraph>
              <div className="galaxy-secret">
                <code style={{ flex: 1, fontSize: 16, letterSpacing: 1 }}>{code.code}</code>
                <Button size="small" icon={<CopyOutlined />} onClick={() => void copy(code.code)}>
                  {t("common.copy")}
                </Button>
              </div>
              <Paragraph style={{ marginTop: 6, marginBottom: 12, color: "var(--manager-text-muted)" }}>
                {t("provider.join.pairExpires").replace("{time}", formatTime(code.expiresAt))}
              </Paragraph>

              <Paragraph style={{ marginBottom: 6, color: "var(--manager-text-muted)" }}>
                {t("provider.join.setupHint")}
              </Paragraph>
              <div className="galaxy-secret">
                <code style={{ flex: 1 }}>{setupCommand}</code>
                <Button size="small" icon={<CopyOutlined />} onClick={() => void copy(setupCommand)}>
                  {t("common.copy")}
                </Button>
              </div>
            </div>
          ) : null}

          {conn ? (
            <div style={{ marginTop: 18 }}>
              <BridgeSetupPanel conn={conn} code={code} onPaired={onPaired} />
            </div>
          ) : null}
        </Panel>
      ) : null}

      {/* 平台地址摆在三步之外、每一步都看得见：它既是配之前要填的东西，
          也是配完之后排障唯一的锚点。 */}
      <HubAddress hubUrl={hubUrl} hubMatches={hubMatches} onCopy={copy} />
    </section>
  );
}

/**
 * 平台地址（base_url）—— **只读**。
 *
 * 为什么是只读：常驻接口对所有来源开放且不要令牌，Hub 地址在 bridge 启动时就锁死
 * （setup/server.ts 的 pinnedHub）。要是这儿能改，任何网站都能调你本机那个端口，
 * 把这台机器改判到它自己的 Hub 上，之后拿你的订阅额度干活 —— 装了 LaunchAgent
 * 的话还是开机自动的。换 Hub 必须回到那台机器上，下面那条命令就是干这个的。
 *
 * 为什么值得单独占一块：节点连错地址时它不会出现在**任何**列表里，控制台上能看到的
 * 只有一个空列表和消费者那头的「共享池暂无可用算力」，没有一处提示地址不对。
 * 把地址摆出来、再把本机的比对结论跟在后面，这类故障一眼就能认出来。
 */
function HubAddress({
  hubUrl,
  hubMatches,
  onCopy,
}: {
  hubUrl: string;
  /** 本机 ai-bridge 连的是不是这个平台。undefined = 没探到本机或版本旧，不下结论。 */
  hubMatches?: boolean;
  onCopy: (value: string) => void;
}) {
  const { t } = useLocale();
  // 部署方没配就整块不显示：显示一个猜出来的地址比不显示更坏。
  if (!hubUrl) return null;
  return (
    <div style={{ marginTop: 24, paddingTop: 18, borderTop: "1px solid var(--manager-border, rgba(0,0,0,0.06))" }}>
      <div style={{ fontWeight: 600, marginBottom: 6 }}>{t("provider.join.hubTitle")}</div>
      <Paragraph style={{ marginBottom: 10, color: "var(--manager-text-muted)" }}>
        {t("provider.join.hubHint")}
      </Paragraph>
      <div className="galaxy-secret">
        <code style={{ flex: 1, wordBreak: "break-all" }}>{hubUrl}</code>
        <Button size="small" icon={<CopyOutlined />} onClick={() => onCopy(hubUrl)}>
          {t("common.copy")}
        </Button>
      </div>

      {/* 一致就只说一句。正常状态不值得占更多地方。 */}
      {hubMatches === true ? (
        <Paragraph style={{ marginTop: 8, marginBottom: 0, color: "var(--manager-text-muted)" }}>
          {t("provider.join.hubLocalOk")}
        </Paragraph>
      ) : null}

      {hubMatches === false ? (
        <Alert
          type="warning"
          showIcon
          style={{ marginTop: 12 }}
          message={t("provider.join.hubMismatch")}
          description={
            <>
              <Paragraph style={{ marginBottom: 8 }}>{t("provider.join.hubMismatchHint")}</Paragraph>
              <div className="galaxy-secret">
                <code style={{ flex: 1, wordBreak: "break-all" }}>{`ai-bridge pool setup --hub ${hubUrl}`}</code>
                <Button
                  size="small"
                  icon={<CopyOutlined />}
                  onClick={() => onCopy(`ai-bridge pool setup --hub ${hubUrl}`)}
                >
                  {t("common.copy")}
                </Button>
              </div>
            </>
          }
        />
      ) : null}
    </div>
  );
}

/** 当前步骤的正文。三个面板共用一套排版，免得每个各写一份。 */
function Panel({ hint, children }: { hint: string; children: React.ReactNode }) {
  return (
    <div>
      <Paragraph style={{ marginBottom: 12, color: "var(--manager-text-muted)" }}>{hint}</Paragraph>
      {children}
    </div>
  );
}
