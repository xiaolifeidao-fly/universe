"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { ArrowLeft, FileText, GitBranch, Save } from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { ApiError } from "@/api/client";
import {
  getItem,
  getProgram,
  listItems,
  listRequirements,
  patchItem,
  type DeliveryItem,
  type ItemKind,
  type ItemStatus,
  type RequirementSummary,
} from "@/api/management.api";
import { EmptyState } from "@/components/empty-state";
import { LoadingState } from "@/components/loading-state";
import { DocumentSheet } from "@/components/workbench/document-sheet";
import { dateInputValue } from "@/lib/date";

type FormState = { title: string; description: string; requirementKey: string; kind: ItemKind; status: ItemStatus; progress: number; ownerId: string; dueDate: string; note: string; benefitTags: string; dependencies: string[]; sourceSides: Record<string, string>; targetSides: Record<string, string> };

function stateFor(item: DeliveryItem): FormState {
  return {
    title: item.title,
    description: item.description,
    requirementKey: item.requirementKey,
    kind: item.kind,
    status: item.status,
    progress: item.progress,
    ownerId: item.ownerId,
    dueDate: dateInputValue(item.dueDate),
    note: item.note,
    benefitTags: item.benefitTags.join(", "),
    dependencies: item.dependsOnItemKeys,
    sourceSides: item.dependencySourceSides ?? {},
    targetSides: item.dependencyTargetSides ?? {},
  };
}

