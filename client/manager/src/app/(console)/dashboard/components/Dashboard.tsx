"use client";

import { ReloadOutlined } from "@ant-design/icons";
import { Alert, Button, Skeleton, Table, Tooltip, message } from "antd";
import type { ColumnsType } from "antd/es/table";
import dayjs, { type Dayjs } from "dayjs";
import { useCallback, useEffect, useState } from "react";
import { ManagerDatePicker } from "@/components/date/DatePickers";
import { useLocale, type TranslationKey } from "@/i18n/LocaleProvider";
import { PageActions } from "@/components/shell/PageActions";
import {
  fetchDashboard,
  type AdminDashboard,
  type DashboardCapacityWindow,
  type DashboardUsageCategory,
} from "../api/dashboard.api";
import { formatClock, formatCompact, formatExact, formatMoney } from "./format";

/**
 * 管理端仪表盘：今天来了多少人、跑了多少量、收了多少钱、池子还剩多少。
 *
 * 和共享算力池的「运营总览」是两页不同的东西：那一页数的是**待办**（有几件事
 * 在等人处理，点进去就去办），这一页数的是**经营**。一页只该回答一个问题 ——
 * 把待办和经营摆在一起，两边都会被对方的数字盖住。
 *
 * 每个数都标出自己的口径。一个说不清是怎么算出来的数字，运营不会拿它做决定：
 *
 *   · 今日登录是**人数**不是次数（口径来自 last_login_at）
 *   · 在线看的是心跳，不是库里那个 status
 *   · 使用端金额和共享端金额是两个数，差额才是毛利，两者不能相加
 *   · 「今日充值」只算真的有钱进来的那两条，花积分买的那笔不算（钱在充值那天就进来了）
 *   · 算力剩余只算在线机器：离线机器的额度此刻一个 token 都放不出来
 */
export function Dashboard() {
  const { t } = useLocale();
  const [data, setData] = useState<AdminDashboard | null>(null);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState("");
  const [trackingDate, setTrackingDate] = useState<Dayjs>(() => dayjs().startOf("day"));

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await fetchDashboard(trackingDate.format("YYYY-MM-DD")));
      setFailure("");
    } catch (error) {
      // 页面留白加一条 toast 等于什么都没说：接口 403（角色还没授这条）和
      // 接口挂了是两种完全不同的处置，错误原文留在页面上才看得出是哪一种。
      const reason = (error as Error).message || t("dashboard.loadFailed");
      setFailure(reason);
      message.error(reason);
    } finally {
      setLoading(false);
    }
  }, [t, trackingDate]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading && !data) {
    return (
      <div className="manager-page-stack">
        <div className="manager-kpi-grid">
          {Array.from({ length: 6 }, (_, i) => (
            <div key={i} className="manager-kpi">
              <Skeleton active title={false} paragraph={{ rows: 3, width: ["45%", "30%", "75%"] }} />
            </div>
          ))}
        </div>
        <section className="manager-data-card">
          <Skeleton active paragraph={{ rows: 5 }} />
        </section>
      </div>
    );
  }

  return (
    <div className="manager-page-stack">
      <PageActions>
        <span className="manager-page-meta">
          <span className="manager-mono">{data?.date || "—"}</span>
          <span>
            {t("dashboard.generatedAt")} {formatClock(data?.generatedAt ?? "")}
          </span>
        </span>
        <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void load()}>
          {t("dashboard.refresh")}
        </Button>
      </PageActions>

      {failure ? <Alert type="error" showIcon message={t("dashboard.loadFailed")} description={failure} /> : null}

      {data ? (
        <>
          <KpiRow data={data} />
          {data.requests ? (
            <section className="manager-data-card">
              <SectionTitle title={t("dashboard.requests.title")} hint={t("dashboard.requests.hint")} />
              <div className="manager-metric-row">
                {(["total", "completed", "failed", "cancelled", "expired", "pending"] as const).map((state) => (
                  <Metric key={state} label={t(`dashboard.requests.${state}`)} value={formatExact(data.requests![state])} />
                ))}
              </div>
            </section>
          ) : null}
          <TrackingSection
            tracking={data.tracking}
            selectedDate={trackingDate}
            loading={loading}
            onDateChange={setTrackingDate}
          />
          <UsageSection usage={data.usage} />
          <CapacitySection data={data} />
          <RevenueSection data={data} />
        </>
      ) : null}
    </div>
  );
}

