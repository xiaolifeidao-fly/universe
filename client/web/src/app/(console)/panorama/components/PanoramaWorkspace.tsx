"use client";

import {
  CloseOutlined,
  FullscreenExitOutlined,
  FullscreenOutlined,
  ReloadOutlined,
} from "@ant-design/icons";
import { Button, Empty, Segmented, Select, Spin, message } from "antd";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useBusinessLine } from "@/business-lines/BusinessLineProvider";
import { useLocale } from "@/i18n/LocaleProvider";
import { getUserScopedStorageKey } from "@/utils/auth";
import {
  fetchBoard,
  fetchPrograms,
  fetchRequirements,
  type DeliveryBoard,
  type DeliveryProgramRecord,
  type DeliveryRequirementRecord,
  type DeliveryStageProgress,
  type RequirementStatus,
} from "@/api/delivery.api";
import {
  PANORAMA_UNASSIGNED_MODULE_KEY,
  PANORAMA_UNASSIGNED_STAGE_KEY,
  PanoramaStage,
  panoramaRequirementGroupKey,
  type PanoramaLayout,
  type PanoramaPick,
} from "./PanoramaStage";

// 和看板页共用同一个记忆键：两个页面切来切去，选中的项目应该是同一个。
const PROGRAM_KEY = "zb.delivery.programId";

/** 和三维里 healthColor 同一套阈值，卡片条的色条不能和球对不上。 */
function moduleAccent(progress: number): string {
  if (progress < 15) return "#f43f5e";
  if (progress < 70) return "#fbbf24";
  return "#34d399";
}

function requirementAccent(status: RequirementStatus): string {
  if (status === "done") return "#34d399";
  if (status === "dropped") return "#46536e";
  return "#22d3ee";
}

function requirementProgress(status: RequirementStatus): number {
  return status === "done" ? 100 : 0;
}

interface PanoramaDetail {
  kicker: string;
  title: string;
  subtitle: string;
  accent: string;
  progress: number;
  meta: [string, string][];
  requirements: DeliveryRequirementRecord[];
}

interface PanoramaGroupCard {
  key: string;
  name: string;
  kicker: string;
  progress: number;
}

