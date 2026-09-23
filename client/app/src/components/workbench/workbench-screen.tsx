"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity,
  AlertTriangle,
  CalendarDays,
  ChevronDown,
  CircleCheck,
  Coins,
  CirclePlay,
  FileText,
  GitBranch,
  Lightbulb,
  ListChecks,
  MessageSquareText,
  Plus,
  RotateCw,
  Search,
  UserRoundCheck,
  UsersRound,
} from "lucide-react";
import { ApiError } from "@/api/client";
import {
  listItems,
  listPrograms,
  listRequirements,
  type DeliveryItem,
  type ProgramSummary,
  type RequirementStatus,
  type RequirementSummary,
} from "@/api/management.api";
import { EmptyState } from "@/components/empty-state";
import { LoadingState } from "@/components/loading-state";
import { useSpace } from "@/components/space-provider";
import { DocumentSheet } from "@/components/workbench/document-sheet";
import { GitSheet } from "@/components/workbench/git-sheet";
import { ProgramPicker } from "@/components/workbench/program-picker";
import { UsageSheet } from "@/components/workbench/usage-sheet";
import { getSession } from "@/lib/auth";

const PROGRAM_KEY = "delivery-mobile.workbench-program";

const statusLabels: Record<RequirementStatus, string> = { open: "进行中", done: "已完成", dropped: "已放弃" };

type StatusFilter = "open" | "done";
type WorkView = "created" | "owner" | "assistant";

const workViews = [
  { value: "created", label: "我是提出者", icon: Lightbulb },
  { value: "owner", label: "我是负责人", icon: UserRoundCheck },
  { value: "assistant", label: "我是协助者", icon: UsersRound },
] as const;

interface RequirementProgressRow {
  requirement: RequirementSummary;
  total: number;
  done: number;
  running: number;
  blocked: number;
  progress: number;
}

