"use client";

/**
 * 一次请求的详情 + 申诉入口。
 *
 * 消费者和提供者互相看不见对方，出了问题两边没法自己谈 —— 平台是唯一同时握着
 * 单元、计量和两本账的一方，所以争议只有「建单 → 平台裁决」这一条路。
 * 入口放在这里而不是单开一页：人是在账单上看见那笔扣费才想申诉的。
 */

import { Modal, message } from "antd";
import { useEffect, useState } from "react";
import { Btn, Field, Note, Pill } from "@/components/ui/kit";
import { useLocale } from "@/i18n/LocaleProvider";
import { DERIVED_TOKEN_UNITS, errorLabel, formatCny, formatDateTime, formatInt, formatMillis, providerLabel, unitLabel } from "@/utils/format";
import { DISPUTE_REASONS, fileDispute, type DisputeReason, type UsageRecord } from "../../api/consumer.api";

export function RecordDetail({
  record,
  alias,
  onClose,
  onFiled,
}: {
  record: UsageRecord | null;
  alias: Map<string, string>;
  onClose: () => void;
  onFiled: () => void;
}) {
  const { t } = useLocale();
  const [disputing, setDisputing] = useState(false);
  const [reason, setReason] = useState<DisputeReason>("overcharged");
  const [detail, setDetail] = useState("");
  const [busy, setBusy] = useState(false);

  // 换一条记录时把申诉表单收回去。留着展开状态会让人对着 B 的表单
  // 填 A 的理由 —— 提交上去钉的是 B 的 unitId。
  useEffect(() => {
    setDisputing(false);
    setDetail("");
  }, [record?.unitId]);

  const submit = async () => {
    if (!record) return;
    setBusy(true);
    try {
      await fileDispute({ unitId: record.unitId, reason, detail: detail.trim() || undefined });
      message.success(t("detail.disputed"));
      setDisputing(false);
      onFiled();
      onClose();
    } catch (error) {
      message.error((error as Error).message || t("common.actionFailed"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={Boolean(record)} title={t("detail.title")} onCancel={onClose} footer={null} width={560}>
      {record ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 16, paddingTop: 4 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span className="gx-mono" style={{ fontSize: 13 }}>
              {record.model || record.kind}
            </span>
            <Pill tone={record.state === "completed" ? "ok" : record.state === "failed" ? "warn" : "default"}>
              {t(`usage.state.${record.state === "completed" ? "completed" : record.state === "failed" ? "failed" : "running"}`)}
            </Pill>
            <span style={{ flex: 1 }} />
            <span className="gx-card__hint">{formatDateTime(record.startedAt)}</span>
          </div>

          <div style={{ display: "grid", gap: 8, padding: "12px 14px", borderRadius: 10, background: "var(--gx-muted)" }}>
            <Row label={t("detail.requestId")} value={record.unitId} mono />
            <Row label={t("usage.col.key")} value={alias.get(record.keyId) ?? record.keyId} />
            <Row
              label={t("detail.provider")}
              value={record.provider ? providerLabel(record.provider) : t("detail.unknownProvider")}
            />
            <Row label={t("usage.col.cost")} value={formatMillis(record.durationMs)} mono />
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <span className="gx-label">{t("detail.usage")}</span>
            {Object.entries(record.usage ?? {})
              .filter(([unit, value]) => value > 0 && !DERIVED_TOKEN_UNITS.has(unit))
              .map(([unit, value]) => (
                <Row key={unit} label={unitLabel(unit, t)} value={formatInt(value)} mono />
              ))}
            {/* 合计单独摆在分项后面：和它们并排的话，看起来像是第五个桶，
                而它其实就是上面那几项加起来的数。 */}
            {(record.usage?.["llm.total_tokens"] ?? 0) > 0 ? (
              <Row label={unitLabel("llm.total_tokens", t)} value={formatInt(record.usage["llm.total_tokens"])} mono strong />
            ) : null}
            <Row label={t("detail.charge")} value={record.cost > 0 ? formatCny(record.cost) : "0"} mono strong />
          </div>

          {record.errorCode ? <Note tone="warn">{errorLabel(record.errorCode, t)}</Note> : null}

          {disputing ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 12, paddingTop: 4, borderTop: "1px solid var(--gx-line)" }}>
              <Field label={t("detail.disputeReason")}>
                <select className="gx-input" value={reason} onChange={(event) => setReason(event.target.value as DisputeReason)}>
                  {DISPUTE_REASONS.map((item) => (
                    <option key={item} value={item}>
                      {t(`dispute.reason.${item}`)}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label={t("detail.disputeDetail")} hint={t("detail.disputeDetailHint")}>
                <textarea
                  className="gx-input"
                  rows={3}
                  maxLength={512}
                  value={detail}
                  onChange={(event) => setDetail(event.target.value)}
                />
              </Field>
              <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
                <Btn tone="ghost" small onClick={() => setDisputing(false)}>
                  {t("common.cancel")}
                </Btn>
                <Btn tone="accent" small loading={busy} onClick={() => void submit()}>
                  {t("detail.disputeSubmit")}
                </Btn>
              </div>
            </div>
          ) : (
            <div style={{ display: "flex", justifyContent: "flex-end" }}>
              <Btn tone="ghost" small onClick={() => setDisputing(true)}>
                {t("detail.dispute")}
              </Btn>
            </div>
          )}
        </div>
      ) : null}
    </Modal>
  );
}

function Row({ label, value, mono, strong }: { label: string; value: string; mono?: boolean; strong?: boolean }) {
  return (
    <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 16, fontSize: 12.5 }}>
      <span style={{ color: "var(--gx-soft)", flex: "0 0 auto" }}>{label}</span>
      <span
        className={mono ? "gx-mono" : undefined}
        style={{
          minWidth: 0,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          fontWeight: strong ? 600 : 400,
          color: strong ? "var(--gx-ink)" : "inherit",
        }}
      >
        {value}
      </span>
    </div>
  );
}
