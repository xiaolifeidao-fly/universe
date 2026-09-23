"use client";

import { useEffect, useState } from "react";
import { getUserScopedStorageKey } from "@/utils/auth";

/**
 * 需求的执行状态只存在这台浏览器里：梳理与任务执行都是「我这轮干到哪儿了」的过程信息，
 * 换台机器重新算一遍即可，没必要占服务端的字段，也不该被别人的操作改写。
 *
 * 写入方是真正看得见事件的那两个窗口：需求编辑的拆解会话负责梳理状态，需求进度窗负责
 * 任务执行状态。工作台只读这份缓存，不额外发请求。
 */

/** 空串表示这条需求还没在本机留下梳理记录。 */
export type RequirementGroomingStatus = "" | "grooming" | "groomed";

/** 空串表示这条需求还没在本机留下任务执行记录。 */
export type RequirementExecutionStatus = "" | "running" | "done";

export interface RequirementRuntimeState {
  groomingStatus: RequirementGroomingStatus;
  groomingStartedAt: string;
  /** 梳理完成时间：拆解回合结束的那一刻。 */
  groomingFinishedAt: string;
  executionStatus: RequirementExecutionStatus;
  executionStartedAt: string;
  /** 执行结束时间：优先取批次自己的完成时间，没有就记观察到全部完成的时刻。 */
  executionFinishedAt: string;
  updatedAt: string;
}

export type RequirementRuntimeMap = Record<string, RequirementRuntimeState>;

const STORAGE_KEY = "zb.requirement-runtime.v1";
const CHANGED_EVENT = "zb.requirement-runtime.changed";
/** 只留最近这么多条：工作台看的是在办需求，历史留着只会把 localStorage 撑大。 */
const MAX_ENTRIES = 300;

const EMPTY: RequirementRuntimeState = {
  groomingStatus: "",
  groomingStartedAt: "",
  groomingFinishedAt: "",
  executionStatus: "",
  executionStartedAt: "",
  executionFinishedAt: "",
  updatedAt: "",
};

export function requirementRuntimeKey(programId: number, requirementKey: string) {
  return `${programId}:${String(requirementKey || "").trim()}`;
}

function normalize(value: Partial<RequirementRuntimeState> | undefined): RequirementRuntimeState {
  const grooming = String(value?.groomingStatus || "");
  const execution = String(value?.executionStatus || "");
  return {
    groomingStatus: (["grooming", "groomed"].includes(grooming) ? grooming : "") as RequirementGroomingStatus,
    groomingStartedAt: String(value?.groomingStartedAt || ""),
    groomingFinishedAt: String(value?.groomingFinishedAt || ""),
    executionStatus: (["running", "done"].includes(execution) ? execution : "") as RequirementExecutionStatus,
    executionStartedAt: String(value?.executionStartedAt || ""),
    executionFinishedAt: String(value?.executionFinishedAt || ""),
    updatedAt: String(value?.updatedAt || ""),
  };
}

function storageKey() {
  return getUserScopedStorageKey(STORAGE_KEY);
}

function read(): RequirementRuntimeMap {
  if (typeof window === "undefined") return {};
  const key = storageKey();
  if (!key) return {};
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, Partial<RequirementRuntimeState>>;
    return Object.fromEntries(Object.entries(parsed).map(([entryKey, value]) => [entryKey, normalize(value)]));
  } catch {
    // 缓存坏了不该拖垮页面：当成空的重新攒一份。
    return {};
  }
}

/** 超出上限时按最后更新时间裁掉最旧的几条。 */
function prune(map: RequirementRuntimeMap): RequirementRuntimeMap {
  const entries = Object.entries(map);
  if (entries.length <= MAX_ENTRIES) return map;
  return Object.fromEntries(entries
    .sort(([, left], [, right]) => (right.updatedAt || "").localeCompare(left.updatedAt || ""))
    .slice(0, MAX_ENTRIES));
}

function write(entryKey: string, patch: Partial<RequirementRuntimeState>) {
  if (typeof window === "undefined") return;
  const key = storageKey();
  if (!key) return;
  const map = read();
  const current = map[entryKey] ?? EMPTY;
  const next = normalize({ ...current, ...patch, updatedAt: new Date().toISOString() });
  // 状态和时间都没变就不写：否则每一轮轮询都会广播一次，列表跟着白重渲染。
  if (JSON.stringify({ ...current, updatedAt: "" }) === JSON.stringify({ ...next, updatedAt: "" })) return;
  map[entryKey] = next;
  try {
    window.localStorage.setItem(key, JSON.stringify(prune(map)));
  } catch {
    // 无痕模式或配额满时写不进去：这只是过程展示，不该把正在跑的会话或进度窗带崩。
    return;
  }
  window.dispatchEvent(new CustomEvent(CHANGED_EVENT));
}

