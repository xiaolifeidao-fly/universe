"use client";

"use client";

import Link from "next/link";
import { ArrowRight, AlertTriangle, Folder, RotateCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { ApiError } from "@/api/client";
import { listPrograms, type ProgramSummary } from "@/api/management.api";
import { EmptyState } from "@/components/empty-state";
import { LoadingState } from "@/components/loading-state";
import { ProjectStatus } from "@/components/project-status";
import { useSpace } from "@/components/space-provider";

export function ProjectListScreen() {
  const [programs, setPrograms] = useState<ProgramSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  // 空间是数据范围：换空间后这份列表必须重新拉，否则还停在上一个空间。
  const { bizLine } = useSpace();
  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try { setPrograms(await listPrograms()); } catch (reason) { setError(reason instanceof ApiError ? reason.message : "无法读取项目列表。"); } finally { setLoading(false); }
  }, [bizLine]);
  useEffect(() => { void load(); }, [load]);

  return (
    <main className="screen">
      <div className="screen-title-row">
        <div>
          <p className="eyebrow">交付管理</p>
          <h1>项目</h1>
          <p>查看项目、需求、任务与依赖。</p>
        </div>
        <button className="icon-button" type="button" onClick={() => void load()} aria-label="刷新项目" title="刷新项目" disabled={loading}><RotateCw size={20} className={loading ? "spin-icon" : ""} /></button>
      </div>
      {loading ? <LoadingState title="正在读取项目" /> : null}
      {!loading && error ? <EmptyState tone="error" icon={<AlertTriangle size={21} />} title="暂时无法读取项目" description={error} action={<button className="button button-primary" type="button" onClick={() => void load()}>重新连接</button>} /> : null}
      {!loading && !error && !programs.length ? <EmptyState icon={<Folder size={21} />} title="还没有可显示的项目" description="项目创建后会按你的访问权限显示在这里。" /> : null}
      {!loading && !error && programs.length ? <section className="project-list" aria-label="项目列表">
          {programs.map((project) => (
            <Link href={`/projects/${project.programId}`} className="project-card" key={project.programId}>
              <span className="project-card__accent" aria-hidden="true" />
              <div className="project-card__body">
                <ProjectStatus status={project.status} />
                <h2>{project.name}</h2>
                <p>{project.summary || "尚未填写项目说明。"}</p>
                <div className="project-meta">
                  <span className="tag">{project.programCode || `#${project.programId}`}</span>
                  <span className="tag">{project.canWrite ? "可管理" : "仅查看"}</span>
                  <span className="tag">{project.cloudSyncEnabled ? "云端同步" : "本地文档"}</span>
                </div>
              </div>
              <ArrowRight size={19} aria-hidden="true" />
            </Link>
          ))}
        </section> : null}
    </main>
  );
}
