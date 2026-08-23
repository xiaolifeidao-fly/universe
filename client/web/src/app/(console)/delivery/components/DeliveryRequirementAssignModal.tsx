"use client";

import { Modal, Select, Spin, message } from "antd";
import { useEffect, useMemo, useState } from "react";
import { useLocale } from "@/i18n/LocaleProvider";
import {
  assignRequirementMembers,
  fetchProgramMembers,
  type DeliveryRequirementRecord,
  type MemberRecord,
  type RequirementMember,
} from "@/api/delivery.api";

interface DeliveryRequirementAssignModalProps {
  open: boolean;
  /** 需求所属项目；工作台的需求来自不同项目，候选成员必须按这条需求的项目取。 */
  programId: number;
  requirement: DeliveryRequirementRecord | null;
  onClose: () => void;
  /** 指派成功后回传服务端最新的需求，调用方据此就地更新列表。 */
  onAssigned: (requirement: DeliveryRequirementRecord) => void;
}

/**
 * 需求负责人的快速指派弹窗：需求列表和工作台共用。
 * 只提交负责人与协助人，别的字段交给需求编辑窗口，避免快速操作误改整条需求。
 */
export function DeliveryRequirementAssignModal({
  open,
  programId,
  requirement,
  onClose,
  onAssigned,
}: DeliveryRequirementAssignModalProps) {
  const { t } = useLocale();
  const [members, setMembers] = useState<MemberRecord[]>([]);
  const [membersLoading, setMembersLoading] = useState(false);
  const [ownerIds, setOwnerIds] = useState<string[]>([]);
  const [assistantIds, setAssistantIds] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setOwnerIds((requirement?.owners ?? []).map((member) => member.id));
    setAssistantIds((requirement?.assistants ?? []).map((member) => member.id));
  }, [open, requirement]);

  useEffect(() => {
    if (!open || !programId) {
      setMembers([]);
      return undefined;
    }
    let cancelled = false;
    setMembersLoading(true);
    setMembers([]);
    fetchProgramMembers(programId)
      .then((list) => {
        if (!cancelled) setMembers(list);
      })
      .catch(() => {
        // 候选加载失败时不退化成全站成员，避免把项目外的人放进下拉框。
        if (!cancelled) message.warning(t("delivery.requirement.membersFailed"));
      })
      .finally(() => {
        if (!cancelled) setMembersLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, programId, t]);

  const memberOptions = useMemo(
    () => members
      .filter((member) => member.id)
      .map((member) => ({ value: member.id, label: member.displayName || member.username || member.id })),
    [members],
  );

  // 候选还没加载完或成员已离开项目时，保留需求上原有的显示名，别把人名写成裸标识。
  const membersOf = (ids: string[], fallback: RequirementMember[]): RequirementMember[] =>
    ids.map((id) => ({
      id,
      name: members.find((member) => member.id === id)?.displayName
        ?? fallback.find((member) => member.id === id)?.name
        ?? id,
    }));

  const submit = async () => {
    if (!requirement) return;
    setSaving(true);
    try {
      const next = await assignRequirementMembers({
        programId,
        requirementKey: requirement.requirementKey,
        owners: membersOf(ownerIds, requirement.owners ?? []),
        assistants: membersOf(assistantIds, requirement.assistants ?? []),
        version: requirement.version,
      });
      message.success(t("delivery.requirement.assignSaved"));
      onAssigned(next);
      onClose();
    } catch (error) {
      message.error((error as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      destroyOnClose
      title={t("delivery.requirement.assign")}
      okText={t("delivery.requirement.assignSave")}
      cancelText={t("common.cancel")}
      confirmLoading={saving}
      okButtonProps={{ disabled: !requirement }}
      onOk={() => void submit()}
      onCancel={onClose}
    >
      <Spin spinning={membersLoading}>
        <div className="delivery-requirement-assign">
          <p className="delivery-requirement-assign__target">{requirement?.name || requirement?.requirementKey}</p>
          <label>
            {t("delivery.requirement.owners")}
            <Select
              mode="multiple"
              allowClear
              showSearch
              optionFilterProp="label"
              value={ownerIds}
              placeholder={t("delivery.requirement.memberPlaceholder")}
              onChange={setOwnerIds}
              options={memberOptions}
            />
          </label>
          <label>
            {t("delivery.requirement.assistants")}
            <Select
              mode="multiple"
              allowClear
              showSearch
              optionFilterProp="label"
              value={assistantIds}
              placeholder={t("delivery.requirement.memberPlaceholder")}
              onChange={setAssistantIds}
              options={memberOptions}
            />
          </label>
        </div>
      </Spin>
    </Modal>
  );
}
