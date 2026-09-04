"use client";

import { CopyOutlined, DesktopOutlined, ExportOutlined, LinkOutlined, ReloadOutlined, ThunderboltOutlined } from "@ant-design/icons";
import { Button, Input, Modal, Progress, Select, Space, Switch, Tag, Tooltip, message } from "antd";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  type DeliveryTaskPlannerUpdateInstallation,
  fetchDeliveryTaskPlannerRuntimeInfo,
  fetchDeliveryTaskPlannerUpdate,
  installDeliveryTaskPlannerUpdate,
} from "@/api/delivery.api";
import { useLocale } from "@/i18n/LocaleProvider";
import {
  getLocalEnvironmentPreference,
  saveLocalEnvironmentPreference,
} from "@/project-workspaces/environmentPreferences";
import { ENVIRONMENT_PRESETS } from "@/project-workspaces/environmentPresets";
import {
  DELIVERY_TASK_PLANNER_DEFAULT_BRIDGE_URL,
  DELIVERY_TASK_PLANNER_REPOSITORY_URL,
  getDeliveryTaskPlannerBridgeUrl,
  normalizeDeliveryTaskPlannerBridgeUrl,
  saveDeliveryTaskPlannerBridgeUrl,
} from "@/project-workspaces/deliveryTaskPlanner";
import { ProgramEnvironmentSetupModal } from "@/app/(console)/programs/components/ProgramEnvironmentSetupModal";
import { copyTextToClipboard } from "@/utils/clipboard";

interface LocalEnvironmentPreferencesModalProps {
  open: boolean;
  onClose: () => void;
}

const ACTIVE_PLUGIN_UPDATE_STATES = new Set([
  "resolving",
  "downloading",
  "validating",
  "installing",
  "restart_required",
  "restarting",
]);

const VISIBLE_PLUGIN_UPDATE_STATES = new Set([
  "resolving",
  "downloading",
  "validating",
  "installing",
  "restart_required",
  "restarting",
  "completed",
  "failed",
]);

