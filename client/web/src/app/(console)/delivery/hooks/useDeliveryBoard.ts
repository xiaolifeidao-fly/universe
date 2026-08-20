"use client";

import { message } from "antd";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useBusinessLine } from "@/business-lines/BusinessLineProvider";
import { effortForConfig, modelForConfig, sceneForPhase, useAIPreferences } from "@/ai-preferences/AIPreferencesProvider";
import { getUserScopedStorageKey } from "@/utils/auth";
import {
  advanceDeliveryPhase,
  createItem,
  deleteItem,
  fetchCodexBridgeHealth,
  fetchBoard,
  fetchItems,
  fetchModules,
  fetchPrograms,
  fetchRequirement,
  fetchRequirements,
  fetchStages,
  patchItem,
  rebuildSnapshot,
  startCodexExecutionBatch,
  startCodexExecution,
  startCodexExecutionSequence,
  startCodexTaskTestingCases,
  type BoardGroupBy,
  type CreateItemPayload,
  type DeliveryBoard,
  type CodexBridgeHealth,
  type DeliveryItemRecord,
  type DeliveryModuleRecord,
  type DeliveryProgramRecord,
  type DeliveryRequirementRecord,
  type DeliveryStageRecord,
  type PatchItemPayload,
} from "@/api/delivery.api";

const PROGRAM_KEY = "zb.delivery.programId";

export interface DeliveryBoardShareFilter {
  /** 分享链接指定的项目优先于会话中记住的项目。 */
  programId?: number;
  /** 分享链接指定的需求；分享视图只加载这条需求。 */
  requirementKey?: string;
}

export interface BoardFilters {
  groupBy: BoardGroupBy;
  stageKey?: string;
  moduleKey?: string;
  /** 需求列表选中的那条需求；空值表示尚未选择需求，不加载任务看板。 */
  requirementKey?: string;
  status?: string;
  phase?: "requirement" | "development" | "testing";
  kind?: string;
  ownerName?: string;
  keyword?: string;
}

const EMPTY_BOARD = {
  programId: 0,
  groupBy: "status" as BoardGroupBy,
  columns: [],
  overview: {
    programId: 0,
    name: "",
    totalCount: 0,
    statusCounts: {},
    maturityScore: 0,
    plainProgress: 0,
    moduleProgress: [],
    stageProgress: [],
  },
} as unknown as DeliveryBoard;

