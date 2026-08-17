import type { ThemeConfig } from "antd";

const SANS = `"Noto Sans SC","PingFang SC","Hiragino Sans GB","Microsoft YaHei",system-ui,sans-serif`;

/** Keep in sync with the :root token block in app/globals.css. */
const BRAND = "#4f46e5";
const BRAND_HOVER = "#4338ca";
const BRAND_TINT = "rgba(79, 70, 229, 0.04)";
const SUCCESS = "#12a150";
const INK = "#101828";

// Mirrors the token block at the top of app/globals.css. Brand is indigo and is
// kept distinct from colorSuccess: green means "done" on the board, and a green
// primary would make a selected card and a finished card read the same.
export const modernTheme: ThemeConfig = {
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
      // A progress bar reports completion, so it stays on the status green.
      defaultColor: SUCCESS,
    },
    Switch: {
      colorPrimary: BRAND,
    },
  },
};
