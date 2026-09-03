"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft, GitBranch, LoaderCircle, MessageSquarePlus, RotateCw, SendHorizontal } from "lucide-react";
import { ApiError } from "@/api/client";
import {
  bindRequirementGitBranch,
  getProgram,
  saveRequirement,
  updateRequirementName,
  type ProgramSummary,
} from "@/api/management.api";
import { createGitBranchAndWait, fetchGitBranches, fetchGitProjects } from "@/api/workbench.api";
import { EmptyState } from "@/components/empty-state";
import { GitCommitSheet } from "@/components/workbench/git-commit-sheet";
import { WorkerOfflineNotice, useWorkerStatus } from "@/components/workbench/worker-status";
import type { GitProjectSnapshot } from "@/features/workbench/types";

/**
 * 新需求的分支名按时间戳起，和 PC 端同一套规则：需求这会儿还没有编号，
 * 只能先有分支再有需求 —— 分支建成之后需求才落库，中途失败不会留下半条记录。
 */
function defaultBranchName(existing: readonly string[] = []) {
  let timestamp = Date.now();
  while (existing.includes(`feature/issue_req-${timestamp}`)) timestamp += 1;
  return `feature/issue_req-${timestamp}`;
}

/**
 * 工作台的「新增需求」。
 *
 * 落点就是需求对话：Git 项目先建需求分支，建成后需求按分支落库，随后跳到这条需求
 * 自己的对话里接着聊 —— 标题由拆解会话按聊天内容自动生成，这里不必先想名字。
 */
