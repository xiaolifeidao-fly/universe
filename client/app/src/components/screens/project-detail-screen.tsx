"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { ArrowLeft, ClipboardList, Cloud, FolderSearch, ListTree, Plus, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { ApiError } from "@/api/client";
import { getProgram, listItems, listRequirements, type DeliveryItem, type ProgramSummary, type RequirementSummary } from "@/api/management.api";
import { EmptyState } from "@/components/empty-state";
import { LoadingState } from "@/components/loading-state";
import { ProjectStatus } from "@/components/project-status";

export function ProjectDetailScreen() {
  const { projectId } = useParams<{ projectId: string }>();
  const programId = Number(projectId);
  const [project, setProject] = useState<ProgramSummary | null>(null);
  const [requirements, setRequirements] = useState<RequirementSummary[]>([]);
  const [items, setItems] = useState<DeliveryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    if (!Number.isInteger(programId) || programId <= 0) { setError("项目标识无效。"); setLoading(false); return; }
    setLoading(true); setError("");
    try {
      const [program, requirementPage, itemPage] = await Promise.all([getProgram(programId), listRequirements(programId), listItems(programId)]);
      setProject(program); setRequirements(requirementPage.data ?? []); setItems(itemPage.data ?? []);
    } catch (reason) { setError(reason instanceof ApiError ? reason.message : "无法读取项目详情。"); } finally { setLoading(false); }
  }, [programId]);
  useEffect(() => { void load(); }, [load]);

  if (loading) return <main className="screen"><LoadingState title="正在读取项目" /></main>;
  if (!project) {
    return (
      <main className="screen">
        <div className="screen-title-row">
          <div><p className="eyebrow">项目</p><h1>找不到此项目</h1></div>
          <Link className="icon-button" href="/projects" aria-label="返回项目列表" title="返回项目列表"><ArrowLeft size={20} /></Link>
        </div>
        <EmptyState icon={<FolderSearch size={21} />} title="项目数据尚不可用" description={error || "请返回列表或在连接恢复后重试。"} action={<button className="button button-primary" type="button" onClick={() => void load()}>重新连接</button>} />
      </main>
    );
  }

  return (
    <main className="screen">
      <div className="screen-title-row">
        <div>
          <p className="eyebrow">项目详情</p>
          <h1>{project.name}</h1>
        </div>
        <div className="stack-actions"><button className="icon-button" type="button" onClick={() => void load()} aria-label="刷新项目" title="刷新项目"><RefreshCw size={19} /></button><Link className="icon-button" href="/projects" aria-label="返回项目列表" title="返回项目列表"><ArrowLeft size={20} /></Link></div>
      </div>
      <section className="detail-hero">
        <ProjectStatus status={project.status} />
        <h1>{project.name}</h1>
        <p>{project.summary || "尚未填写项目说明。"}</p>
        <div className="detail-meta"><span className="tag">{project.programCode || `#${project.programId}`}</span><span className="tag">{project.cloudSyncEnabled ? "云端同步已开启" : "未开启云端同步"}</span></div>
      </section>
      <section className="card section">
        <h2 className="section-heading">项目内容</h2>
        <div className="detail-list">
          <div className="detail-row"><span>需求</span><strong>{requirements.length}</strong></div>
          <div className="detail-row"><span>任务</span><strong>{items.length}</strong></div>
          <div className="detail-row"><span>可管理</span><strong>{project.canWrite ? "是" : "否"}</strong></div>
        </div>
        {project.cloudSyncEnabled ? <Link className="button button-secondary" href={`/projects/${programId}/documents`} style={{ marginTop: 14 }}><Cloud size={17} aria-hidden="true" />云端文档</Link> : null}
      </section>
      <section className="card section">
        <div className="section-heading"><span>需求</span>{project.canWrite ? <Link className="icon-button small-icon-button" href={`/projects/${programId}/requirements/new`} aria-label="新建需求" title="新建需求"><Plus size={18} /></Link> : null}</div>
        {requirements.length ? <div className="compact-list">{requirements.map((requirement) => <Link className="compact-row" href={`/projects/${programId}/requirements/${requirement.requirementKey}`} key={requirement.requirementKey}><div><strong>{requirement.name || "未命名需求"}</strong><p>{requirement.itemCount} 条任务 · {requirement.status === "done" ? "已完成" : requirement.status === "dropped" ? "不做" : "进行中"}</p></div><ClipboardList size={18} aria-hidden="true" /></Link>)}</div> : <p className="muted">还没有需求。{project.canWrite ? "可通过右上角添加。" : ""}</p>}
      </section>
      <section className="card section">
        <div className="section-heading"><span>任务与依赖</span><ListTree size={19} aria-hidden="true" /></div>
        {items.length ? <div className="compact-list">{items.map((item) => <Link className="compact-row" href={`/projects/${programId}/tasks/${item.itemKey}`} key={item.itemKey}><div><strong>{item.title}</strong><p>{item.dependsOnItemKeys.length ? `前置：${item.dependsOnItemKeys.join("、")}` : "无前置依赖"}</p></div><span className={`status ${item.status === "blocked" ? "is-danger" : item.status === "done" ? "is-active" : "is-warning"}`}>{item.progress}%</span></Link>)}</div> : <p className="muted">需求拆解后会显示任务和依赖。</p>}
      </section>
    </main>
  );
}
