"use client";

/**
 * 设计系统的 React 层。样式全在 @shared/styles/galaxy.css 的 .gx-* 里，
 * 这里只负责把「什么时候加哪个 class」这件事固定下来。
 *
 * 刻意不用 antd 的 Table / Button / Input：原型的密度（12px 行、mono 数字、
 * 无边框行分隔）靠改 antd token 拉不过来。antd 只留给浮层 —— Modal、Select、
 * message、Popconfirm，那几个自己实现不划算，而且要处理焦点陷阱。
 *
 * 两个端各有一份拷贝。仓库里 utils/format.ts、utils/axios.ts、i18n 都是这么处理的：
 * 每端的页面与样式归自己维护（见 client/galaxy/README.md）。
 */

import { Select, message } from "antd";
import type { CSSProperties, PropsWithChildren, ReactNode } from "react";
import { useLocale } from "@/i18n/LocaleProvider";
import { IconAlert, IconCheck, IconChevronRight, IconCopy } from "./icons";

/* ---------- 容器 ---------- */

export function Card({
  className = "",
  style,
  children,
}: PropsWithChildren<{ className?: string; style?: CSSProperties }>) {
  return (
    <section className={`gx-card ${className}`} style={style}>
      {children}
    </section>
  );
}

export function CardHead({ title, hint, action }: { title: ReactNode; hint?: ReactNode; action?: ReactNode }) {
  return (
    <div className="gx-card__head">
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, minWidth: 0 }}>
        <span className="gx-card__title">{title}</span>
        {hint ? <span className="gx-card__hint">{hint}</span> : null}
      </div>
      {action}
    </div>
  );
}

/* ---------- 按钮 ---------- */

type ButtonTone = "primary" | "accent" | "ghost" | "soft" | "danger";

export function Btn({
  tone = "ghost",
  small,
  loading,
  icon,
  className = "",
  children,
  ...rest
}: PropsWithChildren<
  {
    tone?: ButtonTone;
    small?: boolean;
    loading?: boolean;
    icon?: ReactNode;
    className?: string;
  } & React.ButtonHTMLAttributes<HTMLButtonElement>
>) {
  return (
    <button
      type="button"
      className={`gx-btn gx-btn--${tone}${small ? " gx-btn--sm" : ""} ${className}`}
      disabled={rest.disabled || loading}
      {...rest}
    >
      {loading ? <Spinner /> : icon}
      {children}
    </button>
  );
}

export function IconBtn({
  label,
  children,
  ...rest
}: PropsWithChildren<{ label: string } & React.ButtonHTMLAttributes<HTMLButtonElement>>) {
  return (
    <button type="button" className="gx-btn--icon" aria-label={label} title={label} {...rest}>
      {children}
    </button>
  );
}

export function LinkBtn({
  children,
  arrow,
  ...rest
}: PropsWithChildren<{ arrow?: boolean } & React.ButtonHTMLAttributes<HTMLButtonElement>>) {
  return (
    <button type="button" className="gx-link" {...rest}>
      <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
        {children}
        {arrow ? <IconChevronRight size={13} /> : null}
      </span>
    </button>
  );
}

function Spinner() {
  return (
    <span
      aria-hidden="true"
      style={{
        width: 13,
        height: 13,
        border: "2px solid currentColor",
        borderRightColor: "transparent",
        borderRadius: "50%",
        animation: "gxSpin .7s linear infinite",
        display: "inline-block",
      }}
    />
  );
}

/* ---------- 状态件 ---------- */

export function Pill({
  tone = "default",
  children,
}: PropsWithChildren<{ tone?: "default" | "ok" | "warn" | "err" | "accent" }>) {
  return <span className={`gx-pill${tone === "default" ? "" : ` gx-pill--${tone}`}`}>{children}</span>;
}

export function LiveDot({ on = true }: { on?: boolean }) {
  return <span className={`gx-dot${on ? "" : " gx-dot--off"}`} />;
}

