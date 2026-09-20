"use client";

/**
 * 账单汇总。
 *
 * input 与 output token 分行列出，各按各的单价算 —— 这是定价口径要求的（D-02），
 * 合成一个「总 token」会让账单对不上。同一个能力下 Claude 与 Codex 也分行：
 * kind 都是 llm.chat，不拆开的话只能看见一个合计，看不出钱花在哪个上游。
 */

import { message } from "antd";
import { useCallback, useEffect, useState } from "react";
import { Card, DataTable, Loading, Seg } from "@/components/ui/kit";
import { useLocale } from "@/i18n/LocaleProvider";
import { formatCny, formatInt, formatUnitPrice, formatUnitValue, providerLabel, unitLabel } from "@/utils/format";
import { fetchUsage, type ConsumerKeyView, type UsageLine, type UsageReport } from "../../api/consumer.api";

const RANGES = [7, 30, 90];

export function BillSummary({ keys }: { keys: ConsumerKeyView[] }) {
  const { t } = useLocale();
  const [report, setReport] = useState<UsageReport | null>(null);
  const [keyId, setKeyId] = useState("");
  const [days, setDays] = useState(30);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const to = new Date();
      const from = new Date(to.getTime() - days * 24 * 3600 * 1000);
      setReport(await fetchUsage({ keyId: keyId || undefined, from: from.toISOString(), to: to.toISOString() }));
    } catch (error) {
      message.error((error as Error).message || t("common.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [days, keyId, t]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <Card className="gx-rise gx-rise--2" style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "14px 16px 10px" }}>
        <select className="gx-input" style={{ height: 32, width: 168, fontSize: 12.5 }} value={keyId} onChange={(event) => setKeyId(event.target.value)}>
          <option value="">{t("usage.allKeys")}</option>
          {keys.map((key) => (
            <option key={key.keyId} value={key.keyId}>
              {key.alias || key.keyId}
            </option>
          ))}
        </select>
        <Seg value={days} onChange={setDays} options={RANGES.map((value) => ({ value, label: `${value}d` }))} />
        <span style={{ flex: 1 }} />
        <span className="gx-card__hint">
          {t("usage.total")} <b className="gx-mono">{formatCny(report?.totalFee ?? 0)}</b>
        </span>
      </div>
      {loading ? (
        <Loading />
      ) : (
        <DataTable
          columns={[
            {
              // 这一列本来就叫「模型」，却一直画的是 kind（所有行都是 llm.chat）。
              // 计价按模型走之后，一行一个模型才对得上它自己那档单价。
              // 老记录的单元行被清掉了，拿不到模型名，退回显示 kind。
              key: "model",
              title: t("usage.col.model"),
              width: "170px",
              render: (row: UsageLine) =>
                row.model ? <span className="gx-mono">{row.model}</span> : <span className="gx-muted">{row.kind}</span>,
            },
            {
              key: "provider",
              title: t("detail.provider"),
              width: "140px",
              render: (row: UsageLine) => (row.provider ? providerLabel(row.provider) : <span className="gx-muted">{t("detail.unknownProvider")}</span>),
            },
            {
              key: "unit",
              title: t("detail.usage"),
              width: "1fr",
              render: (row: UsageLine) => (
                <span>
                  {unitLabel(row.unit, t)} <span className="gx-mono gx-muted">{row.unit}</span>
                </span>
              ),
            },
            {
              key: "amount",
              title: t("usage.col.charge"),
              width: "110px",
              align: "right",
              render: (row: UsageLine) => <span className="gx-mono">{formatUnitValue(row.unit, row.amount)}</span>,
            },
            {
              key: "calls",
              title: t("usage.calls"),
              width: "80px",
              align: "right",
              render: (row: UsageLine) => <span className="gx-mono gx-soft">{formatInt(row.calls)}</span>,
            },
            {
              key: "price",
              title: t("store.total"),
              width: "120px",
              align: "right",
              render: (row: UsageLine) =>
                row.unitPrice > 0 ? (
                  <span className="gx-mono gx-soft">{formatUnitPrice(row.unitPrice, report?.currency)}</span>
                ) : (
                  <span className="gx-muted">{t("usage.notPriced")}</span>
                ),
            },
            {
              key: "cost",
              title: t("detail.charge"),
              width: "100px",
              align: "right",
              render: (row: UsageLine) => <span className="gx-mono">{row.cost > 0 ? formatCny(row.cost) : "-"}</span>,
            },
          ]}
          rows={report?.lines ?? []}
          rowKey={(row) => `${row.kind}:${row.provider}:${row.model}:${row.unit}`}
          empty={t("usage.empty")}
        />
      )}
    </Card>
  );
}
