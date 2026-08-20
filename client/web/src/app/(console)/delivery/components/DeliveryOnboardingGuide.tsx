"use client";

import { FolderOpenOutlined, FormOutlined, PlayCircleOutlined, QuestionCircleOutlined } from "@ant-design/icons";
import { Alert, Button, Modal, Space, Steps, Tooltip, message } from "antd";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { useLocale } from "@/i18n/LocaleProvider";

type OnboardingStep = "projectEnvironment" | "requirementPlanning" | "taskExecution";
type OnboardingStatus = "in_progress" | "completed" | "dismissed";

interface DeliveryOnboardingState {
  version: 2;
  status: OnboardingStatus;
  step: OnboardingStep;
  programId: number;
  requirementKey: string;
  updatedAt: string;
}

interface DeliveryOnboardingGuideProps {
  enabled: boolean;
  userId: number;
  programId: number;
  activeRequirementKey: string;
  writtenRequirementKey: string;
  executionStartedVersion: number;
  onOpenRequirement: (requirementKey: string) => void;
  onShowTasks: (requirementKey: string) => void;
}

// v1 was released before the guide's first-entry trigger was reliable.  A new
// version gives each user one clean first visit with the corrected behaviour.
const STORAGE_KEY = "zb.delivery.onboarding.v2";

function storageKeyForUser(userId: number) {
  return userId > 0 ? `${STORAGE_KEY}:${userId}` : "";
}

function initialState(): DeliveryOnboardingState {
  return {
    version: 2,
    status: "in_progress",
    step: "projectEnvironment",
    programId: 0,
    requirementKey: "",
    updatedAt: "",
  };
}

function readState(userId: number): DeliveryOnboardingState | null {
  if (typeof window === "undefined") return null;
  const storageKey = storageKeyForUser(userId);
  if (!storageKey) return null;
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) return initialState();
    const value = JSON.parse(raw) as Partial<DeliveryOnboardingState>;
    if (value.version !== 2) return initialState();
    return {
      ...initialState(),
      ...value,
      programId: Number(value.programId) || 0,
      requirementKey: String(value.requirementKey || ""),
      step: ["projectEnvironment", "requirementPlanning", "taskExecution"].includes(value.step ?? "")
        ? value.step as OnboardingStep
        : "projectEnvironment",
      status: ["in_progress", "completed", "dismissed"].includes(value.status ?? "")
        ? value.status as OnboardingStatus
        : "in_progress",
    };
  } catch {
    return initialState();
  }
}

function saveState(userId: number, next: DeliveryOnboardingState) {
  const storageKey = storageKeyForUser(userId);
  if (!storageKey || typeof window === "undefined") return;
  window.localStorage.setItem(storageKey, JSON.stringify(next));
}

