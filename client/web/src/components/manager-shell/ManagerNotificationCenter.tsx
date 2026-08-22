"use client";

import {
  BellOutlined,
  CheckCircleOutlined,
  MessageOutlined,
  ProjectOutlined,
  ReloadOutlined,
  TableOutlined,
  UserOutlined,
} from "@ant-design/icons";
import { Badge, Button, Empty, Popover, Space, Spin, Table, Tooltip } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useBusinessLine } from "@/business-lines/BusinessLineProvider";
import { useLocale } from "@/i18n/LocaleProvider";
import {
  fetchDeliveryAttentionTasks,
  fetchDeliveryExecutionBatchNotifications,
  fetchDeliveryRequirementCompletionNotifications,
  markDeliveryExecutionBatchNotificationRead,
  markDeliveryRequirementCompletionNotificationRead,
  type DeliveryAttentionTask,
  type DeliveryExecutionBatchNotification,
  type DeliveryRequirementCompletionNotification,
} from "@/api/delivery.api";
import { DELIVERY_TASKS_CHANGED_EVENT } from "@/api/deliveryTaskEvents";

/** 消息中心自动刷新的间隔；任务状态是人改出来的，一分钟一次足够。 */
const REFRESH_INTERVAL_MS = 60_000;

/** 弹层右边缘距页面右侧留的空隙。 */
const POPOVER_PAGE_GUTTER = 24;

type FocusMode = "board" | "detail" | "requirement";