export function TaskDetailScreen() {
  const params = useParams<{ projectId: string; itemKey: string }>();
  const programId = Number(params.projectId);
  const itemKey = params.itemKey;
  const [item, setItem] = useState<DeliveryItem | null>(null);
  const [allItems, setAllItems] = useState<DeliveryItem[]>([]);
  const [requirements, setRequirements] = useState<RequirementSummary[]>([]);
  const [canWrite, setCanWrite] = useState(false);
  const [documentsOpen, setDocumentsOpen] = useState(false);
  const [form, setForm] = useState<FormState | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    if (!Number.isInteger(programId) || programId <= 0) {
      setError("项目标识无效。");
      setLoading(false);
      return;
    }
    setLoading(true);
    setError("");
    try {
      const [nextItem, page, requirementPage, program] = await Promise.all([
        getItem(programId, itemKey), listItems(programId), listRequirements(programId), getProgram(programId),
      ]);
      setItem(nextItem);
      setForm(stateFor(nextItem));
      setAllItems(page.data ?? []);
      setRequirements(requirementPage.data ?? []);
      setCanWrite(program.canWrite);
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.message : "无法读取任务详情。");
    } finally {
      setLoading(false);
    }
  }, [itemKey, programId]);

  useEffect(() => { void load(); }, [load]);

  const candidates = useMemo(() => allItems.filter((candidate) => candidate.itemKey !== itemKey), [allItems, itemKey]);
  const update = <Key extends keyof FormState>(key: Key, value: FormState[Key]) => setForm((current) => current ? { ...current, [key]: value } : current);
  const toggleDependency = (key: string) => {
    if (!form) return;
    const selected = form.dependencies.includes(key);
    const dependencies = selected ? form.dependencies.filter((value) => value !== key) : [...form.dependencies, key];
    const sourceSides = { ...form.sourceSides };
    const targetSides = { ...form.targetSides };
    if (selected) { delete sourceSides[key]; delete targetSides[key]; } else { sourceSides[key] = "right"; targetSides[key] = "left"; }
    setForm({ ...form, dependencies, sourceSides, targetSides });
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!item || !form) return;
    setSaving(true);
    setError("");
    try {
      const saved = await patchItem({
        programId,
        itemKey,
        version: item.version,
        requirementKey: form.requirementKey,
        kind: form.kind,
        title: form.title.trim(),
        description: form.description,
        benefitTags: form.benefitTags.split(/[,，]/).map((tag) => tag.trim()).filter(Boolean),
        status: form.status,
        progress: Math.min(100, Math.max(0, Number(form.progress))),
        ownerId: form.ownerId.trim(),
        ownerName: "",
        dueDate: form.dueDate,
        note: form.note,
        dependsOnItemKeys: form.dependencies,
        dependencySourceSides: form.sourceSides,
        dependencyTargetSides: form.targetSides,
      });
      setItem(saved);
      setForm(stateFor(saved));
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.message : "任务保存失败，请刷新后重试。");
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <main className="screen"><LoadingState title="正在读取任务" /></main>;
  if (!item || !form) return <main className="screen"><EmptyState icon={<GitBranch size={23} />} title="找不到此任务" description={error || "任务可能已被删除或没有访问权限。"} action={<Link className="button button-primary" href={`/projects/${programId}`}>返回项目</Link>} /></main>;

  return (
    <main className="screen">
      <div className="screen-title-row is-detail"><div><p className="eyebrow">任务详情</p><h1>{item.title}</h1><p>{phaseLabel(item.phase)}阶段 · 版本 {item.version}</p></div><div className="stack-actions"><button className="icon-button" type="button" onClick={() => setDocumentsOpen(true)} aria-label="任务文档" title="任务文档"><FileText size={22} /></button><Link className="icon-button" href={`/projects/${programId}`} aria-label="返回项目" title="返回项目"><ArrowLeft size={22} /></Link></div></div>
      <DocumentSheet open={documentsOpen} programId={programId} ownerKind="task" ownerKey={item.itemKey} ownerName={item.title} onClose={() => setDocumentsOpen(false)} />
      <form className="card form-grid" onSubmit={submit}>
        <div className="field"><label htmlFor="task-title">任务标题</label><input id="task-title" value={form.title} onChange={(event) => update("title", event.target.value)} maxLength={255} required /></div>
        <div className="field"><label htmlFor="task-description">说明</label><textarea id="task-description" value={form.description} onChange={(event) => update("description", event.target.value)} maxLength={32768} /></div>
        <div className="inline-fields"><div className="field"><label htmlFor="task-requirement">所属需求</label><select id="task-requirement" value={form.requirementKey} onChange={(event) => update("requirementKey", event.target.value)}><option value="">未关联需求</option>{requirements.map((requirement) => <option value={requirement.requirementKey} key={requirement.requirementKey}>{requirement.name || requirement.requirementKey}</option>)}</select></div><div className="field"><label htmlFor="task-kind">类型</label><select id="task-kind" value={form.kind} onChange={(event) => update("kind", event.target.value as ItemKind)}><option value="capability">能力</option><option value="gap">问题</option><option value="asset">存量</option></select></div></div>
        <div className="inline-fields"><div className="field"><label htmlFor="task-status">当前状态</label><select id="task-status" value={form.status} onChange={(event) => update("status", event.target.value as ItemStatus)}><option value="todo">未开始</option><option value="doing">进行中</option><option value="done">已完成</option><option value="blocked">受阻</option><option value="dropped">不做</option></select></div><div className="field"><label htmlFor="task-due">截止日期</label><input id="task-due" type="date" value={form.dueDate} onChange={(event) => update("dueDate", event.target.value)} /></div></div>
        <div className="field"><label htmlFor="task-progress">进度 {form.progress}%</label><input id="task-progress" type="range" min="0" max="100" step="5" value={form.progress} onChange={(event) => update("progress", Number(event.target.value))} /><div className="range-row"><span>0%</span><span>100%</span></div></div>
        <div className="field"><label htmlFor="task-owner">负责人 ID</label><input id="task-owner" value={form.ownerId} onChange={(event) => update("ownerId", event.target.value)} placeholder="留空可取消负责人" /><p className="field-help">服务端会校验项目成员并补全显示名。</p></div>
        <div className="field"><label htmlFor="task-benefits">收益标签</label><input id="task-benefits" value={form.benefitTags} onChange={(event) => update("benefitTags", event.target.value)} placeholder="例如：减少返工，降低风险" /></div>
        <div className="field"><label htmlFor="task-note">备注</label><textarea id="task-note" value={form.note} onChange={(event) => update("note", event.target.value)} maxLength={8192} /></div>
        <section className="dependency-editor" aria-labelledby="dependency-heading"><div className="section-heading"><span id="dependency-heading">前置依赖</span><GitBranch size={20} aria-hidden="true" /></div><p className="field-help">选择当前任务开始前必须完成的任务。服务端会拒绝循环依赖。</p>{candidates.length ? <div className="selection-list">{candidates.map((candidate) => { const checked = form.dependencies.includes(candidate.itemKey); return <div className="dependency-row" key={candidate.itemKey}><label className="checkbox-row"><input type="checkbox" checked={checked} onChange={() => toggleDependency(candidate.itemKey)} />{candidate.title}</label>{checked ? <div className="dependency-sides"><select aria-label={`${candidate.title} 的起点`} value={form.sourceSides[candidate.itemKey] ?? "right"} onChange={(event) => update("sourceSides", { ...form.sourceSides, [candidate.itemKey]: event.target.value })}><option value="left">前置左侧</option><option value="right">前置右侧</option><option value="top">前置顶部</option><option value="bottom">前置底部</option></select><select aria-label={`${candidate.title} 的终点`} value={form.targetSides[candidate.itemKey] ?? "left"} onChange={(event) => update("targetSides", { ...form.targetSides, [candidate.itemKey]: event.target.value })}><option value="left">当前左侧</option><option value="right">当前右侧</option><option value="top">当前顶部</option><option value="bottom">当前底部</option></select></div> : null}</div>; })}</div> : <p className="muted">项目内还没有可选的其他任务。</p>}</section>
        {error ? <p className="form-message is-error" role="alert">{error}</p> : null}
        <button className="button button-primary full-width" type="submit" disabled={saving || !canWrite}><Save size={20} aria-hidden="true" />{saving ? "正在保存" : "保存任务与依赖"}</button>
        {!canWrite ? <p className="field-help">当前账号只有查看权限，无法保存更改。</p> : null}
      </form>
    </main>
  );
}

function phaseLabel(value: string) { return ({ requirement: "梳理需求", development: "动作执行", testing: "成品测试" } as Record<string, string>)[value] ?? value; }
