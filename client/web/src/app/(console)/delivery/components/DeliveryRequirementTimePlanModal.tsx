"use client";

import { Alert, Modal, Select, Space, Spin, message } from "antd";
import dayjs from "dayjs";
import { useEffect, useState } from "react";
import { useLocale } from "@/i18n/LocaleProvider";
import {
  bindRequirementTimePlan,
  fetchTimePlans,
  type DeliveryRequirementRecord,
  type DeliveryTimePlanRecord,
} from "@/api/delivery.api";

interface DeliveryRequirementTimePlanModalProps {
  /** 为空表示弹窗关闭。 */
  requirement: DeliveryRequirementRecord | null;
  /** 需求自带 programId 时可以不传；工作台的卡片带的是各自项目。 */
  programId?: number;
  onClose: () => void;
  /** 关联结果落库后回调，调用方据此刷新自己的需求列表。 */
  onBound: (requirement: DeliveryRequirementRecord) => void;
}

/**
 * 需求的「关联时间计划」：任务面板需求列表和工作台共用同一个弹窗。
 *
 * 关联只改需求上的计划键，不碰需求正文，也不碰任何分支 —— 真正的分支合并由
 * 时间计划页的「合并需求分支」发起，这里只决定这条需求属于哪一批发布。
 */
export function DeliveryRequirementTimePlanModal({
  requirement,
  programId,
  onClose,
  onBound,
}: DeliveryRequirementTimePlanModalProps) {
  const { t } = useLocale();
  const [plans, setPlans] = useState<DeliveryTimePlanRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [selected, setSelected] = useState("");
  const [error, setError] = useState("");

  const targetProgramId = programId || requirement?.programId || 0;

  useEffect(() => {
    if (!requirement || !targetProgramId) return;
    setError("");
    setSelected(requirement.timePlanKey || "");
    setLoading(true);
    // 已归档的计划不该再接新需求，但当前已关联的那条要留在选项里，否则回显会变空。
    fetchTimePlans({ programId: targetProgramId })
      .then((page) => setPlans(page.data))
      .catch((reason: Error) => {
        setPlans([]);
        setError(reason.message);
      })
      .finally(() => setLoading(false));
  }, [requirement, targetProgramId]);

  const submit = async () => {
    if (!requirement || saving) return;
    setSaving(true);
    try {
      const updated = await bindRequirementTimePlan(targetProgramId, requirement.requirementKey, selected);
      message.success(t("delivery.requirement.timePlan.saved"));
      onBound(updated);
      onClose();
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const options = plans
    .filter((plan) => plan.status !== "archived" || plan.planKey === requirement?.timePlanKey)
    .map((plan) => ({
      value: plan.planKey,
      label: [
        plan.name,
        plan.endAt ? dayjs(plan.endAt).format("YYYY-MM-DD") : "",
        plan.branch,
      ].filter(Boolean).join(" · "),
    }));

  return (
    <Modal
      wrapClassName="manager-form-skin"
      open={Boolean(requirement)}
      destroyOnClose
      title={t("delivery.requirement.timePlan.title").replace("{name}", requirement?.name || requirement?.requirementKey || "")}
      okText={t("common.save")}
      cancelText={t("common.cancel")}
      confirmLoading={saving}
      onCancel={onClose}
      onOk={() => void submit()}
    >
      <Space direction="vertical" size={12} style={{ width: "100%" }}>
        {loading ? (
          <div style={{ display: "grid", placeItems: "center", padding: 24 }}><Spin /></div>
        ) : (
          <Select
            style={{ width: "100%" }}
            value={selected}
            placeholder={t("delivery.requirement.timePlan.placeholder")}
            onChange={setSelected}
            // 空串是「解除关联」，不是「没选」，所以它是一个正经选项而不是 allowClear。
            options={[{ value: "", label: t("delivery.requirement.timePlan.none") }, ...options]}
          />
        )}
        {!loading && !options.length ? (
          <Alert type="info" showIcon message={t("delivery.requirement.timePlan.empty")} />
        ) : null}
        <div className="manager-table-subline">{t("delivery.requirement.timePlan.hint")}</div>
        {error ? <Alert type="error" showIcon message={error} /> : null}
      </Space>
    </Modal>
  );
}
