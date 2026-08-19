"use client";

import { ArrowLeftOutlined, CheckCircleOutlined, LoadingOutlined, PauseCircleOutlined, PlayCircleOutlined, ReloadOutlined } from "@ant-design/icons";
import { Alert, Button, Empty, Modal, Space, Table, Tag, message } from "antd";
import type { ColumnsType } from "antd/es/table";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { effortForConfig, modelForConfig, toolDisplayName, useAIPreferences } from "@/ai-preferences/AIPreferencesProvider";
import {
  fetchCodexEnvironmentSetupConversation,
  startCodexEnvironmentSetup,
  stopCodexEnvironmentSetup,
  type CodexEnvironmentSetupConversation,
} from "@/api/delivery.api";
import { useLocale } from "@/i18n/LocaleProvider";
import { GIT_PRESET, describeEnvironment, type EnvironmentCommands } from "@/project-workspaces/environmentPresets";
import { SessionMessageContent } from "../../delivery/components/DeliverySessionMessage";

interface ProgramEnvironmentSetupModalProps {
  open: boolean;
  useGit: boolean;
  environments: string[];
  onClose: () => void;
  onBack: () => void;
}

interface EnvironmentRow {
  key: string;
  id: string;
  label: string;
  requirement: string;
  probe: EnvironmentCommands;
  install: EnvironmentCommands;
  custom: boolean;
}

/** 一个系统一格：上面是检测命令，下面是没装时的安装命令。 */
function CommandCell({ probe, install }: { probe: string; install: string }) {
  const { t } = useLocale();
  if (!probe && !install) return <span className="manager-table-subline">{t("programs.environment.byExecutor")}</span>;
  return (
    <div className="program-environment-command">
      {probe ? <code className="manager-mono">{probe}</code> : null}
      {install ? <code className="manager-mono program-environment-command__install">{install}</code> : null}
    </div>
  );
}

