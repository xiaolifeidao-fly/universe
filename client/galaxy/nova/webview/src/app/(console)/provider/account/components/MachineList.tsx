"use client";

/**
 * 账户页的机器列表：这台电脑以外的机器，分「在用」「已解绑」两栏。
 *
 * 名下可能是一排机房服务器。以前每台平铺三行 —— 名字和版本、回连地址、一整句回连报错 ——
 * 再挂两个标签和一个解绑按钮，十台就是一面墙。现在一台一行，只留扫一眼要看的：
 * 在不在线、怎么接进来的、回连通不通。节点 ID、报错原文和解绑收进点开的那一格：
 * 那是排查某一台时才看的，解绑也本该多一步。
 *
 * 解绑掉的机器单独一栏：解绑是终态，它们只留着对账（执行记录和积分里还有它们跑出来的那几笔），
 * 混在在用的机器里只会让人以为还救得回来。
 *
 * 在用的顺序和「今天」「共享设置」一样按名字排（机房-2 在机房-10 前面），不按在线状态：
 * 列表 20 秒刷一次，机器一上下线就挪位置，正要点开的那一行会从手底下跑掉。
 * 已解绑的按解绑先后，最近的在前（服务端排好）。
 *
 * 远程升级也照这个分法：行上只在名字后面挂一个小标签（升级中 / 可升级），扫一眼知道哪几台该升；
 * 版本、平台、上一次升级走到哪、为什么点不了，都在点开的那一格里。已解绑的机器不给升级。
 *
 * 机器上的 claude / codex 同理，摆在点开那一格里：它回答的是「这台为什么接不了 claude 的单」，
 * 属于排查某一台时才看的东西。装和升就地点，进度跟着心跳回来 —— 以前这件事只能 ssh 上去手敲。
 */

import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { IconAlert, IconChevronDown, IconPlus, IconSearch } from "@/components/ui/icons";
import { Btn, Card, CardHead, Loading } from "@/components/ui/kit";
import { useLocale } from "@/i18n/LocaleProvider";
import { formatRelative } from "@/utils/format";
import {
  isNewerBridgeVersion,
  isNodeOnline,
  isUpgradeInProgress,
  nodeDisplayName,
  type NodeView,
} from "../../api/provider.api";
import { isLoginBusy, LoginPanel } from "./LoginPanel";
import { Blank, RowList, TabStrip } from "./parts";
import { ToolRow } from "./ToolRow";

type Tab = "active" | "retired";

/** 两栏加起来到这么多台才给搜索框。三五台时它占掉一行，什么也没省下。 */
const SEARCH_FROM = 6;

/**
 * 状态点 · 名字 · 接入方式 · 状态 · 展开箭头。
 * 中间两列的下限按英文量的：Nova 最窄 960 时要放得下「Direct · unreachable」「Offline · seen 12d ago」。
 */
const COLUMNS = "8px minmax(0, 1.6fr) minmax(156px, 0.7fr) minmax(144px, 0.7fr) 14px";

const ellipsis = { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } as const;

type Translate = (key: string, vars?: Record<string, string | number>) => string;

/** 搜名字、节点 ID 和回连地址：机房里的机器常常只记得 IP。 */
function matches(node: NodeView, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return [node.displayName, node.nodeId, node.endpointUrl].some((field) => (field ?? "").toLowerCase().includes(needle));
}

/**
 * export 机器的回连状态。只对 export 有意义：poll 的机器 Hub 从不主动连它。
 *
 * 和在线绿点是两件事 —— 心跳是节点主动出站的，公网入口不通照样能心跳。
 * 分开显示，主人才看得出「进程活着，但端口没映射对」。
 */
function endpointText(node: NodeView, t: Translate): string {
  if (node.endpointStatus === "ok") return t("account.endpointOk");
  if (node.endpointStatus === "unreachable") {
    return node.endpointError ? `${t("account.endpointDown")} — ${node.endpointError}` : t("account.endpointDown");
  }
  return t("account.endpointPending");
}

