"use client";

/**
 * 管理端外壳：侧栏 + 顶栏 + 内容区。
 *
 * 导航**由后端返回的资源树驱动** —— 一个角色看得到哪些菜单是配出来的，不是
 * 写死在这里的。写死的那份只作兜底（FALLBACK_*）：后端还没配资源、或者接口
 * 暂时不通时，界面退回一个能用的静态导航，而不是白屏。
 *
 * 写操作统一由 WritePermissionProvider 收口。它只是 UI 层的收敛，**真正的门
 * 在后端** —— 每个写接口都要过角色的资源授权，再过一道 writable。
 */

import {
  AccountBookOutlined,
  AlertOutlined,
  ApiOutlined,
  CheckOutlined,
  BranchesOutlined,
  ClusterOutlined,
  ContactsOutlined,
  ControlOutlined,
  CreditCardOutlined,
  DashboardOutlined,
  DatabaseOutlined,
  DeploymentUnitOutlined,
  DesktopOutlined,
  EllipsisOutlined,
  ExperimentOutlined,
  FolderOutlined,
  FundOutlined,
  GlobalOutlined,
  KeyOutlined,
  LogoutOutlined,
  LockOutlined,
  MenuFoldOutlined,
  MenuOutlined,
  MenuUnfoldOutlined,
  MoneyCollectOutlined,
  ProfileOutlined,
  RightOutlined,
  RiseOutlined,
  SafetyCertificateOutlined,
  SafetyOutlined,
  SearchOutlined,
  SettingOutlined,
  ShareAltOutlined,
  ShoppingOutlined,
  SlidersOutlined,
  SolutionOutlined,
  StarFilled,
  StarOutlined,
  StopOutlined,
  TagsOutlined,
  TeamOutlined,
  TransactionOutlined,
  TranslationOutlined,
  UserOutlined,
  UserSwitchOutlined,
  WalletOutlined,
} from "@ant-design/icons";
import { Dropdown, Menu, Modal, Tooltip, message } from "antd";
import type { MenuProps } from "antd";
import { usePathname, useRouter } from "next/navigation";
import { type PropsWithChildren, type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { useLocale, type TranslationKey } from "@/i18n/LocaleProvider";
import { WritePermissionProvider } from "@/components/permission/WritePermission";
import { logout as logoutRequest } from "@/app/login/api/login.api";
import { clearAuthToken, getAuthUser } from "@/utils/auth";
import {
  fetchCurrentUser,
  fetchCurrentUserMenus,
  type CurrentUser,
  type ResourceItem,
} from "./api/profile.api";
import { ChangePasswordModal } from "./ChangePasswordModal";
import { CommandPalette, type PaletteEntry } from "./CommandPalette";
import { PageActionsProvider } from "./PageActions";

const SIDEBAR_COLLAPSED_KEY = "ztb-manager-sidebar-collapsed";

// 兜底标题。后端资源里有 name 时优先用后端的（那是能在后台改的），
// 这里留着是为了迁移期两套并存不白屏。
const FALLBACK_PAGE_TITLES: Record<string, [TranslationKey, TranslationKey]> = {
  "/dashboard": ["dashboard.title", "dashboard.subtitle"],
  "/users": ["users.title", "users.subtitle"],
  "/business-lines": ["bizLines.title", "bizLines.subtitle"],
  "/programs": ["programs.title", "programs.subtitle"],
  "/galaxy": ["galaxy.title", "galaxy.subtitle"],
  "/galaxy/overview": ["nav.galaxyHome", "galaxy.home.subtitle"],
  "/galaxy/pool": ["nav.galaxyPool", "galaxy.pool.subtitle"],
  "/galaxy/units": ["nav.galaxyUnits", "galaxy.units.subtitle"],
  "/galaxy/mismatches": ["nav.galaxyMismatches", "galaxy.mismatches.subtitle"],
  "/galaxy/reputation": ["nav.galaxyReputation", "galaxy.reputation.subtitle"],
  "/galaxy/referrals": ["nav.galaxyReferrals", "galaxy.referrals.subtitle"],
  "/galaxy/settings": ["nav.galaxySettings", "galaxy.settings.subtitle"],
  "/galaxy/nodes": ["nav.galaxyNodes", "galaxy.nodes.subtitle"],
  "/galaxy/payouts": ["nav.galaxyPayouts", "galaxy.payouts.subtitle"],
  "/galaxy/bans": ["nav.galaxyBans", "galaxy.bans.subtitle"],
  "/galaxy/orders": ["nav.galaxyOrders", "galaxy.orders.subtitle"],
  "/galaxy/accounts": ["nav.galaxyAccounts", "galaxy.accounts.subtitle"],
  "/galaxy/probes": ["nav.galaxyProbes", "galaxy.probes.subtitle"],
  "/galaxy/disputes": ["nav.galaxyDisputes", "galaxy.disputes.subtitle"],
  "/galaxy/leads": ["nav.galaxyLeads", "galaxy.leads.subtitle"],
  "/galaxy/commerce": ["nav.galaxyCommerce", "galaxy.commerce.subtitle"],
  "/galaxy/points": ["nav.galaxyPoints", "galaxy.points.subtitle"],
  "/galaxy/keys": ["nav.galaxyKeys", "galaxy.keys.subtitle"],
  "/galaxy/settlement": ["nav.galaxySettlement", "galaxy.settlement.subtitle"],
  "/galaxy/ledger": ["nav.galaxyLedger", "galaxy.ledger.subtitle"],
  "/galaxy/bridge-releases": ["nav.galaxyBridgeReleases", "galaxy.bridgeReleases.subtitle"],
  "/galaxy/desktop-releases": ["nav.galaxyDesktopReleases", "galaxy.desktopReleases.subtitle"],
  "/settings/accounts": ["accounts.title", "accounts.subtitle"],
  "/settings/roles": ["roles.title", "roles.subtitle"],
};

// 后端资源接口不通时的静态导航。
// 有 children 的是目录：它自己不是页面，key 不进 permittedPaths，点了只展开。
type FallbackNavEntry = {
  key: string;
  icon?: ReactNode;
  labelKey: TranslationKey;
  children?: FallbackNavEntry[];
};

const FALLBACK_NAV: FallbackNavEntry[] = [
  { key: "/dashboard", icon: <DashboardOutlined />, labelKey: "nav.dashboard" },
  { key: "/users", icon: <TeamOutlined />, labelKey: "nav.users" },
  { key: "/business-lines", icon: <BranchesOutlined />, labelKey: "nav.businessLines" },
  { key: "/programs", icon: <FolderOutlined />, labelKey: "nav.programs" },
  {
    key: "menu:galaxyOverview",
    icon: <GlobalOutlined />,
    labelKey: "nav.galaxyOverview",
    children: [
      { key: "/galaxy/overview", icon: <FundOutlined />, labelKey: "nav.galaxyHome" },
      { key: "/galaxy/pool", icon: <DatabaseOutlined />, labelKey: "nav.galaxyPool" },
      { key: "/galaxy/units", icon: <ProfileOutlined />, labelKey: "nav.galaxyUnits" },
      { key: "/galaxy/settlement", icon: <AccountBookOutlined />, labelKey: "nav.galaxySettlement" },
      { key: "/galaxy/ledger", icon: <TransactionOutlined />, labelKey: "nav.galaxyLedger" },
    ],
  },
  {
    key: "menu:galaxySupply",
    icon: <ClusterOutlined />,
    labelKey: "nav.galaxySupply",
    children: [
      { key: "/galaxy/nodes", icon: <DeploymentUnitOutlined />, labelKey: "nav.galaxyNodes" },
      { key: "/galaxy/payouts", icon: <MoneyCollectOutlined />, labelKey: "nav.galaxyPayouts" },
    ],
  },
  {
    key: "menu:galaxyRisk",
    icon: <SafetyCertificateOutlined />,
    labelKey: "nav.galaxyRisk",
    children: [
      { key: "/galaxy/probes", icon: <ExperimentOutlined />, labelKey: "nav.galaxyProbes" },
      { key: "/galaxy/mismatches", icon: <AlertOutlined />, labelKey: "nav.galaxyMismatches" },
      { key: "/galaxy/reputation", icon: <StarOutlined />, labelKey: "nav.galaxyReputation" },
      { key: "/galaxy/bans", icon: <StopOutlined />, labelKey: "nav.galaxyBans" },
    ],
  },
  {
    key: "menu:galaxyDemand",
    icon: <WalletOutlined />,
    labelKey: "nav.galaxyDemand",
    children: [
      { key: "/galaxy/keys", icon: <KeyOutlined />, labelKey: "nav.galaxyKeys" },
      { key: "/galaxy/orders", icon: <ShoppingOutlined />, labelKey: "nav.galaxyOrders" },
      { key: "/galaxy/points", icon: <CreditCardOutlined />, labelKey: "nav.galaxyPoints" },
      { key: "/galaxy/commerce", icon: <TagsOutlined />, labelKey: "nav.galaxyCommerce" },
    ],
  },
  {
    key: "menu:galaxyCustomer",
    icon: <RiseOutlined />,
    labelKey: "nav.galaxyCustomer",
    children: [
      { key: "/galaxy/accounts", icon: <UserOutlined />, labelKey: "nav.galaxyAccounts" },
      { key: "/galaxy/disputes", icon: <SolutionOutlined />, labelKey: "nav.galaxyDisputes" },
      { key: "/galaxy/leads", icon: <ContactsOutlined />, labelKey: "nav.galaxyLeads" },
      { key: "/galaxy/referrals", icon: <ShareAltOutlined />, labelKey: "nav.galaxyReferrals" },
    ],
  },
  {
    key: "menu:galaxyPlatform",
    icon: <ControlOutlined />,
    labelKey: "nav.galaxyPlatform",
    children: [
      { key: "/galaxy/settings", icon: <SlidersOutlined />, labelKey: "nav.galaxySettings" },
      { key: "/galaxy/bridge-releases", icon: <ApiOutlined />, labelKey: "nav.galaxyBridgeReleases" },
      { key: "/galaxy/desktop-releases", icon: <DesktopOutlined />, labelKey: "nav.galaxyDesktopReleases" },
    ],
  },
];

/**
 * 图标白名单：后端在资源的 icon 字段里存 antd 的图标名，这里查组件。
 * 白名单式而不是动态 import —— 图标集合仍然是编译期固定的，只是**选哪个**
 * 由后端决定。查不到就不显示图标，不报错。
 */
const MENU_ICONS: Record<string, ReactNode> = {
  DashboardOutlined: <DashboardOutlined />,
  TeamOutlined: <TeamOutlined />,
  BranchesOutlined: <BranchesOutlined />,
  FolderOutlined: <FolderOutlined />,
  GlobalOutlined: <GlobalOutlined />,
  SettingOutlined: <SettingOutlined />,
  SafetyCertificateOutlined: <SafetyCertificateOutlined />,
  KeyOutlined: <KeyOutlined />,
  // 共享算力池拆成六个一级菜单之后各自要一个图标。
  // 刻意避开上面那几个已经被占的：侧栏里两个一级菜单顶着同一个图标，
  // 收起来只剩图标时就完全分不出谁是谁。
  ClusterOutlined: <ClusterOutlined />,
  WalletOutlined: <WalletOutlined />,
  RiseOutlined: <RiseOutlined />,
  ControlOutlined: <ControlOutlined />,
  // 二级菜单的图标。二十多个子项原先一个图标都没有，展开之后是一整列纯文字，
  // 扫的时候只能逐行读 —— 图标才是那种「看一眼就知道是哪一项」的锚点。
  //
  // 同一个分组里的几个必须互不相同，**跨分组重复也要避开**：子项的图标没有底托，
  // 比一级的药丸弱一档，两个长得像的挨在一起就等于没有。
  FundOutlined: <FundOutlined />,
  DatabaseOutlined: <DatabaseOutlined />,
  ProfileOutlined: <ProfileOutlined />,
  AccountBookOutlined: <AccountBookOutlined />,
  TransactionOutlined: <TransactionOutlined />,
  DeploymentUnitOutlined: <DeploymentUnitOutlined />,
  MoneyCollectOutlined: <MoneyCollectOutlined />,
  ExperimentOutlined: <ExperimentOutlined />,
  AlertOutlined: <AlertOutlined />,
  StarOutlined: <StarOutlined />,
  StopOutlined: <StopOutlined />,
  ShoppingOutlined: <ShoppingOutlined />,
  CreditCardOutlined: <CreditCardOutlined />,
  TagsOutlined: <TagsOutlined />,
  UserOutlined: <UserOutlined />,
  SolutionOutlined: <SolutionOutlined />,
  ContactsOutlined: <ContactsOutlined />,
  ShareAltOutlined: <ShareAltOutlined />,
  SlidersOutlined: <SlidersOutlined />,
  ApiOutlined: <ApiOutlined />,
  DesktopOutlined: <DesktopOutlined />,
  UserSwitchOutlined: <UserSwitchOutlined />,
  SafetyOutlined: <SafetyOutlined />,
};

const LOCALE_OPTIONS = [
  { value: "zh-CN", labelKey: "locale.zh-CN" },
  { value: "en-US", labelKey: "locale.en-US" },
] as const;

type MenuItem = Required<MenuProps>["items"][number];

const RECENT_PAGES_KEY = "ztb-manager-recent-pages";

/** 侧栏、面包屑、命令面板共用的一份「页面清单」。 */
type NavPage = { href: string; label: string; icon?: ReactNode; group: string };

export function ManagerShellStub({ children }: PropsWithChildren) {
  const pathname = usePathname();
  const router = useRouter();
  const { locale, setLocale, t } = useLocale();
  const authUser = getAuthUser();

  const [collapsed, setCollapsed] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [profile, setProfile] = useState<CurrentUser | null>(null);
  const [menus, setMenus] = useState<ResourceItem[]>([]);
  const [menuLoading, setMenuLoading] = useState(true);
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [recentPages, setRecentPages] = useState<string[]>([]);
  const [actionsSlot, setActionsSlot] = useState<HTMLDivElement | null>(null);
  // 点下菜单到新页面挂上之间那几百毫秒：顶上走一条进度线，告诉人「点到了，在路上」。
  const [navigating, setNavigating] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  // 「菜单是拿不到，还是我们故意没去拿」——两者要分开。兜底导航是给前者的；
  // 后者（必须改初始密码）如果也退回兜底，就是在展示一批点了必然 403 的入口。
  const [menuUnavailable, setMenuUnavailable] = useState(false);

  // 当前用户和菜单每次挂载现取，不读 localStorage —— writable 和菜单范围决定了
  // 页面上有哪些按钮，存在本地就等于把它交给了能改 localStorage 的人。
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const user = await fetchCurrentUser();
        if (cancelled) return;
        // 菜单要单独拿：必须改初始密码的账号调它会被后端拒（这是对的），
        // 和 Promise.all 放一起会让整个加载失败，用户连改密弹窗都看不到。
        const resources = user.mustChangePassword ? [] : await fetchCurrentUserMenus();
        if (cancelled) return;
        setProfile(user);
        // ?? []：菜单为空时后端回的是 []，但 JSON 里的 null 也能走到这里
        // （Go 的 nil 切片序列化成 null）。直接存进去，下面 menus.length 一读就整页崩，
        // 而它崩在外壳里 —— 连登录页都回不去。
        setMenus(resources ?? []);
        // 带着初始密码的账号除了改密什么都调不动（后端挡在资源判断之前），
        // 所以不等用户去找入口，直接弹出来。
        if (user.mustChangePassword) setPasswordOpen(true);
      } catch (error) {
        // 令牌失效那一类错误由 axios 拦截器统一跳登录页，这里只提示其余情况。
        if (!cancelled) {
          setMenuUnavailable(true);
          message.error((error as Error).message || t("common.loadFailed"));
        }
      } finally {
        if (!cancelled) setMenuLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [t]);

  useEffect(() => {
    try {
      setCollapsed(window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "1");
      const stored = JSON.parse(window.localStorage.getItem(RECENT_PAGES_KEY) ?? "[]");
      if (Array.isArray(stored)) setRecentPages(stored.filter((item): item is string => typeof item === "string"));
    } catch {
      // Storage is optional for the shell preference.
    }
  }, []);

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

  const updateCollapsed = useCallback((next: boolean) => {
    setCollapsed(next);
    try {
      window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, next ? "1" : "0");
    } catch {
      // Storage is optional for the shell preference.
    }
  }, []);

  const activePath = pathname ?? "/dashboard";

  // 菜单文案优先走 i18n（t("nav." + code)），查不到才用库里的 name。
  // 种子资源有翻译，后台新建的资源用管理员自己起的名字。
  const resourceLabel = useCallback(
    (resource: ResourceItem) => {
      const key = `nav.${resource.code}`;
      const translated = t(key);
      return translated === key ? resource.name : translated;
    },
    [t],
  );

  const menuItems = useMemo<MenuItem[]>(() => {
    if (menus.length === 0) {
      if (!menuUnavailable) return [];
      return buildFallbackItems(FALLBACK_NAV, t);
    }
    return buildMenuItems(menus, resourceLabel);
  }, [menus, menuUnavailable, resourceLabel, t]);

  // 能进的页面，连同它在哪一组底下。后端已经按角色过滤过了，这里只是别让点击把人
  // 送去一个必然 403 的页面。目录本身不算页面：它没有 pageUrl，点了只该展开。
  const navPages = useMemo<NavPage[]>(() => {
    const general = t("palette.general");
    if (menus.length === 0) {
      return menuUnavailable ? fallbackPages(FALLBACK_NAV, t, general) : [];
    }
    const byID = new Map(menus.map((item) => [item.id, item]));
    return [...menus]
      .sort((a, b) => a.sortId - b.sortId || a.id - b.id)
      .filter((item) => item.resourceType === "page" && item.pageUrl)
      .map((item) => {
        const parent = byID.get(item.parentId);
        return {
          href: item.pageUrl,
          label: resourceLabel(item),
          icon: MENU_ICONS[item.icon],
          group: parent ? resourceLabel(parent) : general,
        };
      });
  }, [menus, menuUnavailable, resourceLabel, t]);

  const permittedPaths = useMemo(() => new Set(navPages.map((page) => page.href)), [navPages]);

  // 只展开当前页所在的那个一级菜单，不是全部展开。
  //
  // 「共享算力池」拆成了六个一级菜单，全展开是三十多行 —— 侧栏一进来就要滚，
  // 而滚动条底下那几个菜单等于没人看得见。当前页那一个是展开的，进来的人看得到自己停在哪；
  // defaultOpenKeys 是非受控的，用户点开别的照样留着。
  const defaultOpenKeys = useMemo(() => {
    if (menus.length === 0) {
      if (!menuUnavailable) return [];
      const owner = FALLBACK_NAV.find((entry) => entry.children?.some((child) => child.key === activePath));
      return owner ? [owner.key] : [];
    }
    const byID = new Map(menus.map((item) => [item.id, item]));
    let node = menus.find((item) => item.pageUrl && activePath.startsWith(item.pageUrl));
    const opened: string[] = [];
    // 一路往上收，中间那层（如果以后又有三层）也要跟着开，否则展开的是一个看不见的祖先。
    while (node && node.parentId !== 0) {
      const parent = byID.get(node.parentId);
      if (!parent) break;
      opened.push(menuKey(parent));
      node = parent;
    }
    return opened;
  }, [menus, menuUnavailable, activePath]);

  const [fallbackTitle, fallbackSubtitle] =
    FALLBACK_PAGE_TITLES[activePath] ?? ["dashboard.title", "dashboard.subtitle"];
  const activePage = navPages.find((page) => activePath.startsWith(page.href));
  const pageTitle = activePage?.label ?? t(fallbackTitle);
  const pageSubtitle = t(fallbackSubtitle);
  const pageGroup = activePage && activePage.group !== t("palette.general") ? activePage.group : "";

  useEffect(() => {
    document.title = `${pageTitle} · ${t("brand.name")}`;
  }, [pageTitle, t]);

  // 路由落地：收起进度线、记一笔「最近访问」、内容区回到顶部。
  useEffect(() => {
    setNavigating(false);
    if (!permittedPaths.has(activePath)) return;
    setRecentPages((previous) => {
      const next = [activePath, ...previous.filter((item) => item !== activePath)].slice(0, 8);
      try {
        window.localStorage.setItem(RECENT_PAGES_KEY, JSON.stringify(next));
      } catch {
        // Storage is optional for the shell preference.
      }
      return next;
    });
  }, [activePath, permittedPaths]);

  const navigate = useCallback(
    (href: string) => {
      setMobileMenuOpen(false);
      if (href === activePath) return;
      setNavigating(true);
      router.push(href);
    },
    [activePath, router],
  );

  const logout = useCallback(() => {
    // 先请服务端把令牌删掉再清本地。反过来的话，本地清了但服务端那条会话
    // 还活着，令牌被人抄走就一直有效。请求失败也照样跳走 —— 用户要的是登出。
    void logoutRequest().catch(() => undefined);
    clearAuthToken();
    router.replace("/login");
  }, [router]);

  const confirmLogout = useCallback(() => {
    Modal.confirm({
      title: t("shell.logoutConfirm"),
      okText: t("shell.logout"),
      okButtonProps: { danger: true },
      cancelText: t("common.cancel"),
      centered: true,
      onOk: logout,
    });
  }, [logout, t]);

  // 全局快捷键：⌘K / Ctrl+K 或 / 打开命令面板，⌘B / Ctrl+B 收起侧栏。
  // 光标在输入框里时 / 和 ⌘B 不拦 —— 那是在打字。
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing = Boolean(target?.closest("input, textarea, select, [contenteditable='true']"));
      const mod = event.metaKey || event.ctrlKey;
      if (mod && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen((open) => !open);
      } else if (!typing && !mod && event.key === "/") {
        event.preventDefault();
        setPaletteOpen(true);
      } else if (!typing && mod && event.key.toLowerCase() === "b" && !isMobile) {
        event.preventDefault();
        updateCollapsed(!collapsed);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [collapsed, isMobile, updateCollapsed]);

  const displayName = profile?.displayName || profile?.username || authUser?.displayName || authUser?.username || "—";
  const roleName = profile?.superAdmin
    ? t("shell.superAdmin")
    : profile?.roles?.map((role) => role.name).join(" · ") || (profile ? t("shell.readOnly") : "");
  const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

  const paletteEntries = useMemo<PaletteEntry[]>(
    () => [
      ...navPages.map((page) => ({ key: page.href, label: page.label, group: page.group, icon: page.icon, href: page.href })),
      {
        key: "action:locale",
        label: locale === "zh-CN" ? "Switch to English" : "切换到简体中文",
        group: t("palette.actions"),
        icon: <TranslationOutlined />,
        run: () => setLocale(locale === "zh-CN" ? "en-US" : "zh-CN"),
      },
      {
        key: "action:password",
        label: t("password.title"),
        group: t("palette.actions"),
        icon: <LockOutlined />,
        run: () => setPasswordOpen(true),
      },
      {
        key: "action:logout",
        label: t("shell.logout"),
        group: t("palette.actions"),
        icon: <LogoutOutlined />,
        run: confirmLogout,
      },
    ],
    [confirmLogout, locale, navPages, setLocale, t],
  );

  const userMenu: MenuProps = {
    items: [
      {
        key: "who",
        type: "group",
        label: (
          <div className="manager-user-menu-head">
            <strong>{displayName}</strong>
            <span>{roleName}</span>
          </div>
        ),
      },
      { type: "divider" },
      {
        key: "locale",
        icon: <TranslationOutlined />,
        label: t("locale.label"),
        children: LOCALE_OPTIONS.map((item) => ({
          key: `locale:${item.value}`,
          label: (
            <span className="manager-user-menu-check">
              {t(item.labelKey)}
              {locale === item.value ? <CheckOutlined /> : null}
            </span>
          ),
        })),
      },
      { key: "password", icon: <LockOutlined />, label: t("password.title") },
      { type: "divider" },
      { key: "logout", danger: true, icon: <LogoutOutlined />, label: t("shell.logout") },
    ],
    onClick: ({ key }) => {
      if (key === "password") setPasswordOpen(true);
      else if (key === "logout") confirmLogout();
      else if (key.startsWith("locale:")) setLocale(key.slice("locale:".length) as typeof locale);
    },
  };

  const siderCollapsed = !isMobile && collapsed;
  const searchHint = isMac ? "⌘K" : "Ctrl K";

  return (
    // 默认 false：profile 还没回来时按只读渲染，避免闪出一排点不动的写按钮。
    <WritePermissionProvider value={profile?.writable ?? false}>
      <div
        className={`manager-shell${siderCollapsed ? " is-collapsed" : ""}${isMobile && mobileMenuOpen ? " is-mobile-open" : ""}`}
        data-can-write={profile?.writable ? "true" : "false"}
      >
        <div className={`manager-route-progress${navigating ? " is-active" : ""}`} aria-hidden="true" />
        {isMobile && mobileMenuOpen ? (
          <button
            className="manager-mobile-sider-mask"
            type="button"
            aria-label={t("shell.closeMenu")}
            onClick={() => setMobileMenuOpen(false)}
          />
        ) : null}

        <aside className="manager-sider" aria-label={t("shell.navigation")}>
          <div className="manager-sider-head">
            <div className="manager-brand">
              <div className="manager-crest" aria-hidden="true">
                <GlobalOutlined className="manager-crest-planet" />
                <StarFilled className="manager-crest-star" />
              </div>
              <div className="manager-wordmark">
                <strong>{t("brand.name")}</strong>
                <small>{t("brand.subtitle")}</small>
              </div>
            </div>
          </div>

          <div className="manager-sider-search-wrap">
            <Tooltip title={siderCollapsed ? `${t("palette.open")} · ${searchHint}` : null} placement="right">
              <button type="button" className="manager-sider-search" onClick={() => setPaletteOpen(true)}>
                <SearchOutlined />
                <span className="manager-sider-search-label">{t("palette.trigger")}</span>
                <kbd>{searchHint}</kbd>
              </button>
            </Tooltip>
          </div>

          <nav className="manager-sider-nav">
            {menuLoading ? (
              // 菜单是首屏，转圈会让整块区域空着；骨架屏至少保住了布局。
              <div className="manager-nav-skeleton">
                {Array.from({ length: 9 }, (_, i) => (
                  <span key={i} style={{ width: `${52 + ((i * 37) % 40)}%` }} />
                ))}
              </div>
            ) : (
              <Menu
                className="manager-shell-menu"
                mode="inline"
                inlineCollapsed={siderCollapsed}
                inlineIndent={14}
                selectedKeys={[activePage?.href ?? activePath]}
                defaultOpenKeys={siderCollapsed ? [] : defaultOpenKeys}
                items={menuItems}
                onClick={({ key }) => {
                  // 只跳进得去的页面。后端才是真正的门，这里只是别把人送去必然 403 的地方。
                  if (typeof key === "string" && key.startsWith("/") && permittedPaths.has(key)) navigate(key);
                }}
              />
            )}
          </nav>

          <div className="manager-sider-foot">
            <Dropdown menu={userMenu} trigger={["click"]} placement="topLeft" overlayClassName="manager-user-dropdown">
              <button type="button" className="manager-user-chip" aria-label={displayName}>
                <span className="manager-avatar" aria-hidden="true">
                  {initialOf(displayName)}
                  <i className="manager-avatar-status" />
                </span>
                <span className="manager-user-chip-text">
                  <strong>{displayName}</strong>
                  <small>{roleName || t("shell.online")}</small>
                </span>
                <EllipsisOutlined className="manager-user-chip-more" />
              </button>
            </Dropdown>
          </div>
        </aside>

        <div className="manager-main">
          <header className={`manager-topbar${scrolled ? " is-scrolled" : ""}`}>
            <Tooltip
              title={isMobile ? null : `${collapsed ? t("shell.expandMenu") : t("shell.collapseMenu")} · ${isMac ? "⌘B" : "Ctrl B"}`}
              placement="bottomLeft"
            >
              <button
                type="button"
                className="manager-icon-button"
                aria-label={
                  isMobile
                    ? mobileMenuOpen
                      ? t("shell.closeMenu")
                      : t("shell.openMenu")
                    : collapsed
                      ? t("shell.expandMenu")
                      : t("shell.collapseMenu")
                }
                onClick={() => (isMobile ? setMobileMenuOpen(!mobileMenuOpen) : updateCollapsed(!collapsed))}
              >
                {isMobile ? <MenuOutlined /> : collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
              </button>
            </Tooltip>
            <span className="manager-topbar-divider" aria-hidden="true" />
            <nav className="manager-breadcrumb" aria-label="breadcrumb">
              {pageGroup ? (
                <>
                  <span className="manager-breadcrumb-group">{pageGroup}</span>
                  <RightOutlined className="manager-breadcrumb-sep" />
                </>
              ) : null}
              <span className="manager-breadcrumb-current">{pageTitle}</span>
            </nav>
            <span style={{ flex: 1 }} />
            <button type="button" className="manager-topbar-search" onClick={() => setPaletteOpen(true)}>
              <SearchOutlined />
              <span>{t("palette.trigger")}</span>
              <kbd>{searchHint}</kbd>
            </button>
            <Dropdown
              trigger={["click"]}
              placement="bottomRight"
              menu={{
                selectable: true,
                selectedKeys: [locale],
                items: LOCALE_OPTIONS.map((item) => ({ key: item.value, label: t(item.labelKey) })),
                onClick: ({ key }) => setLocale(key as typeof locale),
              }}
            >
              <button type="button" className="manager-icon-button" aria-label={t("locale.label")}>
                <TranslationOutlined />
              </button>
            </Dropdown>
            <span className="manager-topbar-status" title={t("shell.online")}>
              <span className="manager-dot-live" />
              <span>{t("shell.online")}</span>
            </span>
          </header>

          <main className="manager-content" onScroll={(event) => setScrolled(event.currentTarget.scrollTop > 4)}>
            <div className="manager-page">
              <PageActionsProvider value={actionsSlot}>
                <div className="manager-page-head">
                  <div className="manager-page-head-text">
                    <h1>{pageTitle}</h1>
                    {pageSubtitle ? <p>{pageSubtitle}</p> : null}
                  </div>
                  <div className="manager-page-head-actions" ref={setActionsSlot} />
                </div>
                {/* 槽挂上之后再渲染页面：页面里的 <PageActions> 第一帧就能找到位置，不会先在原地闪一下。 */}
                {actionsSlot ? (
                  <div key={activePath} className="manager-page-body">
                    {children}
                  </div>
                ) : null}
              </PageActionsProvider>
            </div>
          </main>
        </div>

        <CommandPalette
          open={paletteOpen}
          onClose={() => setPaletteOpen(false)}
          entries={paletteEntries}
          recent={recentPages}
          onNavigate={navigate}
        />
        <ChangePasswordModal
          open={passwordOpen}
          forced={profile?.mustChangePassword}
          onClose={() => setPasswordOpen(false)}
          // 改完密码后端会把这个人的全部会话删掉，留在原地下一个请求必然失败。
          onChanged={logout}
        />
      </div>
    </WritePermissionProvider>
  );
}

