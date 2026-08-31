"use client";

import { Alert, Checkbox, DatePicker, Form, Input, Modal, Select, Space, Spin, message } from "antd";
import dayjs, { type Dayjs } from "dayjs";
import { useEffect, useState } from "react";
import { useLocale } from "@/i18n/LocaleProvider";
import {
  TIME_PLAN_STATUSES,
  bindTimePlanBranch,
  createCodexGitBranch,
  fetchCodexGitBranches,
  fetchCodexGitProjects,
  saveTimePlan,
  type CodexGitProjectStatus,
  type DeliveryTimePlanRecord,
  type TimePlanStatus,
} from "@/api/delivery.api";

interface TimePlanFormValues {
  name: string;
  range?: [Dayjs, Dayjs];
  status: TimePlanStatus;
  baseBranch: string;
  branch: string;
}

interface TimePlanFormModalProps {
  open: boolean;
  programId: number;
  /** 为空表示新建；带记录表示编辑。 */
  plan: DeliveryTimePlanRecord | null;
  /** 同项目下已有的计划，用于建分支之前先在本地查一遍分支重名。 */
  plans: DeliveryTimePlanRecord[];
  /** 项目没开 Git 时只排期，不建分支，分支字段整体隐藏。 */
  gitEnabled: boolean;
  /** 项目设置里的默认基准分支，新建时预填。 */
  defaultBaseBranch: string;
  onClose: () => void;
  onSaved: () => void;
}

/** 默认分支名 release/{截止日期}，和服务端的兜底规则保持一致，避免表单和落库对不上。 */
function defaultBranchOf(endAt: Dayjs | undefined) {
  return endAt ? `release/${endAt.format("YYYYMMDD")}` : "";
}

/**
 * 时间计划的新建 / 编辑表单。
 *
 * 项目启用 Git 时严格按「先建本机分支，再落库计划」执行：根工作目录的分支没建成就
 * 直接中止，计划不会落库 —— 一条没有分支的计划在列表里三个合并动作全都点不动，
 * 留着只会让人以为分支已经准备好了。子项目建失败不算中止：根分支已经在了，
 * 撤回计划反而更难收拾，缺哪个子项目会明确列出来，之后在编辑里补建。
 */
