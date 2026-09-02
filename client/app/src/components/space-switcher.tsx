"use client";

import { useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import { Sheet } from "@/components/sheet";
import { useSpace } from "@/components/space-provider";

/** 头部的空间切换器：显示当前空间，点开后在可访问的空间之间切换。 */
export function SpaceSwitcher() {
  const { spaces, bizLine, spaceName, switchTo } = useSpace();
  const [open, setOpen] = useState(false);

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

      {/* 和 Git、文档共用同一种底部面板：同样的圆角、把手、升起动画和滚动锁。 */}
      <Sheet open={open} title="切换空间" subtitle="项目、需求和任务都按空间划分" onClose={() => setOpen(false)}>
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
      </Sheet>
    </>
  );
}
