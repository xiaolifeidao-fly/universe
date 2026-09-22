"use client";

/**
 * 账户页最上面那一块：这台电脑。
 *
 * 打开账户页头一件要确认的是「我坐着的这台接上没有」，所以它排第一，而且把两处的信息
 * 合成一块：本机 bridge 报的连接状态和工具版本（只有本机问得到），加上平台上这台机器的
 * 记录（版本、心跳、解绑）。以前后者混在「我的机器」列表里，前者在页面最底下，
 * 同一台机器拆成两截，名下机器一多就更找不着。
 *
 * 状态和版本都是问本机 bridge 拿的，浏览器够不到别的机器，所以纯浏览器调试时整块不显示。
 *
 * 这里不给启动 / 停止 / 重启。内置 bridge 没有要人照看的生命周期：配对过的机器
 * 打开 Nova 就自己接上，配对、改绑平台时 runner 自己停自己起，连不上 Hub 时自己
 * 退避重试。「停止」也只停内存里的 runner，下次打开 Nova 又会自动起来 —— 想暂停接单
 * 该用「今天」页的共享总开关（服务端暂停，重启不丢），想彻底不接用这里的解绑。
 * 只有已配对却没在跑（启动出错、开发时关了自启）才给一个「重新连接」兜底。
 *
 * 装和升都是异步的：npm 全局安装几十秒起步，接口拉起就返回。所以点完之后这一格自己
 * 盯着 —— 走到哪一步、进度条、已经花了多久，全从 bridge 报的 job 来，轮询也跟着提到
 * 一秒一次，完事再说一声。以前这里只弹一句「装完自己刷新一下」：于是要么守着点刷新，
 * 要么以为没点上又点一次（两个 npm 同时写全局 node_modules，装出来什么样没人说得准）。
 */

import { message } from "antd";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { IconMonitor, IconRefresh } from "@/components/ui/icons";
import { Btn, Card, CardHead, LiveDot, Note, Pill } from "@/components/ui/kit";
import { useLocale, type TranslationKey } from "@/i18n/LocaleProvider";
import { formatMillis, formatRelative } from "@/utils/format";
import { isDesktop } from "@/utils/product";
import { bridgeApi, fetchTools, syncBridgeHub, upgradeTool, type BridgeRuntimeStatus, type ToolStatus } from "../../api/bridge.api";
import { fetchProviderEndpoint, nodeDisplayName, type NodeView } from "../../api/provider.api";

const ellipsis = { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } as const;

/**
 * nodes 是主人名下在用的机器（没加载成功时是 null）。拿它做两件事：
 *   · 找出这台电脑在平台上的那条记录 —— 版本、心跳、解绑都从它来；
 *   · 判断「本机自认为配着，平台却已经不认」：在控制台解绑这台电脑之后，本机令牌文件还在，
 *     bridge 只会在后台一遍遍被 401 退回来，状态停在「正在连接平台」—— 不点破的话，
 *     主人会一直等，而且哪儿都没有重新配对的入口。
 * 列表没加载成功时不下这个判断：空列表会让它误报「已解绑」。
 */