export function NewRequirementScreen() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const programId = Number(searchParams.get("programId") ?? 0);

  const [program, setProgram] = useState<ProgramSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [branchesLoading, setBranchesLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  // 需求已经落库、但还有子工程分支没建成时停在这一屏：先说清情况，再由用户决定进不进对话。
  const [createdKey, setCreatedKey] = useState("");
  const [progressNote, setProgressNote] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  // 建分支被未提交改动挡住时就地开的提交面板：这会儿需求还没建出来，没有它自己的 Git 面板可去。
  const [commitOpen, setCommitOpen] = useState(false);
  const [branches, setBranches] = useState<string[]>([]);
  const [baseBranch, setBaseBranch] = useState("");
  const [branch, setBranch] = useState("");
  // 工作目录下的独立子工程：列出来让用户自己勾，默认全勾，和 PC 端一致。
  const [projects, setProjects] = useState<GitProjectSnapshot[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(false);
  const [targets, setTargets] = useState<string[]>([]);
  const { status: workerStatus } = useWorkerStatus(programId);

  const gitEnabled = Boolean(program?.gitEnabled);
  const writable = Boolean(program?.canWrite);

  useEffect(() => {
    if (!programId) {
      setError("缺少项目标识，请回到工作台重新选择项目。");
      setLoading(false);
      return;
    }
    let active = true;
    void getProgram(programId)
      .then((next) => {
        if (!active) return;
        setProgram(next);
        setBaseBranch(next.gitBaseBranch ?? "");
      })
      .catch((reason) => {
        if (active) setError(reason instanceof ApiError ? reason.message : "无法读取项目信息。");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, [programId]);

  const loadBranches = useCallback(async () => {
    if (!programId || !gitEnabled) return;
    setBranchesLoading(true);
    try {
      const catalog = await fetchGitBranches(programId);
      setBranches(catalog.branches);
      setBaseBranch((current) => current || catalog.defaultBranch || catalog.branches[0] || "");
      // 分支名只在还没被用户改过时跟着重算：远端已经有同名分支的概率极低，但重名建不出来。
      setBranch((current) => (current && !catalog.branches.includes(current) ? current : defaultBranchName(catalog.branches)));
      if (catalog.fetchError) setError(`远端分支同步失败：${catalog.fetchError}`);
    } catch (reason) {
      // 读不到分支目录不该挡住建分支：基准分支退回项目配置，名字用本地默认值。
      setBranch((current) => current || defaultBranchName());
      setError(reason instanceof ApiError ? reason.message : "无法读取分支列表。");
    } finally {
      setBranchesLoading(false);
    }
  }, [gitEnabled, programId]);

  useEffect(() => { void loadBranches(); }, [loadBranches]);

  // 子工程一并摆出来：勾上的会用同一个分支名各建一条，读不到就退化成只建根目录。
  const loadProjects = useCallback(async () => {
    if (!programId || !gitEnabled) return;
    setProjectsLoading(true);
    try {
      const catalog = await fetchGitProjects(programId);
      const children = catalog.projects.filter((project) => project.path);
      setProjects(children);
      // 默认全勾：不是仓库、读不动或已经有这条分支的工程建不出来，勾了也是白跑一轮。
      setTargets(children.filter(branchable).map((project) => project.path));
    } catch {
      setProjects([]);
      setTargets([]);
    } finally {
      setProjectsLoading(false);
    }
  }, [gitEnabled, programId]);

  useEffect(() => { void loadProjects(); }, [loadProjects]);

  const toggleTarget = (path: string) => {
    setTargets((current) => (current.includes(path) ? current.filter((item) => item !== path) : [...current, path]));
  };

  const enterChat = (requirementKey: string) => {
    // replace 而不是 push：新建这一屏已经完成使命，返回该回工作台而不是再走一遍。
    router.replace(`/workbench/requirements/${encodeURIComponent(requirementKey)}/chat?programId=${programId}`);
  };

  /** 不启用 Git 的项目没有分支这一步，需求直接落库后进对话。 */
  const createRequirement = async () => {
    setCreating(true);
    setError("");
    setProgressNote("正在创建需求");
    try {
      const requirement = await saveRequirement(newRequirementInput(programId));
      enterChat(requirement.requirementKey);
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.message : "创建需求失败，请稍后重试。");
      setProgressNote("");
      setCreating(false);
    }
  };

  /**
   * 建分支 —— 建成之后需求才落库。
   *
   * 顺序和 PC 端一致：本机分支建成 → 需求按建成的分支名落库 → 名称先写需求编号占位
   * （拆解会话看到这个临时名，就知道要等首轮问答结束再起正式标题）→ 回记分支关联时间。
   */
  const createBranchAndRequirement = async () => {
    const nextBranch = branch.trim() || defaultBranchName(branches);
    if (!baseBranch.trim()) {
      setError("请选择基准分支。");
      return;
    }
    setCreating(true);
    setError("");
    setNotice("");
    setProgressNote("正在执行电脑上创建需求分支");
    try {
      const created = await createGitBranchAndWait({
        programId,
        branch: nextBranch,
        baseBranch: baseBranch.trim(),
        targets,
      }, {
        // 拉远端可能要跑上一两分钟，把执行电脑此刻在做什么如实显示出来。
        onProgress: (progress) => setProgressNote(progress.message || "正在执行电脑上创建需求分支"),
      });
      setProgressNote("分支已就绪，正在创建需求");
      const requirement = await saveRequirement({
        ...newRequirementInput(programId),
        gitEnabled: true,
        gitBaseBranch: created.baseBranch,
        gitBranch: created.branch,
      });
      // 临时名只在名称还空着时写得进去，不会盖掉别处刚填好的标题。
      await updateRequirementName(programId, requirement.requirementKey, requirement.requirementKey, "").catch(() => undefined);
      await bindRequirementGitBranch(programId, requirement.requirementKey, created.baseBranch, created.branch);
      const failed = (created.results ?? []).filter((entry) => entry.path && entry.error);
      if (failed.length) {
        // 根目录建成了、需求也落库了：个别子工程没建成不影响开聊，但得先让用户看见是哪几个。
        setCreatedKey(requirement.requirementKey);
        setError(`需求已创建，但这些子工程没有建成分支：${failed.map((entry) => entry.name || entry.path).join("、")}`);
        setProgressNote("");
        setCreating(false);
        return;
      }
      enterChat(requirement.requirementKey);
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.message : "创建需求分支失败，请稍后重试。");
      setProgressNote("");
      setCreating(false);
    }
  };

  const dirtyHint = useMemo(() => error.includes("未提交改动"), [error]);

  return (
    <div className="chat-screen">
      <header className="chat-header">
        <button className="icon-button" type="button" onClick={() => router.back()} aria-label="返回" title="返回"><ArrowLeft size={22} /></button>
        <div className="chat-header__title">
          <small>需求对话</small>
          <strong>新增需求</strong>
        </div>
        <div className="chat-header__actions">
          <button
            className="icon-button"
            type="button"
            onClick={() => { void loadBranches(); void loadProjects(); }}
            aria-label="刷新分支"
            title="刷新分支"
            disabled={!gitEnabled || branchesLoading || projectsLoading || creating}
          >
            <RotateCw size={21} className={branchesLoading || projectsLoading ? "spin-icon" : ""} />
          </button>
        </div>
      </header>

      <div className="chat-body">
        {loading ? <EmptyState icon={<LoaderCircle size={24} className="spin-icon" />} title="正在准备" description="正在读取项目信息。" /> : null}

        {!loading ? (
          <EmptyState
            icon={<MessageSquarePlus size={24} />}
            title={gitEnabled ? "先给这条需求建一条分支" : "先把这条需求创建出来"}
            description={gitEnabled
              ? "需求分支建好后需求会自动创建，接着在这里说清要做什么，标题由对话内容自动生成。"
              : "需求创建后就能在这里说清要做什么，标题由对话内容自动生成。"}
          />
        ) : null}

        {!loading && program && !writable ? (
          <p className="form-message is-error" role="alert">当前项目只读，不能在这里新增需求。</p>
        ) : null}

        {error ? <p className="form-message is-error" role="alert">{error}</p> : null}
        {notice ? <p className="form-message is-success" role="status">{notice}</p> : null}
        {dirtyHint ? (
          <p className="field-help">
            执行电脑的工作目录还有未提交改动，先
            <button className="inline-button" type="button" onClick={() => setCommitOpen(true)} disabled={creating}>提交</button>
            掉，再回来建分支。
          </p>
        ) : null}

        {!loading && writable ? (
          <section className="git-actions new-requirement-form" aria-label={gitEnabled ? "创建需求分支" : "创建需求"}>
            {gitEnabled ? (
              <>
                <div className="field">
                  <label htmlFor="new-requirement-base">基准分支</label>
                  <select
                    id="new-requirement-base"
                    value={baseBranch}
                    onChange={(event) => setBaseBranch(event.target.value)}
                    disabled={creating}
                  >
                    {baseBranch && !branches.includes(baseBranch) ? <option value={baseBranch}>{baseBranch}</option> : null}
                    {branches.map((name) => <option key={name} value={name}>{name}</option>)}
                  </select>
                </div>
                <div className="field">
                  <label htmlFor="new-requirement-branch">需求分支</label>
                  <input
                    id="new-requirement-branch"
                    value={branch}
                    onChange={(event) => setBranch(event.target.value)}
                    placeholder="feature/..."
                    autoCapitalize="none"
                    spellCheck={false}
                    disabled={creating}
                  />
                  <p className="field-help">
                    {projectsLoading && !projects.length
                      ? "正在读取工作目录下的子工程。"
                      : targets.length
                        ? `根工作目录之外，同时在 ${targets.length} 个子工程建同名分支。`
                        : "只在根工作目录建这一条分支。"}
                  </p>
                </div>
                {projects.length ? (
                  <div className="field">
                    <label id="new-requirement-targets">一起建分支的子工程</label>
                    <p className="field-help">默认全选，不想跟着建的取消勾选即可。</p>
                    <div className="option-list" role="group" aria-labelledby="new-requirement-targets">
                      {projects.map((project) => {
                        const selected = targets.includes(project.path);
                        const disabled = creating || !branchable(project);
                        return (
                          <label className={`option-row${selected ? " is-selected" : ""}`} key={project.path}>
                            <span>
                              <strong>{project.name || project.path}</strong>
                              <small>{projectNote(project)}</small>
                            </span>
                            <input
                              type="checkbox"
                              checked={selected}
                              onChange={() => toggleTarget(project.path)}
                              disabled={disabled}
                              aria-label={`一起建分支 ${project.name || project.path}`}
                            />
                          </label>
                        );
                      })}
                    </div>
                  </div>
                ) : null}
              </>
            ) : (
              <p className="field-help">该项目没有启用 Git，需求不关联分支。</p>
            )}

            <WorkerOfflineNotice status={workerStatus} />
            {creating && progressNote ? (
              <p className="chat-running" role="status"><LoaderCircle size={17} className="spin-icon" aria-hidden="true" />{progressNote}</p>
            ) : null}

            {createdKey ? (
              <button className="button button-primary full-width" type="button" onClick={() => enterChat(createdKey)}>
                <MessageSquarePlus size={19} aria-hidden="true" />进入需求对话
              </button>
            ) : (
              <button
                className="button button-primary full-width"
                type="button"
                disabled={creating || (gitEnabled && (!branch.trim() || !baseBranch.trim()))}
                onClick={() => void (gitEnabled ? createBranchAndRequirement() : createRequirement())}
              >
                {creating ? <LoaderCircle size={19} className="spin-icon" aria-hidden="true" /> : <GitBranch size={19} aria-hidden="true" />}
                {gitEnabled ? "创建分支并开始对话" : "创建需求并开始对话"}
              </button>
            )}
          </section>
        ) : null}
      </div>

      <GitCommitSheet
        open={commitOpen}
        programId={programId}
        writable={writable}
        onClose={() => setCommitOpen(false)}
        onCommitted={(summary) => {
          // 挡住建分支的那点改动已经落成提交：错误提示跟着清掉，直接重试即可。
          setError("");
          setNotice(summary);
          void loadBranches();
          void loadProjects();
        }}
      />

      <form className="chat-composer" onSubmit={(event) => event.preventDefault()}>
        <p className="chat-composer__hint">{gitEnabled ? "创建需求分支后才能开始对话。" : "创建需求后才能开始对话。"}</p>
        <div className="chat-composer__row">
          <textarea rows={1} disabled placeholder={gitEnabled ? "先创建需求分支" : "先创建需求"} aria-label="消息内容" />
          <button className="chat-send" type="submit" disabled aria-label="发送"><SendHorizontal size={21} /></button>
        </div>
      </form>
    </div>
  );
}

/** 新需求的默认设置和 PC 端保持一致：简易模式、从开发阶段起、拆任务、不预生成文档。 */
function newRequirementInput(programId: number) {
  return {
    programId,
    // 名称留空：标题由拆解会话按聊天内容生成，用户不必先想一个名字。
    name: "",
    detail: "",
    status: "open" as const,
    mode: "simple" as const,
    startPhase: "development" as const,
    splitTasks: true,
    preGenerateTaskDocuments: false,
    generatePrototype: false,
    owners: [],
    assistants: [],
  };
}

/** 能不能跟着建这条分支：不是仓库、读不动、或者已经有同名分支的工程都建不出来。 */
function branchable(project: GitProjectSnapshot) {
  return Boolean(project.isGitRepository) && !project.error && !project.hasBranch;
}

/** 子工程那行的副标题：先说清为什么建不了，再说它此刻停在哪条分支上。 */
function projectNote(project: GitProjectSnapshot) {
  if (project.error) return `读不到：${project.error}`;
  if (!project.isGitRepository) return "不是 Git 仓库，建不了分支";
  if (project.hasBranch) return "已经有这条分支";
  return project.currentBranch || "游离 HEAD";
}
