"use client";

/** 长任务。同样只读，唯一的写动作是取消 —— 它在烧额度。 */

import { Modal, message } from "antd";
import { useCallback, useEffect, useState } from "react";
import { Btn, Card, DataTable, Loading, Meter, Pill } from "@/components/ui/kit";
import { useLocale } from "@/i18n/LocaleProvider";
import { formatDateTime } from "@/utils/format";
import { cancelJob, fetchJobs, type ConsumerKeyView, type JobView } from "../../api/consumer.api";

const RUNNING = new Set(["queued", "placed", "running", "streaming"]);

export function JobList({ keys, reloadToken }: { keys: ConsumerKeyView[]; reloadToken?: number }) {
  const { t } = useLocale();
  // 静态 Modal.confirm 拿不到 ConfigProvider 的主题，按钮会是 antd 默认的蓝色，所以用 hook 版。
  const [modal, modalHolder] = Modal.useModal();
  const [rows, setRows] = useState<JobView[]>([]);
  const [loading, setLoading] = useState(true);
  const alias = new Map(keys.map((key) => [key.keyId, key.alias || key.keyId]));

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setRows(await fetchJobs({ limit: 50 }));
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

  const cancel = (row: JobView) => {
    void modal.confirm({
      title: t("jobs.cancel"),
      okText: t("common.confirm"),
      cancelText: t("common.cancel"),
      onOk: async () => {
        try {
          await cancelJob(row.jobId);
          message.success(t("jobs.cancelled"));
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
            { key: "job", title: t("jobs.col.job"), width: "1fr", render: (row: JobView) => <span className="gx-mono">{row.jobId}</span> },
            { key: "kind", title: t("jobs.col.kind"), width: "150px", render: (row: JobView) => row.kind },
            {
              key: "key",
              title: t("usage.col.key"),
              width: "130px",
              render: (row: JobView) => <span className="gx-soft">{alias.get(row.keyId) ?? row.keyId}</span>,
            },
            {
              key: "progress",
              title: t("jobs.col.progress"),
              width: "140px",
              render: (row: JobView) =>
                row.progress ? (
                  <span style={{ display: "block" }}>
                    <Meter used={row.progress.pct} limit={100} />
                    <span className="gx-mono gx-muted" style={{ fontSize: 11 }}>
                      {row.progress.stage}
                    </span>
                  </span>
                ) : (
                  <span className="gx-muted">-</span>
                ),
            },
            {
              key: "time",
              title: t("jobs.col.time"),
              width: "120px",
              render: (row: JobView) => <span className="gx-mono gx-muted">{formatDateTime(row.createdTime)}</span>,
            },
            {
              key: "state",
              title: t("jobs.col.state"),
              width: "140px",
              render: (row: JobView) => (
                <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <Pill tone={row.state === "completed" ? "ok" : row.state === "failed" ? "warn" : "default"}>{row.state}</Pill>
                  {RUNNING.has(row.state) ? (
                    <Btn tone="ghost" small onClick={() => cancel(row)}>
                      {t("jobs.cancel")}
                    </Btn>
                  ) : null}
                </span>
              ),
            },
          ]}
          rows={rows}
          rowKey={(row) => row.jobId}
          empty={t("jobs.empty")}
        />
      )}
    </Card>
  );
}
