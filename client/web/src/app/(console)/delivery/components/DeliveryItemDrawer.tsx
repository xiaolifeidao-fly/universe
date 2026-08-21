"use client";

import {
  CheckCircleOutlined,
  CodeOutlined,
  DeleteOutlined,
	FastForwardOutlined,
  FileTextOutlined,
  HistoryOutlined,
  LoadingOutlined,
  PlayCircleOutlined,
  ToolOutlined,
} from "@ant-design/icons";
import {
  Button,
  DatePicker,
  Descriptions,
  Drawer,
  Empty,
  Input,
  Modal,
  Select,
  Segmented,
  Slider,
  Spin,
  Space,
  Tabs,
  Tag,
  Timeline,
  Tooltip,
  Typography,
  message,
} from "antd";
import dayjs from "dayjs";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useLocale } from "@/i18n/LocaleProvider";
import {
  DELIVERY_KINDS,
  DELIVERY_STATUSES,
	STATUS_COLORS,
	fetchItemDetail,
  fetchItemEvents,
  type DeliveryEventRecord,
  type DeliveryItemRecord,
  type DeliveryKind,
  type DeliveryModuleRecord,
  type DeliveryStageRecord,
  type DeliveryStatus,
  type ExecutionProgressEvent,
  type PatchItemPayload,
} from "@/api/delivery.api";
import type { BusinessLineId } from "@/business-lines/BusinessLineProvider";
import { sceneForPhase, toolDisplayName, useAIPreferences } from "@/ai-preferences/AIPreferencesProvider";
import { SessionDocumentText } from "./DeliverySessionMessage";
import { DeliveryDocumentSetPanel } from "./DeliveryDocumentSet";
import { DeliveryTaskDocumentPanel } from "./DeliveryTaskDocument";

const { Text } = Typography;

interface DeliveryItemDrawerProps {
  open: boolean;
  item: DeliveryItemRecord | null;
  bizLine: BusinessLineId;
  programId: number;
  stages: DeliveryStageRecord[];
  modules: DeliveryModuleRecord[];
  items: DeliveryItemRecord[];
  ownerOptions: Array<{ value: string; label: string }>;
  submitting: boolean;
  codexBridgeReady: boolean;
  executing: boolean;
  onClose: () => void;
  onSave: (payload: Omit<PatchItemPayload, "programId">) => Promise<boolean>;
  onExecute: (item: DeliveryItemRecord) => Promise<boolean>;
  onOpenTestingCasesChat: (item: DeliveryItemRecord, startNewConversation?: boolean) => void;
  onExecuteFollowing: (item: DeliveryItemRecord) => Promise<boolean>;
  onDelete: (itemKey: string) => Promise<boolean>;
	onAdvancePhase: (phase: "requirement" | "development", item: DeliveryItemRecord) => Promise<boolean>;
}

interface DraftState {
  title: string;
  description: string;
	benefitTags: string[];
  stageKey: string;
  moduleKey: string;
  kind: DeliveryKind;
  status: DeliveryStatus;
  progress: number;
  ownerId: string;
  ownerName: string;
  dueDate: string;
  note: string;
  dependsOnItemKeys: string[];
}

function toDraft(item: DeliveryItemRecord): DraftState {
  return {
    title: item.title,
    description: item.description,
	benefitTags: [...(item.benefitTags ?? [])],
    stageKey: item.stageKey,
    moduleKey: item.moduleKey,
    kind: item.kind,
    status: item.status,
    progress: item.progress,
    ownerId: item.ownerId,
    ownerName: item.ownerName,
    dueDate: item.dueDate ? dayjs(item.dueDate).format("YYYY-MM-DD") : "",
    note: item.note,
    dependsOnItemKeys: [...(item.dependsOnItemKeys ?? [])].sort(),
  };
}