export function ProgramEnvironmentSetupModal({ open, useGit, environments, onClose, onBack }: ProgramEnvironmentSetupModalProps) {
  const { t } = useLocale();
  const { configFor } = useAIPreferences();
  const setupConfig = configFor("actionExecution");
  const provider = setupConfig.tool;
  const toolName = toolDisplayName(provider);
  const programId = 0;
  const [conversation, setConversation] = useState<CodexEnvironmentSetupConversation | null>(null);
  const [loading, setLoading] = useState(false);
  const [starting, setStarting] = useState(false);
  const [stopping, setStopping] = useState(false);
  const transcriptRef = useRef<HTMLDivElement>(null);

  const rows = useMemo<EnvironmentRow[]>(() => [
    ...(useGit
      ? [{
        key: GIT_PRESET.id,
        id: GIT_PRESET.id,
        label: GIT_PRESET.label,
        requirement: t("programs.environment.gitDetail"),
        probe: GIT_PRESET.probe,
        install: GIT_PRESET.install,
        custom: false,
      }]
      : []),
    ...environments.map((value) => {
      const preset = describeEnvironment(value);
      return {
        key: value,
        id: preset.id,
        label: preset.label,
        requirement: preset.requirement || t("programs.environment.custom"),
        probe: preset.probe,
        install: preset.install,
        custom: !preset.requirement,
      };
    }),
  ], [environments, t, useGit]);

  const load = useCallback(async (threadId = "") => {
    setLoading(true);
    try {
      const next = await fetchCodexEnvironmentSetupConversation(threadId, provider, { useGit, environments });
      setConversation(next);
      return next;
    } catch (error) {
      message.error((error as Error).message);
      return null;
    } finally {
      setLoading(false);
    }
  }, [environments, provider, useGit]);

  useEffect(() => {
    if (!open) {
      setConversation(null);
      return;
    }
    void load();
  }, [load, open]);

  const active = Boolean(conversation?.active);

  useEffect(() => {
    if (!open || !active) return undefined;
    const timer = window.setInterval(() => void load(conversation?.threadId || ""), 4000);
    return () => window.clearInterval(timer);
  }, [active, conversation?.threadId, load, open]);

  const items = useMemo(
    () => (conversation?.turns ?? []).flatMap((turn) => turn.items.map((item) => ({ ...item, turnId: turn.id }))),
    [conversation],
  );

  const statusesById = useMemo(
    () => new Map((conversation?.environmentStatuses ?? []).map((status) => [status.id.toLocaleLowerCase(), status])),
    [conversation?.environmentStatuses],
  );

  useEffect(() => {
    transcriptRef.current?.scrollTo({ top: transcriptRef.current.scrollHeight, behavior: "smooth" });
  }, [active, items.length]);

  const start = async () => {
    if (!rows.length) return;
    setStarting(true);
    try {
      const action = await startCodexEnvironmentSetup({
        useGit,
        environments,
        newConversation: true,
        provider,
        model: modelForConfig(setupConfig),
        reasoningEffort: effortForConfig(setupConfig),
        fastMode: provider === "claude" && setupConfig.claudeFastMode,
      });
      message.success(t("programs.environment.started"));
      await load(action.threadId);
    } catch (error) {
      message.error((error as Error).message);
    } finally {
      setStarting(false);
    }
  };

  const stop = async () => {
    setStopping(true);
    try {
      await stopCodexEnvironmentSetup(conversation?.threadId || "", provider);
      message.success(t("programs.environment.stopRequested"));
    } catch (error) {
      message.error((error as Error).message);
    } finally {
      setStopping(false);
    }
  };

  const columns: ColumnsType<EnvironmentRow> = [
    {
      title: t("programs.environment.name"),
      dataIndex: "label",
      render: (value: string, record) => {
        const status = statusesById.get(record.id.toLocaleLowerCase());
        return (
          <Space size={6}>
            <b data-locale-static="false">{value}</b>
            {status?.installed ? <Tag color="success" icon={<CheckCircleOutlined />} title={status.version}>{t("programs.environment.installed")}</Tag> : null}
            {record.custom ? <Tag>{t("programs.environment.custom")}</Tag> : null}
          </Space>
        );
      },
    },
    {
      title: t("programs.environment.requirement"),
      dataIndex: "requirement",
      width: 160,
      render: (value: string) => <span data-locale-static="false">{value}</span>,
    },
    {
      title: "macOS",
      dataIndex: "probe",
      render: (_, record) => <CommandCell probe={record.probe.macos} install={record.install.macos} />,
    },
    {
      title: "Windows",
      dataIndex: "install",
      render: (_, record) => <CommandCell probe={record.probe.windows} install={record.install.windows} />,
    },
  ];

  return (
    <Modal
      wrapClassName="manager-form-skin"
      className="program-environment-setup-modal"
      open={open}
      destroyOnClose
      width={960}
      title={t("programs.environment.title")}
      footer={null}
      onCancel={onClose}
    >
      <Space direction="vertical" size={16} style={{ width: "100%" }}>
        <div className="manager-table-subline">
          {t("programs.environment.executor")} · {toolName} · {modelForConfig(setupConfig)}
        </div>
        <Alert showIcon type="info" message={t("programs.environment.detail")} description={t("programs.environment.hint")} />
        <div className="manager-table-subline">{t("programs.environment.platformHint")}</div>
        {rows.length ? (
          <div className="manager-table">
            <Table<EnvironmentRow> rowKey="key" size="small" columns={columns} dataSource={rows} pagination={false} />
          </div>
        ) : (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("programs.environment.emptySelection")} />
        )}
        <Space>
          {!active ? (
            <Button icon={<ArrowLeftOutlined />} onClick={onBack}>
              {t("programs.environment.backToSelection")}
            </Button>
          ) : null}
          <Button
            type="primary"
            icon={items.length ? <ReloadOutlined /> : <PlayCircleOutlined />}
            loading={starting}
            disabled={!rows.length || active}
            onClick={() => void start()}
          >
            {t(items.length ? "programs.environment.rerun" : "programs.environment.start")}
          </Button>
          {active ? (
            <Button danger icon={<PauseCircleOutlined />} loading={stopping} onClick={() => void stop()}>
              {t("programs.environment.stop")}
            </Button>
          ) : null}
          <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void load(conversation?.threadId || "")}>
            {t("programs.environment.refresh")}
          </Button>
          {active ? <Tag color="processing" icon={<LoadingOutlined spin />}>{t("programs.environment.running")}</Tag> : null}
          {!active && items.length ? <Tag color="success" icon={<CheckCircleOutlined />}>{t("programs.environment.finished")}</Tag> : null}
        </Space>
        <div className="delivery-session-transcript program-environment-setup-transcript" ref={transcriptRef}>
          {loading && !conversation ? (
            <div className="delivery-session-transcript__loading"><LoadingOutlined spin /></div>
          ) : items.length ? (
            (conversation?.turns ?? []).map((turn) => (
              <Fragment key={turn.id}>
                {turn.items.map((item) => (
                  <article className={`delivery-session-message${item.type === "userMessage" ? " is-user" : ""}`} key={`${turn.id}-${item.id}-${item.type}`}>
                    <header>
                      <b>{item.type === "userMessage" ? t("delivery.session.you") : toolName}</b>
                      {item.status ? <small>{item.status}</small> : null}
                    </header>
                    <SessionMessageContent item={item} programId={programId} />
                  </article>
                ))}
              </Fragment>
            ))
          ) : (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("programs.environment.empty").replace("{tool}", toolName)} />
          )}
          {active ? <div className="delivery-session-thinking"><LoadingOutlined spin /> {toolName}</div> : null}
        </div>
      </Space>
    </Modal>
  );
}
