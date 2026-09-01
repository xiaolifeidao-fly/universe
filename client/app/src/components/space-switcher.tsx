"use client";

import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Layers } from "lucide-react";
import { useSpace } from "@/components/space-provider";

/** 头部的空间切换器：显示当前空间，点开后在可访问的空间之间切换。 */
export function SpaceSwitcher() {
  const { spaces, bizLine, spaceName, switchTo } = useSpace();
  const [open, setOpen] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const single = spaces.length <= 1;

  return (
    <>
      <button
        className="space-trigger"
        type="button"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={single ? "当前空间" : "切换空间"}
      >
        <span className="space-trigger__name">{spaceName || "选择空间"}</span>
        <ChevronDown size={13} aria-hidden="true" />
      </button>

      {open ? (
        <div className="sheet-backdrop" role="presentation" onClick={() => setOpen(false)}>
          <div className="sheet" role="dialog" aria-modal="true" aria-label="切换空间" onClick={(event) => event.stopPropagation()}>
            <header className="sheet-header">
              <span className="sheet-title"><Layers size={17} aria-hidden="true" />切换空间</span>
              <button className="sheet-close" type="button" onClick={() => setOpen(false)} ref={closeRef}>完成</button>
            </header>
            <p className="sheet-copy">项目、需求和任务都按空间划分，切换后回到该空间的概览。</p>
            <ul className="space-list">
              {spaces.map((space) => {
                const active = space.code === bizLine;
                return (
                  <li key={space.code}>
                    <button
                      className={`space-option${active ? " is-active" : ""}`}
                      type="button"
                      onClick={() => { switchTo(space.code); setOpen(false); }}
                      aria-current={active ? "true" : undefined}
                    >
                      <span className="space-option__text">
                        <strong>{space.name}</strong>
                        <span className="muted">{space.code}·{space.canManage ? "空间管理员" : space.canWrite ? "可写入" : "只读"}</span>
                      </span>
                      {active ? <Check size={17} aria-hidden="true" /> : null}
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        </div>
      ) : null}
    </>
  );
}
