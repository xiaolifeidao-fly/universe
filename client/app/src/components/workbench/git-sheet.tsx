"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowLeft,
  Check,
  GitBranch,
  GitCommitHorizontal,
  GitMerge,
  LoaderCircle,
  RotateCw,
  Stethoscope,
} from "lucide-react";
import { ApiError } from "@/api/client";
import type { ProgramSummary, RequirementSummary } from "@/api/management.api";
import {
  createGitBranch,
  fetchGitBranches,
  fetchGitChangeDetail,
  fetchGitChanges,
  fetchGitMergePreview,
  fetchGitProjects,
  fetchGitStatus,
  fetchGitWorkspaceCheck,
  initGitSubmodules,
  initGitWorkspace,
  mergeGitBranches,
  prepareGitBranch,
  pushGitBranch,
} from "@/api/workbench.api";
import { Sheet } from "@/components/sheet";
import { DiffView } from "@/components/workbench/diff-view";
import type {
  GitBranchCatalog,
  GitChangeDetail,
  GitChangeList,
  GitMergePreview,
  GitMergeProject,
  GitProjectList,
  GitStatus,
  GitWorkspaceCheck,
} from "@/features/workbench/types";

type GitTab = "status" | "branches" | "changes" | "projects" | "merge";

const tabs: { value: GitTab; label: string }[] = [
  { value: "status", label: "状态" },
  { value: "branches", label: "分支" },
  { value: "changes", label: "改动" },
  { value: "projects", label: "工程" },
  { value: "merge", label: "合并" },
];

