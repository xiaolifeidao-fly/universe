import type { ThemeConfig } from "antd";

/**
 * antd 主题。
 *
 * antd 在 Orbit 里只负责浮层（Modal / Select / Popconfirm / message / Spin）——
 * 表格、按钮、输入框都是 @shared/styles/galaxy.css 里的原生件。原型的密度和
 * antd 的默认排版差得太远，靠 token 拉不过来，只会拉出一套四不像。
 *
 * 所以这份配置只做一件事：让那几个浮层的圆角、字体和强调色跟 --gx-* 对上。
 * 数值是手工对齐 globals.css 的第二份，改色两边一起改。
 */

const SANS = `"PingFang SC","Hiragino Sans GB","Microsoft YaHei","Noto Sans CJK SC","Noto Sans SC",system-ui,sans-serif`;

const ACCENT = "#0f7b74";
const ACCENT_HOVER = "#0a5c57";
const INK = "#14201f";
const SURFACE = "#ffffff";
const APP = "#f1f5f4";
const LINE = "rgba(20, 32, 31, 0.09)";
const BORDER = "rgba(20, 32, 31, 0.16)";
const SOFT = "#4b5957";
const FAINT = "#7f8b89";

export const galaxyTheme: ThemeConfig = {
  token: {
    colorPrimary: ACCENT,
    colorSuccess: "#2f7d4a",
    colorWarning: "#9a6f14",
    colorError: "#a8352b",
    colorInfo: ACCENT,
    fontFamily: SANS,
    fontSize: 13.5,
    borderRadius: 10,
    borderRadiusLG: 14,
    borderRadiusSM: 8,
    controlHeight: 38,
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
    colorLinkActive: ACCENT_HOVER,
    boxShadowSecondary: "0 24px 60px -20px rgba(28, 25, 23, 0.28)",
  },
  components: {
    Button: { controlHeight: 38, controlHeightSM: 30, fontWeight: 600, borderRadius: 10 },
    Select: { controlHeight: 38, borderRadius: 10, optionSelectedBg: "rgba(15, 123, 116, 0.10)" },
    Modal: { borderRadiusLG: 16, titleFontSize: 16 },
    Message: { contentBg: SURFACE },
    Tooltip: { borderRadius: 8 },
    Segmented: { itemSelectedBg: SURFACE, trackBg: "rgba(20, 32, 31, 0.05)" },
  },
};

/** 老名字，留给还没改过来的 import。 */
export { galaxyTheme as modernTheme };