/** 成功的那句挂一天就收：之后版本号本身已经说明了，一直挂着像是还有事没完。失败的留到下一次升级。 */
const SUCCEEDED_VISIBLE_MS = 24 * 60 * 60 * 1000;

const PROGRESS_TEXT = {
  downloading: "account.upgradeDownloading",
  installing: "account.upgradeInstalling",
  restarting: "account.upgradeRestarting",
} as const;

/**
 * 上一次升级走到哪了。进行中的几步优先用节点报的人话（「正在下载 0.2.0」），没报就用自己的说法；
 * 等领取、成功这两步由我们来说：那时节点还没说话，或者是 Hub 在重启后的 hello 里判的。
 */
function upgradeStatus(node: NodeView, t: Translate): { text: string; tone: "soft" | "ok" | "danger" } | null {
  const upgrade = node.upgrade;
  if (!upgrade?.status) return null;
  const version = upgrade.version || "-";
  const at = upgrade.updatedAt || upgrade.requestedAt;
  const ago = at ? ` · ${t("account.ago", { value: formatRelative(at) })}` : "";
  switch (upgrade.status) {
    case "pending":
      return { text: t("account.upgradePending", { version }), tone: "soft" };
    case "downloading":
    case "installing":
    case "restarting":
      return { text: upgrade.message || t(PROGRESS_TEXT[upgrade.status], { version }), tone: "soft" };
    case "succeeded": {
      const time = at ? new Date(at).getTime() : Number.NaN;
      if (Date.now() - time > SUCCEEDED_VISIBLE_MS) return null;
      const text = upgrade.fromVersion
        ? t("account.upgradeSucceeded", { from: upgrade.fromVersion, version })
        : t("account.upgradeSucceededPlain", { version });
      return { text: text + ago, tone: "ok" };
    }
    case "failed": {
      const text = upgrade.message
        ? t("account.upgradeFailed", { version, message: upgrade.message })
        : t("account.upgradeFailedPlain", { version });
      return { text: text + ago, tone: "danger" };
    }
    default:
      return null;
  }
}

/**
 * 「升级到 x」为什么点不了；null 是能点。能点的条件只有一条：
 * 在线 && distribution === "cli" && 没有 upgradeBlocker && upgradeAvailable && 不在升级中（升级中由调用方先挡掉）。
 *
 * 顺序是「哪句最先把事说明白」：随 Nova 分发、版本太旧是结构性的，上线也没用，排最前；
 * 障碍（目录不可写、没有发布公钥）排在「已是最新」前面 —— 不修，下一版照样升不了；
 * 离线排最后：离线又已是最新时说「上线后才能升级」是在误导。
 */
function upgradeBlocked(node: NodeView, t: Translate): { text: string; warn?: boolean } | null {
  if (node.distribution === "nova") return { text: t("account.upgradeNova") };
  if (node.distribution !== "cli") return { text: t("account.upgradeLegacy") };
  if (node.upgradeBlocker) return { text: node.upgradeBlocker, warn: true };
  if (!node.latestVersion) return { text: t("account.upgradeNoPackage") };
  if (!node.upgradeAvailable) return { text: t("account.upgradeLatest") };
  // 封禁的机器行上已经写着「已封禁」，这里不再补一句「上线后才能升级」—— 它上不了线。
  if (!isNodeOnline(node)) return { text: node.banned ? "" : t("account.upgradeOffline") };
  return null;
}

const STATUS_COLOR = { soft: "var(--gx-soft)", ok: "var(--gx-ok)", danger: "var(--gx-danger)" } as const;

