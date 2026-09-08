"use client";

/**
 * Galaxy 控制台外壳：侧栏 + 顶栏 + 内容区。视觉语言与 client/manager 的
 * ManagerShellStub 一致（同名 manager-* 类），差别只在导航是**分组**的。
 *
 * 为什么分组而不是做角色切换开关：同一个账号既可能挂机贡献算力，也可能买算力用，
 * 这是同一个人的两副面孔。强行二选一只会让人为了看另一半反复切换。
 */

import {
  ApiOutlined,
  ClusterOutlined,
  CreditCardOutlined,
  DashboardOutlined,
  GlobalOutlined,
  KeyOutlined,
  LineChartOutlined,
  LogoutOutlined,
  MenuOutlined,
  SlidersOutlined,
  StarFilled,
} from "@ant-design/icons";
import { Button, Dropdown, Layout, Menu, Select, Space } from "antd";
import type { MenuProps } from "antd";
import { usePathname, useRouter } from "next/navigation";
import { type PropsWithChildren, type ReactNode, useEffect, useState } from "react";
import { useLocale, type TranslationKey } from "@/i18n/LocaleProvider";
import { clearAuthToken, getAuthUser } from "@/utils/auth";

const { Content, Header, Sider } = Layout;

const SIDEBAR_COLLAPSED_KEY = "galaxy-console-sidebar-collapsed";

const PAGE_TITLES: Record<string, [TranslationKey, TranslationKey]> = {
  "/provider/overview": ["provider.title", "provider.subtitle"],
  "/provider/contributions": ["provider.limits.title", "provider.limits.hint"],
  "/provider/records": ["provider.records.title", "provider.records.hint"],
  "/consumer/keys": ["consumer.keys.title", "consumer.keys.hint"],
  "/consumer/billing": ["consumer.billing.title", "consumer.subtitle"],
  "/consumer/usage": ["consumer.usage.title", "consumer.usage.hint"],
  "/consumer/workloads": ["workloads.title", "workloads.subtitle"],
};

const LOCALE_OPTIONS = [
  { value: "zh-CN", labelKey: "locale.zh-CN" },
  { value: "en-US", labelKey: "locale.en-US" },
] as const;

interface NavEntry {
  key: string;
  labelKey: TranslationKey;
  icon: ReactNode;
}

interface NavGroup {
  key: string;
  labelKey: TranslationKey;
  items: NavEntry[];
}

const NAV_GROUPS: NavGroup[] = [
  {
    key: "grp-provider",
    labelKey: "nav.group.provider",
    items: [
      { key: "/provider/overview", labelKey: "nav.overview", icon: <DashboardOutlined /> },
      { key: "/provider/contributions", labelKey: "nav.contributions", icon: <SlidersOutlined /> },
      { key: "/provider/records", labelKey: "nav.records", icon: <ApiOutlined /> },
    ],
  },
  {
    key: "grp-consumer",
    labelKey: "nav.group.consumer",
    items: [
      { key: "/consumer/keys", labelKey: "nav.keys", icon: <KeyOutlined /> },
      { key: "/consumer/billing", labelKey: "nav.billing", icon: <CreditCardOutlined /> },
      { key: "/consumer/workloads", labelKey: "nav.workloads", icon: <ClusterOutlined /> },
      { key: "/consumer/usage", labelKey: "nav.usage", icon: <LineChartOutlined /> },
    ],
  },
];

type MenuItem = Required<MenuProps>["items"][number];

export function GalaxyShell({ children }: PropsWithChildren) {
  const pathname = usePathname();
  const router = useRouter();
  const { locale, setLocale, t } = useLocale();
  const authUser = getAuthUser();

  const [collapsed, setCollapsed] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  useEffect(() => {
    try {
      setCollapsed(window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "1");
    } catch {
      // 侧栏折叠只是偏好，存不了也不该挡住渲染。
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
      // 同上。
    }
  };

  const activePath = pathname ?? "/provider/overview";
  const [pageTitle, pageSubtitle] = PAGE_TITLES[activePath] ?? ["provider.title", "provider.subtitle"];

  const items: MenuItem[] = NAV_GROUPS.map((group) => ({
    key: group.key,
    type: "group" as const,
    label: <span className="manager-nav-group-label">{t(group.labelKey)}</span>,
    children: group.items.map((entry) => ({
      key: entry.key,
      label: (
        <span className="manager-nav-item-content">
          <span className="manager-nav-item-icon">{entry.icon}</span>
          <span className="manager-nav-item-label">{t(entry.labelKey)}</span>
        </span>
      ),
    })),
  }));

  const logout = () => {
    clearAuthToken();
    router.replace("/login");
  };

  return (
    <div className="manager-shell-root">
      <div className="manager-shell-surface">
        {isMobile && mobileMenuOpen ? (
          <button
            className="manager-mobile-sider-mask"
            type="button"
            aria-label={t("shell.closeMenu")}
            onClick={() => setMobileMenuOpen(false)}
          />
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

              <Menu
                className="manager-shell-menu"
                mode="inline"
                selectedKeys={[activePath]}
                items={items}
                onClick={({ key }) => {
                  if (typeof key === "string" && key.startsWith("/")) {
                    router.push(key);
                    setMobileMenuOpen(false);
                  }
                }}
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
                    items: [{ key: "logout", danger: true, icon: <LogoutOutlined />, label: t("shell.logout") }],
                    onClick: () => logout(),
                  }}
                >
                  <Button aria-label={t("shell.logout")}>
                    {authUser?.displayName || authUser?.username || t("shell.logout")}
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
    </div>
  );
}
