"use client";

/**
 * 通用 i18n Provider 工厂 —— 机制从 client/web/src/i18n/LocaleProvider.tsx 抽出来，
 * 但**不**带 web 那份几千行的具体文案字典，也不带 web 特有的“旧原型内联中文”
 * 翻译层（LegacyContentTranslator / translateLegacy，那是 web 遗留原型的技术债，
 * 新项目不需要）。
 *
 * 每个 app 自己维护一份 messages 字典（key 是这个 app 实际支持的语言子集），调用
 * createLocaleProvider({ messages, theme, storageKey, supportedLocales }) 拿到
 * 自己的 AppLocaleProvider / useLocale，用法和 web 的 useLocale() 一致：
 * const { t, locale, setLocale } = useLocale();
 *
 * TODO(shared-i18n): web 目前仍用它自己手写的 LocaleProvider.tsx（连 messages
 * 一起，几千行业务文案，不适合搬到 shared）。这次只是让 manager 用上同一套
 * 机制，没有改 web 的现有文件。
 */

import { ConfigProvider, type ThemeConfig } from "antd";
import enUS from "antd/locale/en_US";
import idID from "antd/locale/id_ID";
import zhCN from "antd/locale/zh_CN";
import dayjs from "dayjs";
// dayjs 的语言包必须显式 import 才进包 —— 见下面 dayjsLocaleFor() 的注释。
// "en" 是 dayjs 内置的默认语言，不用也不能从 dayjs/locale/en 再引一次。
import "dayjs/locale/id";
import "dayjs/locale/zh-cn";
import { createContext, type PropsWithChildren, useContext, useEffect, useMemo, useState } from "react";

export const ALL_LOCALES = ["zh-CN", "en-US", "id-ID"] as const;
export type AppLocale = (typeof ALL_LOCALES)[number];

function antdLocaleFor(locale: AppLocale) {
  if (locale === "en-US") return enUS;
  if (locale === "id-ID") return idID;
  return zhCN;
}

/**
 * 同一门语言在 dayjs 里的名字。
 *
 * 为什么要有这一份：**antd 的 ConfigProvider.locale 管不到日期面板里的星期与月份**。
 * 那两行文案不在 antd 的语言包里，而是 rc-picker 现场从 dayjs 取的
 * （localeData().weekdaysMin() / monthsShort()，见 rc-picker/generate/dayjs.js）。
 * 而 dayjs 的语言包是按需 import 的，没加载过的语言 `dayjs().locale("zh-cn")`
 * **不报错也不生效**，静默留在 en 上 —— 症状就是 locale 传了 zh_CN、按钮和占位符
 * 都是中文，面板表头却还是 Su Mo Tu We 和 Sep 2026，而且不会有任何一条警告。
 *
 * 顺带还决定「本周」从哪天算起：dayjs 的 startOf("week") 用的是语言包里的
 * weekStart（zh-cn 是周一，en 是周日），所以日期控件的快捷操作跟着界面语言走，
 * 不用也不该自己写死。
 */
function dayjsLocaleFor(locale: AppLocale) {
  if (locale === "en-US") return "en";
  if (locale === "id-ID") return "id";
  return "zh-cn";
}

function getInitialLocale<L extends AppLocale>(supported: readonly L[], storageKey: string): L {
  if (typeof window === "undefined") return supported[0];
  const saved = window.localStorage.getItem(storageKey);
  if (saved && (supported as readonly string[]).includes(saved)) return saved as L;
  const browserLocale = window.navigator.language.toLowerCase();
  const english = supported.find((locale) => locale === "en-US");
  if (browserLocale.startsWith("en") && english) return english;
  return supported[0];
}

export interface CreateLocaleProviderOptions<L extends AppLocale, Messages extends Record<L, Record<string, string>>> {
  /** 文案字典，key 必须和 supportedLocales 完全对应——只支持中英文就只写这两个 key，不用凑一份没用的 id-ID。 */
  messages: Messages;
  /** antd ConfigProvider 的 theme，通常直接传 @shared/theme/managerTheme 的 managerTheme。 */
  theme: ThemeConfig;
  /** localStorage 里记住当前语言用的 key，各 app 要用不同的 key 避免混淆（即便同源也不会撞）。 */
  storageKey: string;
  /** 这个 app 实际支持哪些语言，决定切换器选项和 messages 的 key 形状。 */
  supportedLocales: readonly L[];
}

export function createLocaleProvider<L extends AppLocale, Messages extends Record<L, Record<string, string>>>(
  options: CreateLocaleProviderOptions<L, Messages>,
) {
  const supported = options.supportedLocales;
  type TranslationKey = keyof Messages[L] & string;

  interface LocaleContextValue {
    locale: L;
    setLocale: (locale: L) => void;
    /**
     * 取一条文案。第二个参数把 `{name}` 这样的占位替换掉。
     *
     * 插值不是锦上添花：中英文的语序不一样，「省 30%」和「30% off」里那个数字
     * 落在句子的两端。在调用处拼字符串的话，这两句就只能各写死一种语序，
     * 而切到另一种语言时没人会发现 —— 句子照样出得来，只是读着别扭。
     */
    t: (key: TranslationKey | string, vars?: Record<string, string | number>) => string;
  }

  const LocaleContext = createContext<LocaleContextValue | null>(null);

  function AppLocaleProvider({ children }: PropsWithChildren) {
    const [locale, setLocale] = useState<L>(supported[0]);
    const [ready, setReady] = useState(false);

    useEffect(() => {
      setLocale(getInitialLocale(supported, options.storageKey));
      setReady(true);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useEffect(() => {
      if (!ready) return;
      window.localStorage.setItem(options.storageKey, locale);
      document.documentElement.lang = locale;
    }, [locale, ready]);

    /**
     * dayjs 的「当前语言」是模块级的全局单例，跟着界面语言切一次。
     *
     * 只在浏览器里切（所以放在 effect 里，不放渲染期）：SSR 是同一个 Node 进程给
     * 所有请求渲染，在渲染期改全局会串到别人的请求上。日期面板本身不依赖这一行 ——
     * rc-picker 每次取文案都自己带上语言名 —— 这里管的是业务代码里那些
     * dayjs(x).format("MMM D") 之类的调用，让它们和界面同语言。
     */
    useEffect(() => {
      dayjs.locale(dayjsLocaleFor(locale));
    }, [locale]);

    const value = useMemo<LocaleContextValue>(
      () => ({
        locale,
        setLocale,
        t: (key, vars) => {
          const text = (options.messages[locale] as Record<string, string>)[key as string] ?? String(key);
          if (!vars) return text;
          // 没传到的占位原样留着：显示成 {name} 一眼就知道是哪个字段漏了，
          // 换成空串的话，句子会变成「省 %」而看起来只是排版不好看。
          return text.replace(/\{(\w+)\}/g, (whole, name: string) =>
            name in vars ? String(vars[name]) : whole,
          );
        },
      }),
      [locale],
    );

    return (
      <LocaleContext.Provider value={value}>
        <ConfigProvider theme={options.theme} locale={antdLocaleFor(locale)}>
          {children}
        </ConfigProvider>
      </LocaleContext.Provider>
    );
  }

  function useLocale() {
    const context = useContext(LocaleContext);
    if (!context) {
      throw new Error("useLocale must be used within AppLocaleProvider");
    }
    return context;
  }

  return { AppLocaleProvider, useLocale, supportedLocales: supported };
}
