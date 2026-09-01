"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  AlertTriangle,
  Bot,
  CircleStop,
  FileDiff,
  FileUp,
  GitBranch,
  GitCommitHorizontal,
  GitCompareArrows,
  GitFork,
  GitMerge,
  GitPullRequest,
  ListRestart,
  LoaderCircle,
  Play,
  RefreshCw,
  SendHorizontal,
  Upload,
} from "lucide-react";
import { ApiError } from "@/api/client";
import { listDeliveryItems, listDeliveryPrograms, type DeliveryItem, type DeliveryProgram } from "@/api/delivery.api";
import { submitCommand, uploadCommandAttachments, type CommandSummary } from "@/api/command.api";

type WorkspaceTab = "run" | "git";

const commandLabels: Record<string, string> = {
  "task.execute": "单任务执行",
  "task.execute-batch": "批量执行",
  "task.execute-sequence": "顺序执行",
  "task.session": "会话快照",
  "task.conversation": "追加会话",
  "task.stop": "停止任务",
  "task.stop-all": "停止全部执行",
  "git.status": "Git 状态",
  "git.branches": "分支列表",
  "git.changes": "改动列表",
  "git.change": "文件差异",
  "git.projects": "关联工程",
  "git.merge-preview": "合并预览",
  "git.workspace-check": "工作区检查",
  "git.init": "初始化 Git",
  "git.submodules": "初始化子模块",
  "git.branch": "创建分支",
  "git.prepare": "准备分支",
  "git.push": "提交并推送",
  "git.merge": "合并分支",
};

function commandKey(commandType: string) {
  const suffix = typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `mobile-${commandType}-${suffix}`.slice(0, 128);
}

function splitTargets(value: string) {
  return value.split(/[\n,]/).map((item) => item.trim()).filter(Boolean);
}

function descriptionOf(reason: unknown) {
  return reason instanceof ApiError ? reason.message : "操作未完成，请稍后重试。";
}

