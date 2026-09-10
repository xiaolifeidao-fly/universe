"use client";

/**
 * 提现。
 *
 * 到账金额由服务端按积分算，这里只做预览 —— 让前端把金额传上去，
 * 等于把兑换比交给了客户端。所以请求里只有积分数、收款方式和账号。
 */

import { Modal, message } from "antd";
import { useEffect, useState } from "react";
import { Btn, Field, Note } from "@/components/ui/kit";
import { useLocale } from "@/i18n/LocaleProvider";
import { formatCny, formatInt } from "@/utils/format";
import { createPayout } from "../../api/provider.api";

const METHODS = ["alipay", "wechat", "bank"] as const;

export function WithdrawModal({
  open,
  available,
  pending,
  rate,
  onClose,
  onDone,
}: {
  open: boolean;
  available: number;
  pending: number;
  rate: number;
  onClose: () => void;
  onDone: () => void;
}) {
  const { t } = useLocale();
  const [credits, setCredits] = useState(0);
  const [method, setMethod] = useState<(typeof METHODS)[number]>("alipay");
  const [account, setAccount] = useState("");
  const [busy, setBusy] = useState(false);

  // 每次打开都按当前可提额重置。留着上一次的数字，会在余额变小之后
  // 让人对着一个提不出来的数字点确认。
  useEffect(() => {
    if (open) setCredits(Math.floor(available / rate) * rate);
  }, [available, open, rate]);

  const amount = (credits / rate) * 1_000_000;
  const valid = credits > 0 && credits <= available && credits % rate === 0 && account.trim().length > 0;

  const submit = async () => {
    setBusy(true);
    try {
      await createPayout({ credits, method, account: account.trim() });
      message.success(t("withdraw.done"));
      onDone();
    } catch (error) {
      message.error((error as Error).message || t("common.actionFailed"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      title={t("withdraw.title")}
      onCancel={onClose}
      maskClosable={false}
      footer={[
        <Btn key="cancel" tone="ghost" onClick={onClose}>
          {t("common.cancel")}
        </Btn>,
        <Btn key="ok" tone="accent" loading={busy} disabled={!valid} onClick={() => void submit()}>
          {t("withdraw.submit", { amount: formatCny(amount) })}
        </Btn>,
      ]}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 16, paddingTop: 4 }}>
        <span className="gx-card__hint">{t("withdraw.hint", { rate })}</span>

        <Field label={t("withdraw.credits")}>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input
              className="gx-input gx-input--mono"
              type="number"
              min={0}
              step={rate}
              max={available}
              value={credits}
              onChange={(event) => setCredits(Math.max(0, Number(event.target.value) || 0))}
            />
            <span className="gx-card__hint" style={{ whiteSpace: "nowrap" }}>
              {t("withdraw.max", { value: formatInt(available) })}
            </span>
            <Btn tone="ghost" small onClick={() => setCredits(Math.floor(available / rate) * rate)}>
              {t("withdraw.all")}
            </Btn>
          </div>
        </Field>

        <Field label={t("withdraw.method")}>
          <select className="gx-input" value={method} onChange={(event) => setMethod(event.target.value as typeof method)}>
            {METHODS.map((value) => (
              <option key={value} value={value}>
                {t(`withdraw.method.${value}`)}
              </option>
            ))}
          </select>
        </Field>

        <Field label={t("withdraw.account")}>
          <input
            className="gx-input"
            value={account}
            placeholder={t("withdraw.accountPlaceholder")}
            onChange={(event) => setAccount(event.target.value)}
          />
        </Field>

        <div style={{ display: "flex", flexDirection: "column", gap: 6, padding: "12px 14px", borderRadius: 10, background: "var(--gx-muted)" }}>
          <Row label={t("withdraw.exchange")} value={`${formatInt(credits)} → ${formatCny(amount)}`} />
          <Row label={t("withdraw.fee")} value={formatCny(0)} />
          <Row label={t("withdraw.amount")} value={formatCny(amount)} strong />
        </div>

        {pending > 0 ? <Note>{t("withdraw.pendingNote", { value: formatInt(pending) })}</Note> : null}
      </div>
    </Modal>
  );
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5, color: "var(--gx-soft)" }}>
      <span>{label}</span>
      <span className="gx-mono" style={{ color: strong ? "var(--gx-ink)" : "inherit", fontWeight: strong ? 600 : 400 }}>
        {value}
      </span>
    </div>
  );
}
