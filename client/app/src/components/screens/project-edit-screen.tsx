"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { ArrowLeft, Save } from "lucide-react";
import { EmptyState } from "@/components/empty-state";
import { previewProjectById } from "@/features/foundation/preview-data";
import type { FoundationProjectStatus } from "@/features/foundation/types";

const previewEnabled = process.env.NEXT_PUBLIC_APP_PREVIEW === "true";

export function ProjectEditScreen() {
  const { projectId } = useParams<{ projectId: string }>();
  const project = previewEnabled ? previewProjectById(projectId) : null;
  const [name, setName] = useState(project?.name ?? "");
  const [description, setDescription] = useState(project?.description ?? "");
  const [status, setStatus] = useState<FoundationProjectStatus>(project?.status ?? "active");
  const [message, setMessage] = useState("");

  if (!project) {
    return (
      <main className="screen">
        <div className="screen-title-row"><div><p className="eyebrow">编辑项目</p><h1>项目不可用</h1></div><Link className="icon-button" href="/projects" aria-label="返回项目列表" title="返回项目列表"><ArrowLeft size={22} /></Link></div>
        <EmptyState icon={<Save size={23} />} title="没有可编辑的项目" description="项目编辑 API 接入后会在此处提供完整表单。" />
      </main>
    );
  }

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setMessage("预览模式已验证编辑交互；生产环境会通过移动管理 API 保存更改。");
  };

  return (
    <main className="screen">
      <div className="screen-title-row">
        <div><p className="eyebrow">项目详情</p><h1>编辑项目</h1></div>
        <Link className="icon-button" href={`/projects/${project.id}`} aria-label="取消编辑" title="取消编辑"><ArrowLeft size={22} /></Link>
      </div>
      <form className="card form-grid" onSubmit={submit}>
        <div className="field">
          <label htmlFor="project-name">项目名称</label>
          <input id="project-name" value={name} onChange={(event) => setName(event.target.value)} maxLength={120} required />
        </div>
        <div className="field">
          <label htmlFor="project-description">说明</label>
          <textarea id="project-description" value={description} onChange={(event) => setDescription(event.target.value)} maxLength={600} required />
          <p className="field-help">支持长文本输入，软键盘打开时页面可正常滚动。</p>
        </div>
        <div className="field">
          <label htmlFor="project-status">状态</label>
          <select id="project-status" value={status} onChange={(event) => setStatus(event.target.value as FoundationProjectStatus)}>
            <option value="active">推进中</option>
            <option value="attention">需关注</option>
            <option value="paused">已暂停</option>
          </select>
        </div>
        {message ? <p className="form-message" role="status">{message}</p> : null}
        <button className="button button-primary full-width" type="submit"><Save size={20} aria-hidden="true" />保存更改</button>
      </form>
    </main>
  );
}
