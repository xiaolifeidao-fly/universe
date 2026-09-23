"use client";

import { useCallback, useEffect, useState } from "react";
import { GitCommitHorizontal, LoaderCircle, RotateCw, Upload } from "lucide-react";
import { ApiError } from "@/api/client";
import { fetchGitProjects, fetchGitStatus, pushGitBranchAndWait } from "@/api/workbench.api";
import { Sheet } from "@/components/sheet";
import type { GitProjectSnapshot, GitPushResult, GitStatus } from "@/features/workbench/types";

/**
 * 当前分支的提交面板。
 *
 * 建需求分支被「工作目录有未提交改动」挡住时，从提示里直接开这一屏把改动落成提交，
 * 不用先退出去找需求的 Git 面板 —— 这会儿需求还没建出来，那个面板根本还不存在。
 *
 * 提交落在工作目录此刻所在的分支上：本机不在哪条分支上（游离 HEAD）就不猜，直接说明情况。
 */
export function GitCommitSheet({
  open,
  programId,
  writable,
  onClose,
  onCommitted,
}: {
  open: boolean;
  programId: number;
  writable: boolean;
  onClose: () => void;
  /** 提交成功后交给调用方：错误提示该清掉，分支也该重新读一次。 */
  onCommitted: (summary: string) => void;
}) {
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [projects, setProjects] = useState<GitProjectSnapshot[]>([]);
  // 一起提交哪几个子工程由用户勾：默认只勾有改动的那些，干净的工程没必要跟着动。
  const [targets, setTargets] = useState<string[]>([]);
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState("");
  const [progressNote, setProgressNote] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    if (!programId) return;
    setLoading(true);
    setError("");
    try {
      const next = await fetchGitStatus(programId);
      setStatus(next);
      // 提交说明只在用户还没写过时跟着分支走，刷新不会盖掉正在填的那句。
      setMessage((current) => current || `chore: ${next.currentBranch || "工作目录改动"}`);
      // 子工程读不到不该挡住提交：退化成只提交根工作目录。
      const catalog = await fetchGitProjects(programId).catch(() => null);
      const children = (catalog?.projects ?? []).filter((project) => project.path && project.isGitRepository && !project.error);
      setProjects(children);
      setTargets(children.filter((project) => project.dirty).map((project) => project.path));
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.message : "无法读取工作目录状态。");
    } finally {
      setLoading(false);
    }
  }, [programId]);

  useEffect(() => {
    if (!open) return;
    setError("");
    setProgressNote("");
    void load();
  }, [load, open]);

  const branch = status?.currentBranch ?? "";
  // 勾中的工程里只要有一个有改动就有得提交；全都干净时「仅提交」没有意义。
  const dirty = Boolean(status?.dirty) || projects.some((project) => targets.includes(project.path) && project.dirty);

  const toggleTarget = (path: string) => {
    setTargets((current) => (current.includes(path) ? current.filter((item) => item !== path) : [...current, path]));
  };

  /** commitOnly：只在本机落一个提交点。解开建分支的阻塞用不着推远端，推不推由用户自己决定。 */
  const commit = async (commitOnly: boolean) => {
    const label = commitOnly ? "提交" : "提交并推送";
    if (!branch) return;
    setBusy(label);
    setError("");
    setProgressNote(`正在执行电脑上${label}`);
    try {
      const result = await pushGitBranchAndWait({
        programId,
        branch,
        message: message.trim() || `chore: ${branch}`,
        // 子工程的改动同样会挡住建分支，按勾选一并提交；一个都没勾就只提交根目录。
        targets,
        commitOnly,
      }, {
        onProgress: (progress) => setProgressNote(progress.message || `正在执行电脑上${label}`),
      });
      const failed = (result.results ?? []).filter((entry) => entry.path && entry.error);
      if (failed.length) {
        // 根目录已经提交了：个别子工程没成功要说清是哪几个，面板留在原地等用户处理。
        setError(`这些子工程没有${label}成功：${failed.map((entry) => entry.name || entry.path).join("、")}`);
        setProgressNote("");
        void load();
        return;
      }
      onCommitted(summaryOf(result, commitOnly, label));
      onClose();
    } catch (reason) {
      // git 的原文往往是好几行冲突说明，原样留在面板里，比一闪而过的提示有用。
      setError(reason instanceof ApiError ? reason.message : `${label}失败，请稍后重试。`);
      setProgressNote("");
    } finally {
      setBusy("");
    }
  };

  return (
    <Sheet
      open={open}
      title="提交改动"
      subtitle={branch}
      onClose={onClose}
      actions={
        <button className="icon-button" type="button" onClick={() => void load()} aria-label="刷新" title="刷新" disabled={loading || Boolean(busy)}>
          <RotateCw size={21} className={loading ? "spin-icon" : ""} />
        </button>
      }
      footer={
        /* 提交说明和两个动作钉在底部：子工程一多，正文就滚起来了，填写和确认不该跟着滚走。 */
        <>
          {error ? <p className="form-message is-error" role="alert">{error}</p> : null}
          <div className="field">
            <label htmlFor="git-commit-message">提交说明</label>
            <textarea
              id="git-commit-message"
              rows={2}
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              placeholder="本次提交说明"
              disabled={Boolean(busy)}
            />
          </div>

          {busy && progressNote ? (
            <p className="chat-running" role="status"><LoaderCircle size={17} className="spin-icon" aria-hidden="true" />{progressNote}</p>
          ) : null}

          <div className="stack-actions">
            <button
              className="button button-primary"
              type="button"
              disabled={!writable || !branch || !dirty || Boolean(busy) || loading}
              onClick={() => void commit(true)}
            >
              <GitCommitHorizontal size={19} aria-hidden="true" />仅提交
            </button>
            <button
              className="button button-secondary"
              type="button"
              disabled={!writable || !branch || Boolean(busy) || loading}
              onClick={() => void commit(false)}
            >
              <Upload size={19} aria-hidden="true" />提交并推送
            </button>
          </div>
          {!writable ? <p className="field-help">当前项目只读，不能提交 Git 操作。</p> : null}
        </>
      }
    >
      {loading ? <p className="git-loading"><LoaderCircle size={18} className="spin-icon" aria-hidden="true" />正在与执行电脑通信</p> : null}

      {status ? (
        <div className="detail-list">
          <div className="detail-row"><span>当前分支</span><strong>{branch || "游离 HEAD"}</strong></div>
          <div className="detail-row"><span>工作区</span><strong>{status.dirty ? `${status.changed} 处未提交` : "干净"}</strong></div>
          <div className="detail-row"><span>已暂存 / 未暂存</span><strong>{status.staged} / {status.unstaged}</strong></div>
          <div className="detail-row"><span>未跟踪</span><strong>{status.untracked}</strong></div>
        </div>
      ) : null}

      {!branch && status ? (
        <p className="field-help">工作目录当前不在任何分支上（游离 HEAD），请先在执行电脑上切到一条分支。</p>
      ) : null}
      {branch && !dirty && !loading ? <p className="field-help">工作目录没有未提交的改动，可以直接回去建分支。</p> : null}

      {projects.length ? (
        <section className="git-actions" aria-label="一起提交的子工程">
          <p className="field-help">默认只提交有改动的子工程，其它工程要不要跟着提交由你勾。</p>
          <div className="option-list">
            {projects.map((project) => {
              const selected = targets.includes(project.path);
              return (
                <label className={`option-row${selected ? " is-selected" : ""}`} key={project.path}>
                  <span>
                    <strong>{project.name || project.path}</strong>
                    <small>{project.currentBranch || "游离 HEAD"}{project.dirty ? ` · ${project.changed ?? 0} 处未提交` : " · 干净"}</small>
                  </span>
                  <input
                    type="checkbox"
                    checked={selected}
                    onChange={() => toggleTarget(project.path)}
                    disabled={Boolean(busy)}
                    aria-label={`一起提交 ${project.name || project.path}`}
                  />
                </label>
              );
            })}
          </div>
        </section>
      ) : null}
    </Sheet>
  );
}

/** 提交完成后的一句话：说清改动落在哪条分支上，推没推出去。 */
function summaryOf(result: GitPushResult, commitOnly: boolean, label: string) {
  const branch = result.branch || "当前分支";
  if (!result.committed && !result.pushed) return `${branch} 没有需要提交的改动。`;
  if (commitOnly) return `已把改动提交到 ${branch}，还没推送。`;
  if (result.upToDate) return `${branch} 已经和 ${result.remote || "远端"} 一致。`;
  return `已${label}到 ${result.remote ? `${result.remote}/${branch}` : branch}。`;
}
