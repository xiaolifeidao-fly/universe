import type { ThemeConfig } from "antd";

/**
 * 管理端自己的 antd 主题。
 *
 * 以前是直接转出 @shared/theme/managerTheme（client/web 那套），2026-10 管理端单独
 * 改版之后拆开：那份还被 web 与 Galaxy 的几个端引用着，改它会连带动别人的界面。
 * 这里的数值和 src/styles/tokens.css 的 :root 是手工对齐的两份 —— CSS 变量给
 * 自己写的类用，这里给 antd 组件用，改配色两边要一起改。
 */
const SANS = `-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", system-ui, sans-serif`;

const BRAND = "#5b5bd6";
const BRAND_HOVER = "#4c4cc4";
const BRAND_ACTIVE = "#4141ad";
const INK = "#18181b";
const INK_SOFT = "#52525b";
const INK_FAINT = "#71717a";
const LINE = "rgba(24, 24, 27, 0.08)";
const LINE_STRONG = "rgba(24, 24, 27, 0.14)";
const PANEL = "#f4f4f5";
/** 表格行悬停底色。**必须不透明**：它会盖到右侧 fixed 列上，那一格是 sticky 浮在横向
 *  滚走的列上面的，带 alpha 就会把底下的列透出来。值＝品牌色 4% 压在白底上的实色。 */
const ROW_HOVER = "#f8f8fe";

