"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowLeft,
  Check,
  GitBranch,
  GitCommitHorizontal,
  LoaderCircle,
  RotateCw,
} from "lucide-react";
import { ApiError } from "@/api/client";
import type { ProgramSummary, RequirementSummary } from "@/api/management.api";
import {
  createGitBranch,
  fetchGitBranches,
  fetchGitChangeDetail,
  fetchGitChanges,
  fetchGitProjects,
  fetchGitStatus,
  prepareGitBranch,
  pushGitBranch,
} from "@/api/workbench.api";
import { Sheet } from "@/components/sheet";
import { DiffView } from "@/components/workbench/diff-view";
import type { GitBranchCatalog, GitChangeDetail, GitChangeList, GitProjectList, GitStatus } from "@/features/workbench/types";

type GitTab = "status" | "branches" | "changes" | "projects";

const tabs: { value: GitTab; label: string }[] = [
  { value: "status", label: "状态" },
  { value: "branches", label: "分支" },
  { value: "changes", label: "改动" },
  { value: "projects", label: "工程" },
];

/** 需求上的 Git 区域：状态、分支、改动和子工程，操作都以远程命令交给执行电脑。 */
export function GitSheet({
  open,
  programId,
  program,
  requirement,
  onClose,
}: {
  open: boolean;
  programId: number;
  program: ProgramSummary | null;
  requirement: RequirementSummary | null;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<GitTab>("status");
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [branches, setBranches] = useState<GitBranchCatalog | null>(null);
  const [changes, setChanges] = useState<GitChangeList | null>(null);
  const [projects, setProjects] = useState<GitProjectList | null>(null);
  const [detail, setDetail] = useState<GitChangeDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [branch, setBranch] = useState("");
  const [commitMessage, setCommitMessage] = useState("");

  const writable = Boolean(program?.canWrite);

  const load = useCallback(async (next: GitTab) => {
    if (!programId) return;
    setLoading(true);
    setError("");
    try {
      if (next === "status") setStatus(await fetchGitStatus(programId));
      if (next === "branches") setBranches(await fetchGitBranches(programId));
      if (next === "changes") setChanges(await fetchGitChanges(programId));
      if (next === "projects") setProjects(await fetchGitProjects(programId, branch));
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.message : "无法读取 Git 信息。");
    } finally {
      setLoading(false);
    }
  }, [branch, programId]);

  useEffect(() => {
    if (!open) return;
    setDetail(null);
    setNotice("");
    void load(tab);
  }, [load, open, tab]);

  useEffect(() => {
    if (!open) return;
    setBranch(requirementBranch(requirement));
    setCommitMessage(requirement ? `${requirement.name || requirement.requirementKey}` : "");
  }, [open, requirement]);

  const run = async (label: string, action: () => Promise<unknown>) => {
    setBusy(label);
    setError("");
    setNotice("");
    try {
      await action();
      setNotice(`${label}已提交，可在运行记录里跟进。`);
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.message : `${label}未提交。`);
    } finally {
      setBusy("");
    }
  };

  const openDetail = async (path: string) => {
    setLoading(true);
    setError("");
    try {
      setDetail(await fetchGitChangeDetail(programId, path));
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.message : "无法读取该文件的差异。");
    } finally {
      setLoading(false);
    }
  };

  const subtitle = useMemo(() => requirement?.name || requirement?.requirementKey || "", [requirement]);

  return (
    <Sheet
      open={open}
      title="Git"
      subtitle={subtitle}
      onClose={onClose}
      actions={
        <button className="icon-button" type="button" onClick={() => void load(tab)} aria-label="刷新" title="刷新" disabled={loading}>
          <RotateCw size={19} className={loading ? "spin-icon" : ""} />
        </button>
      }
    >
      {detail ? (
        <div className="git-detail">
          <button className="chip-button" type="button" onClick={() => setDetail(null)}><ArrowLeft size={16} aria-hidden="true" />返回改动</button>
          <p className="git-detail__path">{detail.path}</p>
          <DiffView oldText={detail.oldText} newText={detail.newText} binary={detail.binary} truncated={detail.truncated} />
        </div>
      ) : (
        <>
          <div className="segmented" role="tablist" aria-label="Git 视图">
            {tabs.map((item) => (
              <button key={item.value} type="button" role="tab" aria-selected={tab === item.value} className={tab === item.value ? "is-active" : ""} onClick={() => setTab(item.value)}>
                {item.label}
              </button>
            ))}
          </div>

          {error ? <p className="form-message is-error" role="alert">{error}</p> : null}
          {notice ? <p className="form-message is-success" role="status">{notice}</p> : null}
          {loading ? <p className="git-loading"><LoaderCircle size={16} className="spin-icon" aria-hidden="true" />正在与执行电脑通信</p> : null}

          {tab === "status" && status ? (
            <div className="detail-list">
              <div className="detail-row"><span>当前分支</span><strong>{status.currentBranch || "游离 HEAD"}</strong></div>
              <div className="detail-row"><span>远端</span><strong>{status.remoteName}{status.remoteMatches ? "" : " · 与项目配置不一致"}</strong></div>
              <div className="detail-row"><span>工作区</span><strong>{status.dirty ? `${status.changed} 处未提交` : "干净"}</strong></div>
              <div className="detail-row"><span>已暂存 / 未暂存</span><strong>{status.staged} / {status.unstaged}</strong></div>
              <div className="detail-row"><span>未跟踪</span><strong>{status.untracked}</strong></div>
            </div>
          ) : null}

          {tab === "branches" && branches ? (
            <div className="option-list">
              {branches.fetchError ? <p className="field-help">远端同步失败：{branches.fetchError}</p> : null}
              {branches.branches.map((name) => (
                <button className={`option-row${name === branch ? " is-selected" : ""}`} type="button" key={name} onClick={() => setBranch(name)}>
                  <span>
                    <strong>{name}</strong>
                    {name === branches.currentBranch ? <small>当前所在分支</small> : null}
                  </span>
                  {name === branch ? <Check size={18} aria-hidden="true" /> : null}
                </button>
              ))}
            </div>
          ) : null}

          {tab === "changes" && changes ? (
            changes.files.length ? (
              <ul className="git-change-list">
                {changes.files.map((file) => (
                  <li key={file.path}>
                    <button type="button" onClick={() => void openDetail(file.path)}>
                      <span className="git-change-list__kind" data-kind={file.kind}>{kindLabel(file.kind)}</span>
                      <span className="git-change-list__path">{file.path}</span>
                      <span className="change-summary__counts"><em>+{file.added}</em><i>-{file.removed}</i></span>
                    </button>
                  </li>
                ))}
                {changes.truncated ? <li className="field-help">改动过多，只列出前 {changes.files.length} 个文件。</li> : null}
              </ul>
            ) : <p className="field-help">工作区没有未提交的改动。</p>
          ) : null}

          {tab === "projects" && projects ? (
            <div className="git-project-list">
              {projects.projects.map((project) => (
                <div className="git-project" key={project.workspace}>
                  <strong>{project.name || "根工作目录"}</strong>
                  <small>{project.currentBranch || "游离 HEAD"}{project.dirty ? ` · ${project.changed ?? 0} 处未提交` : " · 干净"}</small>
                  {project.message ? <small className="muted">{project.message}</small> : null}
                </div>
              ))}
            </div>
          ) : null}

          <section className="git-actions">
            <div className="field">
              <label htmlFor="git-branch">需求分支</label>
              <input id="git-branch" value={branch} onChange={(event) => setBranch(event.target.value)} placeholder="feature/..." autoCapitalize="none" spellCheck={false} />
            </div>
            <div className="stack-actions">
              <button className="button button-primary" type="button" disabled={!writable || !branch.trim() || Boolean(busy)} onClick={() => void run("切到该分支", () => prepareGitBranch({ programId, branch: branch.trim(), remoteName: program?.gitRemoteName }))}>
                <GitBranch size={17} aria-hidden="true" />切到该分支
              </button>
              <button className="button button-secondary" type="button" disabled={!writable || !branch.trim() || Boolean(busy)} onClick={() => void run("创建分支", () => createGitBranch({ programId, branch: branch.trim(), baseBranch: branches?.defaultBranch ?? "" }))}>
                <GitBranch size={17} aria-hidden="true" />创建分支
              </button>
            </div>
            <div className="field">
              <label htmlFor="git-commit">提交说明</label>
              <textarea id="git-commit" value={commitMessage} onChange={(event) => setCommitMessage(event.target.value)} placeholder="本次提交说明" />
            </div>
            <button className="button button-secondary full-width" type="button" disabled={!writable || !branch.trim() || !commitMessage.trim() || Boolean(busy)} onClick={() => void run("提交并推送", () => pushGitBranch({ programId, branch: branch.trim(), message: commitMessage.trim() }))}>
              <GitCommitHorizontal size={17} aria-hidden="true" />提交并推送
            </button>
            {!writable ? <p className="field-help">当前项目只读，不能提交 Git 操作。</p> : null}
          </section>
        </>
      )}
    </Sheet>
  );
}

/** 需求已经绑过分支就用它，没绑时给一个按需求键推导的候选名。 */
function requirementBranch(requirement: RequirementSummary | null) {
  if (!requirement) return "";
  return requirement.gitBranch?.trim() || `feature/${requirement.requirementKey}`;
}

function kindLabel(kind: string) {
  if (kind === "add") return "新增";
  if (kind === "delete") return "删除";
  if (kind === "rename") return "重命名";
  return "修改";
}