export function ThisComputerPanel({
  nodes,
  busy,
  onUnbind,
  onRefresh,
}: {
  nodes: NodeView[] | null;
  busy: boolean;
  onUnbind: (node: NodeView) => void;
  /** 刷新时连平台上的记录一起拉：心跳时间在那边。 */
  onRefresh: () => void;
}) {
  const { t } = useLocale();
  const router = useRouter();
  const [status, setStatus] = useState<BridgeRuntimeStatus | null>(null);
  const [tools, setTools] = useState<ToolStatus[]>([]);
  const [error, setError] = useState("");
  const [acting, setActing] = useState("");

  const load = useCallback(async () => {
    if (!isDesktop()) return;
    try {
      setStatus(await bridgeApi.getStatus());
      setError("");
    } catch (loadError) {
      setError((loadError as Error).message);
    }
    try {
      // ai-bridge 不摆进「本机工具」：它随 Nova 分发，没有自己的升级通道，
      // 列出来只是多一个看着要人管、实际按不动的东西。这一行只留真要主人自己升的外部工具。
      setTools((await fetchTools()).filter((tool) => tool.name !== "ai-bridge"));
    } catch {
      // 工具版本要问 npm 拿最新版，网络不通就没有。拿不到不显示这一行，
      // 比显示一排「未知」有用 —— 后者会让人以为工具坏了。
      setTools([]);
    }
  }, []);

  // 有东西在装时把轮询提到一秒一次 —— 进度条要看着它动。平时 5 秒够了：
  // 这一路每次都要问 npm 要最新版、问 CLI 要本机版（bridge 那边有缓存，但也不是白来的）。
  const installing = tools.some((tool) => tool.job?.state === "running");

  useEffect(() => {
    void load();
    if (!isDesktop()) return undefined;
    const timer = setInterval(() => void load(), installing ? 1_000 : 5_000);
    return () => clearInterval(timer);
  }, [load, installing]);

  // 装完 / 装挂了要说一声：点完按钮的人多半已经去干别的了，
  // 回头瞥一眼看见的只是一个不再动的进度条，分不出是装好了还是卡住了。
  const announced = useRef<Record<string, string> | null>(null);
  useEffect(() => {
    if (tools.length === 0) return;
    const settled: Record<string, string> = {};
    for (const tool of tools) {
      if (tool.job && tool.job.state !== "running") settled[tool.name] = tool.job.state;
    }
    const before = announced.current;
    announced.current = settled;
    // 头一轮只记下现状。进页面时正好挂着一条刚结束的记录（bridge 会留一会儿），
    // 那件事发生在上一次打开这个页面的时候，不该再弹一次。
    if (!before) return;
    for (const tool of tools) {
      const job = tool.job;
      if (!job || job.state === "running" || before[tool.name] === job.state) continue;
      if (job.state === "succeeded") {
        const key = job.action === "install" ? "bridge.toolsInstalled" : "bridge.toolsUpgraded";
        message.success(t(key, { name: tool.name }));
      } else {
        message.error(t("bridge.toolsJobFailed", { name: tool.name, message: job.detail }));
      }
    }
  }, [tools, t]);

  // 进这个页面时校准一次平台地址：控制台连的是哪台，本机就该绑哪台。
  //
  // 平台的对外地址由部署方在 galaxy.provider_hub_url 里定，换了域名或机房之后
  // 本机配置不会自己跟上 —— 这一格显示的还是旧地址，而且重新配对会被
  // 「本机已绑定其他平台」拦住，主人只能去 userData 里手改 yaml。
  //
  // 只在进页面时做，不挂在 load() 上：那是 5 秒一次的轮询，跟着它跑等于
  // 每 5 秒问一次平台，而这个地址不会一分钟变三回。
  useEffect(() => {
    if (!isDesktop()) return;
    void (async () => {
      try {
        const endpoint = await fetchProviderEndpoint();
        if (!endpoint.hubUrl) return;
        const synced = await syncBridgeHub(endpoint.hubUrl);
        // 换平台等于旧令牌作废，得让主人知道要重配一次，
        // 否则他看到的是「地址对了但一直未连接」。
        if (synced.changed) message.warning(t("bridge.hubRebound", { hub: synced.hubURL }));
      } catch {
        // 平台地址拿不到（离线、接口还没起来）就先不校准。
        // 拿一个猜出来的地址去覆盖正在用的配置，比不校准糟得多。
      } finally {
        void load();
      }
    })();
  }, [load, t]);

  if (!isDesktop()) return null;

  const reconnect = async () => {
    setActing("reconnect");
    try {
      setStatus(await bridgeApi.restart());
      setError("");
    } catch (actionError) {
      message.error((actionError as Error).message || t("common.actionFailed"));
    } finally {
      setActing("");
    }
  };

  /** 装、升、失败后重试，都是同一条命令（`npm i -g <包>@latest`），只有界面上的说法不同。 */
  const install = async (tool: ToolStatus) => {
    setActing(tool.name);
    try {
      await upgradeTool(tool.name);
      // 马上拉一次：进度条这就该出来，等下一轮的话中间有一秒什么都没发生。
      await load();
    } catch (upgradeError) {
      message.error((upgradeError as Error).message || t("common.actionFailed"));
    } finally {
      setActing("");
    }
  };

  const state = status?.state ?? "stopped";
  const paired = Boolean(status?.paired);
  const node = paired && status?.nodeId ? (nodes?.find((item) => item.nodeId === status.nodeId) ?? null) : null;
  const detached = Boolean(paired && status?.nodeId && nodes && !node);
  const stateLabel = t(`bridge.state.${state}` as TranslationKey);

  // 状态还没拿到时什么都不说：先闪一下「还没加入共享池」再变成「已连接」，比空着更误导。
  // 配着且平台上找得到这台时，大字写机器名、状态放右边的标签里；
  // 平台列表没拿到时找不着记录，大字只能写连接状态。
  const headline = !status
    ? "—"
    : detached
      ? t("bridge.detached")
      : !paired
        ? t("bridge.unpaired")
        : node
          ? nodeDisplayName(node)
          : stateLabel;

  const pill =
    !node ? null : node.banned ? (
      <Pill tone="err">{t("share.machineBanned")}</Pill>
    ) : (
      <Pill tone={state === "running" ? "ok" : state === "error" ? "err" : state === "starting" ? "warn" : "default"}>
        {state === "running" ? <LiveDot /> : null}
        {stateLabel}
      </Pill>
    );

  const action = !status ? null : !paired || detached ? (
    // 解绑过的电脑也走配对：本机旧令牌不用手动清，配对时会带上旧 nodeId，新令牌直接覆盖。
    <Btn tone={detached ? "accent" : "ghost"} small onClick={() => router.push("/provider/pair")}>
      {detached ? t("bridge.repair") : t("bridge.pair")}
    </Btn>
  ) : state === "stopped" || state === "error" ? (
    <Btn tone="ghost" small loading={acting === "reconnect"} onClick={() => void reconnect()}>
      {t("bridge.reconnect")}
    </Btn>
  ) : null;

  return (
    <Card className="gx-rise">
      <CardHead
        title={t("bridge.runtime")}
        action={
          <Btn
            tone="ghost"
            small
            icon={<IconRefresh size={14} />}
            onClick={() => {
              void load();
              onRefresh();
            }}
          >
            {t("common.refresh")}
          </Btn>
        }
      />
      <div style={{ padding: "0 18px 16px", display: "flex", flexDirection: "column" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 14, padding: "14px 0", borderTop: "1px solid var(--gx-line)" }}>
          <span
            style={{
              width: 40,
              height: 40,
              flex: "0 0 auto",
              borderRadius: 11,
              display: "grid",
              placeItems: "center",
              background: "var(--gx-muted)",
              color: "var(--gx-soft)",
            }}
          >
            <IconMonitor size={20} />
          </span>
          <span style={{ flex: 1, minWidth: 0 }}>
            <span
              title={node ? `${nodeDisplayName(node)} · ${node.nodeId}` : undefined}
              style={{ display: "block", fontSize: 15, fontWeight: 600, ...ellipsis }}
            >
              {headline}
            </span>
            {!status ? null : paired && !detached ? (
              <>
                {node ? (
                  <span className="gx-mono" style={{ display: "block", fontSize: 11, color: "var(--gx-faint)", marginTop: 4, ...ellipsis }}>
                    {node.lastBeatAt ? t("share.machineBeat", { value: formatRelative(node.lastBeatAt) }) : t("share.machineNeverSeen")}
                  </span>
                ) : null}
                <span
                  className="gx-mono"
                  // 窗口窄时平台地址会被截掉，悬停给全文。
                  title={t("bridge.identity", { node: status.nodeId || "-", hub: status.hubURL || "-" })}
                  style={{ display: "block", fontSize: 11, color: "var(--gx-faint)", marginTop: node ? 2 : 4, ...ellipsis }}
                >
                  {t("bridge.identity", { node: status.nodeId || "-", hub: status.hubURL || "-" })}
                </span>
              </>
            ) : (
              // 没配、被解绑时副行是一句要读完的话，不截断。
              <span
                style={{
                  display: "block",
                  fontSize: 12,
                  lineHeight: 1.6,
                  marginTop: 4,
                  color: detached ? "var(--gx-warn-ink)" : "var(--gx-faint)",
                }}
              >
                {detached ? t("bridge.detachedHint", { node: status.nodeId || "-" }) : t("bridge.unpairedHint")}
              </span>
            )}
          </span>
          {pill}
          {action}
        </div>

        {error || status?.error ? (
          <div style={{ marginBottom: 14 }}>
            <Note tone="danger">{error || status?.error}</Note>
          </div>
        ) : null}

        {tools.length > 0 ? (
          <div style={{ display: "flex", alignItems: "center", gap: "8px 14px", padding: "12px 0", borderTop: "1px solid var(--gx-line)", flexWrap: "wrap" }}>
            <span style={{ fontSize: 12.5, color: "var(--gx-soft)" }}>{t("bridge.tools")}</span>
            {tools.map((tool) => (
              <ToolRow key={tool.name} tool={tool} busy={acting === tool.name} onRun={() => void install(tool)} t={t} />
            ))}
          </div>
        ) : null}

        {/* 没配对、平台上找不着这台时整行不画：只剩一条分隔线的空格子比没有更碍眼。 */}
        {node ? (
          <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", paddingTop: 12, borderTop: "1px solid var(--gx-line)" }}>
            <Btn tone="danger" small disabled={busy} onClick={() => onUnbind(node)}>
              {t("account.unbindLocal")}
            </Btn>
          </div>
        ) : null}
      </div>
    </Card>
  );
}

