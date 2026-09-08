"use client";

import { DashboardOutlined } from "@ant-design/icons";
import { Empty } from "antd";
import { useLocale } from "@/i18n/LocaleProvider";

/** TODO: 空仪表盘 stub。真正的 KPI 卡片 / 图表接入时，参照 client/web 的
 * manager-stats-grid / manager-data-card 骨架模板（见 web 的 frontend-design-system 说明）。 */
export default function DashboardPage() {
  const { t } = useLocale();

  return (
    <div className="manager-page-stack" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <section className="manager-data-card">
        <Empty
          className="manager-empty-state"
          image={<DashboardOutlined style={{ fontSize: 64, color: "var(--manager-text-faint)" }} />}
          description={
            <span>
              <div style={{ fontSize: "var(--manager-fs-lg)", fontWeight: 700, color: "var(--manager-text)", marginBottom: 4 }}>
                {t("dashboard.empty.title")}
              </div>
              <div>{t("dashboard.empty.description")}</div>
            </span>
          }
        />
      </section>
    </div>
  );
}