export function ExecutionWorkspace({ onCommandSubmitted }: { onCommandSubmitted: (command: CommandSummary) => void }) {
  const [tab, setTab] = useState<WorkspaceTab>("run");
  const [programs, setPrograms] = useState<DeliveryProgram[]>([]);
  const [programID, setProgramID] = useState(0);
  const [items, setItems] = useState<DeliveryItem[]>([]);
  const [itemKey, setItemKey] = useState("");
  const [selectedItemKeys, setSelectedItemKeys] = useState<string[]>([]);
  const [message, setMessage] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingItems, setLoadingItems] = useState(false);
  const [submitting, setSubmitting] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [repositoryURL, setRepositoryURL] = useState("");
  const [baseBranch, setBaseBranch] = useState("");
  const [branch, setBranch] = useState("");
  const [commitMessage, setCommitMessage] = useState("");
  const [changePath, setChangePath] = useState("");
  const [targets, setTargets] = useState("");
  const [mergeSources, setMergeSources] = useState("");
  const [pushAfterMerge, setPushAfterMerge] = useState(true);

  const program = useMemo(() => programs.find((candidate) => candidate.programId === programID) ?? null, [programID, programs]);
  const writable = Boolean(program?.canWrite);

  const loadPrograms = async () => {
    setLoading(true);
    setError("");
    try {
      const nextPrograms = await listDeliveryPrograms();
      setPrograms(nextPrograms);
      const storedProgramID = Number(window.sessionStorage.getItem("delivery-mobile.execution-program"));
      const selected = nextPrograms.find((candidate) => candidate.programId === storedProgramID) ?? nextPrograms[0];
      setProgramID(selected?.programId ?? 0);
    } catch (reason) {
      setError(descriptionOf(reason));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void loadPrograms(); }, []);

  useEffect(() => {
    if (!programID) {
      setItems([]);
      setItemKey("");
      return;
    }
    window.sessionStorage.setItem("delivery-mobile.execution-program", String(programID));
    let active = true;
    setLoadingItems(true);
    setError("");
    void listDeliveryItems(programID).then((nextItems) => {
      if (!active) return;
      setItems(nextItems);
      setItemKey((current) => nextItems.some((item) => item.itemKey === current) ? current : (nextItems[0]?.itemKey ?? ""));
      setSelectedItemKeys((current) => current.filter((key) => nextItems.some((item) => item.itemKey === key)));
    }).catch((reason) => {
      if (active) setError(descriptionOf(reason));
    }).finally(() => {
      if (active) setLoadingItems(false);
    });
    return () => { active = false; };
  }, [programID]);

  const submit = async (commandType: string, input: Record<string, unknown>) => {
    if (!programID) {
      setError("请先选择项目。");
      return;
    }
    setSubmitting(commandType);
    setError("");
    setNotice("");
    try {
      const command = await submitCommand({ programId: programID, commandType, input, idempotencyKey: commandKey(commandType) });
      setNotice(`${commandLabels[commandType] ?? commandType}已提交。`);
      onCommandSubmitted(command);
    } catch (reason) {
      setError(descriptionOf(reason));
    } finally {
      setSubmitting("");
    }
  };

  const runConversation = async () => {
    if (!itemKey) {
      setError("请选择任务。");
      return;
    }
    if (!message.trim() && !files.length) {
      setError("请输入消息或添加附件。");
      return;
    }
    setSubmitting("task.conversation");
    setError("");
    setNotice("");
    try {
      const attachments = files.length ? await uploadCommandAttachments(programID, itemKey, files) : [];
      const command = await submitCommand({
        programId: programID,
        commandType: "task.conversation",
        input: { itemKey, message: message.trim(), attachmentIds: attachments.map((attachment) => attachment.attachmentId) },
        idempotencyKey: commandKey("task.conversation"),
      });
      setMessage("");
      setFiles([]);
      setNotice("会话已提交。");
      onCommandSubmitted(command);
    } catch (reason) {
      setError(descriptionOf(reason));
    } finally {
      setSubmitting("");
    }
  };

  const selectFiles = (selected: FileList | null) => {
    const next = Array.from(selected ?? []);
    if (next.length > 5) {
      setError("一次最多添加 5 个附件。");
      return;
    }
    const oversized = next.find((file) => file.size > 20 * 1024 * 1024);
    if (oversized) {
      setError(`附件 ${oversized.name} 超过 20 MB。`);
      return;
    }
    setError("");
    setFiles(next);
  };

  const toggleItem = (key: string) => {
    setSelectedItemKeys((current) => current.includes(key) ? current.filter((value) => value !== key) : [...current, key]);
  };

  const hasSelection = selectedItemKeys.length > 0;

  return (
    <section className="execution-workspace" aria-label="远程执行与 Git 控制">
      <div className="workspace-tabs" role="tablist" aria-label="操作类型">
        <button className={tab === "run" ? "is-active" : ""} type="button" role="tab" aria-selected={tab === "run"} onClick={() => setTab("run")}><Bot size={17} aria-hidden="true" />执行</button>
        <button className={tab === "git" ? "is-active" : ""} type="button" role="tab" aria-selected={tab === "git"} onClick={() => setTab("git")}><GitBranch size={17} aria-hidden="true" />Git</button>
      </div>

      <section className="card workspace-project-card">
        <div className="workspace-project-heading">
          <div><span className="eyebrow">操作项目</span><strong>{program?.name || "选择项目"}</strong></div>
          <button className="icon-button" type="button" onClick={() => void loadPrograms()} aria-label="刷新项目" title="刷新项目" disabled={loading}><RefreshCw size={18} className={loading ? "spin-icon" : ""} /></button>
        </div>
        <div className="field">
          <select value={programID || ""} onChange={(event) => setProgramID(Number(event.target.value))} disabled={loading} aria-label="选择项目">
            <option value="">选择项目</option>
            {programs.map((candidate) => <option key={candidate.programId} value={candidate.programId}>{candidate.name}</option>)}
          </select>
        </div>
      </section>

      {error ? <p className="form-message is-error" role="alert">{error}</p> : null}
      {notice ? <p className="form-message is-success" role="status">{notice}</p> : null}

      {tab === "run" ? (
        <div className="workspace-stack" role="tabpanel">
          <section className="card">
            <div className="section-heading"><span>任务执行</span>{loadingItems ? <LoaderCircle className="spin-icon" size={17} aria-label="正在加载任务" /> : null}</div>
            <div className="field">
              <select value={itemKey} onChange={(event) => setItemKey(event.target.value)} disabled={!items.length || loadingItems} aria-label="选择任务">
                <option value="">选择任务</option>
                {items.map((item) => <option key={item.itemKey} value={item.itemKey}>{item.title} · {item.itemKey}</option>)}
              </select>
            </div>
            <div className="stack-actions">
              <button className="button button-primary" type="button" disabled={!writable || !itemKey || Boolean(submitting)} onClick={() => void submit("task.execute", { itemKey })}><Play size={17} aria-hidden="true" />执行</button>
              <button className="button button-secondary" type="button" disabled={!writable || !itemKey || Boolean(submitting)} onClick={() => void submit("task.session", { itemKey })}><Bot size={17} aria-hidden="true" />查看会话</button>
              <button className="button button-secondary" type="button" disabled={!writable || !itemKey || Boolean(submitting)} onClick={() => void submit("task.stop", { itemKey })}><CircleStop size={17} aria-hidden="true" />停止</button>
              <button className="button button-quiet" type="button" disabled={!writable || Boolean(submitting)} onClick={() => void submit("task.stop-all", {})}><CircleStop size={17} aria-hidden="true" />停止全部</button>
            </div>
          </section>

          <section className="card">
            <div className="section-heading"><span>会话</span><span className="muted">{itemKey || "未选择任务"}</span></div>
            <div className="field">
              <textarea value={message} onChange={(event) => setMessage(event.target.value)} placeholder="输入本轮要求" inputMode="text" autoCapitalize="sentences" disabled={!writable || !itemKey || Boolean(submitting)} />
            </div>
            <div className="attachment-row">
              <label className="button button-secondary" title="添加图片或文件"><FileUp size={17} aria-hidden="true" />添加附件<input type="file" multiple accept="image/*,.pdf,.txt,.md,.csv,.doc,.docx,.xls,.xlsx" onChange={(event) => selectFiles(event.target.files)} disabled={!writable || !itemKey || Boolean(submitting)} /></label>
              {files.length ? <span className="tag">{files.length} 个附件</span> : null}
            </div>
            {files.length ? <ul className="attachment-list">{files.map((file) => <li key={`${file.name}-${file.lastModified}`}>{file.name}<button type="button" onClick={() => setFiles((current) => current.filter((value) => value !== file))} aria-label={`移除 ${file.name}`} title="移除附件">×</button></li>)}</ul> : null}
            <div className="stack-actions">
              <button className="button button-primary" type="button" disabled={!writable || !itemKey || Boolean(submitting)} onClick={() => void runConversation()}><SendHorizontal size={17} aria-hidden="true" />发送</button>
            </div>
          </section>

          <section className="card">
            <div className="section-heading"><span>批量与顺序</span><span className="muted">已选 {selectedItemKeys.length}</span></div>
            {!items.length && !loadingItems ? <p className="field-help">当前项目没有可执行任务。</p> : null}
            <div className="task-picker">
              {items.map((item) => <label className="task-picker__row" key={item.itemKey}><input type="checkbox" checked={selectedItemKeys.includes(item.itemKey)} onChange={() => toggleItem(item.itemKey)} disabled={!writable || Boolean(submitting)} /><span><strong>{item.title}</strong><small>{item.itemKey} · {item.phase} · {item.progress}%</small></span></label>)}
            </div>
            <div className="stack-actions">
              <button className="button button-primary" type="button" disabled={!writable || !hasSelection || Boolean(submitting)} onClick={() => void submit("task.execute-batch", { itemKeys: selectedItemKeys })}><Play size={17} aria-hidden="true" />批量执行</button>
              <button className="button button-secondary" type="button" disabled={!writable || !hasSelection || Boolean(submitting)} onClick={() => void submit("task.execute-sequence", { itemKeys: selectedItemKeys })}><ListRestart size={17} aria-hidden="true" />按依赖执行</button>
            </div>
          </section>
        </div>
      ) : (
        <div className="workspace-stack" role="tabpanel">
          <section className="card">
            <div className="section-heading"><span>检查</span><span className="muted">{program?.gitEnabled ? "已启用" : "未配置"}</span></div>
            <div className="command-grid">
              <CommandButton icon={<GitBranch size={17} />} label="状态" disabled={!writable || Boolean(submitting)} onClick={() => void submit("git.status", {})} />
              <CommandButton icon={<GitFork size={17} />} label="分支" disabled={!writable || Boolean(submitting)} onClick={() => void submit("git.branches", {})} />
              <CommandButton icon={<FileDiff size={17} />} label="改动" disabled={!writable || Boolean(submitting)} onClick={() => void submit("git.changes", {})} />
              <CommandButton icon={<GitCompareArrows size={17} />} label="工程" disabled={!writable || Boolean(submitting)} onClick={() => void submit("git.projects", { branch })} />
              <CommandButton icon={<RefreshCw size={17} />} label="工作区" disabled={!writable || Boolean(submitting)} onClick={() => void submit("git.workspace-check", {})} />
            </div>
            <div className="field" style={{ marginTop: 12 }}><input value={changePath} onChange={(event) => setChangePath(event.target.value)} placeholder="文件相对路径" /><button className="button button-secondary" type="button" disabled={!writable || !changePath.trim() || Boolean(submitting)} onClick={() => void submit("git.change", { path: changePath.trim() })}><FileDiff size={17} aria-hidden="true" />查看差异</button></div>
          </section>

          <section className="card">
            <div className="section-heading"><span>仓库与分支</span></div>
            <div className="form-grid">
              <div className="field"><label>仓库地址</label><input value={repositoryURL} onChange={(event) => setRepositoryURL(event.target.value)} inputMode="url" placeholder="https://..." /></div>
              <div className="field"><label>基准分支</label><input value={baseBranch} onChange={(event) => setBaseBranch(event.target.value)} placeholder="main" /></div>
              <div className="field"><label>目标分支</label><input value={branch} onChange={(event) => setBranch(event.target.value)} placeholder="feature/..." /></div>
              <div className="field"><label>关联工程</label><textarea value={targets} onChange={(event) => setTargets(event.target.value)} placeholder="每行一个相对路径" /></div>
            </div>
            <div className="stack-actions">
              <button className="button button-secondary" type="button" disabled={!writable || !repositoryURL.trim() || Boolean(submitting)} onClick={() => void submit("git.init", { repositoryUrl: repositoryURL.trim(), baseBranch: baseBranch.trim(), remoteName: program?.gitRemoteName || "origin" })}><Upload size={17} aria-hidden="true" />初始化</button>
              <button className="button button-secondary" type="button" disabled={!writable || Boolean(submitting)} onClick={() => void submit("git.submodules", {})}><GitFork size={17} aria-hidden="true" />子模块</button>
              <button className="button button-secondary" type="button" disabled={!writable || !branch.trim() || Boolean(submitting)} onClick={() => void submit("git.branch", { baseBranch: baseBranch.trim(), branch: branch.trim(), targets: splitTargets(targets) })}><GitBranch size={17} aria-hidden="true" />创建分支</button>
              <button className="button button-primary" type="button" disabled={!writable || !branch.trim() || Boolean(submitting)} onClick={() => void submit("git.prepare", { branch: branch.trim(), strategy: "switch", targets: splitTargets(targets), remoteName: program?.gitRemoteName || "origin" })}><GitPullRequest size={17} aria-hidden="true" />准备分支</button>
            </div>
          </section>

          <section className="card">
            <div className="section-heading"><span>推送与合并</span></div>
            <div className="form-grid">
              <div className="field"><label>提交说明</label><textarea value={commitMessage} onChange={(event) => setCommitMessage(event.target.value)} placeholder="本次提交说明" /></div>
              <div className="field"><label>合并来源</label><textarea value={mergeSources} onChange={(event) => setMergeSources(event.target.value)} placeholder="每行一个来源分支" /></div>
              <label className="check-row"><input type="checkbox" checked={pushAfterMerge} onChange={(event) => setPushAfterMerge(event.target.checked)} />合并后推送</label>
            </div>
            <div className="stack-actions">
              <button className="button button-secondary" type="button" disabled={!writable || !branch.trim() || Boolean(submitting)} onClick={() => void submit("git.push", { branch: branch.trim(), message: commitMessage, targets: splitTargets(targets) })}><GitCommitHorizontal size={17} aria-hidden="true" />提交并推送</button>
              <button className="button button-secondary" type="button" disabled={!writable || !branch.trim() || !splitTargets(mergeSources).length || Boolean(submitting)} onClick={() => void submit("git.merge-preview", { target: branch.trim(), sources: splitTargets(mergeSources), remoteName: program?.gitRemoteName || "origin" })}><GitCompareArrows size={17} aria-hidden="true" />合并预览</button>
              <button className="button button-danger" type="button" disabled={!writable || !branch.trim() || !splitTargets(mergeSources).length || Boolean(submitting)} onClick={() => {
                if (window.confirm(`确认将所选分支合并到 ${branch.trim()} 吗？`)) void submit("git.merge", { target: branch.trim(), sources: splitTargets(mergeSources), targets: splitTargets(targets), push: pushAfterMerge, remoteName: program?.gitRemoteName || "origin" });
              }}><GitMerge size={17} aria-hidden="true" />执行合并</button>
            </div>
          </section>
        </div>
      )}

      {!writable && program ? <p className="workspace-readonly"><AlertTriangle size={16} aria-hidden="true" />当前项目没有写入权限，不能提交远程命令。</p> : null}
    </section>
  );
}

function CommandButton({ icon, label, disabled, onClick }: { icon: ReactNode; label: string; disabled: boolean; onClick: () => void }) {
  return <button className="command-grid__button" type="button" disabled={disabled} onClick={onClick}>{icon}<span>{label}</span></button>;
}
