"use client";

import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, LoaderCircle, RotateCw } from "lucide-react";
import { ApiError } from "@/api/client";
import { fetchRequirementGroupSession, fetchRequirementSession } from "@/api/workbench.api";
import { ConversationTurns, UsageLine } from "@/components/workbench/conversation-turns";
import type { ConversationSnapshot, RequirementUsageGroupKey } from "@/features/workbench/types";

/**
 * 消耗面板里点开某一块需求会话之后看到的正文。
 *
 * 只读。需求分析、原型、review、需求测试、微调这几块在手机上没有输入框——它们的下一
 * 轮要在电脑的需求窗口里发；这里要回答的是「这一块花掉的钱买到了什么」，翻记录就够。
 *
 * 拆解走的是手机上那条能接着聊的会话命令，正文口径和这里一致，所以同一块面板里
 * 六行都能点开，不必让用户记住哪一行是特例。
 */
export function RequirementSessionPane({
  programId,
  requirementKey,
  group,
  label,
  onBack,
}: {
  programId: number;
  requirementKey: string;
  group: RequirementUsageGroupKey;
  label: string;
  onBack: () => void;
}) {
  const [snapshot, setSnapshot] = useState<ConversationSnapshot | null>(null);
  const [threadId, setThreadId] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async (nextThreadId: string) => {
    setLoading(true);
    setError("");
    try {
      const result = group === "planning"
        ? await fetchRequirementSession(programId, requirementKey, nextThreadId)
        : await fetchRequirementGroupSession(programId, requirementKey, group, nextThreadId);
      setSnapshot(result);
      // 第一次进来不带线程号，桥接挑最近那条回来：跟着它走，会话切换条才知道高亮哪一条。
      setThreadId(result.threadId || nextThreadId);
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.message : "无法读取这一块的会话。");
    } finally {
      setLoading(false);
    }
  }, [group, programId, requirementKey]);

  useEffect(() => {
    void load("");
  }, [load]);

  const threads = snapshot?.conversations ?? [];
  const turns = snapshot?.turns ?? [];
  // 太长的会话 Worker 只回一个截断标记：这时候「还没有会话」是句假话，得说清是取不回来。
  const truncated = Boolean(snapshot?.truncated);

  return (
    <div className="usage-session">
      <div className="usage-session__bar">
        <button className="chip-button" type="button" onClick={onBack}>
          <ArrowLeft size={18} aria-hidden="true" />返回消耗
        </button>
        <button
          className="icon-button"
          type="button"
          onClick={() => void load(threadId)}
          aria-label={`重新读取${label}的会话`}
          title="重新读取"
          disabled={loading}
        >
          {loading ? <LoaderCircle size={20} className="spin-icon" /> : <RotateCw size={20} />}
        </button>
      </div>

      {error ? <p className="form-message is-error" role="alert">{error}</p> : null}

      {threads.length > 1 ? (
        <div className="document-filter" role="tablist" aria-label={`${label}的会话`}>
          {threads.map((thread) => (
            <button
              key={thread.threadId}
              type="button"
              role="tab"
              aria-selected={thread.threadId === threadId}
              className={thread.threadId === threadId ? "is-active" : ""}
              onClick={() => void load(thread.threadId)}
            >
              {thread.title || "未命名对话"}
              {thread.status === "running" ? <small className="document-filter__count">执行中</small> : null}
            </button>
          ))}
        </div>
      ) : null}

      {loading && !turns.length ? (
        <p className="git-loading"><LoaderCircle size={18} className="spin-icon" aria-hidden="true" />正在读取{label}的会话</p>
      ) : null}
      {!loading && !error && !turns.length ? (
        <p className="field-help">
          {truncated
            ? `${label}的会话太长，手机上取不回全文；完整正文在执行电脑的需求窗口里。`
            : `${label}还没有留下可以翻的会话。`}
        </p>
      ) : null}

      {turns.length ? <ConversationTurns turns={turns} /> : null}
      {snapshot?.usage?.totalTokens ? <UsageLine usage={snapshot.usage} label="本会话累计" /> : null}
      {turns.length ? (
        <p className="field-help">这一块在手机上只能翻记录，接着聊要回电脑上的需求窗口。</p>
      ) : null}
    </div>
  );
}