/* ---------- 用户行为埋点 ---------- */

function TrackingSection({
  tracking,
  selectedDate,
  loading,
  onDateChange,
}: {
  tracking: AdminDashboard["tracking"];
  selectedDate: Dayjs;
  loading: boolean;
  onDateChange: (date: Dayjs) => void;
}) {
  const { t } = useLocale();

  return (
    <section className="manager-data-card">
      <div className="manager-card-head">
        <div>
          <h3>{t("dashboard.tracking.title")}</h3>
          <p>{t("dashboard.tracking.hint")}</p>
        </div>
        <ManagerDatePicker
          aria-label={t("dashboard.tracking.date")}
          value={selectedDate}
          allowClear={false}
          disabled={loading}
          disabledDate={(date) => date.isAfter(dayjs(), "day")}
          onChange={(date) => {
            if (date) onDateChange(date.startOf("day"));
          }}
        />
      </div>
      <div className="manager-metric-row">
        <Metric label={t("dashboard.tracking.portalOpens")} value={formatExact(tracking.portalOpens)} />
        <Metric label={t("dashboard.tracking.modelClicks")} value={formatExact(tracking.modelSquareClicks)} />
      </div>
    </section>
  );
}

/* ---------- 顶部六格 ---------- */

function KpiRow({ data }: { data: AdminDashboard }) {
  const { t } = useLocale();
  const { accounts, machines, usage, revenue } = data;
  // 今日进来的钱只有这两条：花积分买的那笔不算，那笔钱在充值那天就已经进来过。
  const cashIn = revenue.rechargePaid + revenue.channelPaid;

  const cards = [
    {
      key: "provider",
      label: t("dashboard.kpi.providerLogin"),
      value: formatExact(accounts.provider.loggedIn),
      suffix: `/ ${formatExact(accounts.provider.total)}`,
      hint: t("dashboard.kpi.registeredToday", { count: accounts.provider.registered }),
    },
    {
      key: "consumer",
      label: t("dashboard.kpi.consumerLogin"),
      value: formatExact(accounts.consumer.loggedIn),
      suffix: `/ ${formatExact(accounts.consumer.total)}`,
      hint: t("dashboard.kpi.registeredToday", { count: accounts.consumer.registered }),
    },
    {
      key: "machines",
      label: t("dashboard.kpi.online"),
      value: formatExact(machines.online),
      suffix: `/ ${formatExact(machines.total)}`,
      hint: t("dashboard.kpi.byIdentity", { individual: machines.individual, studio: machines.studio }),
    },
    {
      key: "tokens",
      label: t("dashboard.kpi.tokens"),
      value: formatCompact(usage.total.tokens),
      exact: formatExact(usage.total.tokens),
      hint: data.requests ? t("dashboard.kpi.calls", { count: formatExact(data.requests.completed) }) : undefined,
      extra: `${t("dashboard.kpi.tokenBreakdown", {
        input: formatCompact(usage.total.tokenBuckets?.input ?? 0),
        output: formatCompact(usage.total.tokenBuckets?.output ?? 0),
        cache: formatCompact((usage.total.tokenBuckets?.cacheRead ?? 0) + (usage.total.tokenBuckets?.cacheWrite ?? 0)),
      })}`,
    },
    {
      key: "income",
      label: t("dashboard.kpi.income"),
      value: formatMoney(usage.total.consumerAmount),
      hint: t("dashboard.kpi.margin", {
        cost: formatMoney(usage.total.providerAmount),
        margin: formatMoney(usage.total.margin),
      }),
    },
    {
      key: "cash",
      label: t("dashboard.kpi.cashIn"),
      value: formatMoney(cashIn),
      hint: t("dashboard.kpi.cashSplit", {
        recharge: formatMoney(revenue.rechargePaid),
        channel: formatMoney(revenue.channelPaid),
      }),
    },
  ];

  return (
    // 168 是「六格在常见的桌面宽度（含 248 的侧栏）下正好排成一行」的下限。再宽一点就会挤成
    // 五格加一个孤零零的第二行 —— 六个数是一组，断在第五个上会让人以为漏看了什么。
    <div className="manager-kpi-grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(168px, 1fr))" }}>
      {cards.map((card) => (
        <section key={card.key} className="manager-kpi">
          <span className="manager-kpi-label">{card.label}</span>
          <Tooltip title={card.exact}>
            <span className="manager-kpi-value">
              {card.value}
              {card.suffix ? <small>{card.suffix}</small> : null}
            </span>
          </Tooltip>
          <span className="manager-kpi-foot">
            {card.hint}
            {card.extra ? <><br />{card.extra}</> : null}
          </span>
        </section>
      ))}
    </div>
  );
}