export function MachineList({
  machines,
  retired,
  retiredFailed,
  localNodeId,
  desktop,
  busy,
  onUnbind,
  onUpgrade,
  onInstallTool,
  onStartLogin,
  onSubmitLoginCode,
  onAddServer,
  onRetryRetired,
}: {
  /** 在用的机器，已排好序。桌面里不含这台电脑 —— 它在最上面那一块。 */
  machines: NodeView[];
  /** 解绑掉的机器。null 是还没拿到。 */
  retired: NodeView[] | null;
  retiredFailed: boolean;
  /** 本机 bridge 的节点。只在「已解绑」里用得上：这台电脑解绑前的那条旧记录要认得出来。 */
  localNodeId: string;
  desktop: boolean;
  busy: boolean;
  onUnbind: (node: NodeView) => void;
  /** 确认、下发、刷新都由页面做：确认框要用页面那个 useModal，刷新也得连着轮询节奏一起改。 */
  onUpgrade: (node: NodeView) => void;
  /** 让某台机器装 / 升一个本机工具。同 onUpgrade，下发和刷新都在页面那一层。 */
  onInstallTool: (node: NodeView, tool: string) => void;
  onStartLogin: (node: NodeView, tool: string) => void;
  onSubmitLoginCode: (node: NodeView, tool: string, code: string) => void;
  onAddServer: () => void;
  onRetryRetired: () => void;
}) {
  const { t } = useLocale();
  const [tab, setTab] = useState<Tab>("active");
  const [query, setQuery] = useState("");
  // 点开的那一台。一次只开一台：开着的几格叠在一起，又回到了一面墙。
  const [expanded, setExpanded] = useState("");

  const retiredTab = tab === "retired";
  const rows = retiredTab ? (retired ?? []) : machines;
  const visible = rows.filter((node) => matches(node, query));
  const online = machines.filter(isNodeOnline).length;
  const searchable = machines.length + (retired?.length ?? 0) >= SEARCH_FROM || query.trim() !== "";

  let body: ReactNode;
  if (retiredTab && !retired) {
    // 拿不到只影响这一栏，就在这一栏里说，给个重试 —— 不弹全局报错。
    body = retiredFailed ? (
      <Blank
        title={t("account.retiredFailed")}
        action={
          <Btn tone="ghost" small onClick={onRetryRetired}>
            {t("account.retry")}
          </Btn>
        }
      />
    ) : (
      <Loading />
    );
  } else if (rows.length === 0) {
    body = retiredTab ? (
      <Blank title={t("account.retiredEmpty")} />
    ) : (
      <Blank
        title={desktop ? t("account.machinesEmptyOther") : t("account.machinesEmpty")}
        hint={t("account.machinesEmptyHint")}
      />
    );
  } else if (visible.length === 0) {
    body = <Blank title={t("share.machineNoMatch")} />;
  } else {
    body = visible.map((node, index) => (
      <MachineRow
        key={node.nodeId}
        node={node}
        retired={retiredTab}
        local={Boolean(localNodeId) && node.nodeId === localNodeId}
        open={expanded === node.nodeId}
        first={index === 0}
        busy={busy}
        onToggle={() => setExpanded((current) => (current === node.nodeId ? "" : node.nodeId))}
        onUnbind={() => onUnbind(node)}
        onUpgrade={() => onUpgrade(node)}
        onInstallTool={(tool) => onInstallTool(node, tool)}
        onStartLogin={(tool) => onStartLogin(node, tool)}
        onSubmitLoginCode={(tool, code) => onSubmitLoginCode(node, tool, code)}
      />
    ));
  }

  return (
    // overflow hidden 是给最后一行的悬停底色切出卡片圆角；flexShrink 0 不能少 ——
    // gx-body 是纵向 flex，带 overflow hidden 的子项最小高度变成 0，会被压扁成一行。
    <Card className="gx-rise gx-rise--1" style={{ overflow: "hidden", flexShrink: 0 }}>
      <CardHead
        title={desktop ? t("account.machinesOther") : t("account.node")}
        hint={machines.length > 0 ? t("account.machinesOnline", { online, total: machines.length }) : undefined}
        action={
          <Btn tone="ghost" small icon={<IconPlus size={14} />} onClick={onAddServer}>
            {t("account.addServer")}
          </Btn>
        }
      />
      <TabStrip
        value={tab}
        onChange={(next) => {
          setTab(next);
          setExpanded("");
        }}
        options={[
          { value: "active" as const, label: t("account.tabInUse"), count: machines.length },
          { value: "retired" as const, label: t("account.tabRetired"), count: retired ? retired.length : null },
        ]}
        aside={
          searchable ? (
            <span style={{ position: "relative", display: "flex", alignItems: "center" }}>
              <IconSearch size={14} style={{ position: "absolute", left: 11, color: "var(--gx-faint)" }} />
              <input
                className="gx-input"
                style={{ width: 230, height: 30, paddingLeft: 32, borderRadius: 8, fontSize: 12.5 }}
                placeholder={t("account.machineSearch")}
                aria-label={t("account.machineSearch")}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") setQuery("");
                }}
              />
            </span>
          ) : null
        }
      />
      <RowList>{body}</RowList>
    </Card>
  );
}

