"use client";

import { useState, type ReactNode } from "react";
import { type DeliveryItemRecord } from "@/api/delivery.api";
import { useLocale } from "@/i18n/LocaleProvider";
import { DeliveryDocumentSetModal, DeliveryDocumentSetPanel } from "./DeliveryDocumentSet";

interface DeliveryTaskDocumentProps {
  programId: number;
  item: DeliveryItemRecord | null;
  codexBridgeReady: boolean;
  title?: ReactNode;
}

/**
 * 任务文档栏目。文档目录是任务需求文档所在的目录，里面可以放多份文档；
 * 面板顶部下拉框选择看哪一份，「全屏预览」打开左侧文件列表、右侧预览与编辑的视图。
 */
export function DeliveryTaskDocumentPanel({ programId, item, codexBridgeReady, title }: DeliveryTaskDocumentProps) {
  const { t } = useLocale();
  const [expanded, setExpanded] = useState(false);
  const subjectKey = item?.itemKey ?? "";
  return (
    <>
      <DeliveryDocumentSetPanel
        programId={programId}
        scope="task-document"
        subjectKey={subjectKey}
        codexBridgeReady={codexBridgeReady}
        title={title}
        emptyText={t("delivery.document.requirementEmpty")}
        onExpand={() => setExpanded(true)}
      />
      <DeliveryDocumentSetModal
        open={expanded}
        programId={programId}
        scope="task-document"
        subjectKey={subjectKey}
        codexBridgeReady={codexBridgeReady}
        title={item ? <span title={item.title}>{`${t("delivery.detail.document")} · ${item.title}`}</span> : null}
        emptyText={t("delivery.document.requirementEmpty")}
        onClose={() => setExpanded(false)}
      />
    </>
  );
}

/** 任务面板上的「任务文档」按钮打开的独立预览弹窗。 */
export function DeliveryTaskDocumentModal({
  open,
  programId,
  item,
  codexBridgeReady,
  onClose,
}: DeliveryTaskDocumentProps & { open: boolean; onClose: () => void }) {
  const { t } = useLocale();
  return (
    <DeliveryDocumentSetModal
      open={open}
      programId={programId}
      scope="task-document"
      subjectKey={item?.itemKey ?? ""}
      codexBridgeReady={codexBridgeReady}
      title={item ? <span title={item.title}>{`${t("delivery.detail.document")} · ${item.title}`}</span> : null}
      emptyText={t("delivery.document.requirementEmpty")}
      onClose={onClose}
    />
  );
}