export function ManagerNotificationCenter() {
  const { t } = useLocale();
  const router = useRouter();
  const { activeBusinessLine } = useBusinessLine();
  const bizLine = activeBusinessLine.id;

  const [open, setOpen] = useState(false);
  // 弹层比铃铛宽得多，按 bottomRight 贴着铃铛会整个甩到左边去；
  // 这里把它整体右移，让右边缘落在页面右边距上。
  const anchorRef = useRef<HTMLSpanElement>(null);
  const [popoverOffsetX, setPopoverOffsetX] = useState(0);
  const [loading, setLoading] = useState(false);
  const [tasks, setTasks] = useState<DeliveryAttentionTask[]>([]);
  const [batches, setBatches] = useState<DeliveryExecutionBatchNotification[]>([]);
  const [completionNotifications, setCompletionNotifications] = useState<DeliveryRequirementCompletionNotification[]>([]);

  const refresh = useCallback(async () => {
    if (!bizLine) {
      setTasks([]);
      setBatches([]);
      setCompletionNotifications([]);
      return;
    }
    setLoading(true);
    try {
      const [nextTasks, nextBatches, nextCompletionNotifications] = await Promise.all([
        fetchDeliveryAttentionTasks(bizLine),
        fetchDeliveryExecutionBatchNotifications(bizLine),
        fetchDeliveryRequirementCompletionNotifications(bizLine),
      ]);
      setTasks(nextTasks);
      setBatches(nextBatches);
      setCompletionNotifications(nextCompletionNotifications);
    } catch {
      // 顶栏的铃铛不该因为一次拉取失败弹错误提示，保留上一次的结果即可。
    } finally {
      setLoading(false);
    }
  }, [bizLine]);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), REFRESH_INTERVAL_MS);
    // 任务面板把任务改回其它状态后立刻重算，不用等下一次轮询。
    const handleTasksChanged = () => void refresh();
    window.addEventListener(DELIVERY_TASKS_CHANGED_EVENT, handleTasksChanged);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener(DELIVERY_TASKS_CHANGED_EVENT, handleTasksChanged);
    };
  }, [refresh]);

  const alignPopover = useCallback(() => {
    const anchor = anchorRef.current;
    if (!anchor) return;
    const rect = anchor.getBoundingClientRect();
    // 用 clientWidth 而不是 innerWidth：页面有纵向滚动条时前者才是真正的可视宽度。
    setPopoverOffsetX(Math.max(0, document.documentElement.clientWidth - POPOVER_PAGE_GUTTER - rect.right));
  }, []);

  // 每次展开都重新拉一次：列表打开的这一刻必须是最新的受阻和不做任务。
  const handleOpenChange = useCallback((next: boolean) => {
    setOpen(next);
    if (!next) return;
    alignPopover();
    void refresh();
  }, [alignPopover, refresh]);

  useEffect(() => {
    if (!open) return undefined;
    window.addEventListener("resize", alignPopover);
    return () => window.removeEventListener("resize", alignPopover);
  }, [alignPopover, open]);

  const counts = useMemo(() => ({
    blocked: tasks.filter((task) => task.status === "blocked").length,
    dropped: tasks.filter((task) => task.status === "dropped").length,
    unreadBatches: batches.filter((batch) => !batch.notificationReadAt).length,
    unreadRequirements: completionNotifications.filter((notification) => !notification.notificationReadAt).length,
  }), [batches, completionNotifications, tasks]);

  const goDelivery = useCallback((task: DeliveryAttentionTask, mode: FocusMode) => {
    setOpen(false);
    const query = new URLSearchParams({
      programId: String(task.programId),
      focusRequirementKey: task.requirementKey,
      focusItemKey: task.itemKey,
      focusMode: mode,
      // 同一条任务连点两次也要重新聚焦，靠这个一次性令牌把两次跳转区分开。
      focusToken: String(Date.now()),
    });
    router.push(`/delivery?${query.toString()}`);
  }, [router]);

  const goBatchRequirement = useCallback(async (batch: DeliveryExecutionBatchNotification) => {
    setOpen(false);
    // 已读只作用于完成批次；原有受阻/不做消息仍由任务当前状态决定，不会被这次点击消掉。
    try {
      const updated = await markDeliveryExecutionBatchNotificationRead(batch.programId, batch.batchId);
      setBatches((current) => current.map((entry) => (
        entry.batchId === updated.batchId && entry.programId === updated.programId
          ? { ...entry, notificationReadAt: updated.notificationReadAt }
          : entry
      )));
    } catch {
      // 跳转本身不依赖确认成功；下次轮询会重试拉取最新已读状态。
    }
    const query = new URLSearchParams({
      programId: String(batch.programId),
      focusRequirementKey: batch.requirementKey,
      focusMode: "requirement",
      focusToken: String(Date.now()),
    });
    router.push(`/delivery?${query.toString()}`);
  }, [router]);

  const goCompletedRequirement = useCallback(async (notification: DeliveryRequirementCompletionNotification) => {
    setOpen(false);
    try {
      const updated = await markDeliveryRequirementCompletionNotificationRead(
        notification.programId,
        notification.requirementKey,
      );
      setCompletionNotifications((current) => current.map((entry) => (
        entry.programId === updated.programId && entry.requirementKey === updated.requirementKey
          ? { ...entry, notificationReadAt: updated.notificationReadAt }
          : entry
      )));
    } catch {
      // 跳转不依赖确认成功；下次消息中心刷新时会重新取得自己的已读状态。
    }
    const query = new URLSearchParams({
      programId: String(notification.programId),
      focusRequirementKey: notification.requirementKey,
      focusMode: "requirement",
      focusToken: String(Date.now()),
    });
    router.push(`/delivery?${query.toString()}`);
  }, [router]);

  const columns = useMemo<ColumnsType<DeliveryAttentionTask>>(() => [
    {
      title: t("delivery.notificationCenter.requirement"),
      dataIndex: "requirementName",
      width: 240,
      render: (_value, task) => (
        <div className="manager-notification-cell">
          <Tooltip title={t("delivery.notificationCenter.openRequirement")}>
            <button
              type="button"
              className="manager-notification-cell__link"
              disabled={!task.requirementKey}
              onClick={() => goDelivery(task, "requirement")}
            >
              {task.requirementName || t("delivery.notificationCenter.noRequirement")}
            </button>
          </Tooltip>
          <span className="manager-notification-cell__sub">
            <span><ProjectOutlined /> {task.programName}</span>
            <span>
              <UserOutlined />
              {task.requirementOwners.length ? task.requirementOwners.join("、") : t("delivery.notificationCenter.noOwner")}
            </span>
          </span>
        </div>
      ),
    },
    {
      // 状态和两个入口都跟着任务名走，不再单开一列甩到最右边。
      title: t("delivery.notificationCenter.task"),
      dataIndex: "title",
      render: (_value, task) => (
        <div className="manager-notification-cell">
          <Tooltip title={task.title || task.itemKey} placement="topLeft">
            <span className="manager-notification-cell__main">{task.title || task.itemKey}</span>
          </Tooltip>
          <span className="manager-notification-cell__meta">
            <span className={`manager-notification-status is-${task.status}`}>{t(`delivery.status.${task.status}`)}</span>
            <Space size={6} className="manager-notification-actions">
              <Button size="small" icon={<TableOutlined />} onClick={() => goDelivery(task, "board")}>
                {t("delivery.notificationCenter.openBoard")}
              </Button>
              <Button size="small" type="primary" ghost icon={<MessageOutlined />} onClick={() => goDelivery(task, "detail")}>
                {t("delivery.notificationCenter.openDetail")}
              </Button>
            </Space>
          </span>
        </div>
      ),
    },
  ], [goDelivery, t]);

  const batchColumns = useMemo<ColumnsType<DeliveryExecutionBatchNotification>>(() => [
    {
      title: t("delivery.notificationCenter.requirement"),
      dataIndex: "requirementName",
      width: 240,
      render: (_value, batch) => (
        <div className="manager-notification-cell">
          <Tooltip title={t("delivery.notificationCenter.batchOpenRequirement")}>
            <button
              type="button"
              className="manager-notification-cell__link"
              disabled={!batch.requirementKey}
              onClick={() => void goBatchRequirement(batch)}
            >
              {batch.requirementName || t("delivery.notificationCenter.noRequirement")}
            </button>
          </Tooltip>
          <span className="manager-notification-cell__sub">
            <span><ProjectOutlined /> {batch.programName}</span>
            {batch.requirementGitBranch ? <span>{batch.requirementGitBranch}</span> : null}
          </span>
        </div>
      ),
    },
    {
      title: t("delivery.notificationCenter.batch"),
      dataIndex: "batchId",
      render: (_value, batch) => (
        <div className="manager-notification-cell">
          <span className="manager-notification-cell__main">
            {t(`delivery.notificationCenter.batchMode.${batch.mode}`)}
          </span>
          <span className="manager-notification-cell__meta">
            <span className="manager-notification-status is-done">
              {t("delivery.notificationCenter.batchProgress")
                .replace("{completed}", String(batch.completedCount))
                .replace("{total}", String(batch.itemCount))}
            </span>
            {!batch.notificationReadAt ? <CheckCircleOutlined className="manager-notification-batch-unread" /> : null}
          </span>
        </div>
      ),
    },
  ], [goBatchRequirement, t]);

  const completionColumns = useMemo<ColumnsType<DeliveryRequirementCompletionNotification>>(() => [
    {
      title: t("delivery.notificationCenter.requirement"),
      dataIndex: "requirementName",
      width: 240,
      render: (_value, notification) => (
        <div className="manager-notification-cell">
          <Tooltip title={t("delivery.notificationCenter.requirementOpen")}>
            <button
              type="button"
              className="manager-notification-cell__link"
              disabled={!notification.requirementKey}
              onClick={() => void goCompletedRequirement(notification)}
            >
              {notification.requirementName || t("delivery.notificationCenter.noRequirement")}
            </button>
          </Tooltip>
          <span className="manager-notification-cell__sub">
            <span><ProjectOutlined /> {notification.programName}</span>
          </span>
        </div>
      ),
    },
    {
      title: t("delivery.notificationCenter.completion"),
      dataIndex: "requirementKey",
      render: (_value, notification) => (
        <div className="manager-notification-cell">
          <span className="manager-notification-cell__main">
            {t("delivery.notificationCenter.requirementCompleted")}
          </span>
          <span className="manager-notification-cell__meta">
            <span className="manager-notification-status is-done">
              {t("delivery.status.done")}
            </span>
            {!notification.notificationReadAt ? <CheckCircleOutlined className="manager-notification-batch-unread" /> : null}
          </span>
        </div>
      ),
    },
  ], [goCompletedRequirement, t]);

  return (
    <Popover
      placement="bottomRight"
      align={{ offset: [popoverOffsetX, 0] }}
      trigger="click"
      open={open}
      onOpenChange={handleOpenChange}
      title={(
        <div className="manager-notification-head">
          <span>{t("delivery.notificationCenter.title")}</span>
          <Space size={8}>
            <span className="manager-notification-head__count is-blocked">{t("delivery.notificationCenter.blocked")} {counts.blocked}</span>
            <span className="manager-notification-head__count is-dropped">{t("delivery.notificationCenter.dropped")} {counts.dropped}</span>
            {counts.unreadBatches > 0 ? (
              <span className="manager-notification-head__count is-done">{t("delivery.notificationCenter.unreadBatches")} {counts.unreadBatches}</span>
            ) : null}
            {counts.unreadRequirements > 0 ? (
              <span className="manager-notification-head__count is-done">{t("delivery.notificationCenter.unreadRequirements")} {counts.unreadRequirements}</span>
            ) : null}
            <Tooltip title={t("delivery.notificationCenter.refresh")}>
              <Button size="small" type="text" icon={<ReloadOutlined />} loading={loading} onClick={() => void refresh()} />
            </Tooltip>
          </Space>
        </div>
      )}
      content={(
        <div className="manager-notification-popover">
          {loading && tasks.length === 0 && batches.length === 0 && completionNotifications.length === 0 ? (
            <div className="manager-notification-popover__loading"><Spin /></div>
          ) : tasks.length === 0 && batches.length === 0 && completionNotifications.length === 0 ? (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("delivery.notificationCenter.empty")} />
          ) : (
            <div className="manager-notification-sections">
              <div className="manager-notification-section">
                <div className="manager-notification-section__title">{t("delivery.notificationCenter.completedBatches")}</div>
                {batches.length === 0 ? (
                  <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("delivery.notificationCenter.batchEmpty")} />
                ) : (
                  <Table
                    rowKey={(batch) => `${batch.programId}:${batch.batchId}`}
                    size="small"
                    tableLayout="fixed"
                    columns={batchColumns}
                    dataSource={batches}
                    pagination={batches.length > 5 ? { pageSize: 5, size: "small", showSizeChanger: false } : false}
                  />
                )}
              </div>
              <div className="manager-notification-section">
                <div className="manager-notification-section__title">{t("delivery.notificationCenter.completedRequirements")}</div>
                {completionNotifications.length === 0 ? (
                  <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("delivery.notificationCenter.requirementCompletionEmpty")} />
                ) : (
                  <Table
                    rowKey={(notification) => `${notification.programId}:${notification.requirementKey}`}
                    size="small"
                    tableLayout="fixed"
                    columns={completionColumns}
                    dataSource={completionNotifications}
                    pagination={completionNotifications.length > 5 ? { pageSize: 5, size: "small", showSizeChanger: false } : false}
                  />
                )}
              </div>
              <div className="manager-notification-section">
                <div className="manager-notification-section__title">{t("delivery.notificationCenter.task")}</div>
                {tasks.length === 0 ? (
                  <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("delivery.notificationCenter.empty")} />
                ) : (
                  <Table
                    rowKey={(task) => `${task.programId}:${task.itemKey}`}
                    size="small"
                    tableLayout="fixed"
                    columns={columns}
                    dataSource={tasks}
                    pagination={tasks.length > 10 ? { pageSize: 10, size: "small", showSizeChanger: false } : false}
                    scroll={{ y: "min(420px, calc(100vh - 420px))" }}
                  />
                )}
              </div>
            </div>
          )}
        </div>
      )}
    >
      <span ref={anchorRef} className="manager-notification-anchor">
        <Badge count={counts.blocked + counts.dropped + counts.unreadBatches + counts.unreadRequirements} overflowCount={99} size="small">
          <Button
            className="manager-notification-button"
            icon={<BellOutlined />}
            aria-label={t("delivery.notificationCenter.title")}
          />
        </Badge>
      </span>
    </Popover>
  );
}