export function WorkbenchScreen() {
  const router = useRouter();
  const { bizLine } = useSpace();
  const [programs, setPrograms] = useState<ProgramSummary[]>([]);
  const [programId, setProgramId] = useState(0);
  const [requirements, setRequirements] = useState<RequirementSummary[]>([]);
  const [items, setItems] = useState<DeliveryItem[]>([]);
  const [loadingPrograms, setLoadingPrograms] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState<StatusFilter>("open");
  const [workView, setWorkView] = useState<WorkView>("created");
  const [keyword, setKeyword] = useState("");
  const [gitRequirement, setGitRequirement] = useState<RequirementSummary | null>(null);
  const [documentRequirement, setDocumentRequirement] = useState<RequirementSummary | null>(null);
  const userId = String(getSession()?.user.id ?? "");

  const program = useMemo(() => programs.find((item) => item.programId === programId) ?? null, [programId, programs]);

  const loadPrograms = useCallback(async () => {
    setLoadingPrograms(true);
    setError("");
    try {
      const rows = await listPrograms();
      setPrograms(rows);
      const remembered = Number(window.sessionStorage.getItem(PROGRAM_KEY));
      const selected = rows.find((item) => item.programId === remembered) ?? rows[0];
      setProgramId(selected?.programId ?? 0);
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.message : "无法读取项目列表。");
    } finally {
      setLoadingPrograms(false);
    }
  }, [bizLine]);

  useEffect(() => { void loadPrograms(); }, [loadPrograms]);

  const load = useCallback(async () => {
    if (!programId) {
      setRequirements([]);
      setItems([]);
      return;
    }
    window.sessionStorage.setItem(PROGRAM_KEY, String(programId));
    setLoading(true);
    setError("");
    try {
      // 一次把项目下的任务拉全，需求进度在本地聚合，省掉一条需求一次请求。
      const [requirementPage, itemPage] = await Promise.all([listRequirements(programId), listItems(programId)]);
      setRequirements(requirementPage.data ?? []);
      setItems(itemPage.data ?? []);
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.message : "无法读取需求列表。");
    } finally {
      setLoading(false);
    }
  }, [programId]);

  useEffect(() => { void load(); }, [load]);

  const matchesWorkView = useCallback((requirement: RequirementSummary, view: WorkView) => {
    if (view === "created") return requirement.createdBy === userId;
    const members = view === "owner" ? requirement.owners : requirement.assistants;
    return members.some((member) => String(member.id) === userId);
  }, [userId]);

  // 身份视角上的数字只代表还要推进的事，已完结的需求不该再占用注意力。
  const openRequirements = useMemo(
    () => requirements.filter((requirement) => requirement.status === "open"),
    [requirements],
  );

  const workViewCounts = useMemo<Record<WorkView, number>>(() => ({
    created: openRequirements.filter((requirement) => matchesWorkView(requirement, "created")).length,
    owner: openRequirements.filter((requirement) => matchesWorkView(requirement, "owner")).length,
    assistant: openRequirements.filter((requirement) => matchesWorkView(requirement, "assistant")).length,
  }), [matchesWorkView, openRequirements]);

  const roleRequirements = useMemo(
    () => openRequirements.filter((requirement) => matchesWorkView(requirement, workView)),
    [matchesWorkView, openRequirements, workView],
  );

  const rows = useMemo<RequirementProgressRow[]>(() => {
    const grouped = new Map<string, DeliveryItem[]>();
    for (const item of items) {
      grouped.set(item.requirementKey, [...(grouped.get(item.requirementKey) ?? []), item]);
    }
    const text = keyword.trim().toLowerCase();
    // 已完成只按项目归档看，不再切身份；进行中才按当前身份视角收窄。
    const scoped = filter === "done" ? requirements.filter((requirement) => requirement.status !== "open") : roleRequirements;
    return scoped
      .filter((requirement) => !text || requirement.name.toLowerCase().includes(text) || requirement.requirementKey.toLowerCase().includes(text))
      .map((requirement) => {
        const owned = grouped.get(requirement.requirementKey) ?? [];
        const counted = owned.filter((item) => item.status !== "dropped");
        const done = counted.filter((item) => item.status === "done").length;
        const running = counted.filter((item) => item.status === "doing").length;
        const blocked = counted.filter((item) => item.status === "blocked").length;
        const progress = counted.length
          ? Math.round(counted.reduce((total, item) => total + (item.status === "done" ? 100 : item.progress), 0) / counted.length)
          : 0;
        return { requirement, total: counted.length, done, running, blocked, progress };
      });
  }, [filter, items, keyword, requirements, roleRequirements]);

  const overview = useMemo(() => {
    const related = new Set(roleRequirements.map((requirement) => requirement.requirementKey));
    const counted = items.filter((item) => related.has(item.requirementKey) && item.status !== "dropped");
    const done = counted.filter((item) => item.status === "done").length;
    const running = counted.filter((item) => item.status === "doing").length;
    const blocked = counted.filter((item) => item.status === "blocked").length;
    const progress = counted.length
      ? Math.round(counted.reduce((total, item) => total + (item.status === "done" ? 100 : item.progress), 0) / counted.length)
      : 0;
    return { total: counted.length, done, running, blocked, progress };
  }, [items, roleRequirements]);

  const today = useMemo(() => new Intl.DateTimeFormat("zh-CN", {
    month: "long",
    day: "numeric",
    weekday: "long",
  }).format(new Date()), []);

  return (
    <main className="screen workbench">
      <section className="workbench-hero" aria-labelledby="workbench-title">
        <div className="workbench-hero__header">
          <div>
            <p className="workbench-date"><CalendarDays size={16} aria-hidden="true" />{today}</p>
            <h1 id="workbench-title">工作台</h1>
            <p>把注意力放在正在推进的事情上。</p>
          </div>
          <div className="stack-actions">
            <Link className="icon-button is-glass" href="/commands" aria-label="运行记录" title="运行记录"><Activity size={22} /></Link>
            <button className="icon-button is-glass" type="button" onClick={() => void load()} aria-label="刷新工作台" title="刷新工作台" disabled={loading || loadingPrograms}>
              <RotateCw size={22} className={loading ? "spin-icon" : ""} />
            </button>
          </div>
        </div>

        <ProgramPicker programs={programs} programId={programId} loading={loadingPrograms} onSelect={setProgramId} />

        <div className="workbench-overview" aria-label="项目进度概览">
          <div className="overview-progress">
            <span className="overview-progress__value">{overview.progress}<small>%</small></span>
            <span className="overview-progress__label">整体完成度</span>
          </div>
          <div className="overview-metrics">
            <div><CirclePlay size={18} aria-hidden="true" /><strong>{overview.running}</strong><span>执行中</span></div>
            <div className="is-done"><CircleCheck size={18} aria-hidden="true" /><strong>{overview.done}</strong><span>已完成</span></div>
            <div className={overview.blocked ? "has-alert" : ""}><AlertTriangle size={18} aria-hidden="true" /><strong>{overview.blocked}</strong><span>受阻</span></div>
          </div>
        </div>
      </section>

      {error ? <p className="form-message is-error" role="alert">{error}</p> : null}

      <section className="workbench-list-section" aria-labelledby="requirements-heading">
        <div className="workbench-role-tabs" role="tablist" aria-label="我在需求中的身份">
          {workViews.map((view) => {
            const Icon = view.icon;
            const active = workView === view.value;
            return (
              <button
                className={active ? "is-active" : ""}
                type="button"
                role="tab"
                aria-selected={active}
                key={view.value}
                onClick={() => setWorkView(view.value)}
              >
                <span className="workbench-role-tabs__top">
                  <Icon size={19} aria-hidden="true" />
                  <strong>{workViewCounts[view.value]}</strong>
                </span>
                <span className="workbench-role-tabs__label">{view.label}</span>
              </button>
            );
          })}
        </div>

        <div className="workbench-section-heading">
          <div>
            <p className="eyebrow">{filter === "done" ? "已完成" : workViews.find((view) => view.value === workView)?.label}</p>
            <h2 id="requirements-heading">与我相关的需求</h2>
          </div>
          <div className="workbench-section-heading__aside">
            <span className="workbench-section-heading__count">{rows.length}<small> 项</small></span>
            {/* 新增需求的落点就是需求对话：分支建好、需求落库之后接着在那边聊。 */}
            <button
              className="icon-button is-primary"
              type="button"
              disabled={!programId || !program?.canWrite}
              onClick={() => router.push(`/workbench/requirements/new/chat?programId=${programId}`)}
              aria-label="新增需求"
              title="新增需求"
            >
              <Plus size={22} aria-hidden="true" />
            </button>
          </div>
        </div>

        <div className="workbench-toolbar">
        <label className="workbench-search">
          <Search size={19} aria-hidden="true" />
          <input value={keyword} onChange={(event) => setKeyword(event.target.value)} placeholder="搜索需求" aria-label="搜索需求" enterKeyHint="search" />
        </label>
        <div className="segmented" role="group" aria-label="需求筛选">
          {([["open", "进行中"], ["done", "已完成"]] as const).map(([value, label]) => (
            <button key={value} type="button" className={filter === value ? "is-active" : ""} onClick={() => setFilter(value)}>{label}</button>
          ))}
        </div>
        </div>

        {loading && !rows.length ? <LoadingState title="正在读取需求" /> : null}
        {!loading && !error && !rows.length ? (
          <EmptyState icon={<ListChecks size={24} />} title="这个视角下没有需求" description="换一个身份视角或筛选条件看看。" />
        ) : null}

        <div className="requirement-board" aria-label="需求列表">
          {rows.map((row) => (
            <RequirementCard
              key={row.requirement.requirementKey}
              row={row}
              programId={programId}
              onOpenGit={() => setGitRequirement(row.requirement)}
              onOpenDocuments={() => setDocumentRequirement(row.requirement)}
            />
          ))}
        </div>
      </section>

      {program && !program.canWrite ? (
        <p className="workspace-readonly"><AlertTriangle size={18} aria-hidden="true" />当前项目只读，不能发起对话或 Git 操作。</p>
      ) : null}

      <GitSheet
        open={Boolean(gitRequirement)}
        programId={programId}
        program={program}
        requirement={gitRequirement}
        onClose={() => setGitRequirement(null)}
      />
      <DocumentSheet
        open={Boolean(documentRequirement)}
        programId={programId}
        ownerKind="requirement"
        ownerKey={documentRequirement?.requirementKey ?? ""}
        ownerName={documentRequirement?.name}
        onClose={() => setDocumentRequirement(null)}
      />
    </main>
  );
}

