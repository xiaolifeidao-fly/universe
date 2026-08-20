"use client";

import { CopyOutlined, DesktopOutlined, ExportOutlined, LinkOutlined, ThunderboltOutlined } from "@ant-design/icons";
import { Button, Modal, Select, Space, Switch, Tooltip, message } from "antd";
import { useEffect, useState } from "react";
import { useLocale } from "@/i18n/LocaleProvider";
import {
  getLocalEnvironmentPreference,
  saveLocalEnvironmentPreference,
} from "@/project-workspaces/environmentPreferences";
import { ENVIRONMENT_PRESETS } from "@/project-workspaces/environmentPresets";
import { DELIVERY_TASK_PLANNER_REPOSITORY_URL } from "@/project-workspaces/deliveryTaskPlanner";
import { ProgramEnvironmentSetupModal } from "@/app/(console)/programs/components/ProgramEnvironmentSetupModal";
import { copyTextToClipboard } from "@/utils/clipboard";

interface LocalEnvironmentPreferencesModalProps {
  open: boolean;
  onClose: () => void;
}

export function LocalEnvironmentPreferencesModal({ open, onClose }: LocalEnvironmentPreferencesModalProps) {
  const { t } = useLocale();
  const [useGit, setUseGit] = useState(false);
  const [environments, setEnvironments] = useState<string[]>([]);
  const [setupOpen, setSetupOpen] = useState(false);

  useEffect(() => {
    if (!open) {
      setSetupOpen(false);
      return;
    }
    const saved = getLocalEnvironmentPreference();
    setUseGit(saved.useGit);
    setEnvironments(saved.environments);
  }, [open]);

  const save = () => {
    saveLocalEnvironmentPreference(useGit, environments);
    message.success(t("programs.environment.preferencesSaved"));
    onClose();
  };

  const openSetup = () => {
    saveLocalEnvironmentPreference(useGit, environments);
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
          </section>
          <section className="local-environment-preferences__plugin" aria-label={t("programs.environment.pluginTitle")}>
            <span className="local-environment-preferences__plugin-icon"><LinkOutlined /></span>
            <div className="local-environment-preferences__plugin-content">
              <b>{t("programs.environment.pluginTitle")}</b>
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