/**
 * 「本机工具」里的一格：名字 · 版本 · 这会儿该给它什么。
 *
 * 装着的时候这一格变成进度。阶段（查依赖 / 下载 / 写入本机）是 bridge 从 npm 的输出里
 * **认出来**的，百分比是按取了几个包估的 —— npm 根本不报百分比，所以旁边还写着一个真的
 * 秒数：卡住的时候，不动的秒数比不动的进度条更说明问题。
 *
 * 装挂了不自动重来，也不把那条记录一抹了事：原因留在这儿（鼠标停上去是 npm 的原话和
 * 那条命令，实在不行照着去终端跑一遍），旁边给一个「重试」。
 */
function ToolRow({
  tool,
  busy,
  onRun,
  t,
}: {
  tool: ToolStatus;
  busy: boolean;
  onRun: () => void;
  t: (key: string, vars?: Record<string, string | number>) => string;
}) {
  const job = tool.job;
  const running = job?.state === "running";
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12.5 }}>
      <b style={{ fontWeight: 600 }}>{tool.name}</b>
      <span className="gx-mono gx-muted">{tool.installed ? tool.current : t("bridge.toolsMissing")}</span>
      {running && job ? (
        <>
          <span className="gx-pill gx-pill--sm">
            {t(job.action === "install" ? "bridge.toolsInstalling" : "bridge.toolsUpgrading")}
          </span>
          {/* 进度条只表示「还在动」，所以不给它数字以外的强调色，宽度也压到一行放得下。 */}
          <span className="gx-meter" style={{ display: "block", width: 64, flex: "0 0 auto" }}>
            <span className="gx-meter__fill" style={{ display: "block", width: `${job.percent}%` }} />
          </span>
          <span className="gx-mono" style={{ fontSize: 11, color: "var(--gx-faint)" }} title={job.detail || undefined}>
            {job.percent}% · {t(`bridge.toolsPhase.${job.phase}`)} · {formatMillis(job.elapsedMs)}
          </span>
        </>
      ) : job?.state === "failed" ? (
        <>
          <span className="gx-pill gx-pill--sm gx-pill--err" title={[job.detail, job.command].filter(Boolean).join("\n\n")}>
            {t("bridge.toolsFailed")}
          </span>
          <Btn tone="soft" small loading={busy} onClick={onRun}>
            {t("bridge.toolsRetry")}
          </Btn>
        </>
      ) : tool.upgradable ? (
        <Btn tone="soft" small loading={busy} onClick={onRun}>
          {t("bridge.toolsUpgrade")} {tool.latest}
        </Btn>
      ) : !tool.installed ? (
        // 没装的工具以前只写一句「未安装」，装它得自己去开终端 —— 而这台机器接不接得了单，
        // 正取决于它装没装。
        <Btn tone="soft" small loading={busy} onClick={onRun}>
          {t("bridge.toolsInstall")}
        </Btn>
      ) : tool.latest ? (
        <span className="gx-pill gx-pill--sm gx-pill--ok">{t("bridge.toolsLatest")}</span>
      ) : null}
    </span>
  );
}
