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
  BranchesOutlined,
  DashboardOutlined,
  FolderOutlined,
  GlobalOutlined,
  KeyOutlined,
  LogoutOutlined,
  LockOutlined,
  MenuOutlined,
  SafetyCertificateOutlined,
  SettingOutlined,
  StarFilled,
  TeamOutlined,
} from "@ant-design/icons";
import { Button, Dropdown, Layout, Menu, Select, Skeleton, Space, message } from "antd";
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

const { Content, Header, Sider } = Layout;

const SIDEBAR_COLLAPSED_KEY = "ztb-manager-sidebar-collapsed";

// 兜底标题。后端资源里有 name 时优先用后端的（那是能在后台改的），
// 这里留着是为了迁移期两套并存不白屏。
const FALLBACK_PAGE_TITLES: Record<string, [TranslationKey, TranslationKey]> = {
  "/dashboard": ["dashboard.title", "dashboard.subtitle"],
  "/users": ["users.title", "users.subtitle"],
  "/business-lines": ["bizLines.title", "bizLines.subtitle"],
  "/programs": ["programs.title", "programs.subtitle"],
  "/galaxy": ["galaxy.title", "galaxy.subtitle"],
  "/settings/accounts": ["accounts.title", "accounts.subtitle"],
  "/settings/roles": ["roles.title", "roles.subtitle"],
};

// 后端资源接口不通时的静态导航。
const FALLBACK_NAV: { key: string; icon: ReactNode; labelKey: TranslationKey }[] = [
  { key: "/dashboard", icon: <DashboardOutlined />, labelKey: "nav.dashboard" },
  { key: "/users", icon: <TeamOutlined />, labelKey: "nav.users" },
  { key: "/business-lines", icon: <BranchesOutlined />, labelKey: "nav.businessLines" },
  { key: "/programs", icon: <FolderOutlined />, labelKey: "nav.programs" },
  { key: "/galaxy", icon: <GlobalOutlined />, labelKey: "nav.galaxy" },
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
};

const LOCALE_OPTIONS = [
  { value: "zh-CN", labelKey: "locale.zh-CN" },
  { value: "en-US", labelKey: "locale.en-US" },
] as const;

