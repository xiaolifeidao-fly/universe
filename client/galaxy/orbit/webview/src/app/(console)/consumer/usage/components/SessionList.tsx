"use client";

/**
 * 有状态会话。只读 —— 服务端账本是业务真相，节点上的执行现场只是缓存。
 * 控制台唯一能做的写动作是「关掉它」，因为一个开着的会话钉着一个座位。
 */

import { Modal, message } from "antd";
import { useCallback, useEffect, useState } from "react";
import { Btn, Card, DataTable, Loading, Pill } from "@/components/ui/kit";
import { useLocale } from "@/i18n/LocaleProvider";
import { formatDateTime } from "@/utils/format";
import { closeSession, fetchSessions, type ConsumerKeyView, type SessionView } from "../../api/consumer.api";

export function SessionList({ keys }: { keys: ConsumerKeyView[] }) {
  const { t } = useLocale();
  const [rows, setRows] = useState<SessionView[]>([]);
  const [loading, setLoading] = useState(true);
  const alias = new Map(keys.map((key) => [key.keyId, key.alias || key.keyId]));

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setRows(await fetchSessions({ limit: 50 }));
    } catch (error) {
      message.error((error as Error).message || t("common.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const close = (row: SessionView) => {
    Modal.confirm({
      title: t("sessions.close"),
      okText: t("common.confirm"),
      cancelText: t("common.cancel"),
      onOk: async () => {
        try {
          await closeSession(row.sid, "console");
          message.success(t("sessions.closed"));
          await load();
        } catch (error) {
          message.error((error as Error).message || t("common.actionFailed"));
        }
      },
    });
  };

  return (
    <Card className="gx-rise gx-rise--2" style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
      {loading ? (
        <Loading />
      ) : (
        <DataTable
          columns={[
            {
              key: "sid",
              title: t("sessions.col.sid"),
              width: "1fr",
              render: (row: SessionView) => (
                <span>
                  <span className="gx-mono">{row.sid}</span>
                  {row.migrated ? <span className="gx-muted"> · {t("sessions.migrated")}</span> : null}
                </span>
              ),
            },
            { key: "kind", title: t("sessions.col.kind"), width: "140px", render: (row: SessionView) => row.kind },
            {
              key: "key",
              title: t("usage.col.key"),
              width: "130px",
              render: (row: SessionView) => <span className="gx-soft">{alias.get(row.keyId) ?? row.keyId}</span>,
            },
            {
              key: "turns",
              title: t("sessions.col.turns"),
              width: "70px",
              align: "right",
              render: (row: SessionView) => <span className="gx-mono">{row.lastSeq}</span>,
            },
            {
              key: "time",
              title: t("sessions.col.time"),
              width: "120px",
              render: (row: SessionView) => <span className="gx-mono gx-muted">{formatDateTime(row.lastTurnAt || row.createdTime)}</span>,
            },
            {
              key: "state",
              title: t("sessions.col.state"),
              width: "150px",
              render: (row: SessionView) => (
                <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <Pill tone={row.state === "closed" ? "default" : "ok"}>{row.state}</Pill>
                  {row.state !== "closed" ? (
                    <Btn tone="ghost" small onClick={() => close(row)}>
                      {t("sessions.close")}
                    </Btn>
                  ) : null}
                </span>
              ),
            },
          ]}
          rows={rows}
          rowKey={(row) => row.sid}
          empty={t("sessions.empty")}
        />
      )}
    </Card>
  );
}
