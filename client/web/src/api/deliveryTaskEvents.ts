"use client";

/**
 * 任务状态改动的浏览器内广播。
 *
 * 顶栏消息中心和任务面板是两棵互不相干的组件树，任务从「受阻 / 不做」改回其它状态后，
 * 消息中心必须马上把这条记录去掉，不能等下一次轮询。
 */
export const DELIVERY_TASKS_CHANGED_EVENT = "zb.delivery.tasks-changed";

export function notifyDeliveryTasksChanged() {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(DELIVERY_TASKS_CHANGED_EVENT));
}