export function Switch({
  checked,
  onChange,
  disabled,
  label,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      title={label}
      disabled={disabled}
      className={`gx-switch${checked ? "" : " is-off"}`}
      onClick={() => onChange(!checked)}
    />
  );
}

export function Meter({ used, limit, warned }: { used: number; limit: number; warned?: boolean }) {
  const ratio = limit > 0 ? Math.min(1, used / limit) : 0;
  const full = limit > 0 && used >= limit;
  return (
    <div className="gx-meter">
      <div
        className={`gx-meter__fill${full ? " is-full" : warned ? " is-warn" : ""}`}
        style={{ width: `${Math.round(ratio * 100)}%` }}
      />
    </div>
  );
}

/* ---------- 排版件 ---------- */

export function Figure({
  value,
  unit,
  aside,
  small,
}: {
  value: ReactNode;
  unit?: ReactNode;
  aside?: ReactNode;
  small?: boolean;
}) {
  return (
    <div className="gx-figure">
      <span className={`gx-figure__number${small ? " gx-figure__number--sm" : ""}`}>{value}</span>
      {unit ? <span style={{ fontSize: 15, color: "var(--gx-soft)" }}>{unit}</span> : null}
      {aside ? <span style={{ marginLeft: "auto" }}>{aside}</span> : null}
    </div>
  );
}

export function Kpi({ label, value, hint }: { label: ReactNode; value: ReactNode; hint?: ReactNode }) {
  return (
    <div className="gx-kpi__item">
      <span className="gx-label">{label}</span>
      <span className="gx-kpi__value">{value}</span>
      {hint ? <span className="gx-kpi__hint">{hint}</span> : null}
    </div>
  );
}

/* ---------- 表单件 ---------- */

export function Field({ label, hint, children }: PropsWithChildren<{ label: ReactNode; hint?: ReactNode }>) {
  return (
    <label className="gx-field">
      <span>{label}</span>
      {children}
      {hint ? <span className="gx-card__hint">{hint}</span> : null}
    </label>
  );
}

