/**
 * 图标。一律手绘 inline SVG，24 网格、1.6 描边、currentColor ——
 * 不用 emoji，也不引图标库：门户上图标只有十来个，为它拉一个包不划算，
 * 而 emoji 在不同系统上长得完全不一样，那不叫设计。
 */

import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function Icon({ size = 20, children, ...rest }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      {children}
    </svg>
  );
}

export function IconArrowRight(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4 12h15" />
      <path d="m13 6 6 6-6 6" />
    </Icon>
  );
}

export function IconPlus(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </Icon>
  );
}

export function IconSearch(props: IconProps) {
  return (
    <Icon size={16} {...props}>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.6-3.6" />
    </Icon>
  );
}

export function IconCopy(props: IconProps) {
  return (
    <Icon size={16} {...props}>
      <rect x="9" y="9" width="11" height="11" rx="2.5" />
      <path d="M5 15V6a2 2 0 0 1 2-2h8" />
    </Icon>
  );
}

export function IconCheck(props: IconProps) {
  return (
    <Icon size={16} {...props}>
      <path d="m5 13 4 4 10-11" />
    </Icon>
  );
}

export function IconGlobe(props: IconProps) {
  return (
    <Icon size={18} {...props}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M3.5 12h17" />
      <path d="M12 3.5c2.2 2.4 3.3 5.3 3.3 8.5s-1.1 6.1-3.3 8.5c-2.2-2.4-3.3-5.3-3.3-8.5S9.8 5.9 12 3.5Z" />
    </Icon>
  );
}

export function IconMenu(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4 7h16" />
      <path d="M4 12h16" />
      <path d="M4 17h16" />
    </Icon>
  );
}

export function IconClose(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="m6 6 12 12" />
      <path d="m18 6-12 12" />
    </Icon>
  );
}

export function IconKey(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="8" cy="15" r="4" />
      <path d="m10.8 12.2 8.2-8.2" />
      <path d="m16 7 2.5 2.5" />
    </Icon>
  );
}

export function IconGauge(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4.5 17a8.5 8.5 0 1 1 15 0" />
      <path d="m12 13 4-3.5" />
      <circle cx="12" cy="13.6" r="1.4" fill="currentColor" stroke="none" />
    </Icon>
  );
}

export function IconReceipt(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M5.5 3.5h13v17l-2.2-1.6-2.2 1.6-2.1-1.6-2.2 1.6-2.3-1.6V3.5Z" />
      <path d="M9 8.5h6" />
      <path d="M9 12.5h4" />
    </Icon>
  );
}

export function IconShield(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 3.5 19 6v5.4c0 4-2.8 7.5-7 9.1-4.2-1.6-7-5.1-7-9.1V6l7-2.5Z" />
      <path d="m9 12 2.2 2.2L15.5 10" />
    </Icon>
  );
}

export function IconSnow(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 3.5v17" />
      <path d="m4.6 7.8 14.8 8.4" />
      <path d="m19.4 7.8-14.8 8.4" />
      <path d="m9.6 5.4 2.4 2.2 2.4-2.2" />
      <path d="m9.6 18.6 2.4-2.2 2.4 2.2" />
    </Icon>
  );
}

export function IconLock(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="4.5" y="10.5" width="15" height="10" rx="2.5" />
      <path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" />
    </Icon>
  );
}

export function IconPlug(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M9 3.5v5" />
      <path d="M15 3.5v5" />
      <path d="M6.5 8.5h11v3a5.5 5.5 0 0 1-11 0v-3Z" />
      <path d="M12 17v3.5" />
    </Icon>
  );
}

export function IconMail(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="3.5" y="5.5" width="17" height="13" rx="2.5" />
      <path d="m4.5 8 7.5 5 7.5-5" />
    </Icon>
  );
}

export function IconChat(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M20 12.5c0 3.9-3.6 7-8 7-1 0-2-.2-2.9-.5L4.5 20.5l1.2-3.6A6.7 6.7 0 0 1 4 12.5c0-3.9 3.6-7 8-7s8 3.1 8 7Z" />
    </Icon>
  );
}

/** 品牌标记：一颗核 + 两条轨道。和首屏那张轨道图是同一个意象。 */
export function BrandMark({ size = 30, ...rest }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden="true" {...rest}>
      <ellipse cx="16" cy="16" rx="14.2" ry="6.6" stroke="currentColor" strokeWidth="1.5" opacity="0.34"
        transform="rotate(-28 16 16)" />
      <ellipse cx="16" cy="16" rx="14.2" ry="6.6" stroke="currentColor" strokeWidth="1.5" opacity="0.62"
        transform="rotate(32 16 16)" />
      <circle cx="16" cy="16" r="5.1" fill="currentColor" />
      <circle cx="27.2" cy="10.4" r="2" fill="currentColor" opacity="0.7" />
    </svg>
  );
}
