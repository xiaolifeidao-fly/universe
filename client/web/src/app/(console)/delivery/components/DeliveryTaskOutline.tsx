"use client";

import { useState, type ReactNode } from "react";
import { type DeliveryRequirementRecord } from "@/api/delivery.api";
import { useLocale } from "@/i18n/LocaleProvider";
import { DeliveryDocumentSetModal, DeliveryDocumentSetPanel } from "./DeliveryDocumentSet";

interface DeliveryRequirementOutlineProps {
  programId: number;
  requirement: DeliveryRequirementRecord | null;
  codexBridgeReady: boolean;
  title?: ReactNode;
  /** 正文区自己滚动的方式，透传给文档集面板。 */
  scroll?: "fill" | "cap";
}

function outlineTitle(requirement: DeliveryRequirementRecord | null, tab: string) {
  if (!requirement) return null;
  const name = requirement.name || requirement.requirementKey;
  return <span title={name}>{`${tab} · ${name}`}</span>;
}

/**
 * 需求大纲栏目。文档目录是 doc/requirements/<需求键>/，需求大纲.md 之外的文档同样可选；
 * 原型目录 prototype/ 不在这个栏目里。
 */
export function DeliveryRequirementOutlinePanel({
  programId,
  requirement,
  codexBridgeReady,
  title,
  scroll,
}: DeliveryRequirementOutlineProps) {
  const { t } = useLocale();
  const [expanded, setExpanded] = useState(false);
  const subjectKey = requirement?.requirementKey ?? "";
  return (
    <>
      <DeliveryDocumentSetPanel
        programId={programId}
        scope="requirement-outline"
        subjectKey={subjectKey}
        codexBridgeReady={codexBridgeReady}
        title={title}
        scroll={scroll}
        emptyText={t("delivery.outline.requirementEmpty")}
        onExpand={() => setExpanded(true)}
      />
      <DeliveryDocumentSetModal
        open={expanded}
        programId={programId}
        scope="requirement-outline"
        subjectKey={subjectKey}
        codexBridgeReady={codexBridgeReady}
        title={outlineTitle(requirement, t("delivery.outline.tab"))}
        emptyText={t("delivery.outline.requirementEmpty")}
        onClose={() => setExpanded(false)}
      />
    </>
  );
}

/** 需求列表上的「需求大纲」按钮打开的独立预览弹窗。 */
export function DeliveryRequirementOutlineModal({
  open,
  programId,
  requirement,
  codexBridgeReady,
  onClose,
}: DeliveryRequirementOutlineProps & { open: boolean; onClose: () => void }) {
  const { t } = useLocale();
  return (
    <DeliveryDocumentSetModal
      open={open}
      programId={programId}
      scope="requirement-outline"
      subjectKey={requirement?.requirementKey ?? ""}
      codexBridgeReady={codexBridgeReady}
      title={outlineTitle(requirement, t("delivery.outline.tab"))}
      emptyText={t("delivery.outline.requirementEmpty")}
      onClose={onClose}
    />
  );
}