export function TimePlanFormModal({
  open,
  programId,
  plan,
  plans,
  gitEnabled,
  defaultBaseBranch,
  onClose,
  onSaved,
}: TimePlanFormModalProps) {
  const { t } = useLocale();
  const [form] = Form.useForm<TimePlanFormValues>();
  const [saving, setSaving] = useState(false);
  const [branches, setBranches] = useState<string[]>([]);
  const [branchesLoading, setBranchesLoading] = useState(false);
  const [subprojects, setSubprojects] = useState<CodexGitProjectStatus[]>([]);
  const [targets, setTargets] = useState<string[]>([]);
  const [subprojectsLoading, setSubprojectsLoading] = useState(false);
  const [branchError, setBranchError] = useState("");
  // 用户自己改过分支名之后，就不再跟着截止日期联动，免得把手填的名字冲掉。
  const [branchTouched, setBranchTouched] = useState(false);

  useEffect(() => {
    if (!open) return;
    setBranchError("");
    setBranchTouched(Boolean(plan?.branch));
    const start = plan?.startAt ? dayjs(plan.startAt) : undefined;
    const end = plan?.endAt ? dayjs(plan.endAt) : undefined;
    form.setFieldsValue({
      name: plan?.name ?? "",
      range: start && end ? [start, end] : undefined,
      status: (plan?.status as TimePlanStatus) ?? "active",
      baseBranch: plan?.baseBranch || defaultBaseBranch,
      branch: plan?.branch || defaultBranchOf(end),
    });
    if (!gitEnabled) {
      setBranches([]);
      setSubprojects([]);
      setTargets([]);
      return;
    }
    setBranchesLoading(true);
    void fetchCodexGitBranches(programId)
      .then((catalog) => setBranches(catalog.branches))
      // 读不到本机分支列表不该挡住建计划：基准分支退化成手填。
      .catch(() => setBranches([]))
      .finally(() => setBranchesLoading(false));
    // 编辑时也要有这份勾选：改了分支名同样要在本机建出来，缺了它子项目就跟不上。
    setSubprojectsLoading(true);
    void fetchCodexGitProjects(programId)
      .then((catalog) => {
        const children = catalog.projects.filter((project) => project.path && !project.error);
        setSubprojects(children);
        // 发布分支是整个项目的时间窗口，子项目默认全选，不像需求那样只选已有分支的。
        setTargets(children.map((project) => project.path));
      })
      .catch(() => setSubprojects([]))
      .finally(() => setSubprojectsLoading(false));
  }, [defaultBaseBranch, form, gitEnabled, open, plan, programId]);

  const submit = async () => {
    const values = await form.validateFields();
    const [start, end] = values.range ?? [];
    if (!end) return;
    const baseBranch = values.baseBranch?.trim() || "";
    const branch = values.branch?.trim() || "";
    // 编辑时分支没改就不用再建一次：那条分支早就在本机了。
    const needsBranch = gitEnabled && Boolean(branch) && branch !== plan?.branch;
    setSaving(true);
    setBranchError("");
    try {
      let effectiveBranch = branch;
      let subprojectFailures = "";
      if (needsBranch) {
        // 服务端也会拒绝重名分支，但那是在建完之后才返回的，本机会白留一条没人认领的分支。
        // 先在已加载的计划里查一遍，把这种情况挡在动 Git 之前。
        const taken = plans.find((entry) => entry.planKey !== plan?.planKey && entry.branch === branch);
        if (taken) {
          setBranchError(t("timePlan.form.branchTaken").replace("{branch}", branch).replace("{plan}", taken.name));
          setSaving(false);
          return;
        }
        let created;
        try {
          created = await createCodexGitBranch(programId, baseBranch, branch, targets);
        } catch (error) {
          // 根工作目录的分支没建成，计划一律不落库。
          setBranchError((error as Error).message);
          setSaving(false);
          return;
        }
        // 从 origin/xxx 关联时本机分支名会被规范化，落库要用真正建出来的那个名字。
        effectiveBranch = created.branch || branch;
        const failed = created.results.filter((entry) => entry.path && entry.error);
        if (failed.length) {
          subprojectFailures = [
            t("timePlan.form.subprojectBranchFailed"),
            ...failed.map((entry) => `${entry.name}：${entry.error}`),
          ].join("\n");
        }
        message.success(t("timePlan.form.branchCreated").replace("{branch}", effectiveBranch));
      }
      const saved = await saveTimePlan({
        programId,
        ...(plan ? { planKey: plan.planKey, version: plan.version } : {}),
        name: values.name.trim(),
        startAt: start?.toISOString(),
        endAt: end.toISOString(),
        status: values.status,
        ...(gitEnabled ? { baseBranch, branch: effectiveBranch } : {}),
      });
      message.success(t("timePlan.saved"));
      // 分支创建时间单独记一笔；bind 失败只是少一个时间戳，不影响计划和分支本身。
      if (needsBranch && saved.branch && saved.baseBranch) {
        try {
          await bindTimePlanBranch(programId, saved.planKey, saved.baseBranch, saved.branch);
        } catch (error) {
          message.warning((error as Error).message);
        }
      }
      onSaved();
      if (subprojectFailures) {
        // 缺子项目分支要留在弹窗里说清楚，不关窗，用户看完自己决定要不要重试。
        setBranchError(subprojectFailures);
        return;
      }
      onClose();
    } catch (error) {
      message.error((error as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      wrapClassName="manager-form-skin"
      open={open}
      destroyOnClose
      width={620}
      title={t(plan ? "timePlan.edit" : "timePlan.new")}
      okText={t("common.save")}
      cancelText={t("common.cancel")}
      confirmLoading={saving}
      onCancel={onClose}
      onOk={() => void submit()}
    >
      <Form<TimePlanFormValues> form={form} layout="vertical">
        <Form.Item
          label={t("timePlan.field.name")}
          name="name"
          rules={[{ required: true, message: t("timePlan.field.name.required") }]}
        >
          <Input placeholder={t("timePlan.field.name.placeholder")} />
        </Form.Item>
        <Form.Item
          label={t("timePlan.field.range")}
          name="range"
          rules={[{ required: true, message: t("timePlan.field.range.required") }]}
        >
          <DatePicker.RangePicker
            style={{ width: "100%" }}
            onChange={(value) => {
              // 截止日期决定默认分支名；用户没手改过分支时跟着联动。
              if (branchTouched) return;
              form.setFieldValue("branch", defaultBranchOf(value?.[1] ?? undefined));
            }}
          />
        </Form.Item>
        <Form.Item label={t("timePlan.field.status")} name="status">
          <Select
            options={TIME_PLAN_STATUSES.map((status) => ({
              value: status,
              label: t(`timePlan.status.${status}`),
            }))}
          />
        </Form.Item>
        {gitEnabled ? (
          <>
            <Form.Item
              label={t("timePlan.field.baseBranch")}
              name="baseBranch"
              extra={t("timePlan.field.baseBranch.hint")}
              rules={[{ required: true, message: t("timePlan.field.baseBranch.required") }]}
            >
              <Select
                showSearch
                loading={branchesLoading}
                options={branches.map((branch) => ({ value: branch, label: branch }))}
              />
            </Form.Item>
            <Form.Item
              label={t("timePlan.field.branch")}
              name="branch"
              extra={t("timePlan.field.branch.hint")}
              rules={[{ required: true, message: t("timePlan.field.branch.required") }]}
            >
              <Input onChange={() => setBranchTouched(true)} />
            </Form.Item>
            <Form.Item label={t("timePlan.form.subprojects")} extra={t("timePlan.form.subprojects.hint")}>
                {subprojectsLoading ? (
                  <Spin size="small" />
                ) : subprojects.length ? (
                  <Checkbox.Group
                    value={targets}
                    onChange={(value) => setTargets(value as string[])}
                  >
                    <Space direction="vertical" size={4}>
                      {subprojects.map((project) => (
                        <Checkbox key={project.path} value={project.path}>
                          {project.name}
                          {project.currentBranch ? (
                            <span className="manager-table-subline manager-mono">
                              {" "}
                              {project.currentBranch}
                            </span>
                          ) : null}
                        </Checkbox>
                      ))}
                    </Space>
                  </Checkbox.Group>
                ) : (
                  <div className="manager-table-subline">{t("timePlan.form.subprojects.empty")}</div>
                )}
            </Form.Item>
          </>
        ) : (
          <Alert type="info" showIcon message={t("timePlan.form.gitDisabled")} />
        )}
        {branchError ? (
          <Alert
            type="error"
            showIcon
            message={t("timePlan.form.branchFailed")}
            description={<div style={{ whiteSpace: "pre-wrap" }}>{branchError}</div>}
          />
        ) : null}
      </Form>
    </Modal>
  );
}
