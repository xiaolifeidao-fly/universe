/**
 * 全景视图三维场景的专属配色（对齐原型 assets/data.js 的 C 常量），
 * 在深色雾化背景下需要比 --manager-* 更高的饱和度才能读出来。
 * 三维小球（PanoramaStage）和二维卡片/图例（PanoramaWorkspace）必须用同一份值，
 * 否则同一个状态在球和卡片上会显示成两个颜色。
 */
export const PANORAMA_HEX = {
  red: 0xf43f5e,
  amber: 0xfbbf24,
  green: 0x34d399,
  cyan: 0x22d3ee,
  gray: 0x46536e,
  slate: 0x5d6f95,
} as const;

export const PANORAMA_CSS = {
  red: "#f43f5e",
  amber: "#fbbf24",
  green: "#34d399",
  cyan: "#22d3ee",
  gray: "#46536e",
  slate: "#5d6f95",
} as const;
