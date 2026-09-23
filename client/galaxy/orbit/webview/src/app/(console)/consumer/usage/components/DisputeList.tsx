"use client";

/**
 * 我的申诉。建单在使用记录的行详情里 —— 人是在账单上看见那笔扣费才想申诉的，
 * 让他先来这一页再去找 unitId 是把顺序反过来了。这里只负责「后来怎么样了」。
 */

import { Modal, message } from "antd";
import { useCallback, useEffect, useState } from "react";
import { Btn, Card, DataTable, Loading, Pill } from "@/components/ui/kit";
import { useLocale } from "@/i18n/LocaleProvider";
import { formatDateTime, formatInt, unitLabel } from "@/utils/format";
import { fetchDisputes, withdrawDispute, type DisputeView } from "../../api/consumer.api";

export function DisputeList({ reloadToken }: { reloadToken?: number }) {
  const { t } = useLocale();
  // 静态 Modal.confirm 拿不到 ConfigProvider 的主题，按钮会是 antd 默认的蓝色，所以用 hook 版。
  const [modal, modalHolder] = Modal.useModal();
  const [rows, setRows] = useState<DisputeView[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setRows(await fetchDisputes());
    } catch (error) {
      message.error((error as Error).message || t("common.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  // reloadToken 不进 load 的函数体，只当触发器：页头那个刷新按钮按一下它就换个数，这一栏跟着重拉。
  useEffect(() => {
    void load();
  }, [load, reloadToken]);

  const withdraw = (row: DisputeView) => {
    void modal.confirm({
      title: t("dispute.withdraw"),
      okText: t("common.confirm"),
      cancelText: t("common.cancel"),
      onOk: async () => {
        try {
          await withdrawDispute(row.disputeId);
          await load();
        } catch (error) {
          message.error((error as Error).message || t("common.actionFailed"));
        }
      },
    });
  };

  return (
    <Card className="gx-rise gx-rise--2" style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
      {/* 放在 loading 分支外面：onOk 里 await load() 会把表格换成加载圈，放里面确认框会被一起卸载。 */}
      {modalHolder}
      {loading ? (
        <Loading />
      ) : (
        <DataTable
          columns={[
            {
              key: "time",
              title: t("dispute.col.time"),
              width: "112px",
              render: (row: DisputeView) => <span className="gx-mono gx-muted">{formatDateTime(row.createdTime)}</span>,
            },
            {
              key: "unit",
              title: t("dispute.col.unit"),
              width: "1fr",
              render: (row: DisputeView) => <span className="gx-mono">{row.unitId}</span>,
            },
            {
              key: "reason",
              title: t("dispute.col.reason"),
              width: "160px",
              render: (row: DisputeView) => t(`dispute.reason.${row.reason}`),
            },
            {
              key: "refund",
              title: t("dispute.col.refund"),
              width: "160px",
              render: (row: DisputeView) => {
                const entries = Object.entries(row.refund ?? {}).filter(([, value]) => value > 0);
                if (entries.length === 0) return <span className="gx-muted">-</span>;
                return (
                  <span className="gx-mono gx-soft" style={{ fontSize: 12 }}>
                    {entries.map(([unit, value]) => `${unitLabel(unit, t)} ${formatInt(value)}`).join(" · ")}
                  </span>
                );
              },
            },
            {
              key: "status",
              title: t("dispute.col.status"),
              width: "150px",
              render: (row: DisputeView) => (
                <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <Pill tone={row.status === "accepted" ? "ok" : row.status === "rejected" ? "err" : "warn"}>
                    {t(`dispute.status.${row.status}`)}
                  </Pill>
                  {row.status === "open" ? (
                    <Btn tone="ghost" small onClick={() => withdraw(row)}>
                      {t("dispute.withdraw")}
                    </Btn>
                  ) : null}
                </span>
              ),
            },
          ]}
          rows={rows}
          rowKey={(row) => row.disputeId}
          empty={t("dispute.empty")}
        />
      )}
    </Card>
  );
}
