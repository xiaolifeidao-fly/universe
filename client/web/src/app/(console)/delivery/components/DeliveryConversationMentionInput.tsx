"use client";

import { ClearOutlined, FileTextOutlined } from "@ant-design/icons";
import { Button, Mentions, Tag, Tooltip } from "antd";
import { useEffect, useMemo, useRef, useState, type ClipboardEvent as ReactClipboardEvent, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import type { MentionsRef } from "rc-mentions/lib/Mentions";
import type { OptionProps } from "rc-mentions/lib/Option";
import { useLocale } from "@/i18n/LocaleProvider";
import type {
  DeliveryConversationReference,
  DeliveryConversationFileScope,
  DeliveryItemRecord,
  DeliveryRequirementRecord,
} from "@/api/delivery.api";

interface MentionOption {
  value: string;
  label: ReactNode;
  searchText: string;
  referenceKind?: DeliveryConversationReference["kind"];
  referenceKey?: string;
  referenceScope?: DeliveryConversationFileScope;
  disabled?: boolean;
}

export interface DeliveryConversationMentionFile {
  path: string;
  name: string;
  scope: DeliveryConversationFileScope;
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
  /** 仅需求编辑聊天传入；传入后 @ 面板显示“需求 / 文件”双 Tab。 */
  files?: DeliveryConversationMentionFile[];
  references: DeliveryConversationReference[];
  onReferencesChange: (references: DeliveryConversationReference[]) => void;
  /** 本地最近 20 条都未命中时才调用，避免每次输入都访问服务端。 */
  onSearchCandidates?: (keyword: string) => Promise<DeliveryConversationMentionCatalog>;
}

/** 聊天中的 @ 选择器：需求编辑聊天按“需求 / 文件”分栏，任务聊天保持原有对象目录。 */
export function DeliveryConversationMentionInput({
  value,
  onChange,
  onPaste,
  onPressEnter,
  placeholder,
  disabled,
  requirements,
  items,
  files,
  references,
  onReferencesChange,
  onSearchCandidates,
}: DeliveryConversationMentionInputProps) {
  const { t } = useLocale();
  const containerRef = useRef<HTMLDivElement>(null);
  const mentionsRef = useRef<MentionsRef>(null);
  const latestValueRef = useRef(value);
  latestValueRef.current = value;
  const referencesRef = useRef(references);
  referencesRef.current = references;
  const selectedLabelsRef = useRef(new Map<string, string>());
  const [mentionSearch, setMentionSearch] = useState("");
  const [activeTab, setActiveTab] = useState<"requirement" | "file">("file");
  const [remoteCatalog, setRemoteCatalog] = useState<DeliveryConversationMentionCatalog | null>(null);
  const normalizedSearch = mentionSearch.trim().toLowerCase();
  const localSearchMatched = useMemo(() => {
    if (!normalizedSearch) return true;
    return requirements.some((requirement) => `${requirement.name} ${requirement.requirementKey}`.toLowerCase().includes(normalizedSearch))
      || items.some((item) => `${item.title} ${item.itemKey}`.toLowerCase().includes(normalizedSearch));
  }, [items, normalizedSearch, requirements]);

  useEffect(() => {
    if (activeTab === "file" || !onSearchCandidates || !normalizedSearch || localSearchMatched) {
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
  }, [activeTab, localSearchMatched, mentionSearch, normalizedSearch, onSearchCandidates]);

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
  const fileCandidates = useMemo(() => files ?? [], [files]);
  const fileTabEnabled = files !== undefined;
  const options = useMemo<MentionOption[]>(() => {
    const selectedReferences = new Set(references.map((reference) => `${reference.kind}:${reference.key}`));
    const requirementKeys = new Set(candidateRequirements.map((requirement) => requirement.requirementKey));
    const requirementOptions = candidateRequirements
      .filter((requirement) => !selectedReferences.has(`requirement:${requirement.requirementKey}`))
      .map((requirement) => ({
      value: `requirement:${requirement.requirementKey}`,
      searchText: `${requirement.name} ${requirement.requirementKey}`.toLowerCase(),
      referenceKind: "requirement" as const,
      referenceKey: requirement.requirementKey,
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
        value: `task:${item.itemKey}`,
        searchText: `${item.title} ${item.itemKey}`.toLowerCase(),
        referenceKind: "task" as const,
        referenceKey: item.itemKey,
        label: (
          <span className="delivery-conversation-mention-option">
            <b>{t("delivery.chatMention.task")}</b>
            <span>{item.title || item.itemKey}</span>
            <small>{item.itemKey}</small>
          </span>
        ),
      }));
    const fileOptions = fileCandidates
      .filter((file) => !selectedReferences.has(`file:${file.path}`))
      .map((file) => ({
        value: `file:${file.scope}:${file.path}`,
        searchText: `${file.name} ${file.path}`.toLowerCase(),
        referenceKind: "file" as const,
        referenceKey: file.path,
        referenceScope: file.scope,
        label: (
          <span className="delivery-conversation-mention-option is-file">
            <FileTextOutlined />
            <span>{file.name || file.path}</span>
            <small>{file.path}</small>
          </span>
        ),
      }));
    const tabOption: MentionOption = {
      value: "__reference_tabs__",
      searchText: "",
      disabled: true,
      label: (
        <div className="delivery-conversation-mention-tabs" role="tablist" aria-label={t("delivery.chatMention.tabsLabel")}>
          {(["file", "requirement"] as const).map((tab) => (
            <button
              aria-selected={activeTab === tab}
              className={activeTab === tab ? "is-active" : ""}
              key={tab}
              onMouseDown={(event) => {
                event.preventDefault();
                event.stopPropagation();
                setActiveTab(tab);
              }}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                setActiveTab(tab);
              }}
              role="tab"
              type="button"
            >
              {t(`delivery.chatMention.tab.${tab}`)}
            </button>
          ))}
        </div>
      ),
    };
    const visibleOptions = activeTab === "file" ? fileOptions : [...requirementOptions, ...itemOptions];
    const emptyOption: MentionOption = {
      value: "__reference_empty__",
      searchText: "",
      disabled: true,
      label: (
        <div className="delivery-conversation-mention-empty">
          {t(activeTab === "file" ? "delivery.chatMention.fileEmpty" : "delivery.chatMention.empty")}
        </div>
      ),
    };
    return fileTabEnabled
      ? [tabOption, ...(visibleOptions.length ? visibleOptions : [emptyOption])]
      : visibleOptions;
  }, [activeTab, candidateItems, candidateRequirements, fileCandidates, fileTabEnabled, references, t]);

  const referencedLabels = useMemo(() => {
    const requirementNames = new Map(candidateRequirements.map((requirement) => [requirement.requirementKey, requirement.name]));
    const itemTitles = new Map(candidateItems.map((item) => [item.itemKey, item.title]));
    const fileNames = new Map(fileCandidates.map((file) => [file.path, file.name]));
    return references.map((reference) => ({
      ...reference,
      label: reference.kind === "requirement"
        ? requirementNames.get(reference.key) || selectedLabelsRef.current.get(`requirement:${reference.key}`) || reference.key
        : reference.kind === "task"
          ? itemTitles.get(reference.key) || selectedLabelsRef.current.get(`task:${reference.key}`) || reference.key
          : fileNames.get(reference.key) || selectedLabelsRef.current.get(`file:${reference.key}`) || reference.key,
    }));
  }, [candidateItems, candidateRequirements, fileCandidates, references]);

  const updateReferences = (nextReferences: DeliveryConversationReference[]) => {
    referencesRef.current = nextReferences;
    onReferencesChange(nextReferences);
  };

  const onSelect = (selectedOption: OptionProps, prefix: string) => {
    const option = selectedOption as MentionOption;
    const kind = option.referenceKind;
    const key = String(option.referenceKey ?? "").trim();
    if (!kind || !key) return;

    if (!referencesRef.current.some((reference) => reference.kind === kind && reference.key === key)) {
      const label = kind === "requirement"
        ? candidateRequirements.find((requirement) => requirement.requirementKey === key)?.name
        : kind === "task"
          ? candidateItems.find((item) => item.itemKey === key)?.title
          : fileCandidates.find((file) => file.path === key)?.name;
      selectedLabelsRef.current.set(`${kind}:${key}`, label || key);
      updateReferences([...referencesRef.current, {
        kind,
        key,
        ...(kind === "file" && option.referenceScope ? { scope: option.referenceScope } : {}),
      }]);
    }

    const next = removeInsertedMention(latestValueRef.current, `${prefix}${option.value}`);
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
    <div className="delivery-conversation-mention-input" ref={containerRef}>
      <Mentions
        ref={mentionsRef}
        autoSize={{ minRows: 3, maxRows: 7 }}
        value={value}
        prefix="@"
        placement="top"
        popupClassName="delivery-conversation-mention-dropdown"
        getPopupContainer={() => containerRef.current ?? document.body}
        placeholder={placeholder}
        disabled={disabled}
        options={options}
        notFoundContent={t(activeTab === "file" ? "delivery.chatMention.fileEmpty" : "delivery.chatMention.empty")}
        filterOption={(input, option) => {
          const searchText = String((option as MentionOption | undefined)?.searchText ?? "");
          return ["__reference_tabs__", "__reference_empty__"].includes(String((option as MentionOption | undefined)?.value ?? ""))
            || !input.trim()
            || searchText.includes(input.trim().toLowerCase());
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
              color={reference.kind === "requirement" ? "blue" : reference.kind === "task" ? "cyan" : "purple"}
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
