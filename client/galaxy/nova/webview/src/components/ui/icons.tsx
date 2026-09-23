/**
 * 图标。24×24、1.6 描边、currentColor —— 和原型里那套一模一样。
 *
 * 为什么不用 @ant-design/icons：那套是实心填充风格，和这里的纸感线条排在一起
 * 会明显是两拨人画的。图标数量就这些，自己画一份比挑一个图标库更省事，
 * 也不必为二十几个图标背一个包。
 */

import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function Svg({ size = 18, children, ...rest }: IconProps) {
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

export const IconHome = (props: IconProps) => (
  <Svg {...props}>
    <path d="M4 10.5 12 4l8 6.5V20a1 1 0 0 1-1 1h-4.5v-6h-5v6H5a1 1 0 0 1-1-1z" />
  </Svg>
);

export const IconSliders = (props: IconProps) => (
  <Svg {...props}>
    <path d="M4 7h10M18 7h2M4 12h3M11 12h9M4 17h12M20 17h0" />
    <circle cx="16" cy="7" r="2" />
    <circle cx="9" cy="12" r="2" />
    <circle cx="18" cy="17" r="2" />
  </Svg>
);

export const IconCoins = (props: IconProps) => (
  <Svg {...props}>
    <ellipse cx="10" cy="7" rx="6" ry="2.5" />
    <path d="M4 7v5c0 1.4 2.7 2.5 6 2.5s6-1.1 6-2.5V7" />
    <path d="M4 12v5c0 1.4 2.7 2.5 6 2.5s6-1.1 6-2.5v-5" />
    <path d="M20 10v7c0 1.4-2 2.4-4 2.5" />
  </Svg>
);

export const IconList = (props: IconProps) => (
  <Svg {...props}>
    <path d="M8 6h12M8 12h12M8 18h12" />
    <circle cx="4" cy="6" r="1" fill="currentColor" />
    <circle cx="4" cy="12" r="1" fill="currentColor" />
    <circle cx="4" cy="18" r="1" fill="currentColor" />
  </Svg>
);

export const IconUser = (props: IconProps) => (
  <Svg {...props}>
    <circle cx="12" cy="8" r="4" />
    <path d="M4 21c0-4 3.6-7 8-7s8 3 8 7" />
  </Svg>
);

export const IconKey = (props: IconProps) => (
  <Svg {...props}>
    <circle cx="8" cy="14" r="4" />
    <path d="M11 11l9-9M16 6l3 3M13 9l2 2" />
  </Svg>
);

export const IconLock = (props: IconProps) => (
  <Svg {...props}>
    <rect x="5" y="10.5" width="14" height="10" rx="2" />
    <path d="M8 10.5V7.5a4 4 0 0 1 8 0v3M12 14.5v2" />
  </Svg>
);

export const IconBag = (props: IconProps) => (
  <Svg {...props}>
    <path d="M5 8h14l-1 12H6z" />
    <path d="M9 8V6a3 3 0 0 1 6 0v2" />
  </Svg>
);

export const IconChat = (props: IconProps) => (
  <Svg {...props}>
    <path d="M4 6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H9l-5 4z" />
  </Svg>
);

export const IconSparkle = (props: IconProps) => (
  <Svg {...props}>
    <path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z" />
  </Svg>
);

export const IconShield = (props: IconProps) => (
  <Svg {...props}>
    <path d="M12 3l8 3v6c0 4.5-3.4 7.8-8 9-4.6-1.2-8-4.5-8-9V6z" />
    <path d="M9 12l2 2 4-4" />
  </Svg>
);

export const IconBell = (props: IconProps) => (
  <Svg {...props}>
    <path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z" />
    <path d="M10 21h4" />
  </Svg>
);

export const IconMonitor = (props: IconProps) => (
  <Svg {...props}>
    <rect x="4" y="5" width="16" height="11" rx="1.5" />
    <path d="M2 19h20" />
  </Svg>
);

export const IconGpu = (props: IconProps) => (
  <Svg {...props}>
    <rect x="3" y="6" width="18" height="12" rx="2" />
    <circle cx="9" cy="12" r="3" />
    <path d="M15 9h3M15 12h3M15 15h3" />
  </Svg>
);

export const IconCard = (props: IconProps) => (
  <Svg {...props}>
    <rect x="3" y="6" width="18" height="13" rx="2" />
    <path d="M3 10h18" />
    <circle cx="16.5" cy="14.5" r="1" fill="currentColor" />
  </Svg>
);

export const IconClock = (props: IconProps) => (
  <Svg {...props}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 7v5l3.5 2" />
  </Svg>
);

export const IconMoon = (props: IconProps) => (
  <Svg {...props}>
    <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z" />
  </Svg>
);

export const IconRefresh = (props: IconProps) => (
  <Svg {...props}>
    <path d="M20 12a8 8 0 0 1-14.5 4.6M4 12a8 8 0 0 1 14.5-4.6" />
    <path d="M19 3v5h-5M5 21v-5h5" />
  </Svg>
);

export const IconSearch = (props: IconProps) => (
  <Svg {...props}>
    <circle cx="11" cy="11" r="6.5" />
    <path d="M20 20l-4.3-4.3" />
  </Svg>
);

export const IconChart = (props: IconProps) => (
  <Svg {...props}>
    <path d="M4 20V4M4 20h16" />
    <path d="M8 15l3-4 3 2 5-6" />
  </Svg>
);

export const IconSend = (props: IconProps) => (
  <Svg {...props}>
    <path d="M4 12l16-8-6 16-2.5-6.5z" />
  </Svg>
);

export const IconCopy = (props: IconProps) => (
  <Svg {...props}>
    <rect x="9" y="9" width="11" height="11" rx="2" />
    <path d="M5 15V6a2 2 0 0 1 2-2h9" />
  </Svg>
);

export const IconCheck = (props: IconProps) => (
  <Svg {...props}>
    <path d="M5 12.5l4.5 4.5L19 7" />
  </Svg>
);

export const IconPlus = (props: IconProps) => (
  <Svg {...props}>
    <path d="M12 5v14M5 12h14" />
  </Svg>
);

export const IconClose = (props: IconProps) => (
  <Svg {...props}>
    <path d="M6 6l12 12M18 6L6 18" />
  </Svg>
);

export const IconChevronDown = (props: IconProps) => (
  <Svg {...props}>
    <path d="M6 9l6 6 6-6" />
  </Svg>
);

export const IconChevronRight = (props: IconProps) => (
  <Svg {...props}>
    <path d="M9 6l6 6-6 6" />
  </Svg>
);

export const IconArrowRight = (props: IconProps) => (
  <Svg {...props}>
    <path d="M5 12h14M13 6l6 6-6 6" />
  </Svg>
);

export const IconDownload = (props: IconProps) => (
  <Svg {...props}>
    <path d="M12 4v11M7.5 10.5L12 15l4.5-4.5" />
    <path d="M5 19h14" />
  </Svg>
);

export const IconLogout = (props: IconProps) => (
  <Svg {...props}>
    <path d="M15 5H7a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h8" />
    <path d="M12 12h9M18 9l3 3-3 3" />
  </Svg>
);

export const IconAlert = (props: IconProps) => (
  <Svg {...props}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 7.5v5M12 16h.01" />
  </Svg>
);

export const IconPlug = (props: IconProps) => (
  <Svg {...props}>
    <path d="M9 3v6M15 3v6" />
    <path d="M6 9h12v3a6 6 0 0 1-12 0z" />
    <path d="M12 18v3" />
  </Svg>
);

export const IconWallet = (props: IconProps) => (
  <Svg {...props}>
    <path d="M3 8a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    <path d="M16 11h5v4h-5a2 2 0 0 1 0-4z" />
  </Svg>
);