function ExecutionResultText({ value, fallback }: { value: string; fallback: string }) {
  let readable = value;
  try {
    const legacy = JSON.parse(value) as { turnStatus?: string; turn?: { items?: Array<Record<string, unknown>> } };
    const blocks = [`# Codex 执行结果`, `- 状态：${legacy.turnStatus || "completed"}`];
    for (const item of legacy.turn?.items ?? []) {
      if (item.type === "agentMessage") {
        const text = String(item.text || item.content || "").trim();
        if (text) blocks.push(`## 进度说明\n\n${text}`);
      }
      if (item.type === "commandExecution") {
        const command = Array.isArray(item.command) ? item.command.join("\n") : String(item.command || "");
        if (command) blocks.push(`## 执行命令\n\n\`\`\`sh\n${command}\n\`\`\``);
      }
    }
    readable = blocks.join("\n\n");
  } catch {
    // New execution records are already readable Markdown.
  }
  return <SessionDocumentText value={readable} fallback={fallback} />;
}

function ExecutionProgressDrawer({
  open,
  item,
  bizLine,
  programId,
  onClose,
}: {
  open: boolean;
  item: DeliveryItemRecord;
  bizLine: BusinessLineId;
  programId: number;
  onClose: () => void;
}) {
  const { t } = useLocale();
  const { configFor } = useAIPreferences();
  // 空状态说的是「以后跑完会留在这里」，得按这个阶段实际会用的工具来称呼。
  const toolName = toolDisplayName(configFor(sceneForPhase(item.phase || "requirement")).tool);
  const [events, setEvents] = useState<ExecutionProgressEvent[]>([]);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    setConnected(false);
    if (!open) {
      setEvents([]);
      return undefined;
    }
    if (item.status !== "doing") return undefined;
    return undefined;
  }, [bizLine, item.status, item.itemKey, open, programId]);

  const iconOf = (event: ExecutionProgressEvent) => {
    if (event.status === "running") return <LoadingOutlined spin />;
    if (event.kind === "command") return <CodeOutlined />;
    if (event.kind === "file") return <FileTextOutlined />;
    if (event.kind === "tool") return <ToolOutlined />;
    return <CheckCircleOutlined />;
  };

  return (
    <Drawer
      width="min(720px, 100vw)"
      open={open}
      onClose={onClose}
      title={t("delivery.execution.process")}
      extra={item.status === "doing" ? (
        <Tag color={connected ? "processing" : "default"} icon={connected ? <LoadingOutlined spin /> : undefined}>
          {connected ? t("delivery.execution.live") : t("delivery.execution.connecting")}
        </Tag>
      ) : <Tag color={item.status === "done" ? "success" : "error"}>{t(`delivery.status.${item.status}`)}</Tag>}
    >
      <div className="delivery-execution-process">
        <div className="delivery-execution-process__summary">
          <b>{item.title}</b>
          <span className="manager-mono">{item.itemKey}</span>
        </div>
        {events.length > 0 ? (
          <Timeline
            className="delivery-execution-timeline"
            items={events.map((event) => ({
              dot: iconOf(event),
              color: event.status === "failed" || event.status === "interrupted" ? "red" : "blue",
              children: (
                <article className="delivery-execution-event">
                  <header><b>{event.title}</b><time>{dayjs(event.timestamp).format("HH:mm:ss")}</time></header>
                  {event.body ? event.kind === "command"
                    ? <pre>{event.body}</pre>
                    : <div className="delivery-execution-event__body">{event.body}</div> : null}
                </article>
              ),
            }))}
          />
        ) : item.phase === "development" && item.actionOutput ? (
          <ExecutionResultText value={item.actionOutput} fallback={t("delivery.document.actionEmpty")} />
        ) : item.phase === "testing" && item.testingReport ? (
          <ExecutionResultText value={item.testingReport} fallback={t("delivery.document.testingEmpty")} />
        ) : (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={item.status === "doing"
              ? t("delivery.execution.waitingProgress")
              : t("delivery.document.executionEmpty").replace("{tool}", toolName)}
          />
        )}
      </div>
    </Drawer>
  );
}

