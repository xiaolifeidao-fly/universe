"use client";

import { Tag, Tooltip } from "antd";
import { useLocale } from "@/i18n/LocaleProvider";
import { formatUnitValue, unitLabel } from "@/utils/format";
import type { QuotaStatus } from "@/app/(console)/provider/api/provider.api";

/**
 * 三维额度条。三条一起显示不是排版偏好 —— 三个维度同时生效，任一触顶整条贡献
 * 就停止接新单，分开看会让人误以为「token 还剩很多所以没事」。
 */
export function QuotaBars({ quota }: { quota: QuotaStatus[] }) {
  const { t } = useLocale();
  if (quota.length === 0) return null;

  return (
    <div className="galaxy-quota">
      {quota.map((item) => {
        const ratio = item.limit > 0 ? Math.min(1, item.used / item.limit) : 0;
        const exhausted = item.limit > 0 && item.used >= item.limit;
        const fillClass = exhausted
          ? "galaxy-quota__fill galaxy-quota__fill--full"
          : item.warned
            ? "galaxy-quota__fill galaxy-quota__fill--warn"
            : "galaxy-quota__fill";
        return (
          <div className="galaxy-quota__row" key={item.unit}>
            <div className="galaxy-quota__label">
              <span>
                {unitLabel(item.unit)}
                {exhausted ? (
                  <Tag color="error" style={{ marginLeft: 6 }}>
                    {t("provider.quota.exhausted")}
                  </Tag>
                ) : item.warned ? (
                  <Tag color="warning" style={{ marginLeft: 6 }}>
                    {t("provider.quota.warned")}
                  </Tag>
                ) : null}
              </span>
              <Tooltip
                title={`${t("provider.quota.window")}: ${item.window} · ${item.windowKey}`}
              >
                <b>
                  {formatUnitValue(item.unit, item.used)} / {formatUnitValue(item.unit, item.limit)}
                </b>
              </Tooltip>
            </div>
            <div className="galaxy-quota__track">
              <div className={fillClass} style={{ width: `${Math.round(ratio * 100)}%` }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}
