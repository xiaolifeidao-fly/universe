"use client";

/**
 * 共享设置左边那一列：主人名下的全部机器。顺序由页面排好再传进来。
 *
 * 搜索同时匹配机器名、节点 ID 和能力（cid / provider）：机房里十几台服务器时，
 * 「哪几台在共享 codex」比记住机器名更常被问到。
 */

import { useEffect, useRef } from "react";
import { IconSearch } from "@/components/ui/icons";
import { Card } from "@/components/ui/kit";
import { useLocale } from "@/i18n/LocaleProvider";
import { formatRelative } from "@/utils/format";
import { isNodeOnline, nodeDisplayName, visibleContributions, type NodeView } from "../../api/provider.api";

function matches(node: NodeView, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  const fields = [
    node.displayName,
    node.nodeId,
    ...visibleContributions(node.contributions).flatMap((row) => [row.cid, row.provider]),
  ];
  return fields.some((field) => (field ?? "").toLowerCase().includes(needle));
}

/**
 * 一台机器此刻最该被看见的那句话。按处置的急迫程度排：封禁 > 离线 > 有能力坏了 > 共享了几项。
 * 离线的机器不再往下说能力 —— 它上报的状态是离线前的快照，说了也不准。
 */
function summarize(node: NodeView, t: (key: string, vars?: Record<string, string | number>) => string) {
  if (node.banned) return { text: t("share.machineBanned"), tone: "danger" as const };
  if (!isNodeOnline(node)) {
    return {
      text: node.lastBeatAt ? t("share.machineSeen", { value: formatRelative(node.lastBeatAt) }) : t("share.machineNeverSeen"),
      tone: undefined,
    };
  }
  const rows = visibleContributions(node.contributions);
  if (rows.length === 0) return { text: t("share.machineNoCapability"), tone: undefined };
  const broken = rows.filter((row) => !row.available).length;
  if (broken > 0) return { text: t("share.machineAttention", { value: broken }), tone: "warn" as const };
  const on = rows.filter((row) => row.status === "active").length;
  return {
    text: on > 0 ? t("share.machineSharing", { on, total: rows.length }) : t("share.machineIdle"),
    tone: undefined,
  };
}

export function MachineRail({
  machines,
  selected,
  localNodeId,
  query,
  onQuery,
  onSelect,
}: {
  machines: NodeView[];
  selected: string;
  localNodeId: string;
  query: string;
  onQuery: (next: string) => void;
  onSelect: (nodeId: string) => void;
}) {
  const { t } = useLocale();
  const listRef = useRef<HTMLDivElement>(null);
  const visible = machines.filter((node) => matches(node, query));
  const online = machines.filter(isNodeOnline).length;

  // 选中的那台可能在列表视野外（窄窗口下是横着排的）：搜索回车切过去之后、
  // 或者清掉搜索词列表重新铺满之后，都把它滚进来。
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(".gx-pick.is-active")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [selected, query]);

  return (
    <Card className="gx-split__aside gx-rise">
      <div style={{ display: "flex", flexDirection: "column", gap: 10, padding: "14px 14px 10px" }}>
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8 }}>
          <span className="gx-card__title">
            {t("share.machines")}
            <span className="gx-mono" style={{ marginLeft: 6, fontWeight: 400, color: "var(--gx-faint)" }}>
              {machines.length}
            </span>
          </span>
          <span className="gx-card__hint">{t("share.machinesOnline", { value: online })}</span>
        </div>
        <span style={{ position: "relative", display: "flex", alignItems: "center" }}>
          <IconSearch size={15} style={{ position: "absolute", left: 11, color: "var(--gx-faint)" }} />
          <input
            className="gx-input"
            style={{ height: 34, paddingLeft: 33, fontSize: 12.5 }}
            placeholder={t("share.machineSearch")}
            aria-label={t("share.machineSearch")}
            value={query}
            onChange={(event) => onQuery(event.target.value)}
            onKeyDown={(event) => {
              // 回车直接切到第一个匹配：搜索在这里是「快速切换」，不只是筛选。
              // 拼音输入法选词那一下回车不算 —— 那是在上屏，不是在确认。
              if (event.nativeEvent.isComposing) return;
              if (event.key === "Enter" && visible[0]) onSelect(visible[0].nodeId);
              if (event.key === "Escape") onQuery("");
            }}
          />
        </span>
      </div>
      <div ref={listRef} className="gx-picks gx-scroll" role="listbox" aria-label={t("share.machines")}>
        {visible.map((node) => {
          const summary = summarize(node, t);
          const active = node.nodeId === selected;
          const state = node.banned ? " is-err" : isNodeOnline(node) ? " is-on" : "";
          return (
            <button
              key={node.nodeId}
              type="button"
              role="option"
              aria-selected={active}
              className={`gx-pick${active ? " is-active" : ""}`}
              // 机器名是主人起的（多半是主机名），长了会被截，悬停时给全名和节点 ID。
              title={node.displayName ? `${node.displayName} · ${node.nodeId}` : node.nodeId}
              onClick={() => onSelect(node.nodeId)}
            >
              <span className={`gx-state${state}`} />
              <span className="gx-pick__body">
                <span className="gx-pick__name">
                  <b>{nodeDisplayName(node)}</b>
                  {localNodeId && node.nodeId === localNodeId ? (
                    <span className="gx-pill gx-pill--sm">{t("account.thisComputer")}</span>
                  ) : null}
                </span>
                {/* 要处理的那句本身就是警示色，不再另挂图标 —— 窄列里图标挤掉的是机器名。 */}
                <span className={`gx-pick__meta${summary.tone ? ` is-${summary.tone}` : ""}`}>{summary.text}</span>
              </span>
            </button>
          );
        })}
        {visible.length === 0 ? <div className="gx-pick__empty">{t("share.machineNoMatch")}</div> : null}
      </div>
    </Card>
  );
}