function MachineRow({
  node,
  retired,
  local,
  open,
  first,
  busy,
  onToggle,
  onUnbind,
  onUpgrade,
  onInstallTool,
  onStartLogin,
  onSubmitLoginCode,
}: {
  node: NodeView;
  retired: boolean;
  local: boolean;
  open: boolean;
  first: boolean;
  busy: boolean;
  onToggle: () => void;
  onUnbind: () => void;
  onUpgrade: () => void;
  onInstallTool: (tool: string) => void;
  onStartLogin: (tool: string) => void;
  onSubmitLoginCode: (tool: string, code: string) => void;
}) {
  const { t } = useLocale();
  const online = !retired && isNodeOnline(node);
  const direct = node.accessMode === "export";
  // 行上只挂这两种：升级中得看得见（那几分钟它不接新活），可升级是在提醒去点开。
  // 随 Nova 分发、版本太旧、有障碍这些「升不了」的原因不上行 —— 十台里挂一排灰标签，等于没说。
  const upgradeTag = retired
    ? null
    : isUpgradeInProgress(node.upgrade)
      ? { label: t("account.upgrading"), className: "gx-pill gx-pill--sm gx-pill--warn" }
      : node.distribution === "cli" && node.upgradeAvailable
        ? { label: t("account.upgradable"), className: "gx-pill gx-pill--sm" }
        : null;
  // 回连失败只对在用的 export 机器有意义：解绑之后没人再去探它，留着的是解绑前的旧话。
  const unreachable = !retired && direct && node.endpointStatus === "unreachable";
  const seen = node.lastBeatAt ? formatRelative(node.lastBeatAt) : "";
  const state = retired
    ? seen
      ? t("account.lastSeen", { value: seen })
      : t("share.machineNeverSeen")
    : node.banned
      ? t("share.machineBanned")
      : online
        ? t("share.machineOnline")
        : seen
          ? t("share.machineSeen", { value: seen })
          : t("share.machineNeverSeen");
  const detailId = `machine-${node.nodeId}`;

  return (
    <div>
      <button
        type="button"
        className="gx-row"
        aria-expanded={open}
        aria-controls={open ? detailId : undefined}
        // 机器名是主人起的（多半是主机名），长了会被截，悬停给全名和节点 ID。
        title={node.displayName ? `${node.displayName} · ${node.nodeId}` : node.nodeId}
        style={{ gridTemplateColumns: COLUMNS, padding: "11px 18px", borderTop: first ? 0 : undefined }}
        onClick={onToggle}
      >
        <span className={`gx-state${retired ? "" : node.banned ? " is-err" : online ? " is-on" : ""}`} style={{ marginTop: 0 }} />
        <span style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
          <span style={{ minWidth: 0, fontWeight: 500, color: retired ? "var(--gx-soft)" : "var(--gx-ink)", ...ellipsis }}>
            {nodeDisplayName(node)}
          </span>
          {local ? <span className="gx-pill gx-pill--sm">{t("account.thisComputer")}</span> : null}
          {upgradeTag ? <span className={upgradeTag.className}>{upgradeTag.label}</span> : null}
        </span>
        <span
          style={{
            display: "flex",
            alignItems: "center",
            gap: 5,
            minWidth: 0,
            fontSize: 12,
            color: unreachable ? "var(--gx-warn-ink)" : "var(--gx-soft)",
          }}
        >
          {unreachable ? <IconAlert size={13} style={{ flex: "0 0 auto" }} /> : null}
          <span style={ellipsis}>
            {direct ? t("account.accessExport") : t("account.accessPoll")}
            {unreachable ? ` · ${t("account.endpointDown")}` : ""}
          </span>
        </span>
        <span
          style={{
            fontSize: 12,
            color: !retired && node.banned ? "var(--gx-danger)" : online ? "var(--gx-ok)" : "var(--gx-faint)",
            ...ellipsis,
          }}
        >
          {state}
        </span>
        <IconChevronDown
          size={14}
          style={{ color: "var(--gx-faint)", transition: "transform .15s ease", transform: open ? "rotate(180deg)" : undefined }}
        />
      </button>
      {open ? (
        <MachineDetail
          id={detailId}
          node={node}
          retired={retired}
          busy={busy}
          onUnbind={onUnbind}
          onUpgrade={onUpgrade}
          onInstallTool={onInstallTool}
          onStartLogin={onStartLogin}
          onSubmitLoginCode={onSubmitLoginCode}
        />
      ) : null}
    </div>
  );
}

