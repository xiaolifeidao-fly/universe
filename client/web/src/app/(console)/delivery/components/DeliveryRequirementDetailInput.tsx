"use client";

import { Mentions, Tag } from "antd";
import { useMemo, type ReactNode } from "react";
import { useLocale } from "@/i18n/LocaleProvider";
import type { DeliveryItemRecord, DeliveryRequirementRecord } from "@/api/delivery.api";

/**
 * 需求详情里的 @ 引用：正文中就是 `@需求键` 或 `@任务键`，交互交给 antd Mentions —
 * 光标定位、候选浮层、输入法和键盘选择都由它处理；自己写的浮层会被右侧表单裁掉。
 * 引用的权威记录是需求表的 reference_requirement_keys / reference_item_keys，这段正文只是它的来源。
 */
const MENTION_RE = /@([A-Za-z0-9._-]{1,64})/g;

export interface RequirementMentionReference {
  kind: "requirement" | "task";
  key: string;
}

/**
 * 按正文出现顺序取出被 @ 的需求键，去重。
 * 给了 knownKeys 就只认这些键：正文里的邮箱、@某人不该被当成需求引用。
 */
export function requirementMentionKeys(detail: string, knownKeys?: string[]) {
  const keys: string[] = [];
  // matchAll 的迭代器要更高的编译目标，这里直接用带 g 标记的 exec 循环。
  const pattern = new RegExp(MENTION_RE.source, "g");
  let match = pattern.exec(detail);
  while (match) {
    const key = match[1];
    if (!keys.includes(key) && (!knownKeys || knownKeys.includes(key))) keys.push(key);
    match = pattern.exec(detail);
  }
  return keys;
}

/** 按正文顺序识别需求和任务两类关联；键冲突时优先按需求处理。 */
export function requirementMentionReferences(
  detail: string,
  requirements: DeliveryRequirementRecord[],
  items: DeliveryItemRecord[],
): RequirementMentionReference[] {
  const requirementKeys = new Set(requirements.map((requirement) => requirement.requirementKey));
  const itemKeys = new Set(items.map((item) => item.itemKey));
  const references: RequirementMentionReference[] = [];
  const seen = new Set<string>();
  const pattern = new RegExp(MENTION_RE.source, "g");
  let match = pattern.exec(detail);

  while (match) {
    const key = match[1];
    const kind = requirementKeys.has(key) ? "requirement" : itemKeys.has(key) ? "task" : null;
    if (kind && !seen.has(`${kind}:${key}`)) {
      seen.add(`${kind}:${key}`);
      references.push({ kind, key });
    }
    match = pattern.exec(detail);
  }
  return references;
}

/** 只读展示用：把 `@需求键` 还原成 `@需求名`，别让需求键原文出现在需求卡片上。 */
export function requirementMentionPlainText(detail: string, nameByKey: Map<string, string>) {
  return detail.replace(new RegExp(MENTION_RE.source, "g"), (token, key: string) => {
    const name = nameByKey.get(key);
    return name ? `@${name}` : token;
  });
}

interface DeliveryRequirementDetailInputProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  /** 可被 @ 的候选需求；调用方负责排除当前正在编辑的这一条。 */
  requirements: DeliveryRequirementRecord[];
  /** 可被 @ 的既有任务。 */
  items: DeliveryItemRecord[];
}

export function DeliveryRequirementDetailInput({
  value,
  onChange,
  placeholder,
  requirements,
  items,
}: DeliveryRequirementDetailInputProps) {
  const { t } = useLocale();

  interface MentionOption {
    value: string;
    label: ReactNode;
    searchText: string;
  }

  const options = useMemo<MentionOption[]>(() => {
    const requirementKeys = new Set(requirements.map((requirement) => requirement.requirementKey));
    const requirementOptions = requirements.map((requirement) => ({
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
    const itemOptions = items
      .filter((item) => !requirementKeys.has(item.itemKey))
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
  }, [items, requirements, t]);

  const mentioned = useMemo(() => {
    const nameByKey = new Map(requirements.map((requirement) => [requirement.requirementKey, requirement.name]));
    const titleByKey = new Map(items.map((item) => [item.itemKey, item.title]));
    return requirementMentionReferences(value, requirements, items).map((reference) => ({
      ...reference,
      label: reference.kind === "requirement"
        ? nameByKey.get(reference.key) || reference.key
        : titleByKey.get(reference.key) || reference.key,
    }));
  }, [items, requirements, value]);

  return (
    <div className="delivery-requirement-detail">
      <Mentions
        autoSize={{ minRows: 3, maxRows: 8 }}
        value={value}
        placeholder={placeholder}
        prefix="@"
        notFoundContent={t("delivery.requirement.mentionEmpty")}
        options={options}
        filterOption={(input, option) => {
          const text = input.trim().toLowerCase();
          if (!text) return true;
          const searchText = String((option as MentionOption | undefined)?.searchText ?? "");
          return searchText.includes(text);
        }}
        onChange={onChange}
      />
      {/* 正文里存的是业务键，读起来不直观，选过的引用在下面用名称回显。 */}
      <div className="delivery-requirement-mention-tags">
        <small>{t("delivery.requirement.mentionHint")}</small>
        {mentioned.map((reference) => (
          <Tag color={reference.kind === "requirement" ? "blue" : "cyan"} key={`${reference.kind}:${reference.key}`}>
            {t(`delivery.chatMention.${reference.kind}`)}: {reference.label}
          </Tag>
        ))}
      </div>
    </div>
  );
}