/* ---------- 今日消耗 ---------- */

function UsageSection({ usage }: { usage: AdminDashboard["usage"] }) {
  const { t } = useLocale();
  const columns: ColumnsType<DashboardUsageCategory> = [
    {
      title: t("dashboard.usage.category"),
      dataIndex: "category",
      render: (value: string) => <strong>{categoryLabel(value, t)}</strong>,
    },
    {
      title: t("dashboard.usage.tokens"),
      dataIndex: "tokens",
      align: "right",
      render: (value: number) => (
        <Tooltip title={formatExact(value)}>
          <span className="manager-mono">{formatCompact(value)}</span>
        </Tooltip>
      ),
    },
    {
      title: t("dashboard.usage.calls"),
      dataIndex: "calls",
      align: "right",
      render: (value: number) => <span className="manager-mono">{formatExact(value)}</span>,
    },
    {
      title: t("dashboard.usage.consumerAmount"),
      dataIndex: "consumerAmount",
      align: "right",
      render: (value: number) => <span className="manager-mono">{formatMoney(value)}</span>,
    },
    {
      title: t("dashboard.usage.providerAmount"),
      dataIndex: "providerAmount",
      align: "right",
      render: (value: number) => <span className="manager-mono">{formatMoney(value)}</span>,
    },
    {
      title: t("dashboard.usage.margin"),
      dataIndex: "margin",
      align: "right",
      render: (value: number) => (
        // 负数要显眼：结算价高过对外价是一个合法的运营选择，但那意味着平台在倒贴，
        // 和「今天毛利少一点」不是一回事。
        <span className="manager-mono" style={{ color: value < 0 ? "var(--manager-danger)" : "var(--manager-text)" }}>
          {formatMoney(value)}
        </span>
      ),
    },
  ];

  return (
    <section className="manager-data-card">
      <SectionTitle
        title={t("dashboard.usage.title")}
        hint={t("dashboard.usage.hint", { at: formatClock(usage.rolledUntil) })}
      />
      <Table<DashboardUsageCategory>
        rowKey="category"
        size="small"
        pagination={false}
        columns={columns}
        dataSource={usage.categories}
        expandable={{
          // 分单位的明细摊在下一层：量纲不同的几个数（token / 次 / 秒）
          // 放进同一列会被读成可以相加。
          expandedRowRender: (row) => <UnitTable units={row.units} />,
          rowExpandable: (row) => row.units.length > 0,
        }}
        summary={() => (
          <Table.Summary.Row>
            {/* 第一格是展开箭头那一列：不占它的话，整行会往左错一列，
                「合计」落在箭头的位置上，每个数字都对到上一列的表头去。 */}
            <Table.Summary.Cell index={0} />
            <Table.Summary.Cell index={1}>
              <strong>{t("dashboard.usage.total")}</strong>
            </Table.Summary.Cell>
            <Table.Summary.Cell index={2} align="right">
              <span className="manager-mono">{formatCompact(usage.total.tokens)}</span>
            </Table.Summary.Cell>
            <Table.Summary.Cell index={3} align="right">
              <span className="manager-mono">{formatExact(usage.total.calls)}</span>
            </Table.Summary.Cell>
            <Table.Summary.Cell index={4} align="right">
              <span className="manager-mono">{formatMoney(usage.total.consumerAmount)}</span>
            </Table.Summary.Cell>
            <Table.Summary.Cell index={5} align="right">
              <span className="manager-mono">{formatMoney(usage.total.providerAmount)}</span>
            </Table.Summary.Cell>
            <Table.Summary.Cell index={6} align="right">
              <span className="manager-mono">{formatMoney(usage.total.margin)}</span>
            </Table.Summary.Cell>
          </Table.Summary.Row>
        )}
      />
    </section>
  );
}