export function LocalEnvironmentPreferencesModal({ open, onClose }: LocalEnvironmentPreferencesModalProps) {
  const { locale, t } = useLocale();
  const [useGit, setUseGit] = useState(false);
  const [environments, setEnvironments] = useState<string[]>([]);
  const [bridgeUrl, setBridgeUrl] = useState("");
  const [setupOpen, setSetupOpen] = useState(false);
  const [pluginInstalled, setPluginInstalled] = useState(false);
  // 连不上桥接和插件没装是两回事：前者多半是端口被占或服务没起，后者才该去装插件。
  const [bridgeOffline, setBridgeOffline] = useState(false);
  const [pluginVersion, setPluginVersion] = useState("");
  const [pluginUpdatedAt, setPluginUpdatedAt] = useState("");
  const [pluginCheckedAt, setPluginCheckedAt] = useState(0);
  const [pluginStatusLoading, setPluginStatusLoading] = useState(false);
  const [pluginInstallation, setPluginInstallation] = useState<DeliveryTaskPlannerUpdateInstallation | null>(null);
  const pluginInstallationRef = useRef<DeliveryTaskPlannerUpdateInstallation | null>(null);

  // 桥接默认在本机，也允许指向远端服务；填空按默认处理，填错则先不去连。
  const probeBridgeUrl = normalizeDeliveryTaskPlannerBridgeUrl(bridgeUrl) || DELIVERY_TASK_PLANNER_DEFAULT_BRIDGE_URL;
  const bridgeUrlInvalid = Boolean(bridgeUrl.trim()) && !normalizeDeliveryTaskPlannerBridgeUrl(bridgeUrl);

  const setVisiblePluginInstallation = useCallback((installation?: DeliveryTaskPlannerUpdateInstallation | null) => {
    const visibleInstallation = installation && VISIBLE_PLUGIN_UPDATE_STATES.has(installation.status)
      ? installation
      : null;
    pluginInstallationRef.current = visibleInstallation;
    setPluginInstallation(visibleInstallation);
  }, []);

  const checkPluginRuntime = useCallback(async (showLoading = true) => {
    if (showLoading) setPluginStatusLoading(true);
    let serviceReachable = false;
    let runtimeVersionAvailable = false;
    try {
      const info = await fetchDeliveryTaskPlannerRuntimeInfo(probeBridgeUrl);
      serviceReachable = true;
      setBridgeOffline(false);
      runtimeVersionAvailable = info.installed && Boolean(info.version);
      setPluginInstalled(info.installed);
      setPluginVersion(info.version);
    } catch {
      // The update endpoint below is also the compatibility path for 0.3.x
      // bridges, which do not expose /v1/plugin/info yet.
    }

    try {
      const update = await fetchDeliveryTaskPlannerUpdate(false, probeBridgeUrl);
      serviceReachable = true;
      setBridgeOffline(false);
      if (!runtimeVersionAvailable && update.localVersion) {
        setPluginInstalled(true);
        setPluginVersion(update.localVersion);
      }
      setPluginUpdatedAt(update.localUpdatedAt);
      setPluginCheckedAt(update.checkedAt);
      setVisiblePluginInstallation(update.installation);
    } catch {
      if (!serviceReachable) {
        // A bridge restart briefly closes the loopback port. Preserve an active
        // job so polling continues and the progress can recover after restart.
        const current = pluginInstallationRef.current;
        if (!current || !ACTIVE_PLUGIN_UPDATE_STATES.has(current.status)) {
          setBridgeOffline(true);
          setPluginInstalled(false);
          setPluginVersion("");
          setPluginUpdatedAt("");
          setPluginCheckedAt(0);
          pluginInstallationRef.current = null;
          setPluginInstallation(null);
        }
      }
    } finally {
      if (showLoading) setPluginStatusLoading(false);
    }
  }, [probeBridgeUrl, setVisiblePluginInstallation]);

  useEffect(() => {
    if (!open) {
      setSetupOpen(false);
      return;
    }
    const saved = getLocalEnvironmentPreference();
    setUseGit(saved.useGit);
    setEnvironments(saved.environments);
    setBridgeUrl(getDeliveryTaskPlannerBridgeUrl());
  }, [open]);

  // 打开面板时，以及地址改完停手之后，都按当前填的地址重新探测一次插件状态。
  useEffect(() => {
    if (!open || bridgeUrlInvalid) return;
    const timer = window.setTimeout(() => {
      void checkPluginRuntime();
    }, 300);
    return () => window.clearTimeout(timer);
  }, [bridgeUrlInvalid, checkPluginRuntime, open]);

  useEffect(() => {
    if (!open || !pluginInstallation || !ACTIVE_PLUGIN_UPDATE_STATES.has(pluginInstallation.status)) return;
    const timer = window.setInterval(() => {
      void checkPluginRuntime(false);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [checkPluginRuntime, open, pluginInstallation?.jobId, pluginInstallation?.status]);

  const bridgeUrlHint = t("programs.environment.bridgeUrlHint")
    .replace("{default}", DELIVERY_TASK_PLANNER_DEFAULT_BRIDGE_URL);
  const bridgeOfflineHint = t("programs.environment.pluginBridgeOfflineHint")
    .replace("{url}", probeBridgeUrl);
  const pluginUpdateStatusLabel = pluginInstallation
    ? t(`programs.environment.pluginUpdate.${pluginInstallation.status}`)
    : "";

  const checkPluginUpdate = async () => {
    setPluginStatusLoading(true);
    let serviceReachable = false;
    try {
      let runtimeVersionAvailable = false;
      try {
        const info = await fetchDeliveryTaskPlannerRuntimeInfo(probeBridgeUrl);
        serviceReachable = true;
        runtimeVersionAvailable = info.installed && Boolean(info.version);
        setPluginInstalled(info.installed);
        setPluginVersion(info.version);
      } catch {
        // Older bridge versions do not expose /v1/plugin/info. The update
        // endpoint below still returns the installed version for them.
      }

      const update = await fetchDeliveryTaskPlannerUpdate(true, probeBridgeUrl);
      serviceReachable = true;
      if (!runtimeVersionAvailable && update.localVersion) {
        setPluginInstalled(true);
        setPluginVersion(update.localVersion);
      }
      setPluginUpdatedAt(update.localUpdatedAt);
      setPluginCheckedAt(update.checkedAt);
      setVisiblePluginInstallation(update.installation);

      const installationInProgress = update.installation
        && ACTIVE_PLUGIN_UPDATE_STATES.has(update.installation.status);
      if (!update.updateAvailable || !update.remoteVersion || installationInProgress) return;

      setVisiblePluginInstallation(await installDeliveryTaskPlannerUpdate(update.remoteVersion, probeBridgeUrl));
    } catch (error) {
      message.error((error as Error).message || t("programs.environment.pluginUpdate.failed"));
    } finally {
      // 一次都没调通就是桥接没起来：这时候手上的版本号也已经不可信了。
      setBridgeOffline(!serviceReachable);
      if (!serviceReachable) {
        setPluginInstalled(false);
        setPluginVersion("");
        setPluginUpdatedAt("");
        setPluginCheckedAt(0);
      }
      setPluginStatusLoading(false);
    }
  };

  const savePreferences = () => {
    if (bridgeUrlInvalid) {
      message.error(t("programs.environment.bridgeUrlInvalid"));
      return false;
    }
    saveLocalEnvironmentPreference(useGit, environments);
    saveDeliveryTaskPlannerBridgeUrl(bridgeUrl);
    return true;
  };

  const save = () => {
    if (!savePreferences()) return;
    message.success(t("programs.environment.preferencesSaved"));
    onClose();
  };

  const openSetup = () => {
    if (!savePreferences()) return;
    setSetupOpen(true);
  };

  return (
    <>
      <Modal
        wrapClassName="manager-form-skin"
        className="local-environment-preferences-modal"
        open={open && !setupOpen}
        destroyOnClose
        width={680}
        title={(
          <div className="local-environment-preferences__title">
            <span className="local-environment-preferences__title-icon"><DesktopOutlined /></span>
            <span>
              <b>{t("programs.environment.preferencesTitle")}</b>
              <small>{t("programs.environment.preferencesHint")}</small>
            </span>
          </div>
        )}
        onCancel={onClose}
        footer={(
          <div className="local-environment-preferences__footer">
            <Button
              className="local-environment-preferences__setup"
              icon={<ThunderboltOutlined />}
              disabled={!useGit && !environments.length}
              onClick={openSetup}
            >
              {t("programs.environment.setup")}
            </Button>
            <Space size={8}>
              <Button onClick={onClose}>{t("common.cancel")}</Button>
              <Button type="primary" onClick={save}>{t("programs.environment.save")}</Button>
            </Space>
          </div>
        )}
      >
        <div className="local-environment-preferences">
          <section className="local-environment-preferences__settings" aria-label={t("programs.environment.preferencesTitle")}>
            <div className="local-environment-preferences__setting-row">
              <div className="local-environment-preferences__copy">
                <b>{t("programs.environment.useGit")}</b>
                <p>{t("programs.environment.useGitHint")}</p>
              </div>
              <Switch checked={useGit} aria-label={t("programs.environment.useGit")} onChange={setUseGit} />
            </div>
            <div className="local-environment-preferences__setting-row is-selection">
              <div className="local-environment-preferences__copy">
                <b>{t("programs.environment.selection")}</b>
                <p>{t("programs.environment.selectionHint")}</p>
              </div>
              <Select
                className="local-environment-preferences__select"
                mode="tags"
                allowClear
                value={environments}
                placeholder={t("programs.environment.selectionPlaceholder")}
                onChange={(value: string[]) => setEnvironments(value.map((item) => item.trim()).filter(Boolean))}
                options={ENVIRONMENT_PRESETS.map((preset) => ({
                  value: preset.id,
                  label: `${preset.label} · ${preset.requirement}`,
                }))}
              />
            </div>
            <div className="local-environment-preferences__setting-row is-selection">
              <div className="local-environment-preferences__copy">
                <b>{t("programs.environment.bridgeUrl")}</b>
                <p>{bridgeUrlHint}</p>
              </div>
              <div className="local-environment-preferences__bridge">
                <Input
                  allowClear
                  spellCheck={false}
                  value={bridgeUrl}
                  status={bridgeUrlInvalid ? "error" : undefined}
                  placeholder={DELIVERY_TASK_PLANNER_DEFAULT_BRIDGE_URL}
                  aria-label={t("programs.environment.bridgeUrl")}
                  onChange={(event) => setBridgeUrl(event.target.value)}
                />
                {bridgeUrlInvalid ? (
                  <p className="local-environment-preferences__bridge-error">
                    {t("programs.environment.bridgeUrlInvalid")}
                  </p>
                ) : null}
              </div>
            </div>
          </section>
          <section className="local-environment-preferences__plugin" aria-label={t("programs.environment.pluginTitle")}>
            <span className="local-environment-preferences__plugin-icon"><LinkOutlined /></span>
            <div className="local-environment-preferences__plugin-content">
              <div className="local-environment-preferences__plugin-heading">
                <b>{t("programs.environment.pluginTitle")}</b>
                <Button
                  type="text"
                  size="small"
                  icon={<ReloadOutlined />}
                  loading={pluginStatusLoading}
                  onClick={() => void checkPluginUpdate()}
                >
                  {t("programs.environment.pluginVersionCheck")}
                </Button>
              </div>
              <div className="local-environment-preferences__plugin-runtime">
                <span>{t("programs.environment.pluginVersion")}</span>
                {pluginStatusLoading ? (
                  <Tag>{t("programs.environment.pluginChecking")}</Tag>
                ) : bridgeOffline ? (
                  <Tooltip title={bridgeOfflineHint}>
                    <Tag color="orange">{t("programs.environment.pluginBridgeOffline")}</Tag>
                  </Tooltip>
                ) : pluginInstalled && pluginVersion ? (
                  <Tag color="green">{pluginVersion}</Tag>
                ) : (
                  <Tag>{t("programs.environment.pluginNotInstalled")}</Tag>
                )}
              </div>
              <div className="local-environment-preferences__plugin-runtime">
                <span>{t("programs.environment.pluginUpdatedAt")}</span>
                <span className="manager-mono">
                  {pluginUpdatedAt ? new Date(pluginUpdatedAt).toLocaleString(locale, { hour12: false }) : "-"}
                </span>
              </div>
              <div className="local-environment-preferences__plugin-runtime">
                <span>{t("programs.environment.pluginCheckedAt")}</span>
                <span className="manager-mono">
                  {pluginCheckedAt ? new Date(pluginCheckedAt * 1000).toLocaleString(locale, { hour12: false }) : "-"}
                </span>
              </div>
              {pluginInstallation ? (
                <div className="local-environment-preferences__plugin-progress">
                  <div className="local-environment-preferences__plugin-progress-heading">
                    <span>{pluginUpdateStatusLabel}</span>
                    <span>{pluginInstallation.progress}%</span>
                  </div>
                  <Progress
                    percent={Math.max(0, Math.min(100, pluginInstallation.progress))}
                    size="small"
                    showInfo={false}
                    status={pluginInstallation.status === "completed"
                      ? "success"
                      : pluginInstallation.status === "failed"
                        ? "exception"
                        : "active"}
                  />
                  {pluginInstallation.message ? (
                    <p
                      className="local-environment-preferences__plugin-progress-message"
                      data-failed={pluginInstallation.status === "failed" ? "true" : undefined}
                    >
                      {pluginInstallation.message}
                    </p>
                  ) : null}
                </div>
              ) : null}
              <div className="local-environment-plugin-link">
                <a href={DELIVERY_TASK_PLANNER_REPOSITORY_URL} target="_blank" rel="noreferrer">
                  {DELIVERY_TASK_PLANNER_REPOSITORY_URL}
                </a>
                <Space size={2}>
                  <Tooltip title={t("programs.environment.pluginCopy")}>
                    <Button
                      type="text"
                      size="small"
                      icon={<CopyOutlined />}
                      aria-label={t("programs.environment.pluginCopy")}
                      onClick={() => {
                        void copyTextToClipboard(DELIVERY_TASK_PLANNER_REPOSITORY_URL)
                          .then(() => message.success(t("programs.environment.pluginCopied")))
                          .catch(() => message.error(t("programs.environment.pluginCopyFailed")));
                      }}
                    />
                  </Tooltip>
                  <Tooltip title={t("programs.environment.pluginOpen")}>
                    <Button
                      type="text"
                      size="small"
                      icon={<ExportOutlined />}
                      aria-label={t("programs.environment.pluginOpen")}
                      href={DELIVERY_TASK_PLANNER_REPOSITORY_URL}
                      target="_blank"
                    />
                  </Tooltip>
                </Space>
              </div>
            </div>
          </section>
        </div>
      </Modal>

      <ProgramEnvironmentSetupModal
        open={open && setupOpen}
        useGit={useGit}
        environments={environments}
        onClose={onClose}
        onBack={() => setSetupOpen(false)}
      />
    </>
  );
}
