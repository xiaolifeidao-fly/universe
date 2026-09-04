"use client";

/** Local bridge installed together with the delivery-task-planner plugin. */
export const DELIVERY_TASK_PLANNER_DEFAULT_BRIDGE_URL = "http://127.0.0.1:8765";

export const DELIVERY_TASK_PLANNER_REPOSITORY_URL = "https://github.com/xiaolifeidao-fly/delivery-task-planner";

// 桥接地址回答的是「这台机器连哪个服务」，跟登录的是谁无关，所以不按用户分键。
const BRIDGE_URL_STORAGE_KEY = "zb.delivery-task-planner.bridge-url.v1";

/** 主机名只认字母数字和 . - _，顺带放行 [::1] 这种 IPv6 字面量。 */
const BRIDGE_HOSTNAME_PATTERN = /^(\[[0-9a-f:.]+\]|[a-z0-9._-]+)$/i;

/**
 * 把用户填的地址补成可以直接拼接的前缀：省略协议时按 http 处理，去掉末尾斜杠，
 * 反代到子路径的远端服务也保留路径。填得不成样子就返回空串，由调用方回落默认值。
 */
export function normalizeDeliveryTaskPlannerBridgeUrl(value: string) {
  const trimmed = String(value ?? "").trim();
  // 地址里带空白基本就是粘错了。URL 会把空格转义成 %20 混进主机名，先自己拦下来。
  if (!trimmed || /\s/.test(trimmed)) return "";
  // 写了协议就必须是 http(s)：否则 `ftp://x` 会被当成主机名 ftp 拼出个能过的怪地址。
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed);
  if (hasScheme && !/^https?:\/\//i.test(trimmed)) return "";
  try {
    const url = new URL(hasScheme ? trimmed : `http://${trimmed}`);
    if (!BRIDGE_HOSTNAME_PATTERN.test(url.hostname)) return "";
    return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, "")}`;
  } catch {
    return "";
  }
}

/** 控制台访问桥接服务时统一走这里取地址，没配过就是本机默认端口。 */
export function getDeliveryTaskPlannerBridgeUrl() {
  if (typeof window === "undefined") return DELIVERY_TASK_PLANNER_DEFAULT_BRIDGE_URL;
  try {
    const saved = window.localStorage.getItem(BRIDGE_URL_STORAGE_KEY) ?? "";
    return normalizeDeliveryTaskPlannerBridgeUrl(saved) || DELIVERY_TASK_PLANNER_DEFAULT_BRIDGE_URL;
  } catch {
    return DELIVERY_TASK_PLANNER_DEFAULT_BRIDGE_URL;
  }
}

/** 返回真正生效的地址；填空或填成默认值都当作没配置，直接把这条记录清掉。 */
export function saveDeliveryTaskPlannerBridgeUrl(value: string) {
  const normalized = normalizeDeliveryTaskPlannerBridgeUrl(value);
  try {
    if (!normalized || normalized === DELIVERY_TASK_PLANNER_DEFAULT_BRIDGE_URL) {
      window.localStorage.removeItem(BRIDGE_URL_STORAGE_KEY);
    } else {
      window.localStorage.setItem(BRIDGE_URL_STORAGE_KEY, normalized);
    }
  } catch {
    // 隐私模式下写不进去，本次会话继续用内存里的值即可。
  }
  return normalized || DELIVERY_TASK_PLANNER_DEFAULT_BRIDGE_URL;
}
