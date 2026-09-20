"use client";

import { Alert, Table, Tooltip, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useLocale } from "@/i18n/LocaleProvider";
import type { ContributionView, UsageBucket } from "../api/galaxy.api";

/**
 * 一台机器上各个上游账号此刻还剩多少（Claude / Codex 各一条通道）。
 *
 * 这和「额度」那一列讲的**不是同一件事**，所以单独一块、标题也写清楚：
 *
 *   额度      = 主人在控制台设的上限，「他打算放多少出去」
 *   上游余量  = Claude / Codex 账号自己还让跑多少，「上游实际还剩多少」
 *
 * 前者填得比后者宽的时候，机器会在上游那儿撞限流，而额度那一列显示「还剩大半」——
 * 把两个数摆在一起，就是为了让这种情况一眼能看出来。
 *
 * 数据来自节点本来就要发的那些中转请求的响应头，**不额外打上游**。代价是机器闲着
 * 的时候它不更新，所以观测时刻必须显示在最显眼的位置：一个三小时前的余量，
 * 和此刻的余量是两个不能混用的数。
 */
export function UpstreamUsagePanel({ contributions }: { contributions: ContributionView[] }) {
  const { t } = useLocale();
  const rows = contributions.filter((item) => (item.upstreamUsage?.buckets?.length ?? 0) > 0);

  if (rows.length === 0) {
    return (
      <Alert
        type="info"
        showIcon
        message={t("galaxy.upstream.empty")}
        description={t("galaxy.upstream.emptyHint")}
      />
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {rows.map((item) => (
        <section key={item.cid}>
          <Typography.Text strong>{item.provider || item.cid}</Typography.Text>{" "}
          <span style={{ color: "var(--manager-text-faint)", fontSize: "var(--manager-fs-xs)" }}>
            {t("galaxy.upstream.observedAt", { at: formatObserved(item.upstreamUsageAt || item.upstreamUsage?.observedAt) })}
          </span>
          <BucketTable buckets={item.upstreamUsage?.buckets ?? []} raw={item.upstreamUsage?.raw ?? {}} />
        </section>
      ))}
    </div>
  );
}

function BucketTable({ buckets, raw }: { buckets: UsageBucket[]; raw: Record<string, string> }) {
  const { t } = useLocale();
  const columns: ColumnsType<UsageBucket> = [
    {
      // 列宽写死：一台机器上下叠着两张表（Claude 一张、Codex 一张），
      // 让 antd 各自按内容算宽度的话两张对不齐，读起来像两份不相干的数据。
      title: t("galaxy.upstream.bucket"),
      dataIndex: "bucket",
      width: 200,
      render: (value: string, row) => (
        // 显示的是**原始桶名**：上游随时可能加一种没见过的桶，显示它的真名比
        // 归进一个「其它」有用得多。认出来的时间窗只在桶名里看不出来时才补一个角标 ——
        // unified-5h 后面再挂一个「5h」，是同一个信息写两遍。
        <span>
          <code>{value}</code>
          {row.window && !value.includes(row.window) ? (
            <span style={{ marginLeft: 6, color: "var(--manager-text-soft)" }}>{row.window}</span>
          ) : null}
        </span>
      ),
    },
    {
      title: t("galaxy.upstream.remaining"),
      dataIndex: "remaining",
      align: "right",
      width: 140,
      render: (value?: number) => <Value value={value} />,
    },
    {
      title: t("galaxy.upstream.limit"),
      dataIndex: "limit",
      align: "right",
      width: 140,
      render: (value?: number) => <Value value={value} />,
    },
    {
      title: t("galaxy.upstream.usedPercent"),
      dataIndex: "usedPercent",
      align: "right",
      width: 100,
      render: (value?: number) =>
        value === undefined ? (
          <Unknown />
        ) : (
          // 快满了要显眼：这一格是「还能不能接单」的直接依据。
          <span className="manager-mono" style={{ color: value >= 90 ? "var(--manager-danger)" : "var(--manager-text)" }}>
            {value.toFixed(1)}%
          </span>
        ),
    },
    {
      title: t("galaxy.upstream.reset"),
      dataIndex: "reset",
      width: 220,
      render: (value: string) => (value ? <span className="manager-mono">{value}</span> : <Unknown />),
    },
    {
      title: t("galaxy.upstream.status"),
      dataIndex: "status",
      width: 160,
      render: (value: string) => value || "-",
    },
  ];

  return (
    <Table<UsageBucket>
      rowKey="bucket"
      size="small"
      pagination={false}
      columns={columns}
      dataSource={buckets}
      style={{ marginTop: 6 }}
      footer={() => (
        // 原始头兜在最后：归一化认不出来的东西全在这里，而且这是事后补解析器时
        // 唯一能对照的真实报文。平时折着，排查时展开。
        <Tooltip title={t("galaxy.upstream.rawHint")}>
          <details>
            <summary style={{ cursor: "pointer", color: "var(--manager-text-faint)", fontSize: "var(--manager-fs-xs)" }}>
              {t("galaxy.upstream.raw")}（{Object.keys(raw).length}）
            </summary>
            <pre style={{ margin: "6px 0 0", fontSize: "var(--manager-fs-xs)", whiteSpace: "pre-wrap" }}>
              {Object.entries(raw)
                .map(([key, value]) => `${key}: ${value}`)
                .join("\n")}
            </pre>
          </details>
        </Tooltip>
      )}
    />
  );
}

/** 上游没报这一项时显示「未知」，**不显示 0** —— 0 会被读成「用完了」。 */
function Value({ value }: { value?: number }) {
  if (value === undefined) {
    return <Unknown />;
  }
  return <span className="manager-mono">{value.toLocaleString("zh-CN")}</span>;
}

function Unknown() {
  const { t } = useLocale();
  return <span style={{ color: "var(--manager-text-faint)" }}>{t("galaxy.upstream.unknown")}</span>;
}

function formatObserved(at?: string): string {
  if (!at) return "—";
  const time = new Date(at);
  if (Number.isNaN(time.getTime())) return "—";
  return time.toLocaleString("zh-CN", { hour12: false });
}
