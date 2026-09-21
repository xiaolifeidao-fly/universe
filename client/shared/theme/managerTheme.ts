import type { ThemeConfig } from "antd";

/**
 * antd ThemeConfig —— 从 client/web/src/styles/theme.ts 原样搬过来。
 *
 * TODO(shared-theme): client/web/src/styles/theme.ts 目前还是自己那份拷贝
 * （数值一致，未切换成从这里 import）。这次新建 client/manager 没有动 web 的
 * 现有文件，留给后续单独评估再做迁移。
 *
 * token 值和 client/shared/styles/tokens.css 的 :root 是手工对齐的两份，
 * 改配色两边要一起改。
 */
const SANS = `"Noto Sans SC","PingFang SC","Hiragino Sans GB","Microsoft YaHei",system-ui,sans-serif`;

const BRAND = "#4f46e5";
const BRAND_HOVER = "#4338ca";
/** 表格行的悬停底色。**必须是不透明色**：这个颜色会盖到右侧 `fixed` 列的单元格上，
 *  而那一格是 `position: sticky` 浮在横向滚走的列上面的 —— 底色一旦带 alpha，
 *  被它压住的「状态 / 排序」等列就会直接透出来，和操作按钮叠成一团（模型价目表最明显）。
 *  antd 自己的默认值同理：它把半透明的 colorFillAlter 先压到 colorBgContainer 上
 *  算成实色再用。这里的值＝ rgba(79, 70, 229, 0.04) 压在白底（#ffffff）上的等价色。 */
const BRAND_TINT = "#f8f8fe";
const SUCCESS = "#12a150";
const INK = "#101828";

export const managerTheme: ThemeConfig = {
  token: {
    colorPrimary: BRAND,
    colorSuccess: SUCCESS,
    colorWarning: "#c07600",
    colorError: "#dc2626",
    colorInfo: "#0e8ba8",
    fontFamily: SANS,
    fontSize: 14,
    borderRadius: 12,
    borderRadiusLG: 16,
    borderRadiusSM: 8,
    boxShadow: "0 1px 2px rgba(16, 24, 40, 0.05), 0 4px 12px -4px rgba(16, 24, 40, 0.10)",
    boxShadowSecondary: "0 24px 60px -20px rgba(16, 24, 40, 0.28)",
    padding: 16,
    margin: 16,
    colorBgContainer: "#ffffff",
    colorBgElevated: "#ffffff",
    colorBgLayout: "#eef1f6",
    colorBorder: "rgba(16, 24, 40, 0.14)",
    colorBorderSecondary: "rgba(16, 24, 40, 0.09)",
    colorText: "#101828",
    colorTextSecondary: "#3d4757",
    colorTextTertiary: "#667085",
    colorTextQuaternary: "rgba(16, 24, 40, 0.3)",
    colorLink: BRAND,
    colorLinkHover: BRAND_HOVER,
    colorLinkActive: BRAND_HOVER,
  },
  components: {
    Button: {
      controlHeight: 34,
      controlHeightLG: 40,
      controlHeightSM: 28,
      fontWeight: 500,
      borderRadius: 8,
      borderRadiusLG: 8,
      borderRadiusSM: 8,
      primaryShadow: "0 1px 2px rgba(16, 24, 40, 0.1), 0 8px 18px -8px rgba(79, 70, 229, 0.55)",
      defaultBg: "#ffffff",
      defaultBorderColor: "rgba(16, 24, 40, 0.14)",
      defaultColor: "#101828",
    },
    Input: {
      controlHeight: 34,
      controlHeightLG: 40,
      controlHeightSM: 28,
      borderRadius: 8,
      paddingBlock: 7,
      activeBorderColor: BRAND,
      hoverBorderColor: BRAND,
      colorBgContainer: "#ffffff",
    },
    InputNumber: {
      controlHeight: 34,
      borderRadius: 8,
    },
    Select: {
      controlHeight: 34,
      controlHeightLG: 40,
      controlHeightSM: 28,
      borderRadius: 8,
      colorBgContainer: "#ffffff",
    },
    DatePicker: {
      controlHeight: 34,
      borderRadius: 8,
    },
    Card: {
      borderRadiusLG: 16,
      paddingLG: 20,
    },
    Modal: {
      borderRadiusLG: 20,
    },
    Message: {
      contentBg: "#ffffff",
      contentPadding: "10px 16px",
    },
    Tag: {
      borderRadiusSM: 20,
      defaultBg: "#f2f5f9",
      defaultColor: "#3d4757",
    },
    Layout: {
      headerBg: "rgba(255,255,255,0.72)",
      headerHeight: 64,
      headerPadding: "0 24px",
      siderBg: "transparent",
      bodyBg: "transparent",
    },
    Table: {
      borderColor: "rgba(16, 24, 40, 0.09)",
      headerBg: "#f2f5f9",
      headerColor: "#667085",
      rowHoverBg: BRAND_TINT,
      borderRadius: 12,
    },
    Tabs: {
      itemSelectedColor: BRAND,
      itemHoverColor: INK,
      inkBarColor: BRAND,
    },
    Segmented: {
      itemSelectedBg: "#ffffff",
      itemSelectedColor: BRAND,
      trackBg: "#f2f5f9",
      borderRadius: 10,
    },
    Pagination: {
      itemActiveBg: BRAND,
      colorPrimary: BRAND,
      colorPrimaryHover: BRAND_HOVER,
      borderRadius: 8,
    },
    Drawer: {
      colorBgElevated: "#ffffff",
    },
    Progress: {
      defaultColor: SUCCESS,
    },
    Switch: {
      colorPrimary: BRAND,
    },
  },
};