export function DeliveryOnboardingGuide({
  enabled,
  userId,
  programId,
  activeRequirementKey,
  writtenRequirementKey,
  executionStartedVersion,
  onOpenRequirement,
  onShowTasks,
}: DeliveryOnboardingGuideProps) {
  const { t } = useLocale();
  const router = useRouter();
  const [state, setState] = useState<DeliveryOnboardingState | null>(null);
  const [open, setOpen] = useState(false);

  const updateState = useCallback((patch: Partial<DeliveryOnboardingState>) => {
    setState((current) => {
      if (!current) return current;
      const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
      saveState(userId, next);
      return next;
    });
  }, [userId]);

  useEffect(() => {
    if (!enabled || !userId) {
      setState(null);
      setOpen(false);
      return;
    }
    const loaded = readState(userId);
    setState(loaded);
    setOpen(Boolean(loaded && loaded.status === "in_progress"));
  }, [enabled, userId]);

  useEffect(() => {
    if (!state || state.status !== "in_progress" || state.step !== "requirementPlanning") return;
    if (!activeRequirementKey || activeRequirementKey === state.requirementKey) return;
    updateState({ requirementKey: activeRequirementKey, programId: programId || state.programId });
  }, [activeRequirementKey, programId, state, updateState]);

  useEffect(() => {
    if (!state || state.status !== "in_progress" || state.step !== "requirementPlanning") return;
    if (!writtenRequirementKey || writtenRequirementKey !== state.requirementKey) return;
    updateState({ step: "taskExecution" });
    setOpen(true);
  }, [state, updateState, writtenRequirementKey]);

  useEffect(() => {
    if (!executionStartedVersion || !state || state.status !== "in_progress" || state.step !== "taskExecution") return;
    updateState({ status: "completed" });
    setOpen(false);
    message.success(t("delivery.onboarding.completed"));
  }, [executionStartedVersion, state, t, updateState]);

  if (!enabled || !userId || !state) return null;

  const stepIndex = state.step === "projectEnvironment" ? 0 : state.step === "requirementPlanning" ? 1 : 2;
  const openRequirement = () => {
    if (!programId) return;
    onOpenRequirement(state.requirementKey);
    setOpen(false);
  };

  return (
    <>
      <Tooltip title={t("delivery.onboarding.replay")}>
        <Button
          icon={<QuestionCircleOutlined />}
          aria-label={t("delivery.onboarding.replay")}
          onClick={() => {
            if (state.status !== "in_progress") updateState({ ...initialState(), status: "in_progress" });
            setOpen(true);
          }}
        />
      </Tooltip>
      <Modal
        open={open}
        closable={false}
        footer={null}
        title={t("delivery.onboarding.title")}
        width={640}
        zIndex={1100}
      >
        <Space direction="vertical" size={20} style={{ width: "100%" }}>
          <Alert showIcon type="info" message={t("delivery.onboarding.intro")} />
          <Steps
            current={stepIndex}
            items={[
              { title: t("delivery.onboarding.project.title") },
              { title: t("delivery.onboarding.requirement.title") },
              { title: t("delivery.onboarding.execution.title") },
            ]}
          />
          {state.step === "projectEnvironment" ? (
            <>
              <Alert showIcon type="warning" message={t("delivery.onboarding.project.description")} />
              <Space wrap>
                <Button icon={<FolderOpenOutlined />} onClick={() => router.push("/programs")}>
                  {t("delivery.onboarding.project.open")}
                </Button>
                <Button
                  type="primary"
                  disabled={!programId}
                  onClick={() => updateState({ step: "requirementPlanning", programId })}
                >
                  {t("delivery.onboarding.project.done")}
                </Button>
              </Space>
            </>
          ) : null}
          {state.step === "requirementPlanning" ? (
            <>
              <Alert
                showIcon
                type="info"
                message={t(activeRequirementKey || state.requirementKey
                  ? "delivery.onboarding.requirement.saved"
                  : "delivery.onboarding.requirement.description")}
              />
              <Button type="primary" icon={<FormOutlined />} disabled={!programId} onClick={openRequirement}>
                {t(activeRequirementKey || state.requirementKey
                  ? "delivery.onboarding.requirement.continue"
                  : "delivery.onboarding.requirement.open")}
              </Button>
            </>
          ) : null}
          {state.step === "taskExecution" ? (
            <>
              <Alert showIcon type="success" message={t("delivery.onboarding.execution.description")} />
              <Button
                type="primary"
                icon={<PlayCircleOutlined />}
                onClick={() => {
                  onShowTasks(state.requirementKey);
                  setOpen(false);
                }}
              >
                {t("delivery.onboarding.execution.open")}
              </Button>
            </>
          ) : null}
          <Space>
            <Button onClick={() => setOpen(false)}>{t("delivery.onboarding.later")}</Button>
            <Button
              type="link"
              onClick={() => {
                updateState({ status: "dismissed" });
                setOpen(false);
              }}
            >
              {t("delivery.onboarding.skip")}
            </Button>
          </Space>
        </Space>
      </Modal>
    </>
  );
}
