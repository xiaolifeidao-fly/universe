"use client";

import { EnterOutlined, SearchOutlined } from "@ant-design/icons";
import { Modal } from "antd";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { useLocale } from "@/i18n/LocaleProvider";

export type PaletteEntry = {
  key: string;
  label: string;
  /** 所属分组，同时参与搜索 —— 输「风控」能把那一组都找出来。 */
  group: string;
  icon?: ReactNode;
  /** 有 href 的是页面，没有的是动作（run）。 */
  href?: string;
  run?: () => void;
  hint?: string;
};

/**
 * ⌘K 命令面板：跳页面 + 几个全局动作。
 *
 * 管理端有三十来个页面、两层菜单，常用的那几页每次都要先找它在哪一组底下。
 * 面板把「找」换成「打两个字」：按名称、分组、路由都能搜，回车直达。
 * 没输入时排在最前面的是最近去过的页面 —— 来回切换的往往就是那三四页。
 */
export function CommandPalette({
  open,
  onClose,
  entries,
  recent,
  onNavigate,
}: {
  open: boolean;
  onClose: () => void;
  entries: PaletteEntry[];
  recent: string[];
  onNavigate: (href: string) => void;
}) {
  const { t } = useLocale();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActive(0);
    // Modal 的入场动画结束前 focus 会被它自己抢走，挪到下一帧。
    const timer = window.setTimeout(() => inputRef.current?.focus(), 30);
    return () => window.clearTimeout(timer);
  }, [open]);

  const sections = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) {
      const byHref = new Map(entries.filter((e) => e.href).map((e) => [e.href!, e]));
      const recentEntries = recent.map((href) => byHref.get(href)).filter((e): e is PaletteEntry => Boolean(e)).slice(0, 5);
      const recentKeys = new Set(recentEntries.map((e) => e.key));
      const rest = entries.filter((e) => !recentKeys.has(e.key));
      const byGroup = new Map<string, PaletteEntry[]>();
      for (const entry of rest) byGroup.set(entry.group, [...(byGroup.get(entry.group) ?? []), entry]);
      const groups = Array.from(byGroup, ([title, items]) => ({ title, items }));
      return recentEntries.length ? [{ title: t("palette.recent"), items: recentEntries }, ...groups] : groups;
    }
    const scored = entries
      .map((entry) => ({ entry, score: score(entry, q) }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((item) => item.entry);
    return scored.length ? [{ title: t("palette.results"), items: scored }] : [];
  }, [entries, query, recent, t]);

  const flat = useMemo(() => sections.flatMap((section) => section.items), [sections]);

  useEffect(() => {
    setActive(0);
  }, [query]);

  useEffect(() => {
    const node = listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`);
    node?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const choose = (entry: PaletteEntry | undefined) => {
    if (!entry) return;
    onClose();
    if (entry.href) onNavigate(entry.href);
    else entry.run?.();
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "ArrowDown" || (event.ctrlKey && event.key === "n")) {
      event.preventDefault();
      setActive((index) => (flat.length ? (index + 1) % flat.length : 0));
    } else if (event.key === "ArrowUp" || (event.ctrlKey && event.key === "p")) {
      event.preventDefault();
      setActive((index) => (flat.length ? (index - 1 + flat.length) % flat.length : 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      choose(flat[active]);
    }
  };

  let index = -1;
  return (
    <Modal
      open={open}
      onCancel={onClose}
      footer={null}
      closable={false}
      width={600}
      rootClassName="manager-palette-root"
      className="manager-palette"
      styles={{ content: { padding: 0 } }}
      style={{ top: "14vh" }}
      destroyOnHidden
      transitionName="manager-palette-zoom"
      maskTransitionName="ant-fade"
    >
      <div className="manager-palette-search" onKeyDown={onKeyDown}>
        <SearchOutlined />
        <input
          ref={inputRef}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t("palette.placeholder")}
          aria-label={t("palette.placeholder")}
          spellCheck={false}
          autoComplete="off"
        />
        <kbd>Esc</kbd>
      </div>
      <div className="manager-palette-list" ref={listRef} role="listbox">
        {sections.length === 0 ? (
          <div className="manager-palette-empty">
            <SearchOutlined />
            <span>{t("palette.empty")}</span>
          </div>
        ) : (
          sections.map((section) => (
            <div key={section.title} className="manager-palette-section">
              <div className="manager-palette-section-title">{section.title}</div>
              {section.items.map((entry) => {
                index += 1;
                const current = index;
                const selected = current === active;
                return (
                  <button
                    key={`${section.title}:${entry.key}`}
                    type="button"
                    role="option"
                    aria-selected={selected}
                    data-index={current}
                    className={`manager-palette-item${selected ? " is-active" : ""}`}
                    onMouseMove={() => current !== active && setActive(current)}
                    onClick={() => choose(entry)}
                  >
                    <span className="manager-palette-item-icon">{entry.icon}</span>
                    <span className="manager-palette-item-label">{entry.label}</span>
                    {entry.hint || (query && entry.group) ? (
                      <span className="manager-palette-item-hint">{entry.hint ?? entry.group}</span>
                    ) : null}
                    <EnterOutlined className="manager-palette-item-enter" />
                  </button>
                );
              })}
            </div>
          ))
        )}
      </div>
      <div className="manager-palette-foot">
        <span>
          <kbd>↑</kbd>
          <kbd>↓</kbd> {t("palette.move")}
        </span>
        <span>
          <kbd>↵</kbd> {t("palette.open")}
        </span>
        <span>
          <kbd>Esc</kbd> {t("palette.close")}
        </span>
      </div>
    </Modal>
  );
}

/** 朴素的打分：整词前缀 > 包含 > 子序列。够用，几十条也不需要更复杂的东西。 */
function score(entry: PaletteEntry, q: string) {
  const label = entry.label.toLowerCase();
  const haystack = `${label} ${entry.group.toLowerCase()} ${(entry.href ?? "").toLowerCase()}`;
  if (label.startsWith(q)) return 100 - label.length * 0.1;
  if (label.includes(q)) return 80 - label.indexOf(q);
  if (haystack.includes(q)) return 50;
  let at = 0;
  for (const ch of q) {
    at = haystack.indexOf(ch, at);
    if (at < 0) return 0;
    at += 1;
  }
  return 10;
}