export const modernTheme: ThemeConfig = {
  token: {
    colorPrimary: BRAND,
    colorPrimaryHover: BRAND_HOVER,
    colorPrimaryActive: BRAND_ACTIVE,
    colorSuccess: "#1f9d55",
    colorWarning: "#c2700a",
    colorError: "#e5484d",
    colorInfo: "#0b8ec2",
    colorLink: BRAND,
    colorLinkHover: BRAND_HOVER,
    colorLinkActive: BRAND_ACTIVE,
    fontFamily: SANS,
    fontSize: 14,
    lineHeight: 1.5715,
    borderRadius: 8,
    borderRadiusLG: 12,
    borderRadiusSM: 6,
    borderRadiusXS: 4,
    controlHeight: 34,
    controlHeightLG: 40,
    controlHeightSM: 26,
    colorBgLayout: "#f6f6f7",
    colorBgContainer: "#ffffff",
    colorBgElevated: "#ffffff",
    colorBorder: LINE_STRONG,
    colorBorderSecondary: LINE,
    colorSplit: LINE,
    colorText: INK,
    colorTextSecondary: INK_SOFT,
    colorTextTertiary: INK_FAINT,
    colorTextQuaternary: "#a1a1aa",
    colorTextPlaceholder: "#a1a1aa",
    colorFillAlter: "#fafafa",
    colorFillSecondary: "rgba(24, 24, 27, 0.05)",
    colorFillTertiary: "rgba(24, 24, 27, 0.04)",
    colorFillQuaternary: "rgba(24, 24, 27, 0.025)",
    boxShadow: "0 1px 2px rgba(24, 24, 27, 0.04), 0 4px 16px -4px rgba(24, 24, 27, 0.08)",
    boxShadowSecondary:
      "0 0 0 1px rgba(24, 24, 27, 0.06), 0 8px 24px -6px rgba(24, 24, 27, 0.16), 0 2px 6px -2px rgba(24, 24, 27, 0.06)",
    boxShadowTertiary: "0 1px 2px rgba(24, 24, 27, 0.04)",
    motionDurationMid: "0.18s",
    motionDurationSlow: "0.26s",
    motionEaseOut: "cubic-bezier(0.22, 1, 0.36, 1)",
    wireframe: false,
  },
  components: {
    Button: {
      fontWeight: 500,
      paddingInline: 14,
      paddingInlineLG: 18,
      primaryShadow: "0 1px 2px rgba(24, 24, 27, 0.12), inset 0 1px 0 rgba(255, 255, 255, 0.14)",
      defaultShadow: "0 1px 2px rgba(24, 24, 27, 0.05)",
      dangerShadow: "0 1px 2px rgba(24, 24, 27, 0.08)",
      defaultBorderColor: LINE_STRONG,
      defaultColor: INK,
      defaultHoverBorderColor: "rgba(24, 24, 27, 0.22)",
      defaultHoverColor: INK,
      defaultHoverBg: "#fafafa",
      defaultActiveBg: PANEL,
      defaultActiveBorderColor: "rgba(24, 24, 27, 0.22)",
      defaultActiveColor: INK,
      textHoverBg: "rgba(24, 24, 27, 0.05)",
    },
    Input: {
      paddingBlock: 6,
      activeShadow: "0 0 0 3px rgba(91, 91, 214, 0.14)",
      hoverBorderColor: "rgba(24, 24, 27, 0.24)",
    },
    InputNumber: {
      activeShadow: "0 0 0 3px rgba(91, 91, 214, 0.14)",
      hoverBorderColor: "rgba(24, 24, 27, 0.24)",
    },
    Select: {
      hoverBorderColor: "rgba(24, 24, 27, 0.24)",
      activeOutlineColor: "rgba(91, 91, 214, 0.14)",
      optionSelectedBg: "#f0f0fc",
      optionSelectedFontWeight: 500,
      optionActiveBg: "rgba(24, 24, 27, 0.04)",
      optionPadding: "6px 10px",
    },
    DatePicker: {
      hoverBorderColor: "rgba(24, 24, 27, 0.24)",
      activeShadow: "0 0 0 3px rgba(91, 91, 214, 0.14)",
    },
    Card: {
      paddingLG: 20,
      headerFontSize: 15,
      headerHeight: 52,
    },
    Modal: {
      borderRadiusLG: 16,
      titleFontSize: 16,
      contentBg: "#ffffff",
      headerBg: "#ffffff",
    },
    Drawer: {
      colorBgElevated: "#ffffff",
    },
    Dropdown: {
      paddingBlock: 7,
      controlItemBgHover: "rgba(24, 24, 27, 0.045)",
    },
    Menu: {
      itemHeight: 34,
      itemBorderRadius: 8,
      itemMarginInline: 0,
      itemMarginBlock: 1,
      itemColor: INK_SOFT,
      itemHoverColor: INK,
      itemHoverBg: "rgba(24, 24, 27, 0.045)",
      itemSelectedColor: INK,
      itemSelectedBg: "#ffffff",
      itemActiveBg: "rgba(24, 24, 27, 0.06)",
      subMenuItemBg: "transparent",
      groupTitleColor: INK_FAINT,
      iconSize: 16,
      collapsedIconSize: 17,
      iconMarginInlineEnd: 10,
      activeBarBorderWidth: 0,
    },
    Message: {
      contentBg: "#ffffff",
      contentPadding: "9px 14px",
    },
    Notification: {
      width: 380,
    },
    Tag: {
      defaultBg: PANEL,
      defaultColor: INK_SOFT,
    },
    Layout: {
      headerBg: "transparent",
      headerHeight: 56,
      headerPadding: "0 24px",
      siderBg: "transparent",
      bodyBg: "transparent",
    },
    Table: {
      headerBg: "#fafafa",
      headerColor: INK_FAINT,
      headerSplitColor: "transparent",
      headerBorderRadius: 0,
      borderColor: LINE,
      rowHoverBg: ROW_HOVER,
      rowSelectedBg: "#f3f3fd",
      rowSelectedHoverBg: "#ececfb",
      cellPaddingBlock: 12,
      cellPaddingInline: 14,
      cellPaddingBlockSM: 9,
      cellPaddingInlineSM: 12,
      footerBg: "#fafafa",
      expandIconBg: "#ffffff",
      fixedHeaderSortActiveBg: "#f4f4f5",
      bodySortBg: "#fcfcfd",
    },
    Tabs: {
      itemColor: INK_FAINT,
      itemSelectedColor: INK,
      itemHoverColor: INK,
      itemActiveColor: INK,
      inkBarColor: BRAND,
      titleFontSize: 14,
      horizontalItemPadding: "10px 2px",
      horizontalItemGutter: 24,
    },
    Segmented: {
      itemSelectedBg: "#ffffff",
      itemSelectedColor: INK,
      itemColor: INK_FAINT,
      itemHoverColor: INK,
      itemHoverBg: "rgba(24, 24, 27, 0.04)",
      // 不能用 PANEL：页面底色 #f6f6f7 和它只差一档，直接铺在页面上的分段控件会看不出轨道。
      trackBg: "rgba(24, 24, 27, 0.06)",
      trackPadding: 3,
    },
    Pagination: {
      itemActiveBg: "#ffffff",
      itemBg: "transparent",
    },
    Progress: {
      defaultColor: BRAND,
      remainingColor: "rgba(24, 24, 27, 0.07)",
    },
    Switch: {
      colorPrimary: BRAND,
      colorPrimaryHover: BRAND_HOVER,
    },
    Tooltip: {
      colorBgSpotlight: "#18181b",
      borderRadius: 6,
    },
    Popover: {
      borderRadiusLG: 12,
    },
    Alert: {
      borderRadiusLG: 10,
      withDescriptionPadding: "14px 16px",
      defaultPadding: "9px 14px",
    },
    Form: {
      labelColor: INK_SOFT,
      labelFontSize: 13,
      verticalLabelPadding: "0 0 6px",
      itemMarginBottom: 20,
    },
    Statistic: {
      contentFontSize: 26,
      titleFontSize: 13,
    },
    Descriptions: {
      labelBg: "#fafafa",
      titleColor: INK,
    },
    Badge: {
      dotSize: 7,
    },
    Skeleton: {
      gradientFromColor: "rgba(24, 24, 27, 0.05)",
      gradientToColor: "rgba(24, 24, 27, 0.09)",
    },
    Empty: {
      colorTextDescription: INK_FAINT,
    },
  },
};
