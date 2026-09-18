"use client";

/**
 * 门户的设计系统 React 层。样式全在 globals.css 的 .gp-* 里，
 * 这里只负责把「什么时候加哪个 class」固定下来 —— 和两个控制台的 kit.tsx 同一个思路。
 */

import Link from "next/link";
import type { AnchorHTMLAttributes, ButtonHTMLAttributes, CSSProperties, PropsWithChildren, ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { IconArrowRight, IconPlus } from "./icons";
import { copyText } from "@/utils/format";

/* ---------- 版面 ---------- */

export function Page({ children, className = "" }: PropsWithChildren<{ className?: string }>) {
  return <div className={`gp-page ${className}`}>{children}</div>;
}

export function Section({
  children,
  id,
  tight,
  style,
}: PropsWithChildren<{ id?: string; tight?: boolean; style?: CSSProperties }>) {
  return (
    <section id={id} className={`gp-section${tight ? " gp-section--tight" : ""}`} style={style}>
      <Page>{children}</Page>
    </section>
  );
}

export function SectionHead({ eyebrow, title, lead }: { eyebrow?: ReactNode; title: ReactNode; lead?: ReactNode }) {
  return (
    <header className="gp-section__head">
      {eyebrow ? (
        <span className="gp-eyebrow">
          <span className="gp-dot" />
          {eyebrow}
        </span>
      ) : null}
      <h2 className="gp-h2">{title}</h2>
      {lead ? <p className="gp-lead">{lead}</p> : null}
    </header>
  );
}

export function Card({
  children,
  lift,
  className = "",
  style,
}: PropsWithChildren<{ lift?: boolean; className?: string; style?: CSSProperties }>) {
  return (
    <div className={`gp-card${lift ? " gp-card--lift" : ""} ${className}`} style={style}>
      {children}
    </div>
  );
}

/* ---------- 按钮 ---------- */

type Tone = "primary" | "ghost" | "quiet";
type Size = "sm" | "md" | "lg";

function buttonClass(tone: Tone, size: Size, extra = ""): string {
  const scale = size === "md" ? "" : ` gp-btn--${size}`;
  return `gp-btn gp-btn--${tone}${scale} ${extra}`.trim();
}

export function Btn({
  tone = "primary",
  size = "md",
  className = "",
  children,
  ...rest
}: PropsWithChildren<{ tone?: Tone; size?: Size; className?: string } & ButtonHTMLAttributes<HTMLButtonElement>>) {
  return (
    <button type="button" className={buttonClass(tone, size, className)} {...rest}>
      {children}
    </button>
  );
}

/**
 * 按钮样子的链接。
 *
 * 站内用 next/link 走客户端路由，站外（控制台在另一个域）必须是普通 <a> ——
 * next/link 对跨域地址会退化成整页跳转，但 prefetch 仍会去打那个域，
 * 白白给控制台送一份来自门户的预取流量。
 */
export function LinkBtn({
  href,
  tone = "primary",
  size = "md",
  className = "",
  children,
  ...rest
}: PropsWithChildren<
  { href: string; tone?: Tone; size?: Size; className?: string } & AnchorHTMLAttributes<HTMLAnchorElement>
>) {
  const cls = buttonClass(tone, size, className);
  if (isExternal(href)) {
    return (
      <a className={cls} href={href} {...rest}>
        {children}
      </a>
    );
  }
  return (
    <Link className={cls} href={href} {...rest}>
      {children}
    </Link>
  );
}

export function TextLink({
  href,
  children,
  arrow,
}: PropsWithChildren<{ href: string; arrow?: boolean }>) {
  const content = (
    <>
      {children}
      {arrow ? <IconArrowRight size={15} /> : null}
    </>
  );
  if (isExternal(href)) {
    return (
      <a className="gp-textlink" href={href}>
        {content}
      </a>
    );
  }
  return (
    <Link className="gp-textlink" href={href}>
      {content}
    </Link>
  );
}

export function isExternal(href: string): boolean {
  return /^https?:\/\//i.test(href);
}

/* ---------- 小件 ---------- */

export function Pill({
  tone = "default",
  children,
}: PropsWithChildren<{ tone?: "default" | "accent" | "ember" }>) {
  return <span className={`gp-pill${tone === "default" ? "" : ` gp-pill--${tone}`}`}>{children}</span>;
}

/**
 * 小标签。tone 只有三档：中性、强调、便宜了多少。
 * 配色名是语义的，不是颜色名 —— 模型目录里存的也是语义（hot/new/value），
 * 两边对得上，换主题不用改数据。
 */
export function Tag({ tone = "default", children }: PropsWithChildren<{ tone?: "default" | "accent" | "ok" | "warn" }>) {
  return <span className={`gp-tag${tone === "default" ? "" : ` gp-tag--${tone}`}`}>{children}</span>;
}

export function Empty({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="gp-empty">
      <div style={{ fontWeight: 600, color: "var(--gp-soft)" }}>{title}</div>
      {hint ? <div style={{ marginTop: 6, fontSize: 13 }}>{hint}</div> : null}
    </div>
  );
}

/* ---------- FAQ ---------- */

export interface FaqEntry {
  q: string;
  a: string;
}

/**
 * 手风琴。默认展开第一条 —— 一整列折叠起来的标题看起来像还没加载完，
 * 而第一条通常正是来访者想问的那句。
 */
export function Faq({ items }: { items: FaqEntry[] }) {
  const [open, setOpen] = useState(0);
  return (
    <div className="gp-faq">
      {items.map((item, index) => (
        <div key={item.q} className="gp-faq__item" data-open={open === index}>
          <button
            type="button"
            className="gp-faq__q"
            aria-expanded={open === index}
            onClick={() => setOpen(open === index ? -1 : index)}
          >
            <span>{item.q}</span>
            <IconPlus size={18} />
          </button>
          <div className="gp-faq__a">
            <div>
              <p>{item.a}</p>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

/* ---------- 复制 ---------- */

export type CopyState = "idle" | "ok" | "fail";

/**
 * 复制到剪贴板的三态。
 *
 * 失败必须看得见：门户如果部署在明文 http 上（或任何非安全上下文），
 * `navigator.clipboard` 根本不存在，按钮会一声不响什么都不做 ——
 * 而它复制的正好是首屏那行「照着填就能用」的服务地址。
 */
export function useCopy(resetMs = 1800): { state: CopyState; copy: (value: string) => void } {
  const [state, setState] = useState<CopyState>("idle");
  const timer = useRef<number | null>(null);

  useEffect(() => () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
  }, []);

  const copy = useCallback(
    (value: string) => {
      if (!value) return;
      void copyText(value).then((ok) => {
        setState(ok ? "ok" : "fail");
        if (timer.current !== null) window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => setState("idle"), resetMs);
      });
    },
    [resetMs],
  );

  return { state, copy };
}

/* ---------- 品牌色卡 ---------- */

/** 模型族各有一个固定色。同一个族在门户各处必须是同一个颜色，所以收在这里。 */
export const FAMILY_COLORS: Record<string, string> = {
  claude: "#b4531f",
  gpt: "#0f7b74",
  gemini: "#3f5ea8",
  other: "#5b6b67",
};

export function familyColor(family: string): string {
  return FAMILY_COLORS[family] ?? FAMILY_COLORS.other;
}
