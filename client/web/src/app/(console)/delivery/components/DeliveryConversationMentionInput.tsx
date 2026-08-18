"use client";

import { ClearOutlined } from "@ant-design/icons";
import { Button, Mentions, Tag, Tooltip } from "antd";
import { useEffect, useMemo, useRef, useState, type ClipboardEvent as ReactClipboardEvent, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import type { MentionsRef } from "rc-mentions/lib/Mentions";
import { useLocale } from "@/i18n/LocaleProvider";
import type {
  DeliveryConversationReference,
  DeliveryItemRecord,
  DeliveryRequirementRecord,
} from "@/api/delivery.api";

interface MentionOption {
  value: string;
  label: ReactNode;
  searchText: string;
}

export interface DeliveryConversationMentionCatalog {
  requirements: DeliveryRequirementRecord[];
  items: DeliveryItemRecord[];
}

function removeInsertedMention(value: string, mention: string) {
  const start = value.lastIndexOf(mention);
  if (start < 0) return { value, caret: value.length };
  const afterMention = start + mention.length;
  // rc-mentions 会在选中项后补上 split（默认是空格）；连同该空格移除，正文不会多出一个空白字符。
  const after = value.slice(afterMention);
  return {
    value: `${value.slice(0, start)}${after.startsWith(" ") ? after.slice(1) : after}`,
    caret: start,
  };
}

interface DeliveryConversationMentionInputProps {
  value: string;
  onChange: (value: string) => void;
  onPaste?: (event: ReactClipboardEvent<HTMLTextAreaElement>) => void;
  onPressEnter?: (event: ReactKeyboardEvent<HTMLTextAreaElement>) => void;
  placeholder?: string;
  disabled?: boolean;
  requirements: DeliveryRequirementRecord[];
  items: DeliveryItemRecord[];
  references: DeliveryConversationReference[];
  onReferencesChange: (references: DeliveryConversationReference[]) => void;
  /** 本地最近 20 条都未命中时才调用，避免每次输入都访问服务端。 */
  onSearchCandidates?: (keyword: string) => Promise<DeliveryConversationMentionCatalog>;
}

/** 聊天中的 @ 选择器：候选和当前已关联对象都同时展示需求、任务两种实体。 */
export function DeliveryConversationMentionInput({
  value,
  onChange,
  onPaste,
  onPressEnter,
  placeholder,
  disabled,
  requirements,
  items,
  references,
  onReferencesChange,
  onSearchCandidates,
}: DeliveryConversationMentionInputProps) {
  const { t } = useLocale();
  const mentionsRef = useRef<MentionsRef>(null);
  const latestValueRef = useRef(value);
  latestValueRef.current = value;
  const referencesRef = useRef(references);
  referencesRef.current = references;
  const selectedLabelsRef = useRef(new Map<string, string>());
  const [mentionSearch, setMentionSearch] = useState("");
  const [remoteCatalog, setRemoteCatalog] = useState<DeliveryConversationMentionCatalog | null>(null);
  const normalizedSearch = mentionSearch.trim().toLowerCase();
  const localSearchMatched = useMemo(() => {
    if (!normalizedSearch) return true;
    return requirements.some((requirement) => `${requirement.name} ${requirement.requirementKey}`.toLowerCase().includes(normalizedSearch))
      || items.some((item) => `${item.title} ${item.itemKey}`.toLowerCase().includes(normalizedSearch));
  }, [items, normalizedSearch, requirements]);

  useEffect(() => {
    if (!onSearchCandidates || !normalizedSearch || localSearchMatched) {
      setRemoteCatalog(null);
      return undefined;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void onSearchCandidates(mentionSearch.trim())
        .then((catalog) => {
          if (!cancelled) setRemoteCatalog(catalog);
        })
        .catch(() => {
          // 搜索候选失败不影响已加载的 20 条本地候选，输入框仍保持可用。
          if (!cancelled) setRemoteCatalog(null);
        });
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [localSearchMatched, mentionSearch, normalizedSearch, onSearchCandidates]);

  const candidateRequirements = useMemo(() => {
    const byKey = new Map(requirements.map((requirement) => [requirement.requirementKey, requirement]));
    (remoteCatalog?.requirements ?? []).forEach((requirement) => byKey.set(requirement.requirementKey, requirement));
    return Array.from(byKey.values());
  }, [remoteCatalog?.requirements, requirements]);
  const candidateItems = useMemo(() => {
    const byKey = new Map(items.map((item) => [item.itemKey, item]));
    (remoteCatalog?.items ?? []).forEach((item) => byKey.set(item.itemKey, item));
    return Array.from(byKey.values());
  }, [items, remoteCatalog?.items]);
  const options = useMemo<MentionOption[]>(() => {
    const selectedReferences = new Set(references.map((reference) => `${reference.kind}:${reference.key}`));
    const requirementKeys = new Set(candidateRequirements.map((requirement) => requirement.requirementKey));
    const requirementOptions = candidateRequirements
      .filter((requirement) => !selectedReferences.has(`requirement:${requirement.requirementKey}`))
      .map((requirement) => ({
      value: requirement.requirementKey,
      searchText: `${requirement.name} ${requirement.requirementKey}`.toLowerCase(),
      label: (
        <span className="delivery-conversation-mention-option">
          <b>{t("delivery.chatMention.requirement")}</b>
          <span>{requirement.name || requirement.requirementKey}</span>
          <small>{requirement.requirementKey}</small>
        </span>
      ),
      }));
    const itemOptions = candidateItems
      // 键碰撞的旧数据按需求处理，避免一条正文 token 解析出两个对象。
      .filter((item) => !requirementKeys.has(item.itemKey) && !selectedReferences.has(`task:${item.itemKey}`))
      .map((item) => ({
        value: item.itemKey,
        searchText: `${item.title} ${item.itemKey}`.toLowerCase(),
        label: (
          <span className="delivery-conversation-mention-option">
            <b>{t("delivery.chatMention.task")}</b>
            <span>{item.title || item.itemKey}</span>
            <small>{item.itemKey}</small>
          </span>
        ),
      }));
    return [...requirementOptions, ...itemOptions];
  }, [candidateItems, candidateRequirements, references, t]);

  const referencedLabels = useMemo(() => {
    const requirementNames = new Map(candidateRequirements.map((requirement) => [requirement.requirementKey, requirement.name]));
    const itemTitles = new Map(candidateItems.map((item) => [item.itemKey, item.title]));
    return references.map((reference) => ({
      ...reference,
      label: reference.kind === "requirement"
        ? requirementNames.get(reference.key) || selectedLabelsRef.current.get(`requirement:${reference.key}`) || reference.key
        : itemTitles.get(reference.key) || selectedLabelsRef.current.get(`task:${reference.key}`) || reference.key,
    }));
  }, [candidateItems, candidateRequirements, references]);

  const updateReferences = (nextReferences: DeliveryConversationReference[]) => {
    referencesRef.current = nextReferences;
    onReferencesChange(nextReferences);
  };

  const onSelect = (option: { value?: string }, prefix: string) => {
    const key = String(option.value ?? "").trim();
    const requirementKeys = new Set(candidateRequirements.map((requirement) => requirement.requirementKey));
    const itemKeys = new Set(candidateItems.map((item) => item.itemKey));
    // 键碰撞的旧数据按需求处理，候选构建时也遵循同一优先级。
    const kind = requirementKeys.has(key) ? "requirement" : itemKeys.has(key) ? "task" : null;
    if (!kind) return;

    if (!referencesRef.current.some((reference) => reference.kind === kind && reference.key === key)) {
      const label = kind === "requirement"
        ? candidateRequirements.find((requirement) => requirement.requirementKey === key)?.name
        : candidateItems.find((item) => item.itemKey === key)?.title;
      selectedLabelsRef.current.set(`${kind}:${key}`, label || key);
      updateReferences([...referencesRef.current, { kind, key }]);
    }

    const next = removeInsertedMention(latestValueRef.current, `${prefix}${key}`);
    latestValueRef.current = next.value;
    onChange(next.value);
    window.requestAnimationFrame(() => {
      const textarea = mentionsRef.current?.textarea;
      if (!textarea) return;
      const caret = Math.min(next.caret, textarea.value.length);
      textarea.setSelectionRange(caret, caret);
    });
  };

  return (
    <div className="delivery-conversation-mention-input">
      <Mentions
        ref={mentionsRef}
        autoSize={{ minRows: 3, maxRows: 7 }}
        value={value}
        prefix="@"
        placeholder={placeholder}
        disabled={disabled}
        options={options}
        notFoundContent={t("delivery.chatMention.empty")}
        filterOption={(input, option) => {
          const searchText = String((option as MentionOption | undefined)?.searchText ?? "");
          return !input.trim() || searchText.includes(input.trim().toLowerCase());
        }}
        onSearch={(searchText) => setMentionSearch(searchText)}
        onChange={(nextValue) => {
          latestValueRef.current = nextValue;
          onChange(nextValue);
        }}
        onSelect={onSelect}
        onPaste={onPaste}
        onPressEnter={onPressEnter}
      />
      {referencedLabels.length ? (
        <div className="delivery-conversation-mention-tags">
          {referencedLabels.map((reference) => (
            <Tag
              closable={!disabled}
              color={reference.kind === "requirement" ? "blue" : "cyan"}
              key={`${reference.kind}:${reference.key}`}
              onClose={() => updateReferences(referencesRef.current.filter((current) => current.kind !== reference.kind || current.key !== reference.key))}
            >
              {t(`delivery.chatMention.${reference.kind}`)}: {reference.label}
            </Tag>
          ))}
          <Tooltip title={t("delivery.chatMention.clearAll")}>
            <Button
              aria-label={t("delivery.chatMention.clearAll")}
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