export function DeliveryItemDrawer({
  open,
  item,
  bizLine,
  programId,
  stages,
  modules,
  items,
  ownerOptions,
  submitting,
  codexBridgeReady,
  executing,
  onClose,
  onSave,
  onExecute,
  onOpenTestingCasesChat,
  onExecuteFollowing,
  onDelete,
	onAdvancePhase,
}: DeliveryItemDrawerProps) {
  const { t } = useLocale();
  const [draft, setDraft] = useState<DraftState | null>(null);
  const [detail, setDetail] = useState<DeliveryItemRecord | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [comment, setComment] = useState("");
  const [events, setEvents] = useState<DeliveryEventRecord[]>([]);
  const [eventsLoading, setEventsLoading] = useState(false);
  const [processOpen, setProcessOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<"edit" | "document" | "timeline">("edit");
  const [descriptionView, setDescriptionView] = useState<"edit" | "preview">("edit");

  useEffect(() => {
    setDetail(null);
    setDraft(item ? toDraft(item) : null);
    setComment("");
  }, [item]);

  /** 每次从看板进入详情都先落在可编辑的工作区，文档和时间线作为辅助信息。 */
  useEffect(() => {
    if (!open) return;
    setActiveTab("edit");
    setDescriptionView("edit");
  }, [item?.itemKey, open]);

  const loadDetail = useCallback(async () => {
    if (!item || !programId) return;
    setDetailLoading(true);
    try {
      const next = await fetchItemDetail(programId, item.itemKey);
      setDetail(next);
      setDraft(toDraft(next));
    } catch (error) {
      message.error((error as Error).message);
    } finally {
      setDetailLoading(false);
    }
  }, [bizLine, item, programId]);

  const loadEvents = useCallback(async () => {
    if (!item || !programId) return;
    setEventsLoading(true);
    try {
      const page = await fetchItemEvents(programId, item.itemKey);
      setEvents(page.data);
    } catch (error) {
      message.error((error as Error).message);
    } finally {
      setEventsLoading(false);
    }
  }, [bizLine, item, programId]);

  useEffect(() => {
    if (open) void loadEvents();
    else setEvents([]);
  }, [loadEvents, open]);

  useEffect(() => {
    if (open) {
      void loadDetail();
    }
  }, [loadDetail, open]);

  const activeItem = detail ?? item;

  /** 只提交真正改了的字段：拖一下卡片不该把别人同时改的负责人覆盖回去。 */
  const changes = useMemo(() => {
    if (!activeItem || !draft) return {} as Partial<DraftState>;
    const current = toDraft(activeItem);
    return (Object.keys(draft) as (keyof DraftState)[]).reduce<Partial<DraftState>>((diff, key) => {
      const draftValue = draft[key];
      const currentValue = current[key];
      const equal =
        Array.isArray(draftValue) && Array.isArray(currentValue)
          ? draftValue.length === currentValue.length && draftValue.every((value, index) => value === currentValue[index])
          : draftValue === currentValue;
      if (!equal) {
        return { ...diff, [key]: draft[key] };
      }
      return diff;
    }, {});
  }, [activeItem, draft]);

  const dirty = Object.keys(changes).length > 0 || comment.trim().length > 0;
  const incompleteDependencies = activeItem?.dependsOnItemKeys.filter(
    (itemKey) => items.find((candidate) => candidate.itemKey === itemKey)?.status !== "done",
  ) ?? [];
	const canExecute = Boolean(activeItem && (activeItem.status === "todo" || activeItem.status === "blocked") && incompleteDependencies.length === 0 && codexBridgeReady);
	const canGenerateTestingCases = Boolean(activeItem && activeItem.status !== "dropped" && codexBridgeReady && !dirty);
	const nextPhase: "requirement" | "development" | undefined = activeItem?.status === "done" && activeItem.phase !== "testing"
		? activeItem.phase
		: undefined;

  const handleSave = async () => {
    if (!activeItem || !draft) return;
    const ok = await onSave({
      itemKey: activeItem.itemKey,
      version: activeItem.version,
      ...changes,
      comment: comment.trim() || undefined,
    });
    if (ok) {
      message.success(t("delivery.saved"));
      onClose();
    }
  };

  const handleDelete = () => {
    if (!activeItem) return;
    Modal.confirm({
      title: t("delivery.deleteConfirm"),
      content: activeItem.title,
      okButtonProps: { danger: true },
      onOk: async () => {
        const ok = await onDelete(activeItem.itemKey);
        if (ok) onClose();
      },
    });
  };

  const eventText = (event: DeliveryEventRecord) => {
    if (event.kind === "comment") return event.comment;
    if (event.kind === "create") return t("delivery.event.created");
    if (event.kind === "delete") return t("delivery.event.deleted");
    const field = t(`delivery.field.${event.field}`);
    const from = event.fromValue || t("delivery.empty");
    const to = event.toValue || t("delivery.empty");
    return `${field}: ${from} → ${to}`;
  };

  return (
    <Drawer
      className="delivery-item-drawer"
      width="min(840px, 100vw)"
      open={open}
      onClose={onClose}
      title={activeItem ? (
        <div className="delivery-drawer-title">
          <span className="delivery-drawer-title__text" title={activeItem.title}>{activeItem.title}</span>
          <small className="delivery-drawer-title-meta manager-mono">{activeItem.itemKey} · v{activeItem.version}</small>
        </div>
      ) : ""}
      extra={
        <Space>
          {activeItem && (activeItem.status === "doing" || activeItem.actionOutput || activeItem.testingReport) ? (
            <Button
              icon={activeItem.status === "doing" ? <LoadingOutlined spin /> : <HistoryOutlined />}
              onClick={() => setProcessOpen(true)}
            >
              {t("delivery.execution.process")}
            </Button>
          ) : null}
			{activeItem ? (
				<Tooltip title={!codexBridgeReady ? t("delivery.execution.bridgeOffline") : t("delivery.testingCases.hint")}>
					<Button
						icon={<ToolOutlined />}
						disabled={!canGenerateTestingCases}
						onClick={() => onOpenTestingCasesChat(activeItem, true)}
					>
						{t("delivery.testingCases.generate")}
					</Button>
				</Tooltip>
			) : null}
			{activeItem && (activeItem.testingCasesStatus !== "todo" || activeItem.testingCases) ? (
				<Button icon={<HistoryOutlined />} onClick={() => onOpenTestingCasesChat(activeItem)}>
					{t("delivery.taskTestingCases.open")}
				</Button>
			) : null}
			{activeItem && nextPhase ? (
				<Button icon={<FastForwardOutlined />} disabled={dirty} onClick={async () => {
					if (await onAdvancePhase(nextPhase, activeItem)) onClose();
				}}>
					{t(`delivery.phase.advance.${nextPhase}`)}
				</Button>
			) : null}
          {activeItem && (activeItem.status === "todo" || activeItem.status === "blocked") ? (
            <Tooltip
              title={
                !codexBridgeReady
                  ? t("delivery.execution.bridgeOffline")
                  : incompleteDependencies.length > 0
                    ? t("delivery.execution.waitingDependencies")
                    : undefined
              }
            >
              <Button
                icon={<PlayCircleOutlined />}
                loading={executing}
                disabled={!canExecute || dirty}
                onClick={async () => {
                  if (activeItem && (await onExecute(activeItem))) onClose();
                }}
              >
                {t("delivery.execution.codex")}
              </Button>
            </Tooltip>
          ) : null}
          {activeItem && (activeItem.status === "todo" || activeItem.status === "blocked") ? (
            <Tooltip title={t("delivery.execution.followingHint")}>
              <Button
                icon={<FastForwardOutlined />}
                disabled={!codexBridgeReady || dirty}
                onClick={async () => {
                  if (await onExecuteFollowing(activeItem)) onClose();
                }}
              >
                {t("delivery.execution.following")}
              </Button>
            </Tooltip>
          ) : null}
          <Button danger type="text" icon={<DeleteOutlined />} onClick={handleDelete}>
            {t("delivery.delete")}
          </Button>
          <Button type="primary" loading={submitting} disabled={!dirty} onClick={handleSave}>
            {t("delivery.save")}
          </Button>
        </Space>
      }
    >
      {draft && activeItem ? (
        <Spin spinning={detailLoading}>
          <Tabs
            className="delivery-detail-tabs"
            activeKey={activeTab}
            onChange={(key) => setActiveTab(key as "edit" | "document" | "timeline")}
            items={[
              {
                key: "edit",
                label: t("delivery.detail.edit"),
                children: (
                  <div className="delivery-edit-workspace delivery-drawer">
                    <header className="delivery-edit-summary">
                      <div>
                        <span className="delivery-edit-summary__eyebrow">{t(`delivery.phase.${activeItem.phase}`)}</span>
                        <b>{activeItem.title}</b>
                      </div>
                      <div className="delivery-edit-summary__tags">
                        <Tag color={STATUS_COLORS[activeItem.status]}>{t(`delivery.status.${activeItem.status}`)}</Tag>
                        <Tag color="blue">{t(`delivery.kind.${activeItem.kind}`)}</Tag>
                        <span className="manager-mono">{activeItem.progress}%</span>
                      </div>
                    </header>
                    <div className="delivery-edit-grid">
                      <section className="delivery-editor-panel delivery-editor-panel--description">
                        <div className="delivery-editor-panel__head">
                          <div>
                            <b>{t("delivery.field.description")}</b>
                            <small>{t("delivery.editor.descriptionHint")}</small>
                          </div>
                          <Segmented
                            className="delivery-description-switch"
                            value={descriptionView}
                            onChange={(value) => setDescriptionView(value as "edit" | "preview")}
                            options={[
                              { value: "edit", label: t("delivery.editor.write") },
                              { value: "preview", label: t("delivery.editor.preview") },
                            ]}
                          />
                        </div>
                        {descriptionView === "edit" ? (
                          <Input.TextArea
                            className="delivery-description-editor"
                            rows={10}
                            value={draft.description}
                            onChange={(event) => setDraft({ ...draft, description: event.target.value })}
                          />
                        ) : (
                          <div className="delivery-description-preview">
                            <SessionDocumentText value={draft.description} fallback={t("delivery.editor.descriptionEmpty")} />
                          </div>
                        )}
                      </section>
                      <section className="delivery-editor-panel">
                        <div className="delivery-editor-panel__head"><b>{t("delivery.editor.taskInfo")}</b></div>
                        <label>{t("delivery.field.title")}<Input value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} /></label>
                        <label>
                          {t("delivery.field.benefitTags")}
                          <Select mode="tags" tokenSeparators={[",", "，", ";", "；"]} maxCount={6} value={draft.benefitTags} placeholder={t("delivery.field.benefitTagsHint")} onChange={(value) => setDraft({ ...draft, benefitTags: value })} />
                        </label>
                      </section>
                      <section className="delivery-editor-panel">
                        <div className="delivery-editor-panel__head"><b>{t("delivery.editor.plan")}</b></div>
                        <div className="delivery-drawer-row">
                          <label>{t("delivery.field.moduleKey")}<Select value={draft.moduleKey} onChange={(value) => setDraft({ ...draft, moduleKey: value })} options={modules.map((module) => ({ value: module.moduleKey, label: module.name }))} /></label>
                          <label>{t("delivery.field.stageKey")}<Select value={draft.stageKey} onChange={(value) => setDraft({ ...draft, stageKey: value })} options={stages.map((stage) => ({ value: stage.stageKey, label: `${stage.tag} · ${stage.timeWindow}` }))} /></label>
                        </div>
                        <div className="delivery-drawer-row">
                          <label>{t("delivery.field.kind")}<Select value={draft.kind} onChange={(value) => setDraft({ ...draft, kind: value })} options={DELIVERY_KINDS.map((kind) => ({ value: kind, label: t(`delivery.kind.${kind}`) }))} /></label>
                          <label>{t("delivery.field.status")}<Select value={draft.status} onChange={(value) => setDraft({ ...draft, status: value })} options={DELIVERY_STATUSES.map((status) => ({ value: status, label: t(`delivery.status.${status}`) }))} /></label>
                        </div>
                        <label>
                          {t("delivery.field.progress")} <em className="manager-mono">{draft.progress}%</em>
                          <Slider min={0} max={100} step={5} value={draft.progress} disabled />
                        </label>
                      </section>
                      <section className="delivery-editor-panel delivery-editor-panel--full">
                        <div className="delivery-editor-panel__head"><b>{t("delivery.editor.collaboration")}</b></div>
                        <label>
                          {t("delivery.field.dependsOnItemKeys")}
                          <Select mode="multiple" showSearch allowClear maxTagCount="responsive" optionFilterProp="label" value={draft.dependsOnItemKeys} placeholder={t("delivery.dependencies.placeholder")} onChange={(value) => setDraft({ ...draft, dependsOnItemKeys: [...value].sort() })} options={items.filter((candidate) => candidate.itemKey !== activeItem.itemKey).map((candidate) => ({ value: candidate.itemKey, label: `${candidate.title} · ${candidate.itemKey}` }))} />
                          <small className="delivery-field-hint">{t("delivery.dependencies.hint")}</small>
                        </label>
                        <div className="delivery-drawer-row">
                          <label>
                            {t("delivery.field.ownerName")}
                            <Select
                              allowClear
                              showSearch
                              optionFilterProp="label"
                              value={draft.ownerId || draft.ownerName || undefined}
                              placeholder={t("delivery.unassigned")}
                              options={ownerOptions}
                              onChange={(value) => {
                                const ownerId = value ?? "";
                                const ownerName = ownerOptions.find((option) => option.value === ownerId)?.label ?? "";
                                setDraft({ ...draft, ownerId, ownerName });
                              }}
                            />
                          </label>
                          <label>{t("delivery.field.dueDate")}<DatePicker style={{ width: "100%" }} value={draft.dueDate ? dayjs(draft.dueDate) : null} onChange={(value) => setDraft({ ...draft, dueDate: value ? value.format("YYYY-MM-DD") : "" })} /></label>
                        </div>
                        <label>{t("delivery.field.note")}<Input.TextArea rows={2} value={draft.note} onChange={(event) => setDraft({ ...draft, note: event.target.value })} /></label>
                      </section>
                    </div>
                  </div>
                ),
              },
              {
                key: "document",
                label: t("delivery.detail.document"),
                children: (
                  <article className="delivery-document">
                    <div className="delivery-document__meta">
                      <Tag color={activeItem.status === "done" ? "success" : activeItem.status === "blocked" ? "error" : "processing"}>{t(`delivery.status.${activeItem.status}`)}</Tag>
                      <Tag color="blue">{t(`delivery.kind.${activeItem.kind}`)}</Tag>
                      <span className="manager-mono">{activeItem.progress}%</span>
                    </div>
                    <Descriptions
                      className="delivery-document__facts"
                      size="small"
                      column={{ xs: 1, sm: 2 }}
                      bordered
                      items={[
                        { key: "stage", label: t("delivery.field.stageKey"), children: stages.find((stage) => stage.stageKey === activeItem.stageKey)?.tag || activeItem.stageKey || "-" },
                        { key: "module", label: t("delivery.field.moduleKey"), children: modules.find((module) => module.moduleKey === activeItem.moduleKey)?.name || activeItem.moduleKey || "-" },
                        { key: "phase", label: t("delivery.field.phase"), children: t(`delivery.phase.${activeItem.phase}`) },
						{ key: "createdAt", label: t("delivery.field.createdAt"), children: activeItem.createdAt ? dayjs(activeItem.createdAt).format("YYYY-MM-DD HH:mm") : "-" },
						{ key: "testingCasesStatus", label: t("delivery.testingCases.status"), children: t(`delivery.testingCases.status.${activeItem.testingCasesStatus || "todo"}`) },
                        { key: "benefitTags", label: t("delivery.field.benefitTags"), children: activeItem.benefitTags.length ? <span className="delivery-benefit-tags">{activeItem.benefitTags.map((tag) => <Tag color="gold" key={tag}>{tag}</Tag>)}</span> : "-" },
                        {
                          key: "dependencies",
                          label: t("delivery.field.dependsOnItemKeys"),
                          span: 2,
                          children: activeItem.dependsOnItemKeys.length
                            ? activeItem.dependsOnItemKeys.map((itemKey) => items.find((candidate) => candidate.itemKey === itemKey)?.title || itemKey).join(" · ")
                            : "-",
                        },
                      ]}
                    />
                    <Tabs
                      className="delivery-document-tabs"
                      defaultActiveKey="requirement"
                      items={[
                        {
                          key: "requirement",
                          label: t("delivery.session.document.requirement"),
                          children: (
                            <DeliveryTaskDocumentPanel programId={programId} item={activeItem} codexBridgeReady={codexBridgeReady} scroll="cap" />
                          ),
                        },
                        {
                          key: "design",
                          label: t("delivery.session.document.design"),
                          children: (
                            <DeliveryDocumentSetPanel
                              programId={programId}
                              scope="task-design"
                              subjectKey={activeItem.itemKey}
                              codexBridgeReady={codexBridgeReady}
                              scroll="cap"
                              emptyText={t("delivery.document.designEmpty")}
                              fallback={(
                                <ExecutionResultText value={activeItem.actionOutput} fallback={t("delivery.document.designEmpty")} />
                              )}
                            />
                          ),
                        },
						{
							key: "testingCases",
							label: t("delivery.session.document.testingCases"),
							children: (
								<DeliveryDocumentSetPanel
									programId={programId}
									scope="task-testing"
									subjectKey={activeItem.itemKey}
									codexBridgeReady={codexBridgeReady}
									scroll="cap"
									emptyText={t("delivery.document.testingCasesEmpty")}
									fallback={(
										<>
											{activeItem.testingCasesPath ? <code className="delivery-document-panel__path">{activeItem.testingCasesPath}</code> : null}
											<ExecutionResultText value={activeItem.testingCases} fallback={t("delivery.document.testingCasesEmpty")} />
										</>
									)}
								/>
							),
						},
						{
                          key: "testing",
                          label: t("delivery.session.document.testing"),
                          children: (
                            <section className="delivery-document-panel">
                              <ExecutionResultText value={activeItem.testingReport} fallback={t("delivery.document.testingEmpty")} />
                            </section>
                          ),
                        },
                      ]}
                    />
                  </article>
                ),
              },
              {
                key: "timeline",
                label: t("delivery.timeline"),
                children: (
                  <div className="delivery-drawer">
                    <label>{t("delivery.comment")}<Input.TextArea rows={3} value={comment} placeholder={t("delivery.commentHint")} onChange={(event) => setComment(event.target.value)} /></label>
                    {events.length === 0 && !eventsLoading ? <Text type="secondary">{t("delivery.timelineEmpty")}</Text> : (
                      <Timeline style={{ marginTop: 12 }} items={events.map((event) => ({
                        color: event.kind === "comment" ? "blue" : "gray",
                        children: <div className="delivery-event"><b>{eventText(event)}</b><small className="manager-mono">{dayjs(event.createdAt).format("MM-DD HH:mm")} · {event.actorName || event.actorId}</small></div>,
                      }))} />
                    )}
                  </div>
                ),
              },
            ]}
          />
        </Spin>
      ) : null}
      {activeItem ? <ExecutionProgressDrawer open={processOpen} item={activeItem} bizLine={bizLine} programId={programId} onClose={() => setProcessOpen(false)} /> : null}
    </Drawer>
  );
}
