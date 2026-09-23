"use client";

/**
 * 模型价格滚动条。
 *
 * 它替这一页回答一个陌生人只肯花两秒确认的问题：「你们有哪些模型、大概多少钱」。
 * 轨道要跑满一圈再无缝接上，所以列表**渲染两遍**，动画走到 -50% 正好首尾相接。
 * 鼠标停上去就暂停 —— 想看清某一行的人不该去追一个在动的字。
 */

import { useLocale } from "@/i18n/LocaleProvider";
import { familyColor } from "@/components/site/kit";
import { formatUnitPrice } from "@/utils/format";
import type { PortalModel } from "@/utils/portal";

export function PriceTicker({ models }: { models: PortalModel[] }) {
  const { t } = useLocale();
  if (models.length === 0) return null;

  // 少于 6 个的时候重复到够长为止，不然轨道跑一半就是空白。
  const filled: PortalModel[] = [];
  while (filled.length < 8 && models.length > 0) filled.push(...models);
  const track = [...filled, ...filled];

  return (
    <div className="gp-ticker" aria-hidden="true">
      <div className="gp-ticker__track">
        {track.map((model, index) => (
          <div className="gp-ticker__item" key={`${model.modelId}-${index}`}>
            <span
              style={{
                width: 7,
                height: 7,
                borderRadius: 2,
                background: familyColor(model.family),
                flex: "0 0 auto",
              }}
            />
            <span className="gp-ticker__name">{model.modelId}</span>
            <span className="gp-ticker__price">
              {t("models.input")}
              <b>{formatUnitPrice(model.inputPrice, model.currency)}</b>
            </span>
            <span className="gp-ticker__price">
              {t("models.output")}
              <b>{formatUnitPrice(model.outputPrice, model.currency)}</b>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