export function PanoramaWorkspace() {
  const { t } = useLocale();
  const { activeBusinessLine } = useBusinessLine();
  const bizLine = activeBusinessLine.id;
  const programStorageKey = getUserScopedStorageKey(PROGRAM_KEY);
  const [programs, setPrograms] = useState<DeliveryProgramRecord[]>([]);
  const [programId, setProgramId] = useState<number>(0);
  const [board, setBoard] = useState<DeliveryBoard | null>(null);
  const [requirements, setRequirements] = useState<DeliveryRequirementRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [layout, setLayout] = useState<PanoramaLayout>("module");
  const [picked, setPicked] = useState<PanoramaPick | null>(null);
  const [focus, setFocus] = useState<PanoramaPick | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const shellRef = useRef<HTMLDivElement>(null);

  // Esc 退出聚焦。全屏状态下这一下是浏览器用来退出全屏的，别顺手把聚焦也清了。
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !document.fullscreenElement) setFocus(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // 全屏状态由浏览器说了算：Esc、F11、系统手势都会改它，只能监听不能自己记。
  useEffect(() => {
    const sync = () => setFullscreen(document.fullscreenElement === shellRef.current);
    document.addEventListener("fullscreenchange", sync);
    return () => document.removeEventListener("fullscreenchange", sync);
  }, []);

  const toggleFullscreen = useCallback(async () => {
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else {
        await shellRef.current?.requestFullscreen();
      }
    } catch (error) {
      message.error((error as Error).message);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetchPrograms(bizLine)
      .then((list) => {
        if (cancelled) return;
        setPrograms(list);
        const remembered = Number(programStorageKey ? window.sessionStorage.getItem(programStorageKey) : "");
        setProgramId(list.find((item) => item.programId === remembered)?.programId ?? list[0]?.programId ?? 0);
      })
      .catch((error: Error) => {
        if (!cancelled) message.error(error.message);
      });
    return () => {
      cancelled = true;
    };
  }, [bizLine, programStorageKey]);

  const refresh = useCallback(async () => {
    if (!programId) {
      setBoard(null);
      setRequirements([]);
      return;
    }
    if (programStorageKey) window.sessionStorage.setItem(programStorageKey, String(programId));
    setLoading(true);
    try {
      // 看板提供模块进度；需求列表提供小球的权威归属与状态。
      const [nextBoard, requirementPage] = await Promise.all([
        fetchBoard({ programId, groupBy: "module" }),
        fetchRequirements({ programId }),
      ]);
      setBoard(nextBoard);
      setRequirements(requirementPage.data);
    } catch (error) {
      message.error((error as Error).message);
    } finally {
      setLoading(false);
    }
  }, [bizLine, programId, programStorageKey]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const overview = board?.overview;
  const modules = useMemo(() => {
    const configured = overview?.moduleProgress ?? [];
    if (!requirements.some((requirement) => !requirement.moduleKey)) return configured;
    return [
      ...configured,
      {
        moduleKey: PANORAMA_UNASSIGNED_MODULE_KEY,
        name: t("delivery.panorama.unassignedModule"),
        weight: 0,
        kind: "",
        total: 0,
        doneCount: 0,
        progress: 0,
      },
    ];
  }, [overview?.moduleProgress, requirements, t]);
  const stages = useMemo<DeliveryStageProgress[]>(() => {
    const configured = overview?.stageProgress ?? [];
    if (!requirements.some((requirement) => !requirement.stageKey)) return configured;
    return [
      ...configured,
      {
        stageKey: PANORAMA_UNASSIGNED_STAGE_KEY,
        tag: t("delivery.panorama.unassignedStage"),
        maturityLevel: "",
        total: 0,
        doneCount: 0,
        progress: 0,
      },
    ];
  }, [overview?.stageProgress, requirements, t]);
  const groupCards = useMemo<PanoramaGroupCard[]>(() => {
    if (layout === "module") {
      return modules.map((module) => ({
        key: module.moduleKey,
        name: module.name,
        kicker: `${t("delivery.field.moduleKey")} · ${module.weight}%`,
        progress: module.progress,
      }));
    }
    return stages.map((stage) => ({
      key: stage.stageKey,
      name: stage.tag,
      kicker: `${t("delivery.field.stageKey")}${stage.maturityLevel ? ` · ${stage.maturityLevel}` : ""}`,
      progress: stage.progress,
    }));
  }, [layout, modules, stages, t]);

  // 侧面板内容：大球显示当前分组（模块或里程碑），小球显示该条需求。
  const detail = useMemo<PanoramaDetail | null>(() => {
    if (!picked || !overview) return null;
    if (picked.kind === "requirement") {
      const requirement = requirements.find((entry) => entry.requirementKey === picked.key);
      if (!requirement) return null;
      const module = modules.find(
        (entry) => entry.moduleKey === (requirement.moduleKey || PANORAMA_UNASSIGNED_MODULE_KEY),
      );
      const stage = stages.find(
        (entry) => entry.stageKey === (requirement.stageKey || PANORAMA_UNASSIGNED_STAGE_KEY),
      );
      return {
        kicker: t(`delivery.requirement.status.${requirement.status}`),
        title: requirement.name || requirement.requirementKey,
        subtitle: requirement.detail,
        accent: requirementAccent(requirement.status),
        progress: requirementProgress(requirement.status),
        meta: [
          [t("delivery.requirement.status"), t(`delivery.requirement.status.${requirement.status}`)],
          [t("delivery.field.moduleKey"), module?.name || requirement.moduleKey || "—"],
          [t("delivery.field.stageKey"), stage?.tag || requirement.stageKey || "—"],
          [t("delivery.requirement.owners"), requirement.owners.map((owner) => owner.name).filter(Boolean).join("、") || t("delivery.unassigned")],
          [t("delivery.requirement.taskCount"), String(requirement.itemCount)],
        ] as [string, string][],
        requirements: [],
      };
    }
    if (picked.kind === "core") {
      return {
        kicker: t("delivery.kpi.maturity"),
        title: `${Math.round(overview.maturityScore)}%`,
        subtitle: t("delivery.kpi.maturityHint"),
        accent: "#22d3ee",
        progress: overview.maturityScore,
        meta: [
          [t("delivery.kpi.total"), String(overview.totalCount)],
          [t("delivery.status.doing"), String(overview.statusCounts?.doing ?? 0)],
          [t("delivery.status.done"), String(overview.statusCounts?.done ?? 0)],
          [t("delivery.status.blocked"), String(overview.statusCounts?.blocked ?? 0)],
        ] as [string, string][],
        requirements: [],
      };
    }

    const groupRequirements = requirements.filter(
      (requirement) => panoramaRequirementGroupKey(requirement, layout) === picked.key,
    );
    if (layout === "module") {
      const module = modules.find((entry) => entry.moduleKey === picked.key);
      if (!module) return null;
      return {
        kicker: `${t("delivery.panorama.weight")} ${module.weight}%`,
        title: module.name,
        subtitle: "",
        accent: "#22d3ee",
        progress: module.progress,
        meta: [
          [t("delivery.field.progress"), `${module.progress}%`],
          [t("delivery.status.done"), `${module.doneCount}/${module.total}`],
          [t("delivery.panorama.requirements"), String(groupRequirements.length)],
        ] as [string, string][],
        requirements: groupRequirements,
      };
    }

    const stage = stages.find((entry) => entry.stageKey === picked.key);
    if (!stage) return null;
    return {
      kicker: stage.maturityLevel,
      title: stage.tag,
      subtitle: "",
      accent: "#22d3ee",
      progress: stage.progress,
      meta: [
        [t("delivery.field.progress"), `${stage.progress}%`],
        [t("delivery.status.done"), `${stage.doneCount}/${stage.total}`],
        [t("delivery.panorama.requirements"), String(groupRequirements.length)],
      ] as [string, string][],
      requirements: groupRequirements,
    };
  }, [layout, modules, overview, picked, requirements, stages, t]);

  return (
    <div className="pano-page">
      <div className="pano-toolbar">
        <Select
          value={programId || undefined}
          style={{ minWidth: 180 }}
          placeholder={t("delivery.selectProgram")}
          onChange={setProgramId}
          options={programs.map((program) => ({
            value: program.programId,
            label: program.name || program.programId,
          }))}
        />
        <Segmented
          value={layout}
          onChange={(value) => {
            setLayout(value as PanoramaLayout);
            setPicked(null);
            setFocus(null);
          }}
          options={[
            { label: t("delivery.panorama.module"), value: "module" },
            { label: t("delivery.panorama.stage"), value: "stage" },
          ]}
        />
        <Button icon={<ReloadOutlined />} loading={loading} disabled={!programId} onClick={() => void refresh()} />
        <Button
          icon={fullscreen ? <FullscreenExitOutlined /> : <FullscreenOutlined />}
          disabled={!programId}
          onClick={() => void toggleFullscreen()}
        >
          {t(fullscreen ? "delivery.panorama.exitFullscreen" : "delivery.panorama.fullscreen")}
        </Button>
        <span className="pano-toolbar-spacer" />
        {overview ? (
          <div className="pano-kpi">
            <div>
              <span>{t("delivery.kpi.maturity")}</span>
              <b style={{ color: "#34d399" }}>{Math.round(overview.maturityScore)}%</b>
            </div>
            <div>
              <span>{t("delivery.kpi.total")}</span>
              <b>{overview.totalCount}</b>
            </div>
            <div>
              <span>{t("delivery.status.blocked")}</span>
              <b style={{ color: "#f43f5e" }}>{overview.statusCounts?.blocked ?? 0}</b>
            </div>
          </div>
        ) : null}
      </div>

      <Spin spinning={loading}>
        {!programId || !overview ? (
          <div className="pano-empty">
            <Empty description={t("delivery.noProgram")} />
          </div>
        ) : (
          <div className={`pano-shell${fullscreen ? " is-fullscreen" : ""}`} ref={shellRef}>
            {/* 全屏后工具条被留在了外面，把最少的一组控制搬进来 */}
            {fullscreen ? (
              <div className="pano-fsbar">
                <b>{overview.name || t("delivery.panorama.heroTitle")}</b>
                <button
                  type="button"
                  className={layout === "module" ? "is-on" : ""}
                  onClick={() => {
                    setLayout("module");
                    setPicked(null);
                    setFocus(null);
                  }}
                >
                  {t("delivery.panorama.module")}
                </button>
                <button
                  type="button"
                  className={layout === "stage" ? "is-on" : ""}
                  onClick={() => {
                    setLayout("stage");
                    setPicked(null);
                    setFocus(null);
                  }}
                >
                  {t("delivery.panorama.stage")}
                </button>
                <span className="pano-fsbar-kpi">
                  {t("delivery.kpi.maturity")} <em>{Math.round(overview.maturityScore)}%</em>
                </span>
                <button type="button" className="is-exit" onClick={() => void toggleFullscreen()}>
                  {t("delivery.panorama.exitFullscreen")}
                </button>
              </div>
            ) : null}
            <PanoramaStage
              layout={layout}
              modules={modules}
              stages={stages}
              requirements={requirements}
              maturityScore={overview.maturityScore}
              selectedKey={picked?.key}
              panelOpen={Boolean(detail)}
              focusKey={focus?.key}
              onPick={setPicked}
              onFocus={setFocus}
            />

            {focus ? (
              <div className="pano-focus">
                <div>
                  <em>{t("delivery.panorama.focusing")}</em>
                  <b>{focus.name || focus.key}</b>
                </div>
                <button type="button" onClick={() => setFocus(null)}>
                  {t("delivery.panorama.focusOut")}
                </button>
              </div>
            ) : null}

            <div className="pano-hero">
              <h2>{overview.name || t("delivery.panorama.heroTitle")}</h2>
              <p>{t("delivery.panorama.heroBody")}</p>
            </div>

            {/* 大球按当前分组进度着色，小球按需求状态着色。 */}
            <div className="pano-legend">
              <b>{t("delivery.panorama.legendTitle")}</b>
              <div><i style={{ background: "#22d3ee" }} />{t("delivery.requirement.status.open")}</div>
              <div><i style={{ background: "#34d399" }} />{t("delivery.requirement.status.done")}</div>
              <div><i style={{ background: "#46536e" }} />{t("delivery.requirement.status.dropped")}</div>
              <em>
                {t("delivery.panorama.requirementCount").replace("{n}", String(requirements.length))}
                {" · "}
                {t("delivery.panorama.hint")}
              </em>
            </div>

            {/* 底部卡片条：和当前视图的大球一一对应。 */}
            <div className="pano-cards">
              {groupCards.map((group) => (
                <button
                  type="button"
                  key={group.key}
                  className={`pano-card${focus?.key === group.key ? " is-focus" : ""}`}
                  style={{ ["--card-accent" as string]: moduleAccent(group.progress) }}
                  onClick={() => setPicked({ kind: "node", key: group.key, name: group.name })}
                  onDoubleClick={() => setFocus({ kind: "node", key: group.key, name: group.name })}
                >
                  <span className="pano-card-kicker">{group.kicker}</span>
                  <b>{group.name}</b>
                  <small>
                    {requirements.filter(
                      (requirement) => panoramaRequirementGroupKey(requirement, layout) === group.key,
                    ).length} {t("delivery.panorama.requirements")}
                    {" · "}
                    {Math.round(group.progress)}%
                  </small>
                  <i style={{ width: `${group.progress}%` }} />
                </button>
              ))}
            </div>

            <aside className={`pano-panel${detail ? " is-open" : ""}`}>
              {detail ? (
                <>
                  <button type="button" className="pano-panel-close" onClick={() => setPicked(null)}>
                    <CloseOutlined />
                  </button>
                  <div className="pano-panel-kicker">{detail.kicker}</div>
                  <div className="pano-panel-title">{detail.title}</div>
                  {detail.subtitle ? <div className="pano-panel-sub">{detail.subtitle}</div> : null}
                  <div className="pano-panel-rail">
                    <i style={{ width: `${detail.progress}%`, background: detail.accent }} />
                  </div>
                  <dl className="pano-panel-meta">
                    {detail.meta.map(([label, value]) => (
                      <div key={label}>
                        <dt>{label}</dt>
                        <dd>{value}</dd>
                      </div>
                    ))}
                  </dl>
                  {detail.requirements.length > 0 ? (
                    <ul className="pano-panel-list">
                      {detail.requirements.map((requirement) => (
                        <li key={requirement.requirementKey} onClick={() => setPicked({ kind: "requirement", key: requirement.requirementKey })}>
                          <i style={{ background: requirementAccent(requirement.status) }} />
                          <span>
                            <b>{requirement.name || requirement.requirementKey}</b>
                            <small>{requirement.detail}</small>
                          </span>
                          <em>{t(`delivery.requirement.status.${requirement.status}`)}</em>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </>
              ) : null}
            </aside>
          </div>
        )}
      </Spin>
    </div>
  );
}