export function getRequirementRuntimeMap(): RequirementRuntimeMap {
  return read();
}

export function getRequirementRuntime(programId: number, requirementKey: string): RequirementRuntimeState {
  return read()[requirementRuntimeKey(programId, requirementKey)] ?? EMPTY;
}

/** 拆解会话跑起来了：记「梳理中」，并把上一轮的完成时间清掉。 */
export function markRequirementGrooming(programId: number, requirementKey: string) {
  if (!requirementKey) return;
  const entryKey = requirementRuntimeKey(programId, requirementKey);
  const current = read()[entryKey] ?? EMPTY;
  write(entryKey, {
    groomingStatus: "grooming",
    // 同一轮里反复触发时保留最初的开始时间。
    groomingStartedAt: current.groomingStatus === "grooming" && current.groomingStartedAt
      ? current.groomingStartedAt
      : new Date().toISOString(),
    groomingFinishedAt: "",
  });
}

/** 拆解回合结束：记完成时间。 */
export function markRequirementGroomed(programId: number, requirementKey: string, finishedAt = "") {
  if (!requirementKey) return;
  write(requirementRuntimeKey(programId, requirementKey), {
    groomingStatus: "groomed",
    groomingFinishedAt: finishedAt || new Date().toISOString(),
  });
}

/**
 * 任务执行状态由调用方按服务端的任务与批次现状推出来，这里只负责落到本机。
 * status 传空串表示这条需求还没开始执行，把之前的记录一并清掉。
 */
export function markRequirementExecution(
  programId: number,
  requirementKey: string,
  status: RequirementExecutionStatus,
  times: { startedAt?: string; finishedAt?: string } = {},
) {
  if (!requirementKey) return;
  const entryKey = requirementRuntimeKey(programId, requirementKey);
  const current = read()[entryKey] ?? EMPTY;
  if (!status) {
    write(entryKey, { executionStatus: "", executionStartedAt: "", executionFinishedAt: "" });
    return;
  }
  write(entryKey, {
    executionStatus: status,
    executionStartedAt: times.startedAt || current.executionStartedAt || new Date().toISOString(),
    executionFinishedAt: status === "done"
      ? (times.finishedAt || current.executionFinishedAt || new Date().toISOString())
      : "",
  });
}

/** 需求进度接口里与执行状态有关的那部分，进度窗和工作台都按这一份口径判定。 */
export interface RequirementExecutionSnapshot {
  statusCounts: Record<"todo" | "doing" | "done" | "blocked" | "dropped", number>;
  batches: Array<{ status: string; startedAt?: string; finishedAt?: string }>;
}

/**
 * 按一份需求进度快照推出任务执行状态并落到本机缓存：
 * 有批次在跑、有任务在跑，或者已经动过但还没走完 → 进行中；除「不做」外全部完成 → 已完成。
 * 结束时间优先取批次自己的完成时间，批次记录被清掉时才退回观察到完成的这一刻。
 */
export function applyRequirementExecutionSnapshot(
  programId: number,
  requirementKey: string,
  snapshot: RequirementExecutionSnapshot,
) {
  if (!requirementKey) return;
  const counts = snapshot.statusCounts;
  const batches = snapshot.batches ?? [];
  const startedAt = batches.map((batch) => batch.startedAt || "").filter(Boolean).sort()[0] || "";
  // 「不做」的任务不参与判定：留着它们会让需求永远差一条，凑不齐已完成。
  const counted = counts.todo + counts.doing + counts.done + counts.blocked;
  const running = counts.doing > 0 || batches.some((batch) => batch.status === "running");
  if (!running && counted > 0 && counts.done === counted) {
    const finishedAt = batches.map((batch) => batch.finishedAt || "").filter(Boolean).sort().pop() || "";
    markRequirementExecution(programId, requirementKey, "done", { startedAt, finishedAt });
    return;
  }
  // 有任务停在受阻或已完成上，说明这轮执行开过头了，只是还没走完，仍算进行中。
  const started = running || counts.done + counts.blocked > 0 || batches.length > 0;
  markRequirementExecution(programId, requirementKey, started ? "running" : "", { startedAt });
}

/**
 * 订阅这份缓存：同一个标签页内靠自定义事件，别的标签页靠 storage 事件。
 * 返回整份映射，列表按 `${programId}:${requirementKey}` 取自己那条。
 */
export function useRequirementRuntimeMap(): RequirementRuntimeMap {
  const [map, setMap] = useState<RequirementRuntimeMap>({});
  useEffect(() => {
    const sync = () => setMap(read());
    sync();
    window.addEventListener(CHANGED_EVENT, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(CHANGED_EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, []);
  return map;
}
