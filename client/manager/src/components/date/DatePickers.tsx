"use client";

/**
 * 管理端统一的日期控件：antd 的 DatePicker / RangePicker，外面包一层「本周、本月、
 * 当天、昨天」的快捷操作。
 *
 * 为什么包一层而不是每个页面自己传 presets：快捷操作的语义要全站一致 —— 运营在
 * 计价页点的「本月」和在账本页点的「本月」必须是同一段时间，否则两张表对不上，
 * 而这种对不上没有任何报错，只会让人以为其中一张表漏数据。集中在这里还有一个好处：
 * 「本周」从周一还是周日算，跟着界面语言走（见 @shared/i18n 的 dayjsLocaleFor），
 * 各页面自己算的话迟早会有人写死 weekday(1)。
 *
 * 界面文案（月份、星期、此刻、确定）是 antd + dayjs 的语言包在管，挂在
 * AppLocaleProvider 上，这里不重复传 locale。
 */

import { DatePicker } from "antd";
import type { DatePickerProps, RangePickerProps } from "antd/es/date-picker";
import dayjs from "dayjs";
import { useMemo } from "react";
import { useLocale } from "@/i18n/LocaleProvider";

type SinglePresets = NonNullable<DatePickerProps["presets"]>;
type RangePresets = NonNullable<RangePickerProps["presets"]>;
type Translate = (key: string) => string;

/**
 * 每条快捷操作都给函数而不是现成的值：面板是可以开着不动的（填一整张表单的时候
 * 常这样），值在渲染那一刻就算好的话，跨过午夜点下去拿到的还是昨天那一份。
 */
function singlePresets(t: Translate): SinglePresets {
  return [
    { label: t("date.preset.today"), value: () => dayjs().startOf("day") },
    { label: t("date.preset.yesterday"), value: () => dayjs().subtract(1, "day").startOf("day") },
    // 单选控件只能落一个日期，「本周 / 本月」给的是这段时间的**起点**（本周一 / 本月 1 号）。
    // 用在「生效时间」这类字段上，要的正是这个起点。
    { label: t("date.preset.thisWeek"), value: () => dayjs().startOf("week") },
    { label: t("date.preset.thisMonth"), value: () => dayjs().startOf("month") },
  ];
}

function rangePresets(t: Translate): RangePresets {
  return [
    { label: t("date.preset.today"), value: () => [dayjs().startOf("day"), dayjs().endOf("day")] },
    {
      label: t("date.preset.yesterday"),
      value: () => [dayjs().subtract(1, "day").startOf("day"), dayjs().subtract(1, "day").endOf("day")],
    },
    // 结尾取本周期的末尾，不是「现在」：标签写着「本月」就该是整个本月。截到现在的话，
    // 月底再点一次同一个按钮会得到另一段时间，而两次查出来的数字对不上、看不出为什么。
    // 未来那半截没有数据，查出来仍旧是本月已经发生的全部。
    { label: t("date.preset.thisWeek"), value: () => [dayjs().startOf("week"), dayjs().endOf("week")] },
    { label: t("date.preset.thisMonth"), value: () => [dayjs().startOf("month"), dayjs().endOf("month")] },
  ];
}

/**
 * 单选日期。用法和 antd 的 DatePicker 完全一样，只是默认带上了快捷操作；
 * 自己传 presets 就用自己的那一份。
 *
 * 切语言时 t 会换一个新函数（AppLocaleProvider 里按 locale 重建），所以文案跟着变，
 * 不用另外把 locale 放进依赖。
 */
export function ManagerDatePicker({ presets, ...rest }: DatePickerProps) {
  const { t } = useLocale();
  const merged = useMemo(() => presets ?? singlePresets(t), [presets, t]);
  return <DatePicker {...rest} presets={merged} />;
}

/** 日期区间。同上，默认带「当天 / 昨天 / 本周 / 本月」四条。 */
export function ManagerRangePicker({ presets, ...rest }: RangePickerProps) {
  const { t } = useLocale();
  const merged = useMemo(() => presets ?? rangePresets(t), [presets, t]);
  return <DatePicker.RangePicker {...rest} presets={merged} />;
}
