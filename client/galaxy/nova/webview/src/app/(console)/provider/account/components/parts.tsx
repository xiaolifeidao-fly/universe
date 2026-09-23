"use client";

/** 账户页几块卡片共用的小件。只在这一页用，不进 kit。 */

import { useState, type PropsWithChildren, type ReactNode } from "react";
import { CopyBtn } from "@/components/ui/kit";
import { useLocale } from "@/i18n/LocaleProvider";

/**
 * 一栏里的行，高度封顶，超出的在卡片里自己滚。
 *
 * 机房几十台时平铺开，接入密钥、登录与安全会被挤到两三屏以外。上限卡在一行的中间
 * （机器约 10 行半、密钥约 7 行半）：最后一行露半截，一眼看得出下面还有。
 */
export function RowList({ children }: PropsWithChildren) {
  return (
    <div role="tabpanel" className="gx-scroll" style={{ maxHeight: 440, overflowY: "auto" }}>
      {children}
    </div>
  );
}

/**
 * 卡片里的一排页签，底线横贯整张卡，和下面每一行的分隔线对齐。
 *
 * 不用 kit 的 Tabs：那个是页面级的，底线只画到页签自己那么宽，右边也放不下搜索框。
 * 数量跟在名字后面 —— 「已解绑」「已吊销」平时不点开，里面有没有东西得从外面看得出来。
 */
export function TabStrip<T extends string>({
  value,
  options,
  onChange,
  aside,
}: {
  value: T;
  options: { value: T; label: ReactNode; count?: number | null }[];
  onChange: (next: T) => void;
  aside?: ReactNode;
}) {
  return (
    <div style={{ display: "flex", alignItems: "flex-end", gap: 12, padding: "0 18px", borderBottom: "1px solid var(--gx-line)" }}>
      <div className="gx-tabs" role="tablist" style={{ borderBottom: 0 }}>
        {options.map((option) => {
          const active = option.value === value;
          return (
            <button
              key={option.value}
              type="button"
              role="tab"
              aria-selected={active}
              className={`gx-tab${active ? " is-active" : ""}`}
              onClick={() => onChange(option.value)}
            >
              {option.label}
              {option.count != null ? (
                <span className="gx-mono" style={{ marginLeft: 6, fontSize: 11.5, fontWeight: 400, color: "var(--gx-faint)" }}>
                  {option.count}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
      {aside ? <div style={{ marginLeft: "auto", paddingBottom: 7 }}>{aside}</div> : null}
    </div>
  );
}

/**
 * 卡片里某一栏空着时的那一格。比 kit 的 EmptyState 矮一半：
 * 名下只有这台电脑是最常见的情形，一个 48px 内边距的空状态会把下面的卡整块往下推。
 */
export function Blank({ title, hint, action }: { title: ReactNode; hint?: ReactNode; action?: ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8, padding: "26px 24px", textAlign: "center" }}>
      <strong style={{ fontSize: 13, fontWeight: 600, color: "var(--gx-soft)" }}>{title}</strong>
      {hint ? <span style={{ maxWidth: 560, fontSize: 12.5, lineHeight: 1.7, color: "var(--gx-faint)" }}>{hint}</span> : null}
      {action ? <span style={{ marginTop: 4 }}>{action}</span> : null}
    </div>
  );
}

/**
 * 一段可复制的命令。接入密钥和安装 ai-bridge 两块都用。
 *
 * onCopied 给签发弹窗用：复制任何一条带着密钥的命令，都算密钥已经存下来了。
 */
export function CommandBlock({ title, command, onCopied }: { title: ReactNode; command: string; onCopied?: () => void }) {
  const { t } = useLocale();
  const [copied, setCopied] = useState(false);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
        <span style={{ fontSize: 12.5, color: "var(--gx-soft)" }}>{title}</span>
        <CopyBtn
          value={command}
          label={copied ? t("account.keyCopied") : t("account.cliCopy")}
          copied={copied}
          onCopied={() => {
            setCopied(true);
            onCopied?.();
          }}
        />
      </div>
      <pre
        className="gx-mono"
        style={{
          margin: 0,
          padding: "10px 12px",
          borderRadius: 10,
          border: "1px solid var(--gx-line)",
          background: "var(--gx-muted)",
          fontSize: 12,
          lineHeight: 1.6,
          whiteSpace: "pre-wrap",
          overflowWrap: "anywhere",
        }}
      >
        {command}
      </pre>
    </div>
  );
}
