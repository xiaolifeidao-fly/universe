"use client";

/**
 * 挂机时段在服务端是一组 `{from:"22:00", to:"08:00"}`，在界面上是 24 个格子。
 * 两种形状要来回转，转换只写这一处 —— 跨零点那一段（22:00–08:00）两边各写一遍
 * 必然有一处会漏掉「跨天」，表现是晚上十点之后整条时段消失。
 */

import type { ScheduleWindow } from "@/app/(console)/provider/api/provider.api";

export const HOURS_IN_DAY = 24;

/** 空数组表示全天共享 —— 转成 24 个 false，界面上按「全天」渲染。 */
export function scheduleToHours(windows: ScheduleWindow[] | undefined): boolean[] {
  const hours = new Array<boolean>(HOURS_IN_DAY).fill(false);
  for (const window of windows ?? []) {
    const from = parseHour(window.from);
    const to = parseHour(window.to);
    if (from === null || to === null) continue;
    if (from === to) {
      // 起止相同按整天算：22:00–22:00 想说的是「一直开着」，不是「一小时都不开」。
      hours.fill(true);
      continue;
    }
    for (let step = 0; step < HOURS_IN_DAY; step += 1) {
      const hour = (from + step) % HOURS_IN_DAY;
      if (hour === to) break;
      hours[hour] = true;
    }
  }
  return hours;
}

/** 24 个格子转回时段列表。全选或全不选都返回空数组：那就是「全天」。 */
export function hoursToSchedule(hours: boolean[], tz: string): ScheduleWindow[] {
  if (hours.every((on) => on) || hours.every((on) => !on)) return [];
  // 从「自己开着、前一个小时关着」的那一格开始扫。
  //
  // 从 0 点开始扫的话，22:00–08:00 这种跨零点的时段会被切成两段：
  // 00:00–08:00 先被扫到并收尾，22:00 之后的那截再单独成一条。界面上就是
  // 「00:00 – 08:00, 22:00 – 00:00」——说的是同一段时间，读起来却像两段。
  const first = hours.findIndex((on, hour) => on && !hours[(hour + HOURS_IN_DAY - 1) % HOURS_IN_DAY]);
  const windows: ScheduleWindow[] = [];
  let start: number | null = null;
  for (let step = 0; step <= HOURS_IN_DAY; step += 1) {
    const hour = (first + step) % HOURS_IN_DAY;
    // 绕满一圈后强制收尾，否则最后一段永远等不到一个「关着」的格子。
    const on = step < HOURS_IN_DAY && hours[hour];
    if (on && start === null) start = hour;
    if (!on && start !== null) {
      windows.push({ from: label(start), to: label(hour), tz });
      start = null;
    }
  }
  return windows;
}

/** 现在在不在时段里。全天（一个都没选）永远算在里面。 */
export function isSharingNow(hours: boolean[], at = new Date()): boolean {
  if (hours.every((on) => !on)) return true;
  return hours[at.getHours()];
}

/**
 * 本轮时段还剩多久（分钟）。不在时段里返回 0。
 * 一直算到下一个关掉的整点为止，跨零点也照算。
 */
export function minutesLeftInWindow(hours: boolean[], at = new Date()): number {
  if (hours.every((on) => on) || hours.every((on) => !on)) return 0;
  if (!hours[at.getHours()]) return 0;
  let minutes = 60 - at.getMinutes();
  for (let step = 1; step < HOURS_IN_DAY; step += 1) {
    if (!hours[(at.getHours() + step) % HOURS_IN_DAY]) break;
    minutes += 60;
  }
  return minutes;
}

/** 下一次开始共享是几点。已经在时段里返回 null。 */
export function nextWindowStart(hours: boolean[], at = new Date()): string | null {
  if (hours.every((on) => !on) || hours[at.getHours()]) return null;
  for (let step = 1; step <= HOURS_IN_DAY; step += 1) {
    const hour = (at.getHours() + step) % HOURS_IN_DAY;
    if (hours[hour]) return label(hour);
  }
  return null;
}

export function describeHours(hours: boolean[]): string {
  if (hours.every((on) => !on)) return "";
  const windows = hoursToSchedule(hours, "");
  return windows.map((window) => `${window.from} – ${window.to}`).join(", ");
}

function parseHour(value: string): number | null {
  const matched = /^(\d{1,2})(?::(\d{2}))?/.exec(value?.trim() ?? "");
  if (!matched) return null;
  const hour = Number(matched[1]);
  return hour >= 0 && hour < HOURS_IN_DAY ? hour : null;
}

function label(hour: number): string {
  return `${String(hour).padStart(2, "0")}:00`;
}
