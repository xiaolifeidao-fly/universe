"use client";

/**
 * 两张小图：24 小时时段条、一周积分柱。
 *
 * 没有引图表库。它们各自只有一种形态、没有坐标轴、没有 tooltip，
 * 为这两个东西背一个 echarts / recharts 不划算，而且那些库的默认样式
 * 和这套纸感排版对不上，最后还是要一条条覆盖。
 */

import { useMemo } from "react";
import { formatPoints } from "@/utils/format";

/**
 * 时段条。selected 是 24 个布尔，空数组表示全天共享。
 *
 * onToggle 传了才可点：今天那页只是看一眼「现在在不在时段里」，
 * 共享设置那页才真的能改。
 */
export function HourBar({
  hours,
  now,
  nowLabel,
  onToggle,
}: {
  hours: boolean[];
  now?: number;
  nowLabel?: string;
  onToggle?: (hour: number) => void;
}) {
  const allDay = hours.every((on) => !on);
  return (
    <div style={{ position: "relative", paddingTop: 10 }}>
      <div className={`gx-hours${onToggle ? " gx-hours--editable" : ""}`}>
        {hours.map((on, hour) => {
          const className = on || allDay ? "is-on" : "";
          return onToggle ? (
            // eslint-disable-next-line react/no-array-index-key
            <i
              key={hour}
              className={className}
              role="button"
              tabIndex={0}
              aria-label={`${hour}:00`}
              onClick={() => onToggle(hour)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") onToggle(hour);
              }}
            />
          ) : (
            // eslint-disable-next-line react/no-array-index-key
            <i key={hour} className={className} />
          );
        })}
      </div>
      {typeof now === "number" ? (
        <>
          <span
            aria-hidden="true"
            style={{
              position: "absolute",
              left: `${(now / 24) * 100}%`,
              top: 0,
              bottom: 18,
              width: 1,
              background: "var(--gx-ink)",
            }}
          />
          {/* 一条竖线不说明它是什么。标签靠右画到线的左边，免得 23 点时被裁掉。 */}
          <span
            className="gx-mono"
            style={{
              position: "absolute",
              left: `${(now / 24) * 100}%`,
              top: -4,
              transform: now > 12 ? "translateX(calc(-100% - 4px))" : "translateX(4px)",
              fontSize: 10,
              color: "var(--gx-ink)",
              background: "var(--gx-surface)",
              padding: "0 3px",
              whiteSpace: "nowrap",
            }}
          >
            {nowLabel ?? ""}
          </span>
        </>
      ) : null}
      <div className="gx-hours__scale">
        <span>00</span>
        <span>06</span>
        <span>12</span>
        <span>18</span>
        <span>24</span>
      </div>
    </div>
  );
}

/**
 * 一周积分柱。高度按这一周的峰值归一，全零时一律显示成底部那条灰线。
 *
 * amount 是微积分（1,000,000 = 1 积分 = ¥1）：柱高只看相对大小、不受单位影响，
 * 但悬停那行是给人读的，得按积分写。
 */
export function WeekBars({ points, labels }: { points: { date: string; amount: number }[]; labels: string[] }) {
  const max = useMemo(() => Math.max(1, ...points.map((point) => point.amount)), [points]);
  return (
    <div className="gx-bars">
      {points.map((point, index) => (
        <div className="gx-bars__col" key={point.date}>
          <span
            className={`gx-bars__bar${point.amount > 0 ? "" : " is-idle"}`}
            style={{ height: `${Math.max(3, Math.round((point.amount / max) * 100))}%` }}
            title={`${point.date} · ${formatPoints(point.amount)}`}
          />
          <span className="gx-bars__tick">{labels[index] ?? point.date.slice(5)}</span>
        </div>
      ))}
    </div>
  );
}