export function useDeliveryBoard(shareFilter: DeliveryBoardShareFilter = {}) {
  const sharedProgramId = shareFilter.programId && shareFilter.programId > 0 ? shareFilter.programId : 0;
  const sharedRequirementKey = shareFilter.requirementKey?.trim() ?? "";
  const { activeBusinessLine } = useBusinessLine();
  const { preferences, configFor } = useAIPreferences();
  const bizLine = activeBusinessLine.id;
  const programStorageKey = getUserScopedStorageKey(PROGRAM_KEY);

  const [programs, setPrograms] = useState<DeliveryProgramRecord[]>([]);
  const [programId, setProgramId] = useState<number>(0);
  const [stages, setStages] = useState<DeliveryStageRecord[]>([]);
  const [modules, setModules] = useState<DeliveryModuleRecord[]>([]);
  const [itemCatalog, setItemCatalog] = useState<DeliveryItemRecord[]>([]);
  const [requirements, setRequirements] = useState<DeliveryRequirementRecord[]>([]);
  const [requirementsLoading, setRequirementsLoading] = useState(false);
  const [requirementScope, setRequirementScope] = useState<"mine" | "">("mine");
  const [requirementKeyword, setRequirementKeyword] = useState("");
  // 分享页先聚焦链接中的一条需求；用户可通过「查询所有」解除该限制。
  const [sharedRequirementOnly, setSharedRequirementOnly] = useState(Boolean(sharedRequirementKey));
  const [board, setBoard] = useState<DeliveryBoard>(EMPTY_BOARD);
  const [filters, setFilters] = useState<BoardFilters>({ groupBy: "status", phase: "requirement" });
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [codexHealth, setCodexHealth] = useState<CodexBridgeHealth | null>(null);
  const [codexHealthLoading, setCodexHealthLoading] = useState(false);
  const [executingItemKey, setExecutingItemKey] = useState("");
  const [preparingTestCasesKey, setPreparingTestCasesKey] = useState("");
  const [batchStarting, setBatchStarting] = useState(false);
  const [sequenceStarting, setSequenceStarting] = useState(false);

  const checkCodexHealth = useCallback(async () => {
    if (!programId) {
      const unavailable = {
        ready: false,
        bridge: false,
        codex: false,
        configured: false,
        apiReachable: false,
        executorType: "codex",
        workspace: "",
        message: "未选择项目",
        checkedAt: Math.floor(Date.now() / 1000),
      } as CodexBridgeHealth;
      setCodexHealth(unavailable);
      return unavailable;
    }
    setCodexHealthLoading(true);
    try {
      const health = await fetchCodexBridgeHealth(programId, preferences.globalTool);
      setCodexHealth(health);
      return health;
    } catch (error) {
      const unavailable = {
        ready: false,
        bridge: false,
        codex: false,
        configured: false,
        apiReachable: false,
        executorType: "codex",
        workspace: "",
        message: (error as Error).message,
        checkedAt: Math.floor(Date.now() / 1000),
      } as CodexBridgeHealth;
      setCodexHealth(unavailable);
      return unavailable;
    } finally {
      setCodexHealthLoading(false);
    }
  }, [bizLine, preferences.globalTool, programId]);

  useEffect(() => {
    if (programId) void checkCodexHealth();
  }, [checkCodexHealth, programId]);

  // 项目列表：业务线切换要重新拉，选中的项目优先沿用上次。
  useEffect(() => {
    let cancelled = false;
    fetchPrograms(bizLine)
      .then((list) => {
        if (cancelled) return;
        setPrograms(list);
        const remembered = Number(programStorageKey ? window.sessionStorage.getItem(programStorageKey) : "");
        const next = list.find((item) => item.programId === sharedProgramId)?.programId
          ?? list.find((item) => item.programId === remembered)?.programId
          ?? list[0]?.programId
          ?? 0;
        setProgramId(next);
      })
      .catch((error: Error) => {
        if (!cancelled) message.error(error.message);
      });
    return () => {
      cancelled = true;
    };
  }, [bizLine, programStorageKey, sharedProgramId]);

  useEffect(() => {
    if (!programId) return;
    if (programStorageKey) window.sessionStorage.setItem(programStorageKey, String(programId));
    setItemCatalog([]);
    Promise.all([fetchStages(programId), fetchModules(programId)])
      .then(([stageList, moduleList]) => {
        setStages(stageList);
        setModules(moduleList);
      })
      .catch((error: Error) => message.error(error.message));
  }, [bizLine, programId, programStorageKey]);

  // 同页切换到另一条分享链接时，重新进入单需求视图。
  useEffect(() => {
    setSharedRequirementOnly(Boolean(sharedRequirementKey));
  }, [sharedRequirementKey]);

  const refreshCatalog = useCallback(async () => {
    const requirementKey = filters.requirementKey?.trim();
    if (!programId || !requirementKey) {
      setItemCatalog([]);
      return;
    }
    try {
      const page = await fetchItems(programId, requirementKey);
      setItemCatalog(page.data);
    } catch (error) {
      message.error((error as Error).message);
    }
  }, [bizLine, filters.requirementKey, programId]);

  // 任务目录只服务当前选中的需求及其任务操作，不能在未选择需求时预拉整个项目。
  useEffect(() => {
    void refreshCatalog();
  }, [refreshCatalog]);

  /** 项目级拆解可能新建阶段和模块，不能只刷新任务列表。 */
  const refreshProjectStructure = useCallback(async () => {
    if (!programId) {
      setStages([]);
      setModules([]);
      setItemCatalog([]);
      return;
    }
    try {
      const requirementKey = filters.requirementKey?.trim();
      const [stageList, moduleList] = await Promise.all([
        fetchStages(programId),
        fetchModules(programId),
      ]);
      setStages(stageList);
      setModules(moduleList);
      if (requirementKey) {
        const page = await fetchItems(programId, requirementKey);
        setItemCatalog(page.data);
      } else {
        setItemCatalog([]);
      }
    } catch (error) {
      message.error((error as Error).message);
    }
  }, [bizLine, filters.requirementKey, programId]);

  const refreshRequirements = useCallback(async () => {
    if (!programId) {
      setRequirements([]);
      return;
    }
    setRequirementsLoading(true);
    try {
      if (sharedRequirementKey && sharedRequirementOnly) {
        const requirement = await fetchRequirement(programId, sharedRequirementKey);
        setRequirements([requirement]);
        return;
      }
      const page = await fetchRequirements({
        programId,
        scope: requirementScope,
        keyword: requirementKeyword || undefined,
      });
      setRequirements(page.data);
    } catch (error) {
      message.error((error as Error).message);
    } finally {
      setRequirementsLoading(false);
    }
  }, [programId, requirementKeyword, requirementScope, sharedRequirementKey, sharedRequirementOnly]);

  useEffect(() => {
    void refreshRequirements();
  }, [refreshRequirements]);

  const queryAllRequirements = useCallback(() => {
    setSharedRequirementOnly(false);
    setRequirementScope("");
    setRequirementKeyword("");
  }, []);

  const refresh = useCallback(async () => {
    if (!programId || !filters.requirementKey) {
      setBoard(EMPTY_BOARD);
      return;
    }
    setLoading(true);
    try {
      const next = await fetchBoard({
        programId,
        groupBy: filters.groupBy,
        stageKey: filters.stageKey,
        moduleKey: filters.moduleKey,
        requirementKey: filters.requirementKey,
		status: filters.status,
		phase: filters.phase,
        kind: filters.kind,
		ownerName: filters.ownerName,
        keyword: filters.keyword,
      });
      setBoard(next);
    } catch (error) {
      message.error((error as Error).message);
    } finally {
      setLoading(false);
    }
  }, [bizLine, filters, programId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /**
   * 局部更新。服务端 version 不匹配时抛「已被他人修改」，这里统一刷新看板，
   * 让用户看到别人改成了什么，而不是把自己的值再盖回去。
   */
  const patch = useCallback(
    async (payload: Omit<PatchItemPayload, "programId">) => {
      setSubmitting(true);
      try {
        await patchItem({ programId, ...payload });
        await Promise.all([refresh(), refreshCatalog()]);
        return true;
      } catch (error) {
        message.error((error as Error).message);
        await refresh();
        return false;
      } finally {
        setSubmitting(false);
      }
    },
    [bizLine, programId, refresh, refreshCatalog],
  );

  const create = useCallback(
    async (payload: Omit<CreateItemPayload, "programId">) => {
      setSubmitting(true);
      try {
        await createItem({ programId, ...payload });
        await Promise.all([refresh(), refreshCatalog()]);
        return true;
      } catch (error) {
        message.error((error as Error).message);
        return false;
      } finally {
        setSubmitting(false);
      }
    },
    [bizLine, programId, refresh, refreshCatalog],
  );

  const remove = useCallback(
    async (itemKey: string) => {
      setSubmitting(true);
      try {
        await deleteItem(programId, itemKey);
        await Promise.all([refresh(), refreshCatalog()]);
        return true;
      } catch (error) {
        message.error((error as Error).message);
        return false;
      } finally {
        setSubmitting(false);
      }
    },
    [bizLine, programId, refresh, refreshCatalog],
  );

  const snapshot = useCallback(async () => {
    setSubmitting(true);
    try {
      await rebuildSnapshot(programId);
      return true;
    } catch (error) {
      message.error((error as Error).message);
      return false;
    } finally {
      setSubmitting(false);
    }
  }, [bizLine, programId]);

	const advancePhase = useCallback(async (
		phase: "requirement" | "development",
		items: Array<{ itemKey: string; version: number }>,
	) => {
		setSubmitting(true);
		try {
			await advanceDeliveryPhase({ programId, phase, items });
			await Promise.all([refresh(), refreshCatalog()]);
			return true;
		} catch (error) {
			message.error((error as Error).message);
			await refresh();
			return false;
		} finally {
			setSubmitting(false);
		}
	}, [bizLine, programId, refresh, refreshCatalog]);

  const executeWithCodex = useCallback(
    async (item: DeliveryItemRecord) => {
      setExecutingItemKey(item.itemKey);
      try {
        const config = configFor(sceneForPhase(item.phase));
        const result = await startCodexExecution(
          programId,
          item,
          modelForConfig(config),
          config.tool,
          effortForConfig(config),
          config.tool === "claude" && config.claudeFastMode,
        );
        await Promise.all([refresh(), refreshCatalog()]);
        return result;
      } finally {
        setExecutingItemKey("");
      }
    },
    [bizLine, configFor, programId, refresh, refreshCatalog],
  );

  const generateTestingCases = useCallback(
    async (item: DeliveryItemRecord, testingRequirements = "") => {
      setPreparingTestCasesKey(item.itemKey);
      try {
        const config = configFor("productTesting");
        const result = await startCodexTaskTestingCases(programId, item.itemKey, {
          message: testingRequirements,
          model: modelForConfig(config),
          provider: config.tool,
          reasoningEffort: effortForConfig(config),
          fastMode: config.tool === "claude" && config.claudeFastMode,
        });
        await Promise.all([refresh(), refreshCatalog()]);
        return result;
      } finally {
        setPreparingTestCasesKey("");
      }
    },
    [configFor, programId, refresh, refreshCatalog],
  );

  const executeSequenceWithCodex = useCallback(async (options: {
    itemKeys?: string[];
    startItemKey?: string;
    executionConstraints?: string;
  }) => {
    setSequenceStarting(true);
    try {
      const firstItem = itemCatalog.find((item) => item.itemKey === options.startItemKey || options.itemKeys?.includes(item.itemKey));
      const config = configFor(sceneForPhase(firstItem?.phase || filters.phase || "requirement"));
      const result = await startCodexExecutionSequence(programId, {
        ...options,
        provider: config.tool,
        model: modelForConfig(config),
        reasoningEffort: effortForConfig(config),
        fastMode: config.tool === "claude" && config.claudeFastMode,
      });
      await Promise.all([refresh(), refreshCatalog()]);
      return result;
    } finally {
      setSequenceStarting(false);
    }
  }, [bizLine, configFor, filters.phase, itemCatalog, programId, refresh, refreshCatalog]);

  const executeBatchWithCodex = useCallback(async (itemKeys: string[], executionConstraints = "") => {
    setBatchStarting(true);
    try {
      const firstItem = itemCatalog.find((item) => itemKeys.includes(item.itemKey));
      const config = configFor(sceneForPhase(firstItem?.phase || filters.phase || "requirement"));
      const result = await startCodexExecutionBatch(
        programId,
        itemKeys,
        modelForConfig(config),
        config.tool,
        executionConstraints,
        effortForConfig(config),
        config.tool === "claude" && config.claudeFastMode,
      );
      // The bridge starts each Codex session asynchronously. Refresh again shortly so
      // the claimed items switch to doing without requiring a manual page refresh.
      window.setTimeout(() => {
        void Promise.all([refresh(), refreshCatalog()]);
      }, 500);
      return result;
    } finally {
      setBatchStarting(false);
    }
  }, [bizLine, configFor, filters.phase, itemCatalog, programId, refresh, refreshCatalog]);

  const allItems = useMemo<DeliveryItemRecord[]>(
    () => (board.columns ?? []).flatMap((column) => column.items ?? []),
    [board.columns],
  );

  const stageName = useCallback(
    (stageKey: string) => stages.find((stage) => stage.stageKey === stageKey)?.tag ?? stageKey,
    [stages],
  );

  const moduleName = useCallback(
    (moduleKey: string) => modules.find((module) => module.moduleKey === moduleKey)?.name ?? moduleKey,
    [modules],
  );

  return {
    bizLine,
    programs,
    programId,
    setProgramId,
    stages,
    modules,
    itemCatalog,
    requirements,
    requirementsLoading,
    requirementScope,
    setRequirementScope,
    requirementKeyword,
    setRequirementKeyword,
    sharedRequirementOnly,
    queryAllRequirements,
    refreshRequirements,
    board,
    allItems,
    filters,
    setFilters,
    loading,
    submitting,
    codexHealth,
    codexBridgeReady: Boolean(codexHealth?.ready),
    codexHealthLoading,
    checkCodexHealth,
    executingItemKey,
    preparingTestCasesKey,
    batchStarting,
    sequenceStarting,
    refresh,
    refreshProjectStructure,
    patch,
    create,
    remove,
    snapshot,
    advancePhase,
    executeWithCodex,
    generateTestingCases,
    executeBatchWithCodex,
    executeSequenceWithCodex,
    stageName,
    moduleName,
  };
}
