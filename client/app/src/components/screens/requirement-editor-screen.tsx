"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { ArrowLeft, Save } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { ApiError } from "@/api/client";
import {
  getProgram,
  getRequirement,
  saveRequirement,
  type ItemPhase,
  type RequirementMember,
  type RequirementMode,
  type RequirementStatus,
} from "@/api/management.api";
import { EmptyState } from "@/components/empty-state";
import { LoadingState } from "@/components/loading-state";
import { dateInputValue, dateToIso } from "@/lib/date";

type EditorState = {
  name: string;
  detail: string;
  status: RequirementStatus;
  mode: RequirementMode;
  startPhase: ItemPhase;
  splitTasks: boolean;
  preGenerateTaskDocuments: boolean;
  owners: string;
  assistants: string;
  plannedStartAt: string;
  plannedEndAt: string;
  version: number;
};

const initialState: EditorState = {
  name: "",
  detail: "",
  status: "open",
  mode: "professional",
  startPhase: "requirement",
  splitTasks: true,
  preGenerateTaskDocuments: false,
  owners: "",
  assistants: "",
  plannedStartAt: "",
  plannedEndAt: "",
  version: 0,
};

function memberIds(value: string): RequirementMember[] {
  return value.split(/[,，\s]+/).map((id) => id.trim()).filter(Boolean).map((id) => ({ id, name: "" }));
}

function memberList(members: RequirementMember[]) {
  return members.map((member) => member.id).join(", ");
}