/** 根工作目录在预览结果里没有路径，勾选状态用这个键表示它。 */
const ROOT_PROJECT = "";

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
  const [check, setCheck] = useState<GitWorkspaceCheck | null>(null);
  const [mergeTarget, setMergeTarget] = useState("");
  const [preview, setPreview] = useState<GitMergePreview | null>(null);
  const [mergeProjects, setMergeProjects] = useState<string[]>([]);

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
      // 合并要先知道默认分支：目标分支的候选值就是从分支目录里来的。
      if (next === "merge" && !branches) setBranches(await fetchGitBranches(programId));
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.message : "无法读取 Git 信息。");
    } finally {
      setLoading(false);
    }
  }, [branch, branches, programId]);

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
    setPreview(null);
    setCheck(null);
  }, [open, requirement]);

  // 合并目标默认是仓库的默认分支：需求分支做完了要回的就是那里。
  useEffect(() => {
    if (!mergeTarget && branches?.defaultBranch) setMergeTarget(branches.defaultBranch);
  }, [branches, mergeTarget]);

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

  const runWorkspaceCheck = async () => {
    setBusy("工作目录体检");
    setError("");
    setNotice("");
    try {
      setCheck(await fetchGitWorkspaceCheck(programId));
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.message : "体检未完成。");
    } finally {
      setBusy("");
    }
  };

  const runPreview = async () => {
    const target = mergeTarget.trim();
    const source = branch.trim();
    if (!target || !source) return;
    setBusy("合并预览");
    setError("");
    setNotice("");
    try {
      const next = await fetchGitMergePreview(programId, target, [source], program?.gitRemoteName);
      setPreview(next);
      // 默认勾上真的有东西可合的工程：没有目标分支、读不动、或者一个文件都不动的先不勾。
      setMergeProjects(next.projects.filter(mergeable).map((project) => project.path || ROOT_PROJECT));
    } catch (reason) {
      setPreview(null);
      setError(reason instanceof ApiError ? reason.message : "合并预览未完成。");
    } finally {
      setBusy("");
    }
  };

  const startMerge = async () => {
    const target = mergeTarget.trim();
    const source = branch.trim();
    if (!target || !source || !mergeProjects.length) return;
    await run("合并分支", () => mergeGitBranches({
      programId,
      target,
      sources: [source],
      targets: mergeProjects.filter((path) => path !== ROOT_PROJECT),
      skipRoot: !mergeProjects.includes(ROOT_PROJECT),
      remoteName: program?.gitRemoteName,
    }));
  };

  const toggleMergeProject = (path: string) => {
    setMergeProjects((current) => (current.includes(path) ? current.filter((item) => item !== path) : [...current, path]));
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
          <RotateCw size={21} className={loading ? "spin-icon" : ""} />
        </button>
      }
    >
      {detail ? (
        <div className="git-detail">
          <button className="chip-button" type="button" onClick={() => setDetail(null)}><ArrowLeft size={18} aria-hidden="true" />返回改动</button>
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
          {loading ? <p className="git-loading"><LoaderCircle size={18} className="spin-icon" aria-hidden="true" />正在与执行电脑通信</p> : null}

          {tab === "status" && status ? (
            <div className="detail-list">
              <div className="detail-row"><span>当前分支</span><strong>{status.currentBranch || "游离 HEAD"}</strong></div>
              <div className="detail-row"><span>远端</span><strong>{status.remoteName}{status.remoteMatches ? "" : " · 与项目配置不一致"}</strong></div>
              <div className="detail-row"><span>工作区</span><strong>{status.dirty ? `${status.changed} 处未提交` : "干净"}</strong></div>
              <div className="detail-row"><span>已暂存 / 未暂存</span><strong>{status.staged} / {status.unstaged}</strong></div>
              <div className="detail-row"><span>未跟踪</span><strong>{status.untracked}</strong></div>
            </div>
          ) : null}

          {tab === "status" ? (
            <section className="git-actions">
              <button className="button button-secondary full-width" type="button" disabled={Boolean(busy)} onClick={() => void runWorkspaceCheck()}>
                <Stethoscope size={19} aria-hidden="true" />工作目录体检
              </button>
              {check ? (
                <div className="detail-list">
                  <div className="detail-row"><span>目录</span><strong>{check.exists ? "存在" : "不在执行电脑上"}</strong></div>
                  <div className="detail-row"><span>Git 仓库</span><strong>{check.isGitRepository ? "是" : check.empty ? "空目录，还没初始化" : "不是仓库"}</strong></div>
                  <div className="detail-row"><span>远端 {check.remoteName}</span><strong>{check.remoteConfigured ? "已配置" : "未配置"}</strong></div>
                  <div className="detail-row"><span>待初始化子模块</span><strong>{check.pendingSubmodules.length ? check.pendingSubmodules.join("、") : "无"}</strong></div>
                </div>
              ) : null}
              {check?.pendingSubmodules.length ? (
                <button className="button button-secondary full-width" type="button" disabled={!writable || Boolean(busy)} onClick={() => void run("拉取子模块", () => initGitSubmodules(programId))}>
                  <GitBranch size={19} aria-hidden="true" />拉取子模块
                </button>
              ) : null}
              {check && !check.isGitRepository ? (
                program?.gitRepositoryUrl ? (
                  <>
                    <p className="field-help">
                      这个目录还不是 Git 仓库。按项目登记的地址关联远端：{program.gitRepositoryUrl}
                      {check.exists ? "" : "（目录不在执行电脑上，得先在那台电脑上建出来）"}
                    </p>
                    <button
                      className="button button-secondary full-width"
                      type="button"
                      disabled={!writable || !check.exists || Boolean(busy)}
                      onClick={() => void run("关联远端仓库", () => initGitWorkspace({
                        programId,
                        repositoryUrl: program.gitRepositoryUrl,
                        remoteName: program.gitRemoteName,
                        baseBranch: program.gitBaseBranch,
                      }))}
                    >
                      <GitBranch size={19} aria-hidden="true" />关联远端仓库
                    </button>
                  </>
                ) : (
                  <p className="field-help">这个目录还不是 Git 仓库，而项目也没有登记仓库地址。先在项目设置里填上地址，这里才知道要关联到哪儿。</p>
                )
              ) : null}
            </section>
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
                  {name === branch ? <Check size={20} aria-hidden="true" /> : null}
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

          {tab === "merge" ? (
            <section className="git-actions">
              <div className="field">
                <label htmlFor="git-merge-target">合并到</label>
                <input
                  id="git-merge-target"
                  value={mergeTarget}
                  onChange={(event) => { setMergeTarget(event.target.value); setPreview(null); }}
                  placeholder={branches?.defaultBranch || "main"}
                  autoCapitalize="none"
                  spellCheck={false}
                  list="git-merge-branches"
                />
                <datalist id="git-merge-branches">
                  {(branches?.branches ?? []).map((name) => <option value={name} key={name} />)}
                </datalist>
              </div>
              <p className="field-help">来源分支是下面那条需求分支：{branch || "还没有分支"}。冲突由执行电脑上的 AI 解开后再推送。</p>
              <button className="button button-secondary full-width" type="button" disabled={!mergeTarget.trim() || !branch.trim() || Boolean(busy)} onClick={() => void runPreview()}>
                <GitMerge size={19} aria-hidden="true" />{busy === "合并预览" ? "正在预览（要先拉远端）" : "预览合并"}
              </button>

              {preview ? (
                preview.projects.length ? (
                  <div className="option-list">
                    {preview.projects.map((project) => {
                      const path = project.path || ROOT_PROJECT;
                      const selected = mergeProjects.includes(path);
                      return (
                        <button
                          className={`option-row${selected ? " is-selected" : ""}`}
                          type="button"
                          key={path || "root"}
                          onClick={() => toggleMergeProject(path)}
                          disabled={!project.hasTarget || Boolean(project.error)}
                        >
                          <span>
                            <strong>{project.name || "根工作目录"}</strong>
                            <small>{mergeProjectSummary(project)}</small>
                          </span>
                          {selected ? <Check size={20} aria-hidden="true" /> : null}
                        </button>
                      );
                    })}
                  </div>
                ) : <p className="field-help">预览没有返回任何工程。</p>
              ) : null}

              {preview ? (
                <button className="button button-primary full-width" type="button" disabled={!writable || !mergeProjects.length || Boolean(busy)} onClick={() => void startMerge()}>
                  <GitMerge size={19} aria-hidden="true" />合并选中的 {mergeProjects.length} 个工程并推送
                </button>
              ) : null}
              <p className="field-help">合并会切分支、改工作区文件，执行电脑上还有任务在跑时会被拒绝。一轮可能跑几十分钟，提交后到运行记录里看进展。</p>
            </section>
          ) : null}

          <section className="git-actions">
            <div className="field">
              <label htmlFor="git-branch">需求分支</label>
              <input id="git-branch" value={branch} onChange={(event) => setBranch(event.target.value)} placeholder="feature/..." autoCapitalize="none" spellCheck={false} />
            </div>
            <div className="stack-actions">
              <button className="button button-primary" type="button" disabled={!writable || !branch.trim() || Boolean(busy)} onClick={() => void run("切到该分支", () => prepareGitBranch({ programId, branch: branch.trim(), remoteName: program?.gitRemoteName }))}>
                <GitBranch size={19} aria-hidden="true" />切到该分支
              </button>
              <button className="button button-secondary" type="button" disabled={!writable || !branch.trim() || Boolean(busy)} onClick={() => void run("创建分支", () => createGitBranch({ programId, branch: branch.trim(), baseBranch: branches?.defaultBranch ?? "" }))}>
                <GitBranch size={19} aria-hidden="true" />创建分支
              </button>
            </div>
            <div className="field">
              <label htmlFor="git-commit">提交说明</label>
              <textarea id="git-commit" value={commitMessage} onChange={(event) => setCommitMessage(event.target.value)} placeholder="本次提交说明" />
            </div>
            <button className="button button-secondary full-width" type="button" disabled={!writable || !branch.trim() || !commitMessage.trim() || Boolean(busy)} onClick={() => void run("提交并推送", () => pushGitBranch({ programId, branch: branch.trim(), message: commitMessage.trim() }))}>
              <GitCommitHorizontal size={19} aria-hidden="true" />提交并推送
            </button>
            {!writable ? <p className="field-help">当前项目只读，不能提交 Git 操作。</p> : null}
          </section>
        </>
      )}
    </Sheet>
  );
}

/** 真的有东西可合的工程：有目标分支、读得动、而且确实有文件会变。 */
function mergeable(project: GitMergeProject) {
  return project.hasTarget && !project.error && project.changedFiles > 0;
}

/** 一行说清这个工程的合并处境：会动多少文件、缺不缺目标分支、工作区脏不脏。 */
function mergeProjectSummary(project: GitMergeProject) {
  if (project.error) return `读不动：${project.error}`;
  if (!project.hasTarget) return "这个工程里没有目标分支，本轮跳过";
  const commits = project.sources.reduce((total, source) => total + (source.commits || 0), 0);
  const missing = project.sources.filter((source) => !source.exists).map((source) => source.branch);
  const parts = [project.changedFiles ? `${project.changedFiles} 个文件 · ${commits} 个提交` : "没有要合的内容"];
  if (missing.length) parts.push(`缺少来源分支 ${missing.join("、")}`);
  if (project.dirty) parts.push("工作区有未提交改动");
  return parts.join(" · ");
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