function RequirementCard({
  row,
  programId,
  onOpenGit,
  onOpenDocuments,
}: {
  row: RequirementProgressRow;
  programId: number;
  onOpenGit: () => void;
  onOpenDocuments: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  // 消耗按需拉取：需求列表一屏好几张卡，不能每张都在渲染时去汇总一遍。
  const [usageOpen, setUsageOpen] = useState(false);
  const { requirement } = row;
  const search = `?programId=${programId}`;
  const requirementPath = encodeURIComponent(requirement.requirementKey);

  return (
    <article className="requirement-card">
      <button className="requirement-card__head" type="button" onClick={() => setExpanded((current) => !current)} aria-expanded={expanded}>
        <div className="requirement-card__title">
          <strong>{requirement.name || requirement.requirementKey}</strong>
          <span className={`status ${requirement.status === "open" ? "is-active" : requirement.status === "dropped" ? "is-danger" : "is-success"}`}>
            {statusLabels[requirement.status] ?? requirement.status}
          </span>
        </div>
        <ChevronDown size={20} className={`requirement-card__chevron${expanded ? " is-open" : ""}`} aria-hidden="true" />
      </button>

      <div className="requirement-card__meter" aria-label={`完成度 ${row.progress}%`}>
        <span style={{ width: `${Math.max(0, Math.min(100, row.progress))}%` }} />
      </div>
      <div className="requirement-card__meta">
        <strong>{row.progress}%</strong>
        <span>{row.done}/{row.total} 任务完成</span>
        {row.running ? <span className="is-running">{row.running} 执行中</span> : null}
        {row.blocked ? <span className="is-blocked">{row.blocked} 受阻</span> : null}
      </div>

      {expanded && requirement.detail ? <p className="requirement-card__detail">{requirement.detail}</p> : null}

      <div className="requirement-card__actions">
        <Link className="chip-button is-primary" href={`/workbench/requirements/${requirementPath}/chat${search}`}>
          <MessageSquareText size={21} aria-hidden="true" /><span>对话</span>
        </Link>
        <Link className="chip-button" href={`/workbench/requirements/${requirementPath}/progress${search}`}>
          <CirclePlay size={21} aria-hidden="true" /><span>运行任务</span>
        </Link>
        <button className="chip-button" type="button" onClick={onOpenGit}><GitBranch size={21} aria-hidden="true" /><span>Git</span></button>
        <button className="chip-button" type="button" onClick={onOpenDocuments}><FileText size={21} aria-hidden="true" /><span>文档</span></button>
        <button className="chip-button" type="button" onClick={() => setUsageOpen(true)}><Coins size={21} aria-hidden="true" /><span>消耗</span></button>
      </div>

      <UsageSheet
        open={usageOpen}
        programId={programId}
        requirementKey={requirement.requirementKey}
        requirementName={requirement.name}
        onClose={() => setUsageOpen(false)}
      />
    </article>
  );
}