/** 头像里放名字的第一个字：中文名取首字，英文名取首字母大写。 */
function initialOf(name: string) {
  const first = Array.from(name.trim())[0] ?? "?";
  return first.toUpperCase();
}

/** 兜底导航拼成 antd 菜单树，形状和后端资源那条路径一致。 */
function buildFallbackItems(entries: FallbackNavEntry[], t: (key: TranslationKey) => string): MenuItem[] {
  return entries.map((entry) => {
    const label = <span className="manager-nav-item-label">{t(entry.labelKey)}</span>;
    if (!entry.children?.length) return { key: entry.key, icon: entry.icon, label, title: t(entry.labelKey) };
    return { key: entry.key, icon: entry.icon, label, children: buildFallbackItems(entry.children, t) };
  });
}

/** 兜底导航里真正能点进去的那些路由；目录的 key 不是路由，不进来。 */
function fallbackPages(entries: FallbackNavEntry[], t: (key: TranslationKey) => string, group: string): NavPage[] {
  return entries.flatMap((entry) =>
    entry.children?.length
      ? fallbackPages(entry.children, t, t(entry.labelKey))
      : [{ href: entry.key, label: t(entry.labelKey), icon: entry.icon, group }],
  );
}

/** 菜单项的 key 就是它的前端路由；没有 pageUrl 的（纯目录）退回资源编码。 */
function menuKey(resource: ResourceItem) {
  return resource.pageUrl || `resource:${resource.code || resource.id}`;
}