function MachineDetail({
  id,
  node,
  retired,
  busy,
  onUnbind,
  onUpgrade,
  onInstallTool,
  onStartLogin,
  onSubmitLoginCode,
}: {
  id: string;
  node: NodeView;
  retired: boolean;
  busy: boolean;
  onUnbind: () => void;
  onUpgrade: () => void;
  onInstallTool: (tool: string) => void;
  onStartLogin: (tool: string) => void;
  onSubmitLoginCode: (tool: string, code: string) => void;
}) {
  const { t } = useLocale();
  const panelRef = useRef<HTMLDivElement>(null);
  const direct = node.accessMode === "export";

  // 点开的是列表底上那几台时，展开的这一格落在滚动区外面，看着像没点开。只在展开那一下滚：
  // 20 秒一次的刷新会重渲染，那时候主人可能正往别处滚。
  useEffect(() => {
    panelRef.current?.scrollIntoView({ block: "nearest" });
  }, []);

  // 有新版就在版本后面带一句，不管这台能不能远程升：随 Nova 分发、版本太旧的机器也该知道落后了。
  const newer = !retired && isNewerBridgeVersion(node.latestVersion, node.bridgeVersion);
  const fields: { label: string; value: ReactNode; danger?: boolean }[] = [
    { label: t("account.detailNode"), value: node.nodeId },
    {
      label: "ai-bridge",
      value: (
        <>
          {node.bridgeVersion || "-"}
          {newer ? <span style={{ color: "var(--gx-faint)" }}> {t("account.latestVersion", { version: node.latestVersion })}</span> : null}
        </>
      ),
    },
    { label: t("account.detailPlatform"), value: node.platform || "-" },
    {
      label: t("account.detailBeat"),
      value: node.lastBeatAt ? t("account.ago", { value: formatRelative(node.lastBeatAt) }) : t("share.machineNeverSeen"),
    },
  ];
  if (direct) fields.push({ label: t("account.detailEndpoint"), value: node.endpointUrl || "-" });
  if (direct && !retired) {
    fields.push({ label: t("account.detailProbe"), value: endpointText(node, t), danger: node.endpointStatus === "unreachable" });
  }

  const status = retired ? null : upgradeStatus(node, t);
  const upgrading = isUpgradeInProgress(node.upgrade);
  const blocked = retired || upgrading ? null : upgradeBlocked(node, t);
  const canUpgrade = !retired && !upgrading && blocked === null;
  // 刚升级成功、已是最新时不再补一句「已是最新版本」：上面那句已经说了。
  const reason = blocked?.text && !(status?.tone === "ok" && !node.upgradeAvailable) ? blocked : null;

  return (
    // 左边让出状态点那一列，和上面的机器名对齐。
    <div id={id} ref={panelRef} style={{ padding: "0 18px 14px 38px" }}>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "auto minmax(0, 1fr)",
          gap: "7px 18px",
          padding: "12px 14px",
          borderRadius: 10,
          background: "var(--gx-muted)",
          fontSize: 12,
          lineHeight: 1.5,
        }}
      >
        {fields.map((field) => (
          <Fragment key={field.label}>
            <span style={{ color: "var(--gx-faint)", whiteSpace: "nowrap" }}>{field.label}</span>
            <span className="gx-mono" style={{ color: field.danger ? "var(--gx-danger)" : "var(--gx-ink)", overflowWrap: "anywhere" }}>
              {field.value}
            </span>
          </Fragment>
        ))}
      </div>
      {status || reason || canUpgrade ? (
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 10 }}>
          <span style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 2, fontSize: 12, lineHeight: 1.6 }}>
            {status ? <span style={{ color: STATUS_COLOR[status.tone], overflowWrap: "anywhere" }}>{status.text}</span> : null}
            {reason ? (
              <span style={{ color: reason.warn ? "var(--gx-warn-ink)" : "var(--gx-faint)", overflowWrap: "anywhere" }}>{reason.text}</span>
            ) : null}
            {canUpgrade && !status ? <span style={{ color: "var(--gx-faint)" }}>{t("account.upgradeHint")}</span> : null}
          </span>
          {canUpgrade ? (
            <Btn tone="accent" small disabled={busy} onClick={onUpgrade}>
              {t("account.upgradeAction", { version: node.latestVersion })}
            </Btn>
          ) : null}
        </div>
      ) : null}
      {retired ? null : (
        // 机器上的 claude / codex。它回答的是「这台为什么接不了 claude 的单」——
        // 一台在线、心跳正常、却什么单都接不到的机器，十有八九是这里没装。
        <div style={{ display: "flex", alignItems: "center", gap: "8px 14px", marginTop: 10, flexWrap: "wrap" }}>
          <span style={{ fontSize: 12, color: "var(--gx-faint)" }}>{t("account.machineTools")}</span>
          {(node.tools ?? []).length > 0 ? (
            (node.tools ?? []).map((tool) => (
              <ToolRow
                key={tool.name}
                tool={tool}
                busy={busy}
                onRun={() => onInstallTool(tool.name)}
                onLogin={() => onStartLogin(tool.name)}
                t={t}
              />
            ))
          ) : (
            // 老版本 ai-bridge 报不上来。说清楚是「还没报」而不是「没装」——
            // 后者会让主人跑去机器上装一个本来就在的东西。
            <span style={{ fontSize: 12, color: "var(--gx-faint)" }}>{t("account.machineToolsUnknown")}</span>
          )}
        </div>
      )}
      {retired
        ? null
        : // 正在进行（或刚结束）的登录摊在工具那一行下面：它讲的是同一件事的下一步，
          // 而且这一格里要放地址、短码和一个输入框，挤不进上面那一行。
          // 成功的那条由服务端挂一会儿就收掉，不会一直堆在这儿。
          (node.logins ?? []).map((login) => (
            <LoginPanel
              key={login.tool}
              login={login}
              busy={busy}
              onSubmitCode={(code) => onSubmitLoginCode(login.tool, code)}
              onRestart={() => onStartLogin(login.tool)}
              t={t}
            />
          ))}
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 10 }}>
        <span className="gx-card__hint" style={{ flex: 1, lineHeight: 1.6 }}>
          {retired ? t("account.retiredHint") : t("account.unbindHint")}
        </span>
        {retired ? null : (
          <Btn tone="danger" small disabled={busy} onClick={onUnbind}>
            {t("account.unbindMachine")}
          </Btn>
        )}
      </div>
    </div>
  );
}