function UnitTable({ units }: { units: DashboardUsageCategory["units"] }) {
  const { t } = useLocale();
  return (
    <Table
      rowKey="unit"
      size="small"
      pagination={false}
      dataSource={units}
      columns={[
        { title: t("dashboard.usage.unit"), dataIndex: "unit", render: (value: string) => <code>{value}</code> },
        {
          title: t("dashboard.usage.amount"),
          dataIndex: "amount",
          align: "right" as const,
          render: (value: number) => <span className="manager-mono">{formatExact(value)}</span>,
        },
        {
          title: t("dashboard.usage.consumerAmount"),
          dataIndex: "consumerAmount",
          align: "right" as const,
          render: (value: number) => <span className="manager-mono">{formatMoney(value)}</span>,
        },
        {
          title: t("dashboard.usage.providerAmount"),
          dataIndex: "providerAmount",
          align: "right" as const,
          render: (value: number) => <span className="manager-mono">{formatMoney(value)}</span>,
        },
      ]}
    />
  );
}

/* ---------- 算力剩余 ---------- */

function CapacitySection({ data }: { data: AdminDashboard }) {
  const { t } = useLocale();
  const capacity = data.capacity;
  const columns: ColumnsType<DashboardCapacityWindow> = [
    {
      title: t("dashboard.capacity.window"),
      dataIndex: "window",
      render: (value: string) => <strong>{windowLabel(value, t)}</strong>,
    },
    {
      title: t("dashboard.capacity.left"),
      dataIndex: "left",
      align: "right",
      render: (value: number) => (
        <Tooltip title={formatExact(value)}>
          <span className="manager-mono" style={{ fontWeight: 700 }}>{formatCompact(value)}</span>
        </Tooltip>
      ),
    },
    {
      title: t("dashboard.capacity.used"),
      dataIndex: "used",
      align: "right",
      render: (value: number) => <span className="manager-mono">{formatCompact(value)}</span>,
    },
    {
      title: t("dashboard.capacity.limit"),
      dataIndex: "limit",
      align: "right",
      render: (value: number) => <span className="manager-mono">{formatCompact(value)}</span>,
    },
    {
      title: t("dashboard.capacity.machines"),
      dataIndex: "machines",
      align: "right",
      render: (value: number) => <span className="manager-mono">{formatExact(value)}</span>,
    },
    {
      title: t("dashboard.capacity.contributions"),
      dataIndex: "contributions",
      align: "right",
      render: (value: number) => <span className="manager-mono">{formatExact(value)}</span>,
    },
  ];

  return (
    <section className="manager-data-card">
      <SectionTitle
        title={t("dashboard.capacity.title")}
        hint={t("dashboard.capacity.hint", { at: formatClock(capacity.snapshotAt) })}
      />
      {capacity.stale ? (
        <Alert type="warning" showIcon style={{ marginBottom: 12 }} message={t("dashboard.capacity.stale")} />
      ) : null}
      <div className="manager-metric-row" style={{ marginBottom: 16 }}>
        <Metric label={t("dashboard.capacity.withQuota")} value={`${capacity.machines} / ${capacity.onlineMachines}`} />
        <Metric label={t("dashboard.capacity.unlimited")} value={String(capacity.unlimited)} />
      </div>
      <Table<DashboardCapacityWindow>
        rowKey="window"
        size="small"
        pagination={false}
        columns={columns}
        dataSource={capacity.windows}
        locale={{ emptyText: t("dashboard.capacity.empty") }}
        expandable={{
          expandedRowRender: (row) => (
            <Table
              rowKey="unit"
              size="small"
              pagination={false}
              dataSource={row.units}
              columns={[
                { title: t("dashboard.usage.unit"), dataIndex: "unit", render: (value: string) => <code>{value}</code> },
                {
                  title: t("dashboard.capacity.left"),
                  dataIndex: "left",
                  align: "right" as const,
                  render: (value: number) => <span className="manager-mono">{formatExact(value)}</span>,
                },
                {
                  title: t("dashboard.capacity.used"),
                  dataIndex: "used",
                  align: "right" as const,
                  render: (value: number) => <span className="manager-mono">{formatExact(value)}</span>,
                },
                {
                  title: t("dashboard.capacity.limit"),
                  dataIndex: "limit",
                  align: "right" as const,
                  render: (value: number) => <span className="manager-mono">{formatExact(value)}</span>,
                },
              ]}
            />
          ),
          rowExpandable: (row) => row.units.length > 0,
        }}
      />
    </section>
  );
}

