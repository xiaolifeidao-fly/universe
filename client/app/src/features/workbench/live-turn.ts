/**
 * 回合跑着时的实时正文。
 *
 * 执行电脑在上报活动时把这一轮新长出来的条目一起带回来（`data.live`），界面把它们
 * 并进当前快照。以前这段文字是靠每 4 秒发一条快照命令取回来的：一分钟十几条命令、
 * 十几次领取、十几行结果，只为把 Worker 手边就有的东西搬过来一次。
 *
 * 旧版本的执行电脑不发这一段，界面就还是按原来的节奏整份回读 —— 所以这里只做「有
 * 就用」的合并，不假设它一定存在。
 */

import type { ConversationItem, ConversationSnapshot, ConversationTurn, LiveTurnUpdate } from "@/features/workbench/types";

function itemsOf(value: unknown): ConversationItem[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is ConversationItem => Boolean(item) && typeof item === "object");
}

/** 从一条活动的附加数据里认出实时正文；认不出就当这条活动只是普通进度。 */
export function liveTurnOf(data: Record<string, unknown> | undefined): LiveTurnUpdate | null {
  const live = data?.live;
  if (!live || typeof live !== "object") return null;
  const value = live as Record<string, unknown>;
  const turnId = typeof value.turnId === "string" ? value.turnId : "";
  const items = itemsOf(value.items);
  if (!turnId || !items.length) return null;
  return {
    threadId: typeof value.threadId === "string" ? value.threadId : "",
    turnId,
    status: typeof value.status === "string" ? value.status : "running",
    createdAt: typeof value.createdAt === "string" ? value.createdAt : "",
    active: value.active !== false,
    executorType: typeof value.executorType === "string" ? value.executorType : "",
    items,
    usage: (value.usage ?? undefined) as LiveTurnUpdate["usage"],
    context: (value.context ?? undefined) as LiveTurnUpdate["context"],
  };
}

function mergeItems(current: ConversationItem[], incoming: ConversationItem[]) {
  const merged = [...current];
  for (const item of incoming) {
    // 正在长的那一条会被反复回传：按 id 覆盖，追加只发生在真正新出现的条目上。
    const index = merged.findIndex((candidate) => candidate.id && candidate.id === item.id);
    if (index >= 0) merged[index] = item;
    else merged.push(item);
  }
  return merged;
}

/**
 * 把增量并进快照。
 *
 * 首份快照还没落地时不合并：没有它就没有线程、目录和历史回合，凭一段增量拼出来的
 * 界面反而会让用户以为之前的对话没了。
 */
export function mergeLiveTurn(snapshot: ConversationSnapshot | null, live: LiveTurnUpdate): ConversationSnapshot | null {
  if (!snapshot) return snapshot;
  if (live.threadId && snapshot.threadId && live.threadId !== snapshot.threadId) {
    // 用户正翻着另一条历史会话，这一轮的正文不该插进他正在看的那一屏。
    return snapshot;
  }
  const turns = [...snapshot.turns];
  const index = turns.findIndex((turn) => turn.id === live.turnId);
  const base: ConversationTurn = index >= 0
    ? turns[index]
    : { id: live.turnId, status: live.status, createdAt: live.createdAt, completedAt: "", items: [] };
  const merged: ConversationTurn = {
    ...base,
    status: live.status || base.status,
    items: mergeItems(base.items, live.items),
    usage: live.usage ?? base.usage,
  };
  if (index >= 0) turns[index] = merged;
  else turns.push(merged);
  return {
    ...snapshot,
    turns,
    threadId: snapshot.threadId || live.threadId,
    executorType: snapshot.executorType || live.executorType,
    active: live.active,
    activeTurnId: live.turnId,
    context: live.context ?? snapshot.context,
  };
}
