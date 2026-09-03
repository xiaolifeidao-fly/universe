"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowRight, FileText, MessageSquarePlus, MessageSquareText, Plus, RotateCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { ApiError } from "@/api/client";
import {
  createBusinessRequirement,
  listBusinessPrograms,
  listBusinessRequirements,
  type BusinessProgram,
  type BusinessRequirement,
} from "@/api/business.api";
import { EmptyState } from "@/components/empty-state";
import { LoadingState } from "@/components/loading-state";
import { Sheet } from "@/components/sheet";
import { useSpace } from "@/components/space-provider";
import { hasPersona } from "@/lib/auth";

export function BusinessWorkbenchScreen() {
  const router = useRouter();
  const { bizLine, spaceName } = useSpace();
  const [requirements, setRequirements] = useState<BusinessRequirement[]>([]);
  const [programs, setPrograms] = useState<BusinessProgram[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [selectedProgramId, setSelectedProgramId] = useState(0);
  const [creating, setCreating] = useState(false);
  const allowed = hasPersona("business");

  const load = useCallback(async () => {
    if (!allowed) return;
    setLoading(true);
    setError("");
    try {
      const [page, nextPrograms] = await Promise.all([
        listBusinessRequirements(bizLine),
        listBusinessPrograms(bizLine),
      ]);
      setRequirements(page.data ?? []);
      setPrograms(nextPrograms ?? []);
      setSelectedProgramId((current) => current || nextPrograms[0]?.programId || 0);
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.message : "无法读取业务诉求。");
    } finally {
      setLoading(false);
    }
  }, [allowed, bizLine]);

  useEffect(() => { void load(); }, [load]);

  const create = async () => {
    if (!selectedProgramId || creating) return;
    setCreating(true);
    setError("");
    try {
      const requirement = await createBusinessRequirement(selectedProgramId);
      setCreateOpen(false);
      router.push(`/business/workbench/${requirement.id}`);
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.message : "无法创建业务诉求。");
    } finally {
      setCreating(false);
    }
  };

  if (!allowed) {
    return <main className="screen"><EmptyState icon={<MessageSquareText size={24} />} title="当前账号没有业务方身份" description="业务工作台只向拥有业务身份的账号开放。" /></main>;
  }

  return (
    <main className="screen business-workbench">
      <div className="screen-title-row">
        <div><p className="eyebrow">{spaceName}</p><h1>业务工作台</h1><p>用自己的语言描述诉求，AI 会持续访谈并整理文档。</p></div>
        <div className="stack-actions">
          <button className="icon-button" type="button" onClick={() => void load()} aria-label="刷新业务诉求" title="刷新" disabled={loading}><RotateCw size={21} className={loading ? "spin-icon" : ""} /></button>
          <button className="icon-button is-primary" type="button" onClick={() => setCreateOpen(true)} aria-label="新的业务诉求" title="新的业务诉求"><Plus size={22} /></button>
        </div>
      </div>

      <section className="business-workbench__summary">
        <div><MessageSquareText size={21} /><span><strong>{requirements.length}</strong><small>我的业务诉求</small></span></div>
        <div><FileText size={21} /><span><strong>{requirements.filter((item) => item.detail).length}</strong><small>已有整理</small></span></div>
      </section>

      {error ? <p className="form-message is-error" role="alert">{error}</p> : null}
      {loading && !requirements.length ? <LoadingState title="正在读取业务诉求" /> : null}
      {!loading && !error && !requirements.length ? (
        <EmptyState icon={<MessageSquarePlus size={24} />} title="还没有业务诉求" description="选择一个项目，开始和业务访谈 AI 交流。" action={<button className="button button-primary" type="button" onClick={() => setCreateOpen(true)}><Plus size={19} />新的业务诉求</button>} />
      ) : null}

      <section className="business-requirement-list" aria-label="我的业务诉求">
        {requirements.map((requirement) => (
          <Link className="business-requirement-row" href={`/business/workbench/${requirement.id}`} key={requirement.id}>
            <span className="business-requirement-row__mark"><MessageSquareText size={20} /></span>
            <span className="business-requirement-row__body">
              <span className="business-requirement-row__meta"><small>{requirement.programName || requirement.programCode || `项目 #${requirement.programId}`}</small><time>{formatDate(requirement.updatedAt || requirement.createdAt)}</time></span>
              <strong>{requirement.title || "未命名业务诉求"}</strong>
              <p>{requirement.detail || "尚未发送第一条业务想法"}</p>
            </span>
            <ArrowRight size={20} aria-hidden="true" />
          </Link>
        ))}
      </section>

      <Sheet open={createOpen} title="开始新的业务诉求" subtitle="先选择一个关联项目" onClose={() => setCreateOpen(false)}>
        <div className="option-list">
          {programs.map((program) => (
            <button className={`option-row${program.programId === selectedProgramId ? " is-selected" : ""}`} type="button" key={program.programId} onClick={() => setSelectedProgramId(program.programId)}>
              <span><strong>{program.name || program.programCode}</strong><small>{program.summary || "暂无项目说明"}</small></span>
              {program.programId === selectedProgramId ? <span className="status is-active">已选择</span> : null}
            </button>
          ))}
        </div>
        <button className="button button-primary business-create-button" type="button" onClick={() => void create()} disabled={!selectedProgramId || creating}>{creating ? "正在创建…" : "开始交流"}</button>
      </Sheet>
    </main>
  );
}

function formatDate(value: string | null) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? "" : date.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
}
