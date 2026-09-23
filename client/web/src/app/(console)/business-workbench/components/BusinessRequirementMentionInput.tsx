"use client";

import { ClearOutlined, FileTextOutlined } from "@ant-design/icons";
import { Button, Mentions, Spin, Tag, Tooltip, message } from "antd";
import { useEffect, useRef, useState, type ClipboardEvent as ReactClipboardEvent, type KeyboardEvent as ReactKeyboardEvent } from "react";
import type { MentionsRef } from "rc-mentions/lib/Mentions";
import type { OptionProps } from "rc-mentions/lib/Option";
import { useLocale } from "@/i18n/LocaleProvider";
import { useImeCompositionGuard } from "@/utils/ime";
import type { BusinessDocumentReference } from "@/api/businessRequirement.api";

/**
 * rc-mentions 选中后会把 `@value` 连同一个分隔空格写进正文。业务方要的是
 * 「引用了哪份文档」，不是正文里多出一串 id，所以这里把插入的 token 原样撤掉，
 * 引用改用输入框下方的标签承载 —— 和需求编辑聊天的 @ 完全一致的做法。
 */
function removeInsertedMention(value: string, mention: string) {
  const start = value.lastIndexOf(mention);
  if (start < 0) return { value, caret: value.length };
  const after = value.slice(start + mention.length);
  return {
    value: `${value.slice(0, start)}${after.startsWith(" ") ? after.slice(1) : after}`,
    caret: start,
  };
}

interface MentionOption {
  value: string;
  label: React.ReactNode;
  searchText: string;
  documentId?: number;
  disabled?: boolean;
}

/**
 * 业务访谈聊天框的 @ 选择器：可以引用同一项目下其它访谈已经整理出的文档。
 *
 * 业务方常常在新会话里重复讲上一次已经说清楚的背景。让他 @ 一份既有文档，
 * 服务端在发送时把正文作为「既有资料」注入提示词，比让人再复述一遍可靠。
 */
