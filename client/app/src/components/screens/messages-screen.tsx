"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useMemo, useState } from "react";
import { AlertTriangle, CircleCheck, CirclePlay, Inbox, RotateCw } from "lucide-react";
import {
  markExecutionBatchMessageRead,
  markRequirementCompletionMessageRead,
  type AttentionTaskMessage,
  type ExecutionBatchMessage,
  type RequirementCompletionMessage,
} from "@/api/messages.api";
import { EmptyState } from "@/components/empty-state";
import { LoadingState } from "@/components/loading-state";
import { useMessages } from "@/components/messages-provider";
import { relativeTimeLabel } from "@/lib/date";

type MessageTab = "batches" | "completions" | "attention";

const batchModeLabels: Record<string, string> = {
  parallel: "并行执行",
  serial: "串行执行",
  dependency: "按依赖执行",
};

function attentionLabel(status: AttentionTaskMessage["status"]) {
  return status === "blocked" ? "受阻" : status === "dropped" ? "不做" : status;
}

export function MessagesScreen() {
  const router = useRouter();
  // 拉取和轮询都在外壳的 MessagesProvider 里，底部导航的角标和这一页共用同一份快照。
  const { snapshot, loading, error, refresh, applyRead } = useMessages();
  const [tab, setTab] = useState<MessageTab>("batches");

  const counts = useMemo(() => ({
    batches: snapshot.batches.filter((batch) => !batch.notificationReadAt).length,
    completions: snapshot.completions.filter((completion) => !completion.notificationReadAt).length,
    attention: snapshot.attention.length,
  }), [snapshot]);

  const openBatch = useCallback(async (batch: ExecutionBatchMessage) => {
    // 先本地标已读再跳转：等接口回来再跳会让点击有明显延迟，
    // 确认失败也无所谓，下一次轮询会把真实的已读态取回来。
    applyRead((current) => ({
      ...current,
      batches: current.batches.map((entry) => (
        entry.programId === batch.programId && entry.batchId === batch.batchId
          ? { ...entry, notificationReadAt: entry.notificationReadAt ?? new Date().toISOString() }
          : entry
      )),
    }));
    void markExecutionBatchMessageRead(batch.programId, batch.batchId).catch(() => undefined);
    router.push(`/workbench/requirements/${encodeURIComponent(batch.requirementKey)}/progress?programId=${batch.programId}`);
  }, [applyRead, router]);

  const openCompletion = useCallback(async (completion: RequirementCompletionMessage) => {
    applyRead((current) => ({
      ...current,
      completions: current.completions.map((entry) => (
        entry.programId === completion.programId && entry.requirementKey === completion.requirementKey
          ? { ...entry, notificationReadAt: entry.notificationReadAt ?? new Date().toISOString() }
          : entry
      )),
    }));
    void markRequirementCompletionMessageRead(completion.programId, completion.requirementKey).catch(() => undefined);
    router.push(`/projects/${completion.programId}/requirements/${encodeURIComponent(completion.requirementKey)}`);
  }, [applyRead, router]);

  const tabs: { value: MessageTab; label: string; count: number; icon: typeof CirclePlay }[] = [
    { value: "batches", label: "批次完成", count: counts.batches, icon: CirclePlay },
    { value: "completions", label: "需求完成", count: counts.completions, icon: CircleCheck },
    { value: "attention", label: "待关注", count: counts.attention, icon: AlertTriangle },
  ];

  return (
    <main className="screen">
      <div className="screen-title-row">
        <div>
          <p className="eyebrow">交付管理</p>
          <h1>消息</h1>
          <p>执行完成、需求交付和需要你处理的任务。</p>
        </div>
        <button
          className="icon-button"
          type="button"
          onClick={() => refresh()}
          aria-label="刷新消息"
          title="刷新消息"
          disabled={loading}
        >
          <RotateCw size={22} className={loading ? "spin-icon" : ""} />
        </button>
      </div>

      {/* 三类消息的未读语义不同，不并成一条流：批次和需求完成是「看过就消」，
          待关注是「改掉状态才消」，混在一起会让未读数说不清是什么。 */}
      <div className="message-tabs" role="tablist" aria-label="消息分类">
        {tabs.map((entry) => {
          const Icon = entry.icon;
          const active = tab === entry.value;
          return (
            <button
              className={active ? "is-active" : ""}
              type="button"
              role="tab"
              aria-selected={active}
              key={entry.value}
              onClick={() => setTab(entry.value)}
            >
              <span className="message-tabs__top">
                <Icon size={19} aria-hidden="true" />
                <strong>{entry.count}</strong>
              </span>
              <span className="message-tabs__label">{entry.label}</span>
            </button>
          );
        })}
      </div>

      {loading ? <LoadingState title="正在读取消息" /> : null}

      {!loading && error ? (
        <EmptyState
          tone="error"
          icon={<AlertTriangle size={23} />}
          title="暂时无法读取消息"
          description={error}
          action={<button className="button button-primary" type="button" onClick={() => refresh()}>重新连接</button>}
        />
      ) : null}

      {!loading && !error && tab === "batches" ? (
        snapshot.batches.length ? (
          <section className="message-list" aria-label="批次完成消息">
            {snapshot.batches.map((batch) => (
              <button
                className={`message-row${batch.notificationReadAt ? "" : " is-unread"}`}
                type="button"
                key={`${batch.programId}:${batch.batchId}`}
                onClick={() => void openBatch(batch)}
              >
                <span className="message-row__icon is-brand" aria-hidden="true"><CirclePlay size={21} /></span>
                <span className="message-row__body">
                  <strong>{batch.requirementName || batch.requirementKey}</strong>
                  <span className="message-row__summary">
                    {batchModeLabels[batch.mode] ?? batch.mode} 完成 {batch.completedCount}/{batch.itemCount}
                    {batch.blockedCount ? ` · ${batch.blockedCount} 受阻` : ""}
                  </span>
                  <span className="message-row__meta">
                    <span>{batch.programName}</span>
                    {batch.requirementGitBranch ? <span>{batch.requirementGitBranch}</span> : null}
                    <span>{relativeTimeLabel(batch.finishedAt)}</span>
                  </span>
                </span>
                {batch.notificationReadAt ? null : <span className="message-row__dot" aria-label="未读" />}
              </button>
            ))}
          </section>
        ) : (
          <EmptyState icon={<CirclePlay size={23} />} title="没有新的执行完成" description="批量或串行执行跑完后会在这里提醒你，点开可以直接看任务进度。" />
        )
      ) : null}

      {!loading && !error && tab === "completions" ? (
        snapshot.completions.length ? (
          <section className="message-list" aria-label="需求完成消息">
            {snapshot.completions.map((completion) => (
              <button
                className={`message-row${completion.notificationReadAt ? "" : " is-unread"}`}
                type="button"
                key={`${completion.programId}:${completion.requirementKey}`}
                onClick={() => void openCompletion(completion)}
              >
                <span className="message-row__icon is-success" aria-hidden="true"><CircleCheck size={21} /></span>
                <span className="message-row__body">
                  <strong>{completion.requirementName || completion.requirementKey}</strong>
                  <span className="message-row__summary">需求已标记完成</span>
                  <span className="message-row__meta">
                    <span>{completion.programName}</span>
                    <span>{relativeTimeLabel(completion.completedAt)}</span>
                  </span>
                </span>
                {completion.notificationReadAt ? null : <span className="message-row__dot" aria-label="未读" />}
              </button>
            ))}
          </section>
        ) : (
          <EmptyState icon={<CircleCheck size={23} />} title="没有新的需求完成" description="你负责或协助的需求被标记完成后，会在这里通知你。" />
        )
      ) : null}

      {!loading && !error && tab === "attention" ? (
        snapshot.attention.length ? (
          <section className="message-list" aria-label="待关注任务">
            {snapshot.attention.map((task) => (
              <Link
                className="message-row"
                href={`/projects/${task.programId}/tasks/${encodeURIComponent(task.itemKey)}`}
                key={`${task.programId}:${task.itemKey}`}
              >
                <span
                  className={`message-row__icon ${task.status === "blocked" ? "is-danger" : "is-muted"}`}
                  aria-hidden="true"
                >
                  <AlertTriangle size={21} />
                </span>
                <span className="message-row__body">
                  <strong>{task.title}</strong>
                  <span className="message-row__summary">{task.requirementName}</span>
                  <span className="message-row__meta">
                    <span>{task.programName}</span>
                    {task.ownerName ? <span>{task.ownerName}</span> : null}
                    <span>{relativeTimeLabel(task.updatedAt)}</span>
                  </span>
                </span>
                <span className={`status ${task.status === "blocked" ? "is-danger" : ""}`}>{attentionLabel(task.status)}</span>
              </Link>
            ))}
          </section>
        ) : (
          <EmptyState icon={<Inbox size={23} />} title="没有待关注的任务" description="任务被标成「受阻」或「不做」时会出现在这里，改回其它状态就自动消失。" />
        )
      ) : null}
    </main>
  );
}