export function RequirementEditorScreen({ editing }: { editing: boolean }) {
  const params = useParams<{ projectId: string; requirementKey?: string }>();
  const router = useRouter();
  const programId = Number(params.projectId);
  const requirementKey = params.requirementKey ?? "";
  const [state, setState] = useState<EditorState>(initialState);
  const [canWrite, setCanWrite] = useState(false);
  const [loading, setLoading] = useState(editing);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!Number.isInteger(programId) || programId <= 0) {
      setError("项目标识无效。");
      setLoading(false);
      return;
    }
    void getProgram(programId).then((program) => setCanWrite(program.canWrite)).catch((reason) => {
      setError(reason instanceof ApiError ? reason.message : "无法读取项目权限。");
    });
    if (!editing) return;
    void getRequirement(programId, requirementKey).then((requirement) => {
      setState({
        name: requirement.name,
        detail: requirement.detail,
        status: requirement.status,
        mode: requirement.mode,
        startPhase: requirement.startPhase,
        splitTasks: requirement.splitTasks,
        preGenerateTaskDocuments: requirement.preGenerateTaskDocuments,
        owners: memberList(requirement.owners),
        assistants: memberList(requirement.assistants),
        plannedStartAt: dateInputValue(requirement.plannedStartAt),
        plannedEndAt: dateInputValue(requirement.plannedEndAt),
        version: requirement.version,
      });
    }).catch((reason) => {
      setError(reason instanceof ApiError ? reason.message : "无法读取需求。");
    }).finally(() => setLoading(false));
  }, [editing, programId, requirementKey]);

  const update = <Key extends keyof EditorState>(key: Key, value: EditorState[Key]) => {
    setState((current) => ({ ...current, [key]: value }));
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSaving(true);
    setError("");
    try {
      const saved = await saveRequirement({
        programId,
        requirementKey: editing ? requirementKey : undefined,
        name: state.name.trim(),
        detail: state.detail,
        status: state.status,
        mode: state.mode,
        startPhase: state.startPhase,
        splitTasks: state.splitTasks,
        preGenerateTaskDocuments: state.preGenerateTaskDocuments,
        generatePrototype: false,
        owners: memberIds(state.owners),
        assistants: memberIds(state.assistants),
        plannedStartAt: dateToIso(state.plannedStartAt),
        plannedEndAt: dateToIso(state.plannedEndAt),
        version: editing ? state.version : undefined,
      });
      router.replace(`/projects/${programId}/requirements/${saved.requirementKey}`);
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.message : "需求保存失败，请稍后重试。");
    } finally {
      setSaving(false);
    }
  };

  const backHref = editing ? `/projects/${programId}/requirements/${requirementKey}` : `/projects/${programId}`;
  if (loading) return <main className="screen"><LoadingState title="正在读取需求" /></main>;
  if (error && editing) return <main className="screen"><EmptyState icon={<Save size={23} />} title="需求不可编辑" description={error} action={<Link className="button button-primary" href={backHref}>返回项目</Link>} /></main>;

  return (
    <main className="screen">
      <div className="screen-title-row">
        <div><p className="eyebrow">{editing ? "需求详情" : "项目需求"}</p><h1>{editing ? "编辑需求" : "新建需求"}</h1><p>需求保存后可发起受控的任务拆解。</p></div>
        <Link className="icon-button" href={backHref} aria-label="取消编辑" title="取消编辑"><ArrowLeft size={22} /></Link>
      </div>
      <form className="card form-grid" onSubmit={submit}>
        <div className="field"><label htmlFor="requirement-name">需求名称</label><input id="requirement-name" value={state.name} onChange={(event) => update("name", event.target.value)} maxLength={255} placeholder="例如：完善移动端任务依赖管理" /></div>
        <div className="field"><label htmlFor="requirement-detail">需求说明</label><textarea id="requirement-detail" value={state.detail} onChange={(event) => update("detail", event.target.value)} maxLength={32768} required placeholder="描述目标、边界和验收重点。" /></div>
        <div className="inline-fields">
          <div className="field"><label htmlFor="requirement-mode">交付模式</label><select id="requirement-mode" value={state.mode} onChange={(event) => update("mode", event.target.value as RequirementMode)}><option value="professional">专业模式</option><option value="simple">简易模式</option></select></div>
          <div className="field"><label htmlFor="requirement-phase">任务起始阶段</label><select id="requirement-phase" value={state.startPhase} onChange={(event) => update("startPhase", event.target.value as ItemPhase)} disabled={state.mode === "simple"}><option value="requirement">梳理需求</option><option value="development">动作执行</option><option value="testing">成品测试</option></select></div>
        </div>
        <div className="inline-fields">
          <div className="field"><label htmlFor="requirement-status">状态</label><select id="requirement-status" value={state.status} onChange={(event) => update("status", event.target.value as RequirementStatus)}><option value="open">进行中</option><option value="done">已完成</option><option value="dropped">不做</option></select></div>
          <div className="field"><label htmlFor="requirement-start">计划开始</label><input id="requirement-start" type="date" value={state.plannedStartAt} onChange={(event) => update("plannedStartAt", event.target.value)} /></div>
          <div className="field"><label htmlFor="requirement-end">计划结束</label><input id="requirement-end" type="date" value={state.plannedEndAt} onChange={(event) => update("plannedEndAt", event.target.value)} /></div>
        </div>
        <div className="field"><label htmlFor="requirement-owners">负责人 ID</label><input id="requirement-owners" value={state.owners} onChange={(event) => update("owners", event.target.value)} placeholder="多个 ID 以逗号分隔" /><p className="field-help">服务端会校验成员归属并使用权威显示名。</p></div>
        <div className="field"><label htmlFor="requirement-assistants">协助人 ID</label><input id="requirement-assistants" value={state.assistants} onChange={(event) => update("assistants", event.target.value)} placeholder="可留空，多个 ID 以逗号分隔" /></div>
        <label className="checkbox-row"><input type="checkbox" checked={state.splitTasks} onChange={(event) => update("splitTasks", event.target.checked)} />拆解为多条任务</label>
        <label className="checkbox-row"><input type="checkbox" checked={state.preGenerateTaskDocuments} onChange={(event) => update("preGenerateTaskDocuments", event.target.checked)} />拆解后预生成任务需求文档</label>
        {error ? <p className="form-message is-error" role="alert">{error}</p> : null}
        <button className="button button-primary full-width" type="submit" disabled={saving || !canWrite}><Save size={20} aria-hidden="true" />{saving ? "正在保存" : "保存需求"}</button>
        {!canWrite ? <p className="field-help">当前账号只有查看权限，无法保存更改。</p> : null}
      </form>
    </main>
  );
}
