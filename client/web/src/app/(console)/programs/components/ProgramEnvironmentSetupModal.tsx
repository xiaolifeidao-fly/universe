"use client";

import { ArrowLeftOutlined, CheckCircleOutlined, CopyOutlined, InfoCircleOutlined, LoadingOutlined, PauseCircleOutlined, PlayCircleOutlined, ReloadOutlined, SendOutlined, ToolOutlined } from "@ant-design/icons";
import { Button, Empty, Input, Modal, Space, Table, Tag, Tooltip, message } from "antd";
import type { ColumnsType } from "antd/es/table";
import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { effortForConfig, modelForConfig, toolDisplayName, useAIPreferences } from "@/ai-preferences/AIPreferencesProvider";
import {
  fetchCodexEnvironmentSetupConversation,
  startCodexEnvironmentSetup,
  stopCodexEnvironmentSetup,
  type CodexEnvironmentSetupConversation,
} from "@/api/delivery.api";
import { useLocale } from "@/i18n/LocaleProvider";
import { copyTextToClipboard } from "@/utils/clipboard";
import { GIT_PRESET, describeEnvironment, type EnvironmentCommands } from "@/project-workspaces/environmentPresets";
import { useStickToBottom } from "../../delivery/hooks/useStickToBottom";
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
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);

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
      setDraft("");
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
  const githubSshStatus = statusesById.get(GIT_PRESET.id);
  const githubSshPublicKey = githubSshStatus?.githubSshPublicKey || "";

  const { ref: transcriptRef, onScroll: onTranscriptScroll } = useStickToBottom<HTMLDivElement>([active, items.length]);

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

  /** 续聊：会话在跑就把话追加进当前回合，没在跑就用这句话续起上一条会话。 */
  const send = async () => {
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    try {
      const action = await startCodexEnvironmentSetup({
        useGit,
        environments,
        message: text,
        threadId: conversation?.threadId || "",
        newConversation: false,
        provider,
        model: modelForConfig(setupConfig),
        reasoningEffort: effortForConfig(setupConfig),
        fastMode: provider === "claude" && setupConfig.claudeFastMode,
      });
      setDraft("");
      await load(action.threadId || conversation?.threadId || "");
    } catch (error) {
      message.error((error as Error).message);
    } finally {
      setSending(false);
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
            {record.id === GIT_PRESET.id ? (
              <Tag color={status?.githubSshConfigured ? "success" : "warning"}>
                {t(status?.githubSshConfigured ? "programs.environment.githubSshReady" : "programs.environment.githubSshMissing")}
              </Tag>
            ) : null}
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
      title={(
        <div className="program-environment-setup__title">
          <span className="program-environment-setup__title-icon"><ToolOutlined /></span>
          <span>
            <b>{t("programs.environment.title")}</b>
            <small>{t("programs.environment.executor")} · {toolName} · {modelForConfig(setupConfig)}</small>
          </span>
        </div>
      )}
      footer={null}
      onCancel={onClose}
    >
      <div className="program-environment-setup">
        <section className="program-environment-setup__summary">
          <div className="program-environment-setup__overview">
            <span className="program-environment-setup__overview-icon"><InfoCircleOutlined /></span>
            <div>
              <b>{t("programs.environment.detail")}</b>
              <p>{t("programs.environment.hint")}</p>
            </div>
          </div>
          <p className="program-environment-setup__platform-hint">{t("programs.environment.platformHint")}</p>
          {rows.length ? (
            <div className="manager-table program-environment-setup__table">
              <Table<EnvironmentRow> rowKey="key" size="small" columns={columns} dataSource={rows} pagination={false} />
            </div>
          ) : (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("programs.environment.emptySelection")} />
          )}
          {useGit ? (
            <section className={`program-environment-setup__ssh${githubSshStatus?.githubSshConfigured ? " is-ready" : " is-warning"}`}>
              <span className="program-environment-setup__ssh-icon"><CheckCircleOutlined /></span>
              <div className="program-environment-setup__ssh-copy">
                <b>{t("programs.environment.githubSshTitle")}</b>
                <span>
                  {githubSshPublicKey
                    ? t("programs.environment.githubSshReadyHint")
                    : githubSshStatus?.githubSshError
                      ? t("programs.environment.githubSshError").replace("{error}", githubSshStatus.githubSshError)
                      : t("programs.environment.githubSshMissingHint")}
                </span>
                {githubSshPublicKey ? (
                  <div className="program-environment-github-key__value">
                    <code className="manager-mono">{githubSshPublicKey}</code>
                    <Tooltip title={t("programs.environment.githubSshCopy")}>
                      <Button
                        type="text"
                        size="small"
                        icon={<CopyOutlined />}
                        aria-label={t("programs.environment.githubSshCopy")}
                        onClick={() => {
                          void copyTextToClipboard(githubSshPublicKey)
                            .then(() => message.success(t("programs.environment.githubSshCopied")))
                            .catch(() => message.error(t("programs.environment.githubSshCopyFailed")));
                        }}
                      />
                    </Tooltip>
                  </div>
                ) : null}
              </div>
            </section>
          ) : null}
        </section>
        <div className="program-environment-setup__actions">
          <Space size={8} wrap>
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
        </div>
        <div className="delivery-session-transcript program-environment-setup-transcript" ref={transcriptRef} onScroll={onTranscriptScroll}>
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
        <footer className="delivery-session-composer is-stacked program-environment-setup__composer">
          <div className="delivery-session-composer__input">
            <Input.TextArea
              autoSize={{ minRows: 2, maxRows: 6 }}
              value={draft}
              disabled={sending}
              placeholder={t("programs.environment.input")}
              onChange={(event) => setDraft(event.target.value)}
              onPressEnter={(event) => {
                if (event.shiftKey) return;
                event.preventDefault();
                void send();
              }}
            />
            <Button type="primary" icon={<SendOutlined />} loading={sending} disabled={!draft.trim()} onClick={() => void send()}>
              {t("delivery.session.send")}
            </Button>
          </div>
          <small className="program-environment-setup__composer-hint">{t("programs.environment.inputHint")}</small>
        </footer>
      </div>
    </Modal>
  );
}