/* ---------- 今日进账 ---------- */

function RevenueSection({ data }: { data: AdminDashboard }) {
  const { t } = useLocale();
  const revenue = data.revenue;
  return (
    <section className="manager-data-card">
      <SectionTitle title={t("dashboard.revenue.title")} hint={t("dashboard.revenue.hint")} />
      <div className="manager-metric-row">
        <Metric
          label={t("dashboard.revenue.recharge")}
          value={formatMoney(revenue.rechargePaid)}
          hint={t("dashboard.revenue.count", { count: revenue.rechargeCount })}
        />
        <Metric
          label={t("dashboard.revenue.channel")}
          value={formatMoney(revenue.channelPaid)}
          hint={t("dashboard.revenue.count", { count: revenue.channelCount })}
        />
        <Metric
          label={t("dashboard.revenue.points")}
          value={formatMoney(revenue.pointsPaid)}
          hint={t("dashboard.revenue.pointsHint", { count: revenue.pointsCount })}
          muted
        />
      </div>
    </section>
  );
}

/* ---------- 小零件 ---------- */

function SectionTitle({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="manager-card-head">
      <div>
        <h3>{title}</h3>
        {hint ? <p>{hint}</p> : null}
      </div>
    </div>
  );
}

function Metric({ label, value, hint, muted }: { label: string; value: string; hint?: string; muted?: boolean }) {
  return (
    <div className="manager-metric">
      <span className="manager-metric-label">{label}</span>
      <span className="manager-metric-value" style={muted ? { color: "var(--manager-text-soft)" } : undefined}>
        {value}
      </span>
      {hint ? <span className="manager-kpi-foot">{hint}</span> : null}
    </div>
  );
}

type Translate = (key: TranslationKey, values?: Record<string, string | number>) => string;

/** 类别名。认不出来的原样显示 —— 服务端将来多一类，这里不该把它吞成「其它」。 */
function categoryLabel(category: string, t: Translate): string {
  switch (category) {
    case "claude":
      return t("dashboard.category.claude");
    case "codex":
      return t("dashboard.category.codex");
    case "video":
      return t("dashboard.category.video");
    case "other":
      return t("dashboard.category.other");
    default:
      return category;
  }
}

/** 额度窗口名。同上，认不出来的原样显示。 */
function windowLabel(window: string, t: Translate): string {
  switch (window) {
    case "5h":
      return t("dashboard.window.5h");
    case "day":
      return t("dashboard.window.day");
    case "week":
      return t("dashboard.window.week");
    case "month":
      return t("dashboard.window.month");
    case "total":
      return t("dashboard.window.total");
    default:
      return window;
  }
}