export function BusinessRequirementMentionInput({
  value,
  onChange,
  onPaste,
  onPressEnter,
  placeholder,
  disabled,
  maxReferences,
  references,
  onReferencesChange,
  onSearchCandidates,
}: {
  value: string;
  onChange: (value: string) => void;
  onPaste?: (event: ReactClipboardEvent<HTMLTextAreaElement>) => void;
  onPressEnter?: (event: ReactKeyboardEvent<HTMLTextAreaElement>) => void;
  placeholder?: string;
  disabled?: boolean;
  maxReferences: number;
  references: BusinessDocumentReference[];
  onReferencesChange: (references: BusinessDocumentReference[]) => void;
  /** 输入 @ 时按关键字取候选；面板打开时先用空关键字取最近的一批。 */
  onSearchCandidates: (keyword: string) => Promise<BusinessDocumentReference[]>;
}) {
  const { t } = useLocale();
  const containerRef = useRef<HTMLDivElement>(null);
  const mentionsRef = useRef<MentionsRef>(null);
  const { compositionProps, isComposingEnter } = useImeCompositionGuard();
  const latestValueRef = useRef(value);
  latestValueRef.current = value;
  const referencesRef = useRef(references);
  referencesRef.current = references;
  const [candidates, setCandidates] = useState<BusinessDocumentReference[]>([]);
  const [search, setSearch] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // 候选完全由服务端按项目范围给出，本地不缓存全量：一个项目的历史访谈可以很多，
  // 而 @ 面板一次只需要最近或命中关键字的那二十条。
  useEffect(() => {
    if (search === null) return undefined;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      setLoading(true);
      void onSearchCandidates(search.trim())
        .then((rows) => {
          if (!cancelled) setCandidates(rows);
        })
        .catch((error) => {
          // 取候选失败不该打断正在输入的消息，但也不能装成「没有文档」：
          // 接口挂了和这个项目确实没有历史文档，看起来会是同一个空面板。
          if (cancelled) return;
          setCandidates([]);
          message.error((error as Error).message);
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, search.trim() ? 250 : 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [onSearchCandidates, search]);

  const full = references.length >= maxReferences;
  const selected = new Set(references.map((reference) => reference.documentId));
  const options: MentionOption[] = candidates
    .filter((candidate) => !selected.has(candidate.documentId))
    .map((candidate) => ({
      value: `doc-${candidate.documentId}`,
      documentId: candidate.documentId,
      searchText: `${candidate.requirementTitle} ${candidate.title}`.toLowerCase(),
      label: (
        <span className="delivery-conversation-mention-option is-file">
          <FileTextOutlined />
          <span>{candidate.requirementTitle || candidate.title}</span>
          {/* 一场访谈只有一份文档，标题之外不再标版本号。 */}
          <small>{candidate.title}</small>
        </span>
      ),
    }));

  const updateReferences = (next: BusinessDocumentReference[]) => {
    referencesRef.current = next;
    onReferencesChange(next);
  };

  const onSelect = (selectedOption: OptionProps, prefix: string) => {
    const option = selectedOption as MentionOption;
    const candidate = candidates.find((row) => row.documentId === option.documentId);
    // 撤掉插入的 token 必须无条件执行：即使因为超限没能加上引用，
    // 正文里也不该留下一个 `@doc-12`。
    const next = removeInsertedMention(latestValueRef.current, `${prefix}${option.value}`);
    latestValueRef.current = next.value;
    onChange(next.value);
    window.requestAnimationFrame(() => {
      const textarea = mentionsRef.current?.textarea;
      if (!textarea) return;
      const caret = Math.min(next.caret, textarea.value.length);
      textarea.setSelectionRange(caret, caret);
    });
    if (!candidate || referencesRef.current.some((row) => row.documentId === candidate.documentId)) return;
    if (referencesRef.current.length >= maxReferences) return;
    updateReferences([...referencesRef.current, candidate]);
  };

  return (
    <div className="delivery-conversation-mention-input" ref={containerRef} {...compositionProps}>
      <Mentions
        ref={mentionsRef}
        autoSize={{ minRows: 2, maxRows: 6 }}
        value={value}
        prefix="@"
        placement="top"
        popupClassName="business-mention-dropdown"
        getPopupContainer={() => containerRef.current ?? document.body}
        placeholder={placeholder}
        disabled={disabled}
        options={full ? [] : options}
        notFoundContent={
          <div className="delivery-conversation-mention-empty">
            {loading ? <Spin size="small" /> : t(full ? "businessMention.full" : "businessMention.empty").replace("{max}", String(maxReferences))}
          </div>
        }
        // 过滤在服务端按项目范围做，本地再过一次只会把刚取回的候选筛掉。
        filterOption={false}
        onSearch={setSearch}
        onChange={(nextValue) => {
          latestValueRef.current = nextValue;
          onChange(nextValue);
        }}
        onSelect={onSelect}
        onPaste={onPaste}
        onPressEnter={(event) => {
          // 输入法用回车确认候选词，这一下不能当成发送。
          if (isComposingEnter(event)) return;
          onPressEnter?.(event);
        }}
      />
      {references.length ? (
        <div className="delivery-conversation-mention-tags">
          {references.map((reference) => (
            <Tag
              closable={!disabled}
              color="purple"
              key={reference.documentId}
              title={`${reference.requirementTitle} · ${reference.title}`}
              onClose={() => updateReferences(referencesRef.current.filter((row) => row.documentId !== reference.documentId))}
            >
              {t("businessMention.document")}: {reference.requirementTitle || reference.title}
            </Tag>
          ))}
          <Tooltip title={t("businessMention.clearAll")}>
            <Button
              aria-label={t("businessMention.clearAll")}
              className="delivery-conversation-mention-tags__clear"
              disabled={disabled}
              icon={<ClearOutlined />}
              onClick={() => updateReferences([])}
              size="small"
              type="text"
            />
          </Tooltip>
        </div>
      ) : null}
    </div>
  );
}
