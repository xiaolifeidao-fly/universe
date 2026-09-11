"use client";

/**
 * 首屏那张轨道图。
 *
 * 它要在一眼之内讲完「这是什么」：中间是统一网关，左边是接进来的上游模型，
 * 右边是调用从哪来 —— 命令行工具和你自己的应用。所以它不是装饰，
 * 是这一页唯一一处「不用读字就能懂」的地方。
 *
 * 纯 SVG + CSS，不引任何图表库：形状固定、要跟着主题色走、还要能在
 * prefers-reduced-motion 下停住动画，自己画反而最省。
 */

import { useLocale } from "@/i18n/LocaleProvider";
import { familyColor } from "@/components/site/kit";

interface Chip {
  title: string;
  note: string;
  color: string;
  badge: string;
  style: React.CSSProperties;
}

export function OrbitDiagram({ vendors }: { vendors: string[] }) {
  const { t } = useLocale();

  // 左边的芯片跟着服务端真的声明了哪些厂商走：只接了一家就不摆两家，
  // 一家都没有（后端连不上）就一个都不画 —— 旁边那格统计写着「上游厂商 0 家」，
  // 图上却摆着 Claude 和 GPT，两个说法只能有一个是真的。
  const left: Chip[] = vendors.slice(0, 2).map((vendor, index) => ({
    title: vendor === "anthropic" ? "Claude" : vendor === "openai" ? "GPT · Codex" : vendor,
    note: vendor,
    color: familyColor(vendor === "anthropic" ? "claude" : vendor === "openai" ? "gpt" : "other"),
    badge: (vendor[0] ?? "?").toUpperCase(),
    style: index === 0 ? { left: 0, top: "20%" } : { left: "2%", bottom: "20%" },
  }));

  const right: Chip[] = [
    {
      title: t("home.orbit.cli"),
      note: t("home.orbit.cliNote"),
      color: "#0f7b74",
      badge: ">_",
      style: { right: 0, top: "18%" },
    },
    {
      title: t("home.orbit.app"),
      note: t("home.orbit.appNote"),
      color: "#475652",
      // 不用 "{}"：12px 的粗体大括号在白字深底上会糊成一个「0」。
      badge: "</>",
      style: { right: "2%", bottom: "18%" },
    },
  ];

  return (
    <div className="gp-orbit">
      <svg className="gp-orbit__rings" viewBox="0 0 400 400" fill="none" aria-hidden="true">
        {/* 三层轨道，虚线粗细与透明度往外递减 —— 越远越淡，图才有纵深。 */}
        <circle cx="200" cy="200" r="196" stroke="currentColor" strokeOpacity="0.09" strokeDasharray="2 7" />
        <g className="gp-orbit__spin gp-orbit__spin--reverse">
          <circle cx="200" cy="200" r="152" stroke="currentColor" strokeOpacity="0.16" strokeDasharray="4 9" />
          <circle cx="200" cy="48" r="4.5" fill="currentColor" fillOpacity="0.5" stroke="none" />
          <circle cx="86" cy="286" r="3" fill="#b4531f" fillOpacity="0.6" stroke="none" />
        </g>
        <g className="gp-orbit__spin">
          <circle cx="200" cy="200" r="112" stroke="currentColor" strokeOpacity="0.24" strokeDasharray="5 8" />
          <circle cx="312" cy="200" r="5" fill="currentColor" fillOpacity="0.65" stroke="none" />
          <circle cx="130" cy="102" r="3.5" fill="currentColor" fillOpacity="0.4" stroke="none" />
        </g>
        {/* 内圈不转：转的东西太多会变成一台洗衣机。 */}
        <circle cx="200" cy="200" r="112" stroke="currentColor" strokeOpacity="0.05" strokeWidth="18" />
      </svg>

      <div className="gp-orbit__core">
        <b>{t("brand.name")}</b>
        <span>{t("home.orbit.core")}</span>
      </div>

      {[...left, ...right].map((chip) => (
        <div key={`${chip.title}-${chip.note}`} className="gp-orbit__chip" style={chip.style}>
          <span className="gp-orbit__badge" style={{ background: chip.color }}>
            {chip.badge}
          </span>
          <span>
            <b>{chip.title}</b>
            <small>{chip.note}</small>
          </span>
        </div>
      ))}
    </div>
  );
}