export function Seg<T extends string | number>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label: ReactNode }[];
  onChange: (next: T) => void;
}) {
  return (
    <div className="gx-seg">
      {options.map((option) => (
        <button
          key={String(option.value)}
          type="button"
          className={option.value === value ? "is-active" : ""}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function Tabs<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label: ReactNode }[];
  onChange: (next: T) => void;
}) {
  return (
    <div className="gx-tabs">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className={`gx-tab${option.value === value ? " is-active" : ""}`}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/**
 * 候选项：平台在卖的一个模型。
 *
 * available 是「这台机器的上游此刻真的有它」，**只是标注**：没有也照选不误 ——
 * 主人完全可能在给一台登录态刚过期、或者还没装好 CLI 的机器先把规则填上。
 * 拿它去禁用选项就等于让一台临时抽风的机器改写了主人的长期设置。
 */
export interface ChipOption {
  value: string;
  label?: string;
  available?: boolean;
}

/**
 * 模式标签。收的是**通配模式**（claude-sonnet-*、*），所以必须保留自由输入 ——
 * 做成纯下拉会把这个能力废掉：候选项是平台在卖的那些模型（服务端按厂商给的，
 * 见 fetchModelOptions），而「把 opus 全系列划掉」这条规则一个候选项都对不上。
 *
 * 用 antd 的 tags 模式，不自己糊一个浮层：定位、外部点击、键盘上下键这几样
 * 自己实现不划算，而且要处理焦点陷阱（见本文件顶注 —— 浮层一律留给 antd）。
 */
export function ChipInput({
  values,
  onChange,
  placeholder,
  struck,
  options = [],
  availableLabel,
  emptyText,
}: {
  values: string[];
  onChange: (next: string[]) => void;
  placeholder: string;
  struck?: boolean;
  options?: ChipOption[];
  /** 「这台机器上真有」那个角标的文案。kit 里不引 i18n，文案一律由页面给。 */
  availableLabel?: string;
  /** 一个候选项都没有时下拉里的那句话。**照样能自己输入**，所以别写成「无数据」。 */
  emptyText?: string;
}) {
  return (
    <Select
      mode="tags"
      className={`gx-tags${struck ? " gx-tags--off" : ""}`}
      style={{ width: "100%" }}
      value={values}
      placeholder={placeholder}
      // 逗号也断词：从别处贴一串模型名过来是常事。
      tokenSeparators={[","]}
      // 标签上一律显示**填进去的那个值**，不显示模型的展示名：这两个框里的一行
      // 是一条规则，「claude-sonnet-*」和「Sonnet 5」不是一回事，显示后者就没法
      // 一眼看出自己填的是精确名还是通配。
      labelRender={(item) => String(item.value ?? "")}
      options={options.map((option) => ({
        value: option.value,
        label: option.label || option.value,
        available: option.available,
      }))}
      optionRender={(option) => {
        const data = option.data as ChipOption;
        const name = data.label || data.value;
        return (
          <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
            <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>
              <span style={{ fontFamily: "var(--gx-mono)", fontSize: 12.5 }}>{data.value}</span>
              {name === data.value ? null : (
                <span style={{ marginLeft: 8, fontSize: 12, color: "var(--gx-faint)" }}>{name}</span>
              )}
            </span>
            {data.available && availableLabel ? (
              <span className="gx-pill gx-pill--sm gx-pill--ok">{availableLabel}</span>
            ) : null}
          </div>
        );
      }}
      // 按模型名和展示名一起过滤。默认只认 label，而这里的 label 是展示名 ——
      // 敲 claude-son 搜不到 Sonnet 5 的话，候选项等于白给。
      filterOption={(input, option) => {
        const keyword = input.trim().toLowerCase();
        if (!keyword) return true;
        const data = (option ?? {}) as ChipOption;
        return `${data.value ?? ""} ${data.label ?? ""}`.toLowerCase().includes(keyword);
      }}
      notFoundContent={emptyText ?? null}
      onChange={(next: string[]) => onChange(cleanPatterns(next))}
    />
  );
}

/** 去空白、丢空串、去重。顺序保持主人填进去的样子。 */
function cleanPatterns(values: string[]): string[] {
  const out: string[] = [];
  for (const value of values) {
    const pattern = value.trim();
    if (pattern && !out.includes(pattern)) out.push(pattern);
  }
  return out;
}

/* ---------- 表格 ---------- */

export interface Column<Row> {
  key: string;
  title: ReactNode;
  width: string;
  align?: "right";
  render: (row: Row) => ReactNode;
}

export function DataTable<Row>({
  columns,
  rows,
  rowKey,
  onRowClick,
  empty,
  foot,
}: {
  columns: Column<Row>[];
  rows: Row[];
  rowKey: (row: Row) => string;
  onRowClick?: (row: Row) => void;
  empty: ReactNode;
  foot?: ReactNode;
}) {
  const template = columns.map((column) => column.width).join(" ");
  return (
    <div className="gx-table">
      <div className="gx-th" style={{ gridTemplateColumns: template }}>
        {columns.map((column) => (
          <span key={column.key} style={column.align === "right" ? { textAlign: "right" } : undefined}>
            {column.title}
          </span>
        ))}
      </div>
      <div className="gx-rows">
        {rows.length === 0 ? (
          <div className="gx-empty">{empty}</div>
        ) : (
          rows.map((row) => {
            const cells = columns.map((column) => (
              <span
                key={column.key}
                style={{
                  minWidth: 0,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  ...(column.align === "right" ? { textAlign: "right" as const } : {}),
                }}
              >
                {column.render(row)}
              </span>
            ));
            return onRowClick ? (
              <button
                key={rowKey(row)}
                type="button"
                className="gx-row"
                style={{ gridTemplateColumns: template }}
                onClick={() => onRowClick(row)}
              >
                {cells}
              </button>
            ) : (
              <div key={rowKey(row)} className="gx-row" style={{ gridTemplateColumns: template }}>
                {cells}
              </div>
            );
          })
        )}
      </div>
      {foot}
    </div>
  );
}

/**
 * 分页。页码之间省略成 …，因为 316 条记录会排出 32 个按钮，
 * 而真正会被点的只有前几页和最后一页。
 */
export function Pager({
  page,
  pageSize,
  total,
  onChange,
  summary,
}: {
  page: number;
  pageSize: number;
  total: number;
  onChange: (next: number) => void;
  summary: ReactNode;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const numbers: (number | "gap")[] = [];
  for (let index = 1; index <= pages; index += 1) {
    if (index <= 2 || index > pages - 1 || Math.abs(index - page) <= 1) numbers.push(index);
    else if (numbers[numbers.length - 1] !== "gap") numbers.push("gap");
  }
  return (
    <div className="gx-row__foot">
      <span>{summary}</span>
      <div className="gx-pager">
        <button type="button" disabled={page <= 1} onClick={() => onChange(page - 1)} aria-label="previous">
          ‹
        </button>
        {numbers.map((item, index) =>
          item === "gap" ? (
            // eslint-disable-next-line react/no-array-index-key
            <span key={`gap-${index}`} style={{ color: "var(--gx-faint)" }}>
              …
            </span>
          ) : (
            <button
              key={item}
              type="button"
              className={item === page ? "is-active" : ""}
              onClick={() => onChange(item)}
            >
              {item}
            </button>
          ),
        )}
        <button type="button" disabled={page >= pages} onClick={() => onChange(page + 1)} aria-label="next">
          ›
        </button>
      </div>
    </div>
  );
}

/* ---------- 提示与占位 ---------- */

export function Note({
  tone = "default",
  icon,
  children,
}: PropsWithChildren<{ tone?: "default" | "warn" | "danger"; icon?: ReactNode }>) {
  return (
    <div className={`gx-note${tone === "default" ? "" : ` gx-note--${tone}`}`}>
      <span style={{ flex: "0 0 auto", marginTop: 2 }}>{icon ?? <IconAlert size={15} />}</span>
      <span>{children}</span>
    </div>
  );
}

export function EmptyState({ title, hint, action }: { title: ReactNode; hint?: ReactNode; action?: ReactNode }) {
  return (
    <div className="gx-empty">
      <strong style={{ color: "var(--gx-soft)", fontWeight: 600 }}>{title}</strong>
      {hint ? <span>{hint}</span> : null}
      {action}
    </div>
  );
}

export function Loading() {
  return (
    <div className="gx-loading">
      <span
        aria-label="loading"
        style={{
          width: 22,
          height: 22,
          border: "2px solid var(--gx-line-strong)",
          borderTopColor: "var(--gx-accent)",
          borderRadius: "50%",
          animation: "gxSpin .8s linear infinite",
          display: "inline-block",
        }}
      />
    </div>
  );
}

/* ---------- 复制 ---------- */

/**
 * 复制按钮。成和败都弹一条提示。
 *
 * 光把图标换成勾不够：按钮小、勾就压在指针底下，点完那一下多半没看见，
 * 于是人会来回点好几次，始终不确定到底复制上没有。
 *
 * 提示收在这里而不是各个调用点：它得对每一个复制按钮都成立，
 * 交给调用点自己写的话，下一个加进来的按钮就会漏掉。
 */
export function CopyBtn({
  value,
  label,
  copied,
  onCopied,
  small = true,
}: {
  value: string;
  label: string;
  copied: boolean;
  onCopied: () => void;
  small?: boolean;
}) {
  const { t } = useLocale();
  return (
    <Btn
      tone="ghost"
      small={small}
      icon={copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          onCopied();
          message.success(t("common.copySuccess"));
        } catch {
          // 剪贴板被拒（无安全上下文、用户拒绝）时不改按钮状态，另外说明白：
          // 谎报"已复制"比什么都不显示更糟，明文密钥只显示这一次。
          message.error(t("common.copyFailed"));
        }
      }}
    >
      {label}
    </Btn>
  );
}
