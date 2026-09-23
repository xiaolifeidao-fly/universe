"use client";

import {
  AppstoreOutlined,
  BranchesOutlined,
  BulbOutlined,
  CheckCircleOutlined,
  ClockCircleOutlined,
  CloseCircleOutlined,
	CopyOutlined,
  DownOutlined,
	ExportOutlined,
	FileTextOutlined,
  FolderOutlined,
  GlobalOutlined,
	IdcardOutlined,
	InboxOutlined,
	KeyOutlined,
	LogoutOutlined,
  MenuOutlined,
  ReloadOutlined,
  SettingOutlined,
  StarFilled,
  ThunderboltOutlined,
  UserOutlined,
} from "@ant-design/icons";
import { Alert, Avatar, Badge, Button, Descriptions, Divider, Drawer, Dropdown, Form, Input, Layout, Menu, Modal, Segmented, Select, Slider, Space, Spin, Switch, Tabs, Tag, Tooltip, message } from "antd";
import type { MenuProps } from "antd";
import { usePathname, useRouter } from "next/navigation";
import dynamic from "next/dynamic";
import { PropsWithChildren, type CSSProperties, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { TranslationKey, useLocale } from "@/i18n/LocaleProvider";
import { useBusinessLine } from "@/business-lines/BusinessLineProvider";
import { changeOwnPassword, fetchCurrentUser, type CurrentUserProfile } from "@/api/auth.api";
import { useDeliveryTaskPlannerHeartbeat } from "@/project-workspaces/deliveryTaskPlannerHeartbeat";
import { authPersonas, clearAuthToken, getAuthUser, hasAuthPersona, isAuthTokenRemembered, isPasswordChangeRequired, setAuthToken, setAuthUser, setPasswordChangeRequired } from "@/utils/auth";
import { copyTextToClipboard } from "@/utils/clipboard";
import {
  CLAUDE_EFFORTS,
  CLAUDE_MODEL_OPTIONS,
  CODEX_MODEL_OPTIONS,
  CODEX_REASONING_EFFORTS,
  type AIExecutionConfig,
  type AIPreferences,
  type AITool,
  type AIToolScene,
  type AISceneOverride,
  type ClaudeEffort,
  type ClaudeModel,
  type CodexModel,
  type CodexReasoningEffort,
  globalConfig,
  resolveSceneConfig,
  useAIPreferences,
} from "@/ai-preferences/AIPreferencesProvider";
import { AIEnvironmentHealth, fetchAIEnvironmentHealth } from "@/ai-preferences/aiEnvironment.api";
import {
	type DeliveryTaskPlannerUpdateInstallation,
	type DeliveryTaskPlannerUpdateStatus,
	fetchDeliveryTaskPlannerHealth,
	fetchDeliveryTaskPlannerUpdate,
	installDeliveryTaskPlannerUpdate,
	restartDeliveryTaskPlannerUpdate,
} from "@/api/delivery.api";
import {
	DELIVERY_TASK_PLANNER_REPOSITORY_URL,
	getDeliveryTaskPlannerBridgeUrl,
} from "@/project-workspaces/deliveryTaskPlanner";
import { ManagerNotificationCenter } from "./ManagerNotificationCenter";

const TaskBoardStoryModal = dynamic(
  () => import("./TaskBoardStoryModal").then((module) => module.TaskBoardStoryModal),
  { ssr: false },
);

const LocalEnvironmentPreferencesModal = dynamic(
  () => import("./LocalEnvironmentPreferencesModal").then((module) => module.LocalEnvironmentPreferencesModal),
  { ssr: false },
);

const { Content, Header, Sider } = Layout;

const SIDEBAR_COLLAPSED_KEY = "zb.sidebar.collapsed";
const NAV_CLOSED_GROUPS_KEY = "zb.nav.closedGroups";
const TASK_PLANNER_UPDATE_INTERVAL_MS = 60_000;

const PAGE_TITLES: Record<string, [string, string]> = {
  "/dashboard": ["page.dashboard.title", "page.dashboard.subtitle"],
  "/device-timeline": ["page.deviceTimeline.title", "page.deviceTimeline.subtitle"],
  "/device-pool": ["page.devicePool.title", "page.devicePool.subtitle"],
  "/device-parameters": ["page.deviceParameterPool.title", "page.deviceParameterPool.subtitle"],
  "/numbers": ["号码池", "权重分级 · 状态机 · Number Pool"],
  "/contacts": ["外部联系人池", "运营名单 · 掺号分配 · External Pool"],
  "/proxies": ["代理 IP 池", "L0 基础设施 · 一号一 IP · Proxy Pool"],
  "/orchestration": ["任务编排与运行", "编排计划 · 运行实例 · Task Orchestration"],
  "/growth-strategy": ["养号策略", "策略库 · Prompt → AI 每日计划 · Growth Strategy"],
  "/operations-strategy": ["运营策略", "养成状态 → 合规催收运营规则 · Operations Strategy"],
  "/task-library": ["任务模板库", "能力地图 · 有限模板 × AI 编排 = 无限场景 · Template Library"],
  "/exec-guard": ["执行守护", "界面识别 · 归位 · 状态机导航 · 打断处理 · Execution Guard"],
  "/ai": ["AI 决策", "拟人思考 · 感知 → 决策 → 执行 · Brain"],
  "/ai-config": ["AI 决策配置", "多 Agent 编排 · 提示词定义 · 任务挂钩 · Agents"],
  "/commands": ["指令库", "WhatsApp / 系统 / 浏览器指令 · Commands"],
  "/scoring": ["评分体系", "健康分 · 执行分 · 等级反哺 · Scoring"],
  "/survival": ["投产存活反馈", "真实存活率回测 · 校准评分与流程 · Survival Loop"],
	"/delivery": ["page.delivery.title", "page.delivery.subtitle"],
	"/my-work": ["page.myWork.title", "page.myWork.subtitle"],
	"/business-workbench": ["page.businessWorkbench.title", "page.businessWorkbench.subtitle"],
	"/business-intake": ["page.businessIntake.title", "page.businessIntake.subtitle"],
  "/panorama": ["page.panorama.title", "page.panorama.subtitle"],
  "/business-lines": ["page.businessLines.title", "page.businessLines.subtitle"],
  "/programs": ["page.programs.title", "page.programs.subtitle"],
	"/user": ["page.user.title", "page.user.subtitle"],
  "/attribution-config": ["page.attributionConfig.title", "page.attributionConfig.subtitle"],
  "/attribution-analysis": ["page.attributionAnalysis.title", "page.attributionAnalysis.subtitle"],
};

interface ManagerShellProps extends PropsWithChildren {}

type MenuItem = Required<MenuProps>["items"][number];

interface NavLeaf {
  key: string;
  label: TranslationKey;
  icon: ReactNode;
}

interface NavGroup {
  key: string;
  label: TranslationKey;
  caption: string;
  tone: "green" | "cyan" | "blue" | "violet" | "amber";
  icon: ReactNode;
  children: NavLeaf[];
}

type NavEntry = NavGroup | NavLeaf;

// 只挂真实存在的页面。工作台 / 资源 / 风控 / 平台管理那几组指向的页面目录
// 不在这个仓库里（src/app/(console)/ 下只有 delivery 和 user），点进去全是 404。
// 页面补回来的时候，照下面这个形状把组加回来即可。
const DELIVERY_NAV_GROUP: NavGroup = {
  key: "grp-delivery",
  label: "nav.delivery",
  caption: "DELIVERY",
  tone: "blue",
  icon: <span>🧭</span>,
  children: [
    { key: "/my-work", label: "nav.myWork", icon: <InboxOutlined /> },
		{ key: "/business-intake", label: "nav.businessIntake", icon: <FileTextOutlined /> },
    { key: "/delivery", label: "nav.deliveryBoard", icon: <span>🗂️</span> },
    { key: "/time-plans", label: "nav.timePlans", icon: <ClockCircleOutlined /> },
    { key: "/panorama", label: "nav.panorama", icon: <span>🌐</span> },
  ],
};

const BUSINESS_NAV_GROUP: NavGroup = {
	key: "grp-business",
	label: "nav.businessWorkbench",
	caption: "BUSINESS",
	tone: "green",
	icon: <span>◈</span>,
	children: [
		{ key: "/business-workbench", label: "nav.businessWorkbench", icon: <FileTextOutlined /> },
	],
};

// 用户管理是系统管理员独占的入口：其余人连这一组都看不到。
const SYSTEM_NAV_GROUP: NavGroup = {
  key: "grp-system",
  label: "nav.systemSettings",
  caption: "SYSTEM",
  tone: "amber",
  icon: <SettingOutlined />,
  children: [
    { key: "/user", label: "nav.users", icon: <KeyOutlined /> },
  ],
};

// 交付项目和空间管理都是单页入口，直接作为一级菜单呈现。
const PRIMARY_NAV_ITEMS: NavLeaf[] = [
  { key: "/programs", label: "programs.title", icon: <FolderOutlined /> },
  { key: "/business-lines", label: "nav.businessLines", icon: <BranchesOutlined /> },
];

// 空间管理对所有人常开：新建空间不再是管理员特权，
// 名下一个空间都没有的人也得有地方建第一个。
// 系统管理员的空间可见范围和普通用户一致，多出来的只有用户管理。

function navEntriesFor(isAdmin: boolean, hasBusiness: boolean, hasProductResearch: boolean): NavEntry[] {
	if (hasBusiness && !hasProductResearch) {
		return [BUSINESS_NAV_GROUP];
	}
	return [
		...(hasBusiness ? [BUSINESS_NAV_GROUP] : []),
		DELIVERY_NAV_GROUP,
		...PRIMARY_NAV_ITEMS,
		...(isAdmin ? [SYSTEM_NAV_GROUP] : []),
	];
}

function isNavGroup(entry: NavEntry): entry is NavGroup {
	return "children" in entry;
}

function findGroupKey(path: string, groups: NavGroup[]): string | undefined {
	return groups.find((group) => group.children.some((leaf) => leaf.key === path))?.key;
}

export function ManagerShell({ children }: ManagerShellProps) {
  const pathname = usePathname();
  const router = useRouter();
  const { locale, t } = useLocale();
	const { activeBusinessLine, businessLines, businessLinesLoaded, setActiveBusinessLine } = useBusinessLine();
	const { preferences, setPreferences } = useAIPreferences();
	const authUser = getAuthUser();
	// 本地插件的 token 和 user_id 全靠这条心跳，登录期间一直跑。
	useDeliveryTaskPlannerHeartbeat();
	const isAdmin = authUser?.role === "admin";
	const hasBusiness = hasAuthPersona("business", authUser);
	const hasProductResearch = hasAuthPersona("product_research", authUser);
	const shouldRemindTaskPlannerPlugin = !hasBusiness;
	const navEntries = useMemo(() => navEntriesFor(isAdmin, hasBusiness, hasProductResearch), [hasBusiness, hasProductResearch, isAdmin]);
	const navGroups = useMemo(() => navEntries.filter(isNavGroup), [navEntries]);
  const [collapsed, setCollapsed] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [openKeys, setOpenKeys] = useState<string[]>(navGroups.map((group) => group.key));
	const [profileOpen, setProfileOpen] = useState(false);
	const [passwordModalOpen, setPasswordModalOpen] = useState(false);
	const [profile, setProfile] = useState<CurrentUserProfile | null>(null);
	const [profileLoading, setProfileLoading] = useState(false);
	const [passwordSubmitting, setPasswordSubmitting] = useState(false);
	const [preferencesOpen, setPreferencesOpen] = useState(false);
	const [localEnvironmentOpen, setLocalEnvironmentOpen] = useState(false);
	const [storyOpen, setStoryOpen] = useState(false);
	const [preferencesDraft, setPreferencesDraft] = useState<AIPreferences>(preferences);
	const [aiEnvironmentHealth, setAIEnvironmentHealth] = useState<AIEnvironmentHealth | null>(null);
	const [aiEnvironmentLoading, setAIEnvironmentLoading] = useState(false);
	const [taskPlannerInstallOpen, setTaskPlannerInstallOpen] = useState(false);
	const [taskPlannerInstallation, setTaskPlannerInstallation] = useState<DeliveryTaskPlannerUpdateInstallation | null>(null);
	const [taskPlannerHealthLoading, setTaskPlannerHealthLoading] = useState(false);
	const taskPlannerUpdateActionBusy = useRef(false);
	const [passwordForm] = Form.useForm<{ currentPassword: string; newPassword: string; confirmPassword: string }>();

  const items = useMemo<MenuItem[]>(
	    () =>
	      navEntries.map((entry) => {
	        if (isNavGroup(entry)) {
	          return {
	            key: entry.key,
	            label: (
	              <span className={`manager-nav-group-heading manager-nav-group-heading--${entry.tone}`}>
	                <span className="manager-nav-group-icon">{entry.icon}</span>
	                <span className="manager-nav-group-copy">
	                  <b>{t(entry.label)}</b>
	                  <small>{entry.caption}</small>
	                </span>
	              </span>
	            ),
	            children: entry.children.map((leaf) => ({
	              key: leaf.key,
	              label: (
	                <span
	                  className={`manager-nav-item-content manager-nav-item-content--${entry.tone}`}
	                  style={{ "--manager-nav-accent": `var(--manager-${entry.tone})` } as CSSProperties}
	                >
	                  <span className="manager-nav-item-icon">{leaf.icon}</span>
	                  <span className="manager-nav-item-label">{t(leaf.label)}</span>
	                </span>
	              ),
	            })),
	          };
	        }

	        return {
	          key: entry.key,
	          label: (
	            <span
	              className="manager-nav-item-content manager-nav-item-content--amber"
	              style={{ "--manager-nav-accent": "var(--manager-amber)" } as CSSProperties}
	            >
	              <span className="manager-nav-item-icon">{entry.icon}</span>
	              <span className="manager-nav-item-label">{t(entry.label)}</span>
	            </span>
	          ),
	        };
	      }),
	    [navEntries, t],
  );

  const activePath = pathname ?? "/my-work";
  const openGroupKey = findGroupKey(activePath, navGroups);
  const [pageTitle, pageSubtitle] = PAGE_TITLES[activePath] ?? ["brand.name", "page.fallback.subtitle"];
	const visiblePersonas = profile?.personas?.length ? profile.personas : authPersonas(authUser);

  useEffect(() => {
    try {
      setCollapsed(window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "1");
      const closed = JSON.parse(window.localStorage.getItem(NAV_CLOSED_GROUPS_KEY) || "[]") as string[];
      setOpenKeys(navGroups.filter((group) => group.key === openGroupKey || !closed.includes(group.key)).map((group) => group.key));
    } catch {
      setOpenKeys(navGroups.map((group) => group.key));
    }
  }, [navGroups, openGroupKey]);

  useEffect(() => {
    const media = window.matchMedia("(max-width: 900px)");
    const updateViewport = () => {
      setIsMobile(media.matches);
      if (!media.matches) setMobileMenuOpen(false);
    };
    updateViewport();
    media.addEventListener("change", updateViewport);
    return () => media.removeEventListener("change", updateViewport);
  }, []);

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === "\\") {
        event.preventDefault();
        updateCollapsed(!collapsed);
      }
    };
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, [collapsed]);

  const openProfile = () => {
    setProfileOpen(true);
    setProfileLoading(true);
    fetchCurrentUser()
      .then((value) => setProfile(value))
      .catch((error: Error) => message.error(error.message))
      .finally(() => setProfileLoading(false));
  };

  const logout = () => {
    clearAuthToken();
    router.replace("/login");
  };

  // 首次登录必须改密码时，改密码弹窗自动弹出并锁住，改完才放行。
  useEffect(() => {
    setPasswordModalOpen(isPasswordChangeRequired());
  }, []);

  const saveOwnPassword = async () => {
    const values = await passwordForm.validateFields();
    setPasswordSubmitting(true);
    try {
      const result = await changeOwnPassword(values.currentPassword, values.newPassword);
		const remember = isAuthTokenRemembered();
      setAuthToken(result.token, remember);
		setAuthUser(result.user, remember);
      setPasswordChangeRequired(false);
      passwordForm.resetFields();
      setPasswordModalOpen(false);
      message.success(t("account.passwordUpdated"));
    } catch (error) {
      message.error((error as Error).message);
    } finally {
      setPasswordSubmitting(false);
    }
  };

  const checkAIEnvironment = async () => {
    setAIEnvironmentLoading(true);
    try {
      const health = await fetchAIEnvironmentHealth();
      setAIEnvironmentHealth(health);
      return health;
    } catch (error) {
      setAIEnvironmentHealth(Object.assign(new AIEnvironmentHealth(), { message: (error as Error).message }));
      return null;
    } finally {
      setAIEnvironmentLoading(false);
    }
  };

	const advanceSilentTaskPlannerUpdate = useCallback(async (update: DeliveryTaskPlannerUpdateStatus) => {
		const installation = update.installation ?? null;
		setTaskPlannerInstallation(installation);
		if (taskPlannerUpdateActionBusy.current) return;

		if (installation?.status === "restart_required") {
			// The browser path bootstraps upgrades from older bridges that do not yet
			// own the server-side restart monitor. New bridges also monitor in the
			// background, so whichever side wins the restart race safely completes it.
			if (installation.activeRuns > 0 || !installation.jobId) return;
			taskPlannerUpdateActionBusy.current = true;
			try {
				setTaskPlannerInstallation(await restartDeliveryTaskPlannerUpdate(installation.jobId));
			} catch {
				// The server-side monitor may already have moved the job to restarting,
				// or the loopback port may be closing. The status poll will reconnect.
			} finally {
				taskPlannerUpdateActionBusy.current = false;
			}
			return;
		}

		const installationFinished = !installation || ["completed", "failed"].includes(installation.status);
		if (!update.updateAvailable || !update.remoteVersion || !installationFinished) return;
		taskPlannerUpdateActionBusy.current = true;
		try {
			setTaskPlannerInstallation(await installDeliveryTaskPlannerUpdate(update.remoteVersion));
		} catch {
			// Discovery runs every minute, so transient download/authentication errors
			// retry silently without requiring the operator to manage an update dialog.
		} finally {
			taskPlannerUpdateActionBusy.current = false;
		}
	}, []);

	const checkTaskPlannerHealth = useCallback(async (showMissingPlugin = true, force = false) => {
		setTaskPlannerHealthLoading(true);
		try {
			await fetchDeliveryTaskPlannerHealth();
			setTaskPlannerInstallOpen(false);
			try {
				const update = await fetchDeliveryTaskPlannerUpdate(force);
				await advanceSilentTaskPlannerUpdate(update);
			} catch {
				// A legacy bridge without update endpoints remains usable, but cannot
				// participate in the silent updater until it is installed once manually.
				setTaskPlannerInstallation(null);
			}
			return true;
		} catch {
			setTaskPlannerInstallation(null);
			if (showMissingPlugin && shouldRemindTaskPlannerPlugin) setTaskPlannerInstallOpen(true);
			return false;
		} finally {
			setTaskPlannerHealthLoading(false);
		}
	}, [advanceSilentTaskPlannerUpdate, shouldRemindTaskPlannerPlugin]);

	// The shell remains mounted during console navigation. Check immediately and
	// then once a minute so a newly published GitHub version is noticed without a refresh.
	useEffect(() => {
		setTaskPlannerInstallOpen(false);
		void checkTaskPlannerHealth(shouldRemindTaskPlannerPlugin);
		const timer = window.setInterval(() => {
			void checkTaskPlannerHealth(false);
		}, TASK_PLANNER_UPDATE_INTERVAL_MS);
		return () => window.clearInterval(timer);
	}, [checkTaskPlannerHealth, shouldRemindTaskPlannerPlugin]);

	useEffect(() => {
		if (!taskPlannerInstallation || !["resolving", "downloading", "validating", "installing", "restart_required", "restarting"].includes(taskPlannerInstallation.status)) return;
		const timer = window.setInterval(() => {
			void fetchDeliveryTaskPlannerUpdate(false)
				.then((update) => {
					void advanceSilentTaskPlannerUpdate(update);
				})
				.catch(() => {
					// A restart briefly closes the loopback port. Keep polling until it returns.
				});
		}, taskPlannerInstallation.status === "restart_required" ? 5000 : 1000);
		return () => window.clearInterval(timer);
	}, [advanceSilentTaskPlannerUpdate, taskPlannerInstallation?.jobId, taskPlannerInstallation?.status]);

	const taskPlannerInstallPrompt = t("delivery.plugin.installPrompt")
		.replace("{url}", DELIVERY_TASK_PLANNER_REPOSITORY_URL)
		.replace("{bridge}", getDeliveryTaskPlannerBridgeUrl());
	const copyTaskPlannerInstallPrompt = () => {
		void copyTextToClipboard(taskPlannerInstallPrompt)
			.then(() => message.success(t("delivery.plugin.installCopied")))
			.catch(() => message.error(t("delivery.plugin.installCopyFailed")));
	};

  const openPreferences = () => {
    setPreferencesDraft(preferences);
    setPreferencesOpen(true);
    void checkAIEnvironment();
  };

  const savePreferences = () => {
    setPreferences(preferencesDraft);
    setPreferencesOpen(false);
    message.success(t("aiPreferences.saved"));
  };

	const toolControl = () => (
    <Segmented
      block
      value={preferencesDraft.globalTool}
      options={[{ label: "Codex", value: "codex" }, { label: "Claude", value: "claude" }]}
      onChange={(value) => setPreferencesDraft((current) => ({ ...current, globalTool: value as AITool }))}
    />
  );

	const effortControl = (
		tool: AITool,
		value: CodexReasoningEffort | ClaudeEffort,
		onChange: (value: CodexReasoningEffort | ClaudeEffort) => void,
	) => {
		const values = tool === "codex" ? CODEX_REASONING_EFFORTS : CLAUDE_EFFORTS;
		const index = Math.max(0, values.indexOf(value as never));
		return (
		  <div className="manager-ai-preferences__effort">
			<div><span>{t("aiPreferences.faster")}</span><b>{t(`aiPreferences.reasoning.${value}`)}</b><span>{t("aiPreferences.smarter")}</span></div>
			<Slider
			  min={0}
			  max={values.length - 1}
			  step={1}
			  dots
			  value={index}
			  tooltip={{ formatter: (next) => t(`aiPreferences.reasoning.${values[next ?? index]}`) }}
			  onChange={(next) => onChange(values[next])}
			/>
		  </div>
		);
	};

	const configurationControls = (
		config: AIExecutionConfig,
		onPatch: (patch: AISceneOverride) => void,
	) => config.tool === "codex" ? (
		<div className="manager-ai-preferences__config-grid">
		  <label>{t("aiPreferences.codexModel")}</label>
		  <Select
			value={config.codexModel}
			options={CODEX_MODEL_OPTIONS}
			onChange={(value) => onPatch({ codexModel: value as CodexModel })}
		  />
		  <label>{t("aiPreferences.reasoningEffort")}</label>
		  {effortControl("codex", config.codexReasoningEffort, (value) => onPatch({ codexReasoningEffort: value as CodexReasoningEffort }))}
		</div>
	) : (
		<div className="manager-ai-preferences__config-grid">
		  <label>{t("aiPreferences.claudeModel")}</label>
		  <Select
			value={config.claudeModel}
			options={CLAUDE_MODEL_OPTIONS}
			onChange={(value) => onPatch({ claudeModel: value as ClaudeModel })}
		  />
		  <label>{t("aiPreferences.claudeEffort")}</label>
		  {effortControl("claude", config.claudeEffort, (value) => onPatch({ claudeEffort: value as ClaudeEffort }))}
		  <label>{t("aiPreferences.fastMode")}</label>
		  <div className="manager-ai-preferences__switch-row">
			<small>{t("aiPreferences.fastModeHint")}</small>
			<Switch checked={config.claudeFastMode} onChange={(checked) => onPatch({ claudeFastMode: checked })} />
		  </div>
		</div>
	);

  const updateCollapsed = (next: boolean) => {
    setCollapsed(next);
    try {
      window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, next ? "1" : "0");
    } catch {
      // Storage is optional for the shell preference.
    }
  };

  const updateOpenKeys = (nextKeys: string[]) => {
    setOpenKeys(nextKeys);
    try {
      window.localStorage.setItem(NAV_CLOSED_GROUPS_KEY, JSON.stringify(navGroups.filter((group) => !nextKeys.includes(group.key)).map((group) => group.key)));
    } catch {
      // Storage is optional for the navigation preference.
    }
  };

  return (
    <div className="manager-shell-root">
      <div className="manager-shell-surface">
        {isMobile && mobileMenuOpen ? (
          <button className="manager-mobile-sider-mask" type="button" aria-label={t("shell.closeMenu")} onClick={() => setMobileMenuOpen(false)} />
        ) : null}
        <Layout
          className="manager-shell-layout"
          style={{
            height: "100%",
            minHeight: 0,
            background: "transparent",
          }}
        >
          <Sider
            className={`manager-shell-sider${isMobile && mobileMenuOpen ? " manager-shell-sider--mobile-open" : ""}`}
            width={236}
            breakpoint="lg"
            collapsedWidth={72}
            collapsible
            trigger={null}
            collapsed={isMobile ? !mobileMenuOpen : collapsed}
            style={{ background: "transparent" }}
          >
            <div
              className="manager-sidebar-card manager-sidebar-scroll manager-stagger-1"
              style={{
                height: "100%",
                padding: "20px 14px",
                display: "flex",
                flexDirection: "column",
                gap: 12,
                overflowX: "hidden",
              }}
            >
              <div className="manager-brand-block">
                <Space align="center" size={11}>
                  <div className="manager-crest" aria-hidden="true">
                    <GlobalOutlined className="manager-crest-planet" />
                    <StarFilled className="manager-crest-star" />
                  </div>
                  <div className="manager-wordmark">
                    <strong>{t("brand.name")}</strong>
                    <small>{t("brand.subtitle")}</small>
                  </div>
                </Space>
              </div>

              <Menu
                className="manager-shell-menu"
                mode="inline"
                selectedKeys={[activePath]}
                openKeys={openKeys}
                items={items}
                onClick={({ key }) => {
                  if (typeof key === "string" && key.startsWith("/")) {
                    router.push(key);
                    setMobileMenuOpen(false);
                  }
                }}
                onOpenChange={updateOpenKeys}
                style={{ fontSize: "var(--manager-fs-base)", flex: 1 }}
              />

              <div className="manager-sidebar-foot">
                <span className="manager-dot-live" />
                <span>{t("shell.online")}</span>
              </div>
            </div>
          </Sider>

          <Layout className="manager-main-layout" style={{ background: "transparent" }}>
            <Header
              className="manager-command-bar manager-stagger-2"
              style={{
                height: "auto",
                lineHeight: "normal",
                padding: "16px clamp(20px, 3vw, 40px)",
                borderBottom: "1px solid var(--manager-border)",
                display: "flex",
                gap: 12,
                alignItems: "center",
              }}
            >
              <Button
                className="manager-menu-trigger"
                type="default"
                shape="circle"
                aria-label={
                  isMobile
                    ? mobileMenuOpen
                      ? t("shell.closeMenu")
                      : t("shell.openMenu")
                    : collapsed
                      ? t("shell.expandMenu")
                      : t("shell.collapseMenu")
                }
                icon={<MenuOutlined />}
                onClick={() => (isMobile ? setMobileMenuOpen(!mobileMenuOpen) : updateCollapsed(!collapsed))}
              />
              <div className="manager-prototype-title" style={{ minWidth: 0 }}>
                <h1>{t(pageTitle)}</h1>
                <div>{t(pageSubtitle)}</div>
              </div>
              <span style={{ flex: 1 }} />
              <Space className="manager-prototype-top-actions" size={8}>
                <Button
                  className="manager-story-trigger"
                  icon={<BulbOutlined />}
                  onClick={() => setStoryOpen(true)}
                >
                  {t("story.trigger")}
                </Button>
                <Button
                  className="manager-local-environment-trigger"
                  icon={<ThunderboltOutlined />}
                  onClick={() => setLocalEnvironmentOpen(true)}
                >
                  {t("programs.environment.manage")}
                </Button>
                <Tooltip title={t("aiPreferences.title")}>
                  <Button aria-label={t("aiPreferences.title")} icon={<SettingOutlined />} onClick={openPreferences} />
                </Tooltip>
                {/* 消息中心跨所有项目汇总受阻和不做的任务，位置紧跟偏好设置。 */}
                <ManagerNotificationCenter />
                <Select
                  aria-label={t("businessLine.current")}
                  className="manager-business-line-select"
				  value={activeBusinessLine.id || undefined}
                  prefix={<AppstoreOutlined />}
				  placeholder={t("businessLine.current")}
				  loading={!businessLinesLoaded}
				  disabled={!businessLinesLoaded || businessLines.length === 0}
                  onChange={(value) => setActiveBusinessLine(value as typeof activeBusinessLine.id)}
                  options={businessLines.map((line) => ({
                    value: line.id,
                    label: line.id === "whatsapp" ? t("businessLine.whatsapp") : line.label,
                  }))}
                />
				<Dropdown
				  trigger={["click"]}
				  menu={{
					items: [
					  { key: "profile", icon: <IdcardOutlined />, label: t("account.profileInfo") },
					  { key: "password", icon: <KeyOutlined />, label: t("account.changePassword") },
					  { type: "divider" },
					  { key: "logout", danger: true, icon: <LogoutOutlined />, label: t("shell.logout") },
					],
					onClick: ({ key }) => {
					  if (key === "profile") {
						openProfile();
						return;
					  }
					  if (key === "password") {
						setPasswordModalOpen(true);
						return;
					  }
					  logout();
					},
				  }}
				>
				  <Button aria-label={t("account.profile")} icon={<UserOutlined />}>
					{authUser?.displayName || authUser?.username} <DownOutlined />
				  </Button>
				</Dropdown>
              </Space>
            </Header>

            <Content className={`manager-console-content${activePath === "/delivery" ? " manager-console-content--delivery" : ""}${activePath === "/my-work" ? " manager-console-content--my-work" : ""}`} style={{ padding: 20 }}>
			  {!businessLinesLoaded ? (
				  <div className="manager-stagger-3" style={{ display: "grid", minHeight: 240, placeItems: "center" }}><Spin /></div>
			  ) : activeBusinessLine.id || activePath === "/business-lines" ? (
				  <div className={`manager-stagger-3${activePath === "/delivery" ? " manager-stagger-3--delivery" : ""}`} data-business-line={activeBusinessLine.id} key={activeBusinessLine.id}>{children}</div>
			  ) : (
				  <Alert className="manager-stagger-3" type="info" showIcon message={t("businessLine.unavailable")} />
			  )}
            </Content>
          </Layout>
        </Layout>
      </div>
		<Modal
		  wrapClassName="manager-form-skin"
		  open={profileOpen}
		  width={560}
		  title={t("account.profileInfo")}
		  footer={<Button onClick={() => setProfileOpen(false)}>{t("common.close")}</Button>}
		  onCancel={() => setProfileOpen(false)}
		>
		  <Spin spinning={profileLoading}>
			<Space align="center" size={12} style={{ marginBottom: 12 }}>
			  <Avatar size={48} icon={<UserOutlined />} />
			  <div>
				<strong style={{ fontSize: "var(--manager-fs-lg)" }}>{profile?.displayName || authUser?.displayName || authUser?.username}</strong>
				<div style={{ color: "var(--manager-text-soft, #8c8c8c)" }}>@{profile?.username || authUser?.username}</div>
			  </div>
			  <Tag color={(profile?.role ?? authUser?.role) === "admin" ? "gold" : "blue"}>
				{(profile?.role ?? authUser?.role) === "admin" ? t("account.roleAdmin") : t("account.roleMember")}
			  </Tag>
			  {visiblePersonas.map((persona) => (
				<Tag key={persona} color={persona === "business" ? "green" : "purple"}>
					{persona === "business" ? t("account.personaBusiness") : t("account.personaProductResearch")}
				</Tag>
			  ))}
			  <Tag color={profile?.status === "disabled" ? "red" : "green"}>
				{profile?.status === "disabled" ? t("account.statusDisabled") : t("account.statusActive")}
			  </Tag>
			</Space>
			<Descriptions column={1} size="small" bordered>
			  <Descriptions.Item label={t("account.persona")}>
				<Space size={[4, 4]} wrap>
				  {visiblePersonas.map((persona) => (
					<Tag key={persona} color={persona === "business" ? "green" : "purple"}>
					  {persona === "business" ? t("account.personaBusiness") : t("account.personaProductResearch")}
					</Tag>
				  ))}
				</Space>
			  </Descriptions.Item>
			  <Descriptions.Item label={t("account.bizLines")}>
				{profile?.bizLines?.length ? profile.bizLines.join("、") : t("account.scopeAll")}
			  </Descriptions.Item>
			  <Descriptions.Item label={t("account.programs")}>
				{profile?.programs?.length ? t("account.programCount").replace("{count}", String(profile.programs.length)) : t("account.scopeAll")}
			  </Descriptions.Item>
			  <Descriptions.Item label={t("account.lastLoginAt")}>
				{profile?.lastLoginAt ? new Date(profile.lastLoginAt).toLocaleString(locale) : "-"}
			  </Descriptions.Item>
			  <Descriptions.Item label={t("account.createdAt")}>
				{profile?.createdAt ? new Date(profile.createdAt).toLocaleString(locale) : "-"}
			  </Descriptions.Item>
			</Descriptions>
		  </Spin>
		</Modal>
		<Modal
		  wrapClassName="manager-form-skin"
		  open={passwordModalOpen}
		  title={t("account.changePassword")}
		  okText={t("account.savePassword")}
		  cancelText={t("common.cancel")}
		  closable={!isPasswordChangeRequired()}
		  maskClosable={!isPasswordChangeRequired()}
		  keyboard={!isPasswordChangeRequired()}
		  confirmLoading={passwordSubmitting}
		  onCancel={() => { if (!isPasswordChangeRequired()) setPasswordModalOpen(false); }}
		  onOk={() => void saveOwnPassword()}
		>
		  {isPasswordChangeRequired() ? (
			<Alert type="warning" showIcon style={{ marginBottom: 12 }} message={t("account.mustChangePassword")} />
		  ) : null}
		  <Form form={passwordForm} layout="vertical">
			<Form.Item label={t("account.currentPassword")} name="currentPassword" rules={[{ required: true, message: t("account.currentPasswordRequired") }]}>
			  <Input.Password autoComplete="current-password" />
			</Form.Item>
			<Form.Item label={t("account.newPassword")} name="newPassword" rules={[{ required: true, min: 8, message: t("account.newPasswordRequired") }]}>
			  <Input.Password autoComplete="new-password" />
			</Form.Item>
			<Form.Item label={t("account.confirmPassword")} name="confirmPassword" dependencies={["newPassword"]} rules={[{ required: true, message: t("account.confirmPasswordRequired") }, ({ getFieldValue }) => ({ validator(_, value) { return !value || getFieldValue("newPassword") === value ? Promise.resolve() : Promise.reject(new Error(t("account.passwordMismatch"))); } })]}>
			  <Input.Password autoComplete="new-password" />
			</Form.Item>
		  </Form>
		</Modal>
		<Drawer
		  className="manager-ai-preferences"
		  title={t("aiPreferences.title")}
			  width={480}
		  open={preferencesOpen}
		  onClose={() => setPreferencesOpen(false)}
		  extra={<Button type="primary" onClick={savePreferences}>{t("delivery.save")}</Button>}
		>
		  <Tabs
			defaultActiveKey="ai"
			items={[
			  { key: "ai", label: t("aiPreferences.tabAI"), children: (<>
		  <div className="manager-ai-preferences__environment">
			<div className="manager-ai-preferences__environment-heading">
			  <div className="manager-ai-preferences__section">
				<strong>{t("aiPreferences.environment")}</strong>
				<small>{t("aiPreferences.environmentHint")}</small>
			  </div>
			  <Tooltip title={t("aiPreferences.environmentRecheck")}>
				<Button
				  type="text"
				  shape="circle"
				  icon={<ReloadOutlined />}
				  loading={aiEnvironmentLoading}
				  aria-label={t("aiPreferences.environmentRecheck")}
				  onClick={() => void checkAIEnvironment()}
				/>
			  </Tooltip>
			</div>
			<div className="manager-ai-preferences__environment-list" aria-live="polite">
			  {(["codex", "claude"] as const).map((tool) => {
				const ready = Boolean(
				  aiEnvironmentHealth?.bridge
				  && aiEnvironmentHealth.configured
				  && aiEnvironmentHealth.apiReachable
				  && aiEnvironmentHealth[tool],
				);
				return (
				  <div className="manager-ai-preferences__environment-row" key={tool}>
					<span><Badge status={aiEnvironmentLoading ? "processing" : ready ? "success" : "error"} />{tool === "codex" ? "Codex" : "Claude"}</span>
					<span className={ready ? "is-ready" : "is-unavailable"}>
					  {aiEnvironmentLoading ? null : ready ? <CheckCircleOutlined /> : <CloseCircleOutlined />}
					  {aiEnvironmentLoading ? t("aiPreferences.environmentChecking") : ready ? "Ready" : t("aiPreferences.environmentUnavailable")}
					</span>
				  </div>
				);
			  })}
			</div>
			{!aiEnvironmentLoading && aiEnvironmentHealth?.message && aiEnvironmentHealth.message !== "ready" ? (
			  <small className="manager-ai-preferences__environment-message">{aiEnvironmentHealth.message}</small>
			) : null}
		  </div>
		  <Divider />
			  <div className="manager-ai-preferences__section">
				<strong>{t("aiPreferences.global")}</strong>
				<small>{t("aiPreferences.globalHint")}</small>
				{toolControl()}
			  </div>
			  {configurationControls(globalConfig(preferencesDraft), (patch) => setPreferencesDraft((current) => ({ ...current, ...patch })))}
			  <Divider />
			  <div className="manager-ai-preferences__section">
				<strong>{t("aiPreferences.sceneOverrides")}</strong>
				<small>{t("aiPreferences.sceneOverridesHint")}</small>
			  </div>
			  <div className="manager-ai-preferences__scenes">
				{([
				  ["taskPlanning", "aiPreferences.taskPlanning"],
				  ["requirementRefinement", "aiPreferences.requirementRefinement"],
				  ["actionExecution", "aiPreferences.actionExecution"],
				  ["productTesting", "aiPreferences.productTesting"],
				] as const).map(([key, label]) => {
				  const override = preferencesDraft.scenes[key];
				  const config = resolveSceneConfig(preferencesDraft, key);
				  return (
					<section className="manager-ai-preferences__scene" key={key}>
					  <div className="manager-ai-preferences__scene-heading">
						<label>{t(label)}</label>
						<Select
						  value={override?.tool ?? "inherit"}
						  aria-label={t(label)}
						  options={[
							{ value: "inherit", label: t("aiPreferences.inheritGlobal") },
							{ value: "codex", label: "Codex" },
							{ value: "claude", label: "Claude" },
						  ]}
						  onChange={(value) => setPreferencesDraft((current) => {
							const scenes = { ...current.scenes };
							if (value === "inherit") delete scenes[key];
							else scenes[key] = { ...(scenes[key] ?? {}), tool: value as AITool };
							return { ...current, scenes };
						  })}
						/>
					  </div>
					  {override ? configurationControls(config, (patch) => setPreferencesDraft((current) => ({
						...current,
						scenes: { ...current.scenes, [key]: { ...(current.scenes[key] ?? {}), ...patch } },
					  }))) : (
						<small className="manager-ai-preferences__inherited">
						  {config.tool === "codex" ? `Codex · ${CODEX_MODEL_OPTIONS.find((item) => item.value === config.codexModel)?.label}` : `Claude · ${CLAUDE_MODEL_OPTIONS.find((item) => item.value === config.claudeModel)?.label}`}
						</small>
					  )}
					</section>
				  );
				})}
			  </div>
			  </>) },
			  { key: "git", label: t("aiPreferences.tabGit"), children: (<>
			  <div className="manager-ai-preferences__section">
				<strong>{t("aiPreferences.gitEnvironment")}</strong>
				<small>{t("aiPreferences.gitEnvironmentHint")}</small>
				<Button
				  icon={<ThunderboltOutlined />}
				  style={{ justifySelf: "start" }}
				  onClick={() => setLocalEnvironmentOpen(true)}
				>
				  {t("programs.environment.manage")}
				</Button>
			  </div>
			  </>) },
			]}
		  />
		</Drawer>
		<Modal
		  open={taskPlannerInstallOpen && shouldRemindTaskPlannerPlugin}
		  title={t("delivery.plugin.title")}
		  closable
		  maskClosable
		  onCancel={() => setTaskPlannerInstallOpen(false)}
		  footer={(
			<Space>
			  <Button onClick={() => setTaskPlannerInstallOpen(false)}>{t("common.cancel")}</Button>
			  <Button type="primary" icon={<ReloadOutlined />} loading={taskPlannerHealthLoading} onClick={() => void checkTaskPlannerHealth()}>
				{t("delivery.plugin.retry")}
			  </Button>
			</Space>
		  )}
		>
		  <div className="delivery-plugin-install">
			<p>{t("delivery.plugin.description")}</p>
			<div className="delivery-plugin-install__repository">
			  <a href={DELIVERY_TASK_PLANNER_REPOSITORY_URL} target="_blank" rel="noreferrer">
				{DELIVERY_TASK_PLANNER_REPOSITORY_URL}
			  </a>
			  <Space size={2}>
				<Tooltip title={t("delivery.plugin.copyRepository")}>
				  <Button
					type="text"
					size="small"
					icon={<CopyOutlined />}
					aria-label={t("delivery.plugin.copyRepository")}
					onClick={() => {
					  void copyTextToClipboard(DELIVERY_TASK_PLANNER_REPOSITORY_URL)
						.then(() => message.success(t("delivery.plugin.repositoryCopied")))
						.catch(() => message.error(t("delivery.plugin.repositoryCopyFailed")));
					}}
				  />
				</Tooltip>
				<Tooltip title={t("delivery.plugin.openRepository")}>
				  <Button
					type="text"
					size="small"
					icon={<ExportOutlined />}
					aria-label={t("delivery.plugin.openRepository")}
					href={DELIVERY_TASK_PLANNER_REPOSITORY_URL}
					target="_blank"
				  />
				</Tooltip>
			  </Space>
			</div>
			<div className="delivery-plugin-install__prompt">
			  <code>{taskPlannerInstallPrompt}</code>
			  <Tooltip title={t("delivery.plugin.copyInstall")}>
				<Button
				  type="text"
				  size="small"
				  icon={<CopyOutlined />}
				  aria-label={t("delivery.plugin.copyInstall")}
				  onClick={copyTaskPlannerInstallPrompt}
				/>
			  </Tooltip>
			</div>
		  </div>
		</Modal>
      <TaskBoardStoryModal open={storyOpen} onClose={() => setStoryOpen(false)} />
      <LocalEnvironmentPreferencesModal open={localEnvironmentOpen} onClose={() => setLocalEnvironmentOpen(false)} />
    </div>
  );
}
