"use client";

import Link from "next/link";
import { ArrowRight, AlertTriangle, FolderKanban, ListTodo, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { ApiError } from "@/api/client";
import { listPrograms, type ProgramSummary } from "@/api/management.api";
import { EmptyState } from "@/components/empty-state";
import { LoadingState } from "@/components/loading-state";
import { ProjectStatus } from "@/components/project-status";
import { useSpace } from "@/components/space-provider";

export function OverviewScreen() {
  const [programs, setPrograms] = useState<ProgramSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  // 空间是数据范围：换空间后这份列表必须重新拉，否则还停在上一个空间。
  const { bizLine } = useSpace();
  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try { setPrograms(await listPrograms()); } catch (reason) { setError(reason instanceof ApiError ? reason.message : "无法读取项目概览。"); } finally { setLoading(false); }
  }, [bizLine]);
  useEffect(() => { void load(); }, [load]);
  const manageable = programs.filter((program) => program.canWrite).length;

  return (
    <main className="screen">
      <div className="screen-title-row">
        <div>
          <p className="eyebrow">今天</p>
          <h1>交付概览</h1>
          <p>把握需要处理的进展和风险。</p>
        </div>
        <div className="stack-actions"><button className="icon-button" type="button" onClick={() => void load()} aria-label="刷新概览" title="刷新概览" disabled={loading}><RefreshCw size={20} className={loading ? "spin-icon" : ""} /></button><Link className="icon-button" href="/projects" aria-label="查看项目" title="查看项目"><ArrowRight size={20} aria-hidden="true" /></Link></div>
      </div>
      {loading ? <LoadingState title="正在恢复交付概览" /> : null}
      {!loading && error ? <EmptyState icon={<AlertTriangle size={21} />} title="暂时无法读取概览" description={error} action={<button className="button button-primary" type="button" onClick={() => void load()}>重新连接</button>} /> : null}
      {!loading && !error && !programs.length ? <EmptyState icon={<ListTodo size={21} />} title="还没有可显示的项目" description="项目创建后会按你的访问权限显示在这里。" /> : null}
      {!loading && !error && programs.length ? <><section className="metric-grid" aria-label="交付概览统计"><div className="metric"><strong>{programs.length}</strong><span>可访问项目</span></div><div className="metric"><strong>{manageable}</strong><span>可管理项目</span></div><div className="metric"><strong>{programs.filter((program) => program.status === "attention").length}</strong><span>需要关注</span></div></section><section className="section card" aria-labelledby="recent-programs"><h2 className="section-heading" id="recent-programs">最近项目</h2><div className="compact-list">{programs.slice(0, 4).map((program) => <Link className="compact-row" href={`/projects/${program.programId}`} key={program.programId}><div><strong>{program.name}</strong><p>{program.summary || "尚未填写项目说明。"}</p></div><ProjectStatus status={program.status} /></Link>)}</div></section></> : null}
    </main>
  );
}
