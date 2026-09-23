"use client";

/**
 * 提现。
 *
 * 到账金额由服务端按积分算，这里只做预览 —— 让前端把金额传上去，
 * 等于把兑换比交给了客户端。所以请求里只有积分数、收款方式和账号。
 *
 * 输入框里是**积分**，发出去的是**微积分**：账上和接口都按微积分算
 * （1,000,000 = 1 积分 = ¥1），让人对着一串六个零的数字填提现额没有意义。
 */

import { Modal, message } from "antd";
import { useEffect, useState } from "react";
import { Btn, Field, Note } from "@/components/ui/kit";
import { useLocale } from "@/i18n/LocaleProvider";
import { formatCny, formatPoints } from "@/utils/format";
import { createPayout } from "../../api/provider.api";

const METHODS = ["alipay", "wechat", "bank"] as const;

/** 1 积分 = ¥1 = 1,000,000 微积分。 */
const POINT = 1_000_000;

/**
 * 起提额与「按整元提现」两条，跟服务端同一套（galaxy.payout_min_credits 默认 ¥10、
 * 金额要能被 payout_rate 整除）。这里只是提前拦一下、把话说在前面 ——
 * 真正说了算的还是服务端，部署方把配置调了，这边最多是少拦一次。
 */
const MIN_POINTS = 10;

export function WithdrawModal({
  open,
  available,
  pending,
  onClose,
  onDone,
}: {
  open: boolean;
  /** 微积分。 */
  available: number;
  /** 微积分。 */
  pending: number;
  onClose: () => void;
  onDone: () => void;
}) {
  const { t } = useLocale();
  const [points, setPoints] = useState(0);
  const [method, setMethod] = useState<(typeof METHODS)[number]>("alipay");
  const [account, setAccount] = useState("");
  const [busy, setBusy] = useState(false);

  // 可提额里不足一元的零头提不出来，向下取整到整元。
  const maxPoints = Math.floor(available / POINT);

  // 每次打开都按当前可提额重置。留着上一次的数字，会在余额变小之后
  // 让人对着一个提不出来的数字点确认。
  useEffect(() => {
    if (open) setPoints(maxPoints);
  }, [maxPoints, open]);

  // 输入框允许敲小数（可提额本身就可能带零头），能不能提由下面这条判 ——
  // 服务端只收整元，所以四舍五入到微积分之后必须被 POINT 整除。
  const micros = Math.round(points * POINT);
  const valid =
    micros >= MIN_POINTS * POINT && micros <= available && micros % POINT === 0 && account.trim().length > 0;

  const submit = async () => {
    setBusy(true);
    try {
      await createPayout({ credits: micros, method, account: account.trim() });
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
          {t("withdraw.submit", { amount: formatCny(micros) })}
        </Btn>,
      ]}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 16, paddingTop: 4 }}>
        <span className="gx-card__hint">{t("withdraw.hint")}</span>

        {/* 两条门槛写在输入框上，别等人填完点了确认才由服务端回一句「不少于 10 积分」。 */}
        <Field label={t("withdraw.credits")} hint={t("withdraw.rule", { min: MIN_POINTS })}>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input
              className="gx-input gx-input--mono"
              type="number"
              min={0}
              step={1}
              max={maxPoints}
              value={points}
              onChange={(event) => setPoints(Math.max(0, Number(event.target.value) || 0))}
            />
            <span className="gx-card__hint" style={{ whiteSpace: "nowrap" }}>
              {t("withdraw.max", { value: formatPoints(available) })}
            </span>
            {/* 「全部」取整元，直接按可提额填会填出一个提不出去的零头。 */}
            <Btn tone="ghost" small onClick={() => setPoints(maxPoints)}>
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
          <Row label={t("withdraw.exchange")} value={`${formatPoints(micros)} → ${formatCny(micros)}`} />
          <Row label={t("withdraw.fee")} value={formatCny(0)} />
          <Row label={t("withdraw.amount")} value={formatCny(micros)} strong />
        </div>

        {pending > 0 ? <Note>{t("withdraw.pendingNote", { value: formatPoints(pending) })}</Note> : null}
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
