"use client";

import { useState } from "react";
import { Check, ChevronDown, Folder } from "lucide-react";
import type { ProgramSummary } from "@/api/management.api";
import { Sheet } from "@/components/sheet";

/** 项目切换：移动端用一层选择面板，比原生下拉更好点，也放得下项目状态。 */
export function ProgramPicker({
  programs,
  programId,
  loading,
  onSelect,
}: {
  programs: ProgramSummary[];
  programId: number;
  loading: boolean;
  onSelect: (programId: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const current = programs.find((item) => item.programId === programId) ?? null;

  return (
    <>
      <button className="program-picker" type="button" onClick={() => setOpen(true)} disabled={loading || !programs.length}>
        <span className="program-picker__mark" aria-hidden="true"><Folder size={20} /></span>
        <span className="program-picker__body">
          <small>当前项目</small>
          <strong>{loading ? "正在读取项目" : current?.name || "选择项目"}</strong>
        </span>
        <ChevronDown size={20} aria-hidden="true" />
      </button>

      <Sheet open={open} title="选择项目" subtitle={`${programs.length} 个可进入的项目`} onClose={() => setOpen(false)}>
        <div className="option-list">
          {programs.map((program) => (
            <button
              className={`option-row${program.programId === programId ? " is-selected" : ""}`}
              type="button"
              key={program.programId}
              onClick={() => {
                onSelect(program.programId);
                setOpen(false);
              }}
            >
              <span>
                <strong>{program.name}</strong>
                <small>{program.programCode}{program.canWrite ? "" : " · 只读"}</small>
              </span>
              {program.programId === programId ? <Check size={20} aria-hidden="true" /> : null}
            </button>
          ))}
        </div>
      </Sheet>
    </>
  );
}