type MenuItem = Required<MenuProps>["items"][number];

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
        setMenus(resources);
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

  const updateCollapsed = (next: boolean) => {
    setCollapsed(next);
    try {
      window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, next ? "1" : "0");
    } catch {
      // Storage is optional for the shell preference.
    }
  };

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
      return FALLBACK_NAV.map((entry) => ({
        key: entry.key,
        label: (
          <span className="manager-nav-item-content">
            <span className="manager-nav-item-icon">{entry.icon}</span>
            <span className="manager-nav-item-label">{t(entry.labelKey)}</span>
          </span>
        ),
      }));
    }
    return buildMenuItems(menus, resourceLabel);
  }, [menus, menuUnavailable, resourceLabel, t]);

  // 能进的页面。后端已经按角色过滤过了，这里只是别让点击把人送去一个必然 403 的页面。
  const permittedPaths = useMemo(() => {
    if (menus.length === 0) {
      return menuUnavailable ? new Set(FALLBACK_NAV.map((entry) => entry.key)) : new Set<string>();
    }
    return new Set(menus.filter((item) => item.pageUrl).map((item) => item.pageUrl));
  }, [menus, menuUnavailable]);

  const [fallbackTitle, fallbackSubtitle] =
    FALLBACK_PAGE_TITLES[activePath] ?? ["dashboard.title", "dashboard.subtitle"];
  const activeResource = menus.find((item) => item.pageUrl && activePath.startsWith(item.pageUrl));
  const pageTitle = activeResource ? resourceLabel(activeResource) : t(fallbackTitle);
  const pageSubtitle = t(fallbackSubtitle);

  const logout = () => {
    // 先请服务端把令牌删掉再清本地。反过来的话，本地清了但服务端那条会话
    // 还活着，令牌被人抄走就一直有效。请求失败也照样跳走 —— 用户要的是登出。
    void logoutRequest().catch(() => undefined);
    clearAuthToken();
    router.replace("/login");
  };

  return (
    // 默认 false：profile 还没回来时按只读渲染，避免闪出一排点不动的写按钮。
    <WritePermissionProvider value={profile?.writable ?? false}>
    <div className="manager-shell-root" data-can-write={profile?.writable ? "true" : "false"}>
      <div className="manager-shell-surface">
        {isMobile && mobileMenuOpen ? (
          <button className="manager-mobile-sider-mask" type="button" aria-label={t("shell.closeMenu")} onClick={() => setMobileMenuOpen(false)} />
        ) : null}
        <Layout className="manager-shell-layout" style={{ height: "100%", minHeight: 0, background: "transparent" }}>
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
              style={{ height: "100%", padding: "20px 14px", display: "flex", flexDirection: "column", gap: 12, overflowX: "hidden" }}
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

              {menuLoading ? (
                // 菜单是首屏，转圈会让整块区域空着；骨架屏至少保住了布局。
                <div style={{ flex: 1, padding: "8px 6px" }}>
                  <Skeleton active paragraph={{ rows: 5 }} title={false} />
                </div>
              ) : (
                <Menu
                  className="manager-shell-menu"
                  mode="inline"
                  selectedKeys={[activePath]}
                  defaultOpenKeys={menus.filter((item) => item.parentId === 0).map((item) => menuKey(item))}
                  items={menuItems}
                  onClick={({ key }) => {
                    // 只跳进得去的页面。后端才是真正的门，这里只是别把人送去必然 403 的地方。
                    if (typeof key === "string" && key.startsWith("/") && permittedPaths.has(key)) {
                      router.push(key);
                      setMobileMenuOpen(false);
                    }
                  }}
                  style={{ fontSize: "var(--manager-fs-base)", flex: 1 }}
                />
              )}

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
                aria-label={isMobile ? (mobileMenuOpen ? t("shell.closeMenu") : t("shell.openMenu")) : collapsed ? t("shell.expandMenu") : t("shell.collapseMenu")}
                icon={<MenuOutlined />}
                onClick={() => (isMobile ? setMobileMenuOpen(!mobileMenuOpen) : updateCollapsed(!collapsed))}
              />
              <div className="manager-prototype-title" style={{ minWidth: 0 }}>
                <h1>{pageTitle}</h1>
                <div>{pageSubtitle}</div>
              </div>
              <span style={{ flex: 1 }} />
              <Space size={8}>
                <Select
                  aria-label={t("locale.label")}
                  className="manager-locale-select"
                  value={locale}
                  onChange={(value) => setLocale(value as typeof locale)}
                  options={LOCALE_OPTIONS.map((item) => ({ value: item.value, label: t(item.labelKey) }))}
                />
                <Dropdown
                  trigger={["click"]}
                  menu={{
                    items: [
                      { key: "password", icon: <LockOutlined />, label: t("password.title") },
                      { key: "logout", danger: true, icon: <LogoutOutlined />, label: t("shell.logout") },
                    ],
                    onClick: ({ key }) => (key === "password" ? setPasswordOpen(true) : logout()),
                  }}
                >
                  <Button aria-label={t("shell.logout")}>
                    {profile?.displayName || profile?.username || authUser?.displayName || t("shell.logout")}
                  </Button>
                </Dropdown>
              </Space>
            </Header>

            <Content className="manager-console-content" style={{ padding: 20 }}>
              <div className="manager-stagger-3">{children}</div>
            </Content>
          </Layout>
        </Layout>
      </div>
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
    const content = (
      <span className="manager-nav-item-content">
        {icon ? <span className="manager-nav-item-icon">{icon}</span> : null}
        <span className="manager-nav-item-label">{label(resource)}</span>
      </span>
    );
    if (resource.resourceType === "page") {
      if (!resource.pageUrl) return null;
      return { key: menuKey(resource), label: content };
    }
    const children = (childrenByParent.get(resource.id) ?? [])
      .map(build)
      .filter((item): item is MenuItem => item !== null);
    if (children.length === 0) return null;
    return { key: menuKey(resource), label: content, children };
  };

  return (childrenByParent.get(0) ?? []).map(build).filter((item): item is MenuItem => item !== null);
}
