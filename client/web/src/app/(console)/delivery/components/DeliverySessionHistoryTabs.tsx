"use client";

import { MessageOutlined, PlusOutlined } from "@ant-design/icons";
import { Button, Empty, Tooltip } from "antd";
import dayjs from "dayjs";
import { toolDisplayName, type AITool } from "@/ai-preferences/AIPreferencesProvider";
import type { CodexPlanningSessionSummary } from "@/api/delivery.api";
import { useLocale } from "@/i18n/LocaleProvider";

/** 需求聊天历史按用途分栏：拆解、代码 review、测试各自一列，互不混排。 */
export type DeliveryHistoryTab = "planning" | "review" | "testing";

export const DELIVERY_HISTORY_TABS: DeliveryHistoryTab[] = ["planning", "review", "testing"];

interface DeliverySessionHistoryTabsProps {
  activeTab: DeliveryHistoryTab;
  onTabChange: (tab: DeliveryHistoryTab) => void;
  planningConversations: CodexPlanningSessionSummary[];
  reviewConversations?: CodexPlanningSessionSummary[];
  testingConversations: CodexPlanningSessionSummary[];
  /** 当前正在看的是哪一类会话的哪条线程，用来点亮列表项。 */
  selectedKind: DeliveryHistoryTab;
  selectedThreadId: string;
  /** 还没落库的新聊天草稿，只显示在它自己那一栏。 */
  draft?: { kind: DeliveryHistoryTab; title: string; subtitle: string } | null;
  onSelect: (kind: DeliveryHistoryTab, threadId: string) => void;
  onNew: (tab: DeliveryHistoryTab) => void;
  newDisabled?: boolean;
  newDisabledTip?: string;
  /** 测试会话在服务端常常没有标题，兜底用需求名拼出来的那个。 */
  testingTitleFallback?: string;
}

function entrySubtitle(kind: DeliveryHistoryTab, executorType: AITool, t: (key: string) => string) {
  const label = kind === "planning"
    ? t("delivery.planning.title")
    : kind === "review" ? t("delivery.review.title") : t("delivery.testingCases.status");
  return [label, toolDisplayName(executorType)].filter(Boolean).join(" · ");
}

export function DeliverySessionHistoryTabs({
  activeTab,
  onTabChange,
  planningConversations,
  reviewConversations = [],
  testingConversations,
  selectedKind,
  selectedThreadId,
  draft = null,
  onSelect,
  onNew,
  newDisabled = false,
  newDisabledTip = "",
  testingTitleFallback = "",
}: DeliverySessionHistoryTabsProps) {
  const { t } = useLocale();
  const kind = activeTab;
  const entries = activeTab === "planning" ? planningConversations : activeTab === "review" ? reviewConversations : testingConversations;
  const tabDraft = draft && draft.kind === activeTab ? draft : null;
  const entryTitle = (title: string) => title || (kind === "testing" && testingTitleFallback ? testingTitleFallback : t("delivery.session.untitled"));

  return (
    <aside className="delivery-planning-history" aria-label={t("delivery.session.history")}>
      <header className="delivery-session-history__header">
        <h3>{t("delivery.session.history")}</h3>
        <Tooltip title={newDisabled ? newDisabledTip || t("delivery.session.newDisabled") : t("delivery.session.new")}>
          <Button
            type="text"
            shape="circle"
            icon={<PlusOutlined />}
            disabled={newDisabled}
            onClick={() => onNew(kind)}
            aria-label={t("delivery.session.new")}
          />
        </Tooltip>
      </header>
      <nav className="delivery-session-history__tabs" role="tablist">
        {DELIVERY_HISTORY_TABS.map((tab) => (
          <button
            key={tab}
            type="button"
            role="tab"
            aria-selected={tab === activeTab}
            className={`delivery-session-history__tab${tab === activeTab ? " is-active" : ""}`}
            onClick={() => onTabChange(tab)}
          >
            {t(`delivery.session.historyTab.${tab}`)}
          </button>
        ))}
      </nav>
      <div className="delivery-session-history__list">
        {tabDraft ? (
          <div className="delivery-session-history__item is-selected is-draft">
            <MessageOutlined />
            <div><b>{tabDraft.title}</b><span>{tabDraft.subtitle}</span></div>
          </div>
        ) : null}
        {entries.map((entry) => (
          <button
            className={`delivery-session-history__item${!tabDraft && kind === selectedKind && entry.threadId === selectedThreadId ? " is-selected" : ""}`}
            key={`${kind}-${entry.threadId}`}
            type="button"
            onClick={() => onSelect(kind, entry.threadId)}
          >
            <MessageOutlined />
            <div>
              <Tooltip title={entryTitle(entry.title)} placement="topLeft" mouseEnterDelay={0.3}>
                <b>{entryTitle(entry.title)}</b>
              </Tooltip>
              <span>{entrySubtitle(kind, entry.executorType, t)}</span>
              {/* 时间单独占一行：跟阶段、工具挤在一行时窄侧栏里必被省略号吃掉。 */}
              {entry.updatedAt ? <span className="delivery-session-history__item-time">{dayjs(entry.updatedAt).format("MM-DD HH:mm")}</span> : null}
            </div>
            {entry.active ? <i /> : null}
          </button>
        ))}
        {!tabDraft && !entries.length ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t(activeTab === "review" ? "delivery.session.historyTab.reviewEmpty" : "delivery.session.historyEmpty")} />
        ) : null}
      </div>
    </aside>
  );
}
