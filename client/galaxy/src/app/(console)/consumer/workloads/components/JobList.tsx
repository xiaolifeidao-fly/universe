"use client";

import { Alert, Button, Drawer, Empty, Popconfirm, Progress, Space, Table, Tag, Timeline, Typography, message } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useCallback, useEffect, useRef, useState } from "react";
import { useLocale } from "@/i18n/LocaleProvider";
import { formatTime, formatUnitValue, unitLabel } from "@/utils/format";
import { cancelJob, fetchJobEvents, fetchJobs, type JobView, type UnitEventView } from "../../api/consumer.api";
import { FileDisputeModal } from "./DisputeList";

const STATE_COLOR: Record<string, string> = {
  queued: "default",
  dispatched: "processing",
  running: "processing",
  completed: "success",
  failed: "error",
  canceled: "warning",
};

const LIVE_STATES = new Set(["queued", "dispatched", "running"]);

type Props = { keyId: string; refreshToken: number; onChanged: () => void };

export function JobList({ keyId, refreshToken, onChanged }: Props) {
  const { t } = useLocale();
  const [rows, setRows] = useState<JobView[]>([]);
  const [loading, setLoading] = useState(true);
  const [events, setEvents] = useState<UnitEventView[] | null>(null);
  const [disputing, setDisputing] = useState<string>("");
  const [eventsLoading, setEventsLoading] = useState(false);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(
    async (quiet = false) => {
      if (!quiet) setLoading(true);
      try {
        setRows(await fetchJobs({ keyId: keyId || undefined, limit: 100 }));
      } catch (error) {
        if (!quiet) message.error((error as Error).message || t("common.loadFailed"));
      } finally {
        if (!quiet) setLoading(false);
      }
    },
    [keyId, t],
  );

  useEffect(() => {
    void load();
  }, [load, refreshToken]);

  // 任务能跑几个小时，一个不动的「running」看不出它是在跑还是卡住了。
  // 只在真有在途任务时轮询 —— 全是终态还接着敲服务端没有意义。
  useEffect(() => {
    const live = rows.some((row) => LIVE_STATES.has(row.state));
    if (!live) {
      if (timer.current) clearInterval(timer.current);
      timer.current = null;
      return;
    }
    if (timer.current) return;
    timer.current = setInterval(() => void load(true), 10_000);
    return () => {
      if (timer.current) clearInterval(timer.current);
      timer.current = null;
    };
  }, [rows, load]);

  const openEvents = async (jobId: string) => {
    setEventsLoading(true);
    try {
      setEvents(await fetchJobEvents(jobId));
    } catch (error) {
      message.error((error as Error).message || t("common.loadFailed"));
    } finally {
      setEventsLoading(false);
    }
  };

  const cancel = async (jobId: string) => {
    try {
      await cancelJob(jobId);
      message.success(t("workloads.job.canceled"));
      onChanged();
    } catch (error) {
      message.error((error as Error).message || t("common.actionFailed"));
    }
  };

  const columns: ColumnsType<JobView> = [
    {
      title: t("workloads.job.id"),
      dataIndex: "jobId",
      width: 220,
      render: (jobId: string) => <span className="manager-mono">{jobId}</span>,
    },
    { title: t("workloads.kind"), dataIndex: "kind", width: 160 },
    {
      title: t("workloads.job.state"),
      dataIndex: "state",
      width: 150,
      render: (state: string, row) => (
        <Space size={4}>
          <Tag color={STATE_COLOR[state] ?? "default"}>{state}</Tag>
          {/* 重跑次数大于 1 说明上一台机器把它跑丢了，平台换了一台重来。 */}
          {row.attempt > 1 ? <Tag>{`${t("workloads.job.attempt")} ${row.attempt}`}</Tag> : null}
        </Space>
      ),
    },
    {
      title: t("workloads.job.progress"),
      dataIndex: "progress",
      width: 170,
      render: (_, row) =>
        row.progress ? (
          <Progress
            percent={row.progress.pct}
            size="small"
            status={row.state === "failed" ? "exception" : row.state === "completed" ? "success" : "active"}
            format={(pct) => `${pct ?? 0}%${row.progress?.stage ? ` · ${row.progress.stage}` : ""}`}
          />
        ) : (
          "-"
        ),
    },
    {
      title: t("workloads.job.outputs"),
      dataIndex: "outputs",
      width: 110,
      render: (_, row) => (row.outputs.length > 0 ? row.outputs.length : "-"),
    },
    {
      title: t("workloads.job.createdTime"),
      dataIndex: "createdTime",
      width: 180,
      render: (value: string) => formatTime(value),
    },
    {
      title: t("common.actions"),
      key: "actions",
      width: 160,
      render: (_, row) => (
        <Space size={4}>
          <Button type="link" size="small" onClick={() => void openEvents(row.jobId)}>
            {t("workloads.job.events")}
          </Button>
          {LIVE_STATES.has(row.state) ? (
            <Popconfirm title={t("workloads.job.cancelConfirm")} onConfirm={() => void cancel(row.jobId)}>
              <Button type="link" size="small" danger>
                {t("workloads.job.cancel")}
              </Button>
            </Popconfirm>
          ) : (
            // 只有跑完的才能申诉：状态还在变的时候裁决没有意义。
            <Button type="link" size="small" onClick={() => setDisputing(row.jobId)}>
              {t("dispute.file")}
            </Button>
          )}
        </Space>
      ),
    },
  ];

  return (
    <>
      <Alert type="info" showIcon style={{ marginBottom: 16 }} message={t("workloads.job.hint")} />
      <Table
        rowKey="jobId"
        size="small"
        loading={loading}
        dataSource={rows}
        columns={columns}
        pagination={{ pageSize: 20, hideOnSinglePage: true }}
        expandable={{
          rowExpandable: (row) => Boolean(row.errorMessage) || Object.keys(row.usage ?? {}).length > 0,
          expandedRowRender: (row) => <JobDetail job={row} />,
        }}
        locale={{ emptyText: <Empty description={t("workloads.job.empty")} /> }}
      />
      <Drawer
        width={640}
        open={events !== null}
        loading={eventsLoading}
        onClose={() => setEvents(null)}
        title={t("workloads.job.events")}
      >
        {events && events.length > 0 ? (
          <Timeline
            items={events.map((event) => ({
              children: (
                <Space direction="vertical" size={2} style={{ width: "100%" }}>
                  <Space size={8}>
                    <Typography.Text strong>#{event.seq}</Typography.Text>
                    <Tag>{event.kind}</Tag>
                    <Typography.Text type="secondary">{formatTime(event.at)}</Typography.Text>
                  </Space>
                  {event.data ? (
                    <Typography.Paragraph className="manager-mono" style={{ fontSize: 12, marginBottom: 0 }}>
                      {JSON.stringify(event.data)}
                    </Typography.Paragraph>
                  ) : null}
                </Space>
              ),
            }))}
          />
        ) : (
          <Empty description={t("workloads.job.noEvents")} />
        )}
      </Drawer>
      <FileDisputeModal
        open={disputing !== ""}
        unitId={disputing}
        onClose={() => setDisputing("")}
        onFiled={onChanged}
      />
    </>
  );
}

function JobDetail({ job }: { job: JobView }) {
  const { t } = useLocale();
  const usage = Object.entries(job.usage ?? {}).filter(([, value]) => value > 0);
  return (
    <Space direction="vertical" size={6} style={{ width: "100%" }}>
      {job.errorMessage ? (
        <Typography.Text type="danger">
          {job.errorCode ? `${job.errorCode} · ` : ""}
          {job.errorMessage}
        </Typography.Text>
      ) : null}
      {usage.length > 0 ? (
        <Space size={[8, 4]} wrap>
          <Typography.Text type="secondary">{t("workloads.job.usage")}</Typography.Text>
          {usage.map(([unit, value]) => (
            <Tag key={unit}>{`${unitLabel(unit)} ${formatUnitValue(unit, value)}`}</Tag>
          ))}
        </Space>
      ) : null}
    </Space>
  );
}
