"use client";

import { ReloadOutlined } from "@ant-design/icons";
import { Alert, Button, Empty, Segmented, Spin, message } from "antd";
import { useCallback, useEffect, useMemo, useState } from "react";
import { QuotaBars } from "@/components/galaxy/QuotaBars";
import { useLocale } from "@/i18n/LocaleProvider";
import { fetchNodes, type ContributionView } from "../../api/provider.api";
import { GrantForm } from "./GrantForm";

/**
 * 贡献授权。
 *
 * 这里只能改授权，不能凭空造一条贡献 —— 贡献是节点 hello 时申报出来的，
 * 「这台机器有什么能力」由那台机器说了算，控制台造一条出来也没人能执行它。
 * 要新增能力得去那台机器上改 ai-bridge 的配置。
 */
export function ContributionGrants() {
  const { t } = useLocale();
  const [contributions, setContributions] = useState<ContributionView[]>([]);
  const [selected, setSelected] = useState<string>("");
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const nodes = await fetchNodes();
      const flattened = nodes.flatMap((node) => node.contributions);
      setContributions(flattened);
      setSelected((current) => (flattened.some((item) => item.cid === current) ? current : (flattened[0]?.cid ?? "")));
    } catch (error) {
      message.error((error as Error).message || t("common.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const current = useMemo(
    () => contributions.find((item) => item.cid === selected) ?? null,
    [contributions, selected],
  );

  if (loading) {
    return (
      <div style={{ padding: 60, display: "grid", placeItems: "center" }}>
        <Spin />
      </div>
    );
  }

  if (contributions.length === 0) {
    return (
      <section className="galaxy-card">
        <Empty description={t("provider.nodes.empty")} />
      </section>
    );
  }

  return (
    <div className="galaxy-page">
      <section className="galaxy-card">
        <div className="galaxy-card__head">
          <div style={{ flex: 1, minWidth: 0 }}>
            <p style={{ margin: 0 }}>{t("provider.limits.hint")}</p>
          </div>
          <Button icon={<ReloadOutlined />} onClick={() => void load()}>
            {t("common.refresh")}
          </Button>
        </div>

        <Segmented
          value={selected}
          onChange={(value) => setSelected(String(value))}
          options={contributions.map((item) => ({ value: item.cid, label: item.cid }))}
          style={{ marginBottom: 16, maxWidth: "100%", overflowX: "auto" }}
        />

        {current ? (
          <>
            <Alert type="info" showIcon message={t("provider.quota.hint")} style={{ marginBottom: 16 }} />
            <div style={{ marginBottom: 18 }}>
              <QuotaBars quota={current.quota} />
            </div>
            <GrantForm contribution={current} onSaved={() => void load()} />
          </>
        ) : null}
      </section>
    </div>
  );
}