/**
 * 扁平数组 + parentId 拼成 antd 的菜单树。
 *
 * 两处剪枝很关键：没有 pageUrl 的 page 不出现（点了没地方去），
 * 没有有效子节点的 menu 也不出现（一个点开是空的目录比没有更糟）。
 * 后端只要不下发某个资源，整条分支就自动消失。
 */
function buildMenuItems(resources: ResourceItem[], label: (item: ResourceItem) => string): MenuItem[] {
  const sorted = [...resources].sort((a, b) => a.sortId - b.sortId || a.id - b.id);
  const childrenByParent = new Map<number, ResourceItem[]>();
  for (const resource of sorted) {
    const siblings = childrenByParent.get(resource.parentId) ?? [];
    siblings.push(resource);
    childrenByParent.set(resource.parentId, siblings);
  }

  const build = (resource: ResourceItem): MenuItem | null => {
    const icon = MENU_ICONS[resource.icon];
    const content = <span className="manager-nav-item-label">{label(resource)}</span>;
    if (resource.resourceType === "page") {
      if (!resource.pageUrl) return null;
      return { key: menuKey(resource), icon, label: content, title: label(resource) };
    }
    const children = (childrenByParent.get(resource.id) ?? [])
      .map(build)
      .filter((item): item is MenuItem => item !== null);
    if (children.length === 0) return null;
    return { key: menuKey(resource), icon, label: content, children };
  };

  return (childrenByParent.get(0) ?? []).map(build).filter((item): item is MenuItem => item !== null);
}
