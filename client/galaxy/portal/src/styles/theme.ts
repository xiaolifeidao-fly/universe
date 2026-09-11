import type { ThemeConfig } from "antd";

/**
 * antd 主题。
 *
 * 门户里 antd 只负责表单与浮层（Form / Input / Select / message）—— 版面、卡片、
 * 按钮都是 globals.css 里的 .gp-*。理由和两个控制台一样：这套排版的密度和圆角
 * 靠改 token 拉不过来，硬拉只会拉出一套四不像。
 *
 * 数值是手工对齐 globals.css 的第二份，改色两边一起改。
 */

const SANS = `"PingFang SC","Hiragino Sans GB","Microsoft YaHei","Noto Sans CJK SC","Noto Sans SC",system-ui,sans-serif`;

const ACCENT = "#0f7b74";
const ACCENT_HOVER = "#0a5c57";
const INK = "#101a19";
const SURFACE = "#ffffff";
const APP = "#f7f9f8";
const LINE = "rgba(16, 26, 25, 0.08)";
const BORDER = "rgba(16, 26, 25, 0.14)";
const SOFT = "#475652";
const FAINT = "#7d8b87";

export const portalTheme: ThemeConfig = {
  token: {
    colorPrimary: ACCENT,
    colorSuccess: "#2f7d4a",
    colorWarning: "#9a6f14",
    colorError: "#a8352b",
    colorInfo: ACCENT,
    fontFamily: SANS,
    fontSize: 14,
    borderRadius: 10,
    borderRadiusLG: 14,
    borderRadiusSM: 8,
    controlHeight: 42,
    colorBgContainer: SURFACE,
    colorBgElevated: SURFACE,
    colorBgLayout: APP,
    colorBorder: BORDER,
    colorBorderSecondary: LINE,
    colorText: INK,
    colorTextSecondary: SOFT,
    colorTextTertiary: FAINT,
    colorLink: ACCENT_HOVER,
    colorLinkHover: ACCENT,
    boxShadowSecondary: "0 24px 60px -24px rgba(16, 26, 25, 0.3)",
  },
  components: {
    Button: { controlHeight: 42, fontWeight: 600, borderRadius: 11 },
    Input: { controlHeight: 42, borderRadius: 10, paddingInline: 14 },
    Select: { controlHeight: 42, borderRadius: 10, optionSelectedBg: "rgba(15, 123, 116, 0.10)" },
    Form: { labelFontSize: 13, verticalLabelPadding: "0 0 7px" },
    Message: { contentBg: SURFACE },
  },
};
