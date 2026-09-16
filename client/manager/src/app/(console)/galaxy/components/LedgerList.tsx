"use client";

import { ReloadOutlined, SearchOutlined } from "@ant-design/icons";
import { Alert, Button, Empty, Input, Segmented, Select, Space, Table, Tag, Typography, message } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useCallback, useEffect, useRef, useState } from "react";
import { useLocale } from "@/i18n/LocaleProvider";
import {
  fetchLedger,
  type AdminLedgerPage,
  type LedgerAmountUnit,
  type LedgerEntry,
  type LedgerSide,
  type LedgerTypeTotal,
} from "../api/galaxy.api";

const PAGE_SIZE = 20;
const MICRO = 1_000_000;

/** 1.21M / 316k。计量数是大基数，要一眼读出量级。 */
function compact(value: number): string {
  const sign = value < 0 ? "-" : "";
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${sign}${(abs / 1_000_000).toFixed(2)}M`;
  if (abs >= 10_000) return `${sign}${Math.round(abs / 1000)}k`;
  return value.toLocaleString("en-US");
}

/**
 * 按这一侧的量纲把 amount 渲染成人能读的数。
 *
 * **三侧的 amount 是三个不同的东西**：消费侧扣的是额度本身（计量数），
 * 供给侧记的是微积分，平台侧记的是微分。拿同一套规则去画，消费侧那一列会变成
 * 一个荒唐的小数 —— 而看的人不会意识到自己在读一个错的数。
 */
function renderAmount(value: number, unit: LedgerAmountUnit | ""): string {
  switch (unit) {
    case "credit":
      return `${(value / MICRO).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
    case "money":
      return `¥${(value / MICRO).toFixed(2)}`;
    default:
      return compact(value);
  }
}

/**
 * 三本账的逐笔流水。
 *
 * 结算汇总回答「这个月一共多少」，这一页回答「那一笔是怎么记的」—— 对账、申诉，
 * 以及「平台这个月到底赚了多少」都要从这里查。
 *
 * **平台侧那本账此前完全没有读的路**：抽成与坏账一直在写，而管理端任何一页
 * 都看不到它。也就是说毛利这个数，在库里有，在界面上不存在。
 */
export function LedgerList() {
  const { t } = useLocale();
  const [side, setSide] = useState<LedgerSide>("consumer");
  const [type, setType] = useState("");
  const [keyword, setKeyword] = useState("");
  const [days, setDays] = useState(30);
  const [pageIndex, setPageIndex] = useState(1);
  const [page, setPage] = useState<AdminLedgerPage | null>(null);
  const [loading, setLoading] = useState(true);
  const latest = useRef(0);

  const load = useCallback(async () => {
    const seq = ++latest.current;
    setLoading(true);
    try {
      const result = await fetchLedger({
        side,
        type,
        keyword,
        days,
        offset: (pageIndex - 1) * PAGE_SIZE,
        limit: PAGE_SIZE,
      });
      if (seq !== latest.current) return;
      setPage(result);
    } catch (error) {
      if (seq !== latest.current) return;
      message.error((error as Error).message || t("galaxy.loadFailed"));
    } finally {
      if (seq === latest.current) setLoading(false);
    }
  }, [side, type, keyword, days, pageIndex, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const amountUnit = page?.amountUnit ?? "";

  // 主体那一列每一侧问的是不同的东西：消费侧是哪把密钥、供给侧是谁的哪条贡献、
  // 平台侧根本没有主体（那是平台自己的账）。
  const subjectColumn: ColumnsType<LedgerEntry>[number] =
    side === "provider"
      ? {
          title: t("galaxy.ledger.provider"),
          dataIndex: "cid",
          width: 240,
          render: (cid: string, row) => (
            <Space direction="vertical" size={0}>
              <span>{row.ownerName || row.ownerUserId || "-"}</span>
              <Typography.Text type="secondary" className="manager-mono" style={{ fontSize: 12 }}>
                {cid || "-"}
              </Typography.Text>
            </Space>
          ),
        }
      : side === "consumer"
        ? {
            title: t("galaxy.ledger.consumer"),
            dataIndex: "keyId",
            width: 200,
            render: (value: string) => <span className="manager-mono">{value || "-"}</span>,
          }
        : {
            title: t("galaxy.ledger.unitId"),
            dataIndex: "unitId",
            width: 230,
            render: (value: string) => <span className="manager-mono">{value || "-"}</span>,
          };

  const columns: ColumnsType<LedgerEntry> = [
    {
      title: t("galaxy.ledger.time"),
      dataIndex: "createdAt",
      width: 165,
      render: (value: string) => (value ? new Date(value).toLocaleString() : "-"),
    },
    {
      title: t("galaxy.ledger.type"),
      dataIndex: "type",
      width: 120,
      render: (value: string) => <Tag>{t(`galaxy.ledger.type.${value}`) || value}</Tag>,
    },
    subjectColumn,
    ...(side === "platform"
      ? []
      : [
          {
            title: t("galaxy.ledger.meterUnit"),
            dataIndex: "unit",
            width: 180,
            render: (value: string) => <span className="manager-mono">{value || "-"}</span>,
          } as ColumnsType<LedgerEntry>[number],
        ]),
    {
      title: t(`galaxy.ledger.amount.${amountUnit || "metering"}`),
      dataIndex: "amount",
      align: "right",
      width: 150,
      render: (value: number) => (
        <span className="manager-mono" style={{ color: value < 0 ? "var(--manager-danger)" : undefined }}>
          {renderAmount(value, amountUnit)}
        </span>
      ),
    },
    {
      title: t("galaxy.ledger.txn"),
      dataIndex: "txnId",
      render: (value: string) => (
        <Typography.Text className="manager-mono" style={{ fontSize: 12 }} copyable={{ text: value }}>
          {value.length > 34 ? `${value.slice(0, 34)}…` : value}
        </Typography.Text>
      ),
    },
  ];

  const totalColumns: ColumnsType<LedgerTypeTotal> = [
    {
      title: t("galaxy.ledger.type"),
      dataIndex: "type",
      width: 150,
      render: (value: string) => <Tag>{t(`galaxy.ledger.type.${value}`) || value}</Tag>,
    },
    {
      title: t("galaxy.ledger.count"),
      dataIndex: "count",
      align: "right",
      width: 120,
      render: (value: number) => <span className="manager-mono">{value.toLocaleString("en-US")}</span>,
    },
    {
      title: t(`galaxy.ledger.amount.${amountUnit || "metering"}`),
      dataIndex: "amount",
      align: "right",
      width: 180,
      render: (value: number) => (
        <span className="manager-mono" style={{ color: value < 0 ? "var(--manager-danger)" : undefined }}>
          {renderAmount(value, amountUnit)}
        </span>
      ),
    },
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {/* 量纲这件事必须说在最前面：三侧的数不是一个东西，加在一起没有意义。 */}
      <Alert type="info" showIcon message={t("galaxy.ledger.hint")} description={t(`galaxy.ledger.sideHint.${side}`)} />

      <Space wrap>
        <Segmented
          value={side}
          onChange={(value) => {
            setSide(value as LedgerSide);
            // 类型是按侧定义的，换侧必须清掉 —— 留着上一侧的类型会筛出一个空表，
            // 而运营看到的是「这一侧没有账」。
            setType("");
            setPageIndex(1);
          }}
          options={[
            { value: "consumer", label: t("galaxy.ledger.side.consumer") },
            { value: "provider", label: t("galaxy.ledger.side.provider") },
            { value: "platform", label: t("galaxy.ledger.side.platform") },
          ]}
        />
        <Select
          style={{ width: 150 }}
          value={type}
          onChange={(value) => {
            setType(value);
            setPageIndex(1);
          }}
          options={[
            { value: "", label: t("galaxy.ledger.type.all") },
            ...(page?.types ?? []).map((value) => ({ value, label: t(`galaxy.ledger.type.${value}`) || value })),
          ]}
        />
        <Segmented
          value={days}
          onChange={(value) => {
            setDays(Number(value));
            setPageIndex(1);
          }}
          options={[
            { value: 7, label: t("galaxy.ledger.day7") },
            { value: 30, label: t("galaxy.ledger.day30") },
            { value: 90, label: t("galaxy.ledger.day90") },
          ]}
        />
        <Input.Search
          allowClear
          style={{ width: 280 }}
          placeholder={t(`galaxy.ledger.keyword.${side}`)}
          enterButton={<SearchOutlined />}
          onSearch={(value) => {
            setKeyword(value.trim());
            setPageIndex(1);
          }}
        />
        <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void load()}>
          {t("galaxy.refresh")}
        </Button>
      </Space>

      {(page?.totals?.length ?? 0) > 0 ? (
        <section className="manager-data-card" style={{ padding: 16 }}>
          <Typography.Title level={5} style={{ marginTop: 0 }}>
            {t("galaxy.ledger.totalsTitle").replace("{days}", String(page?.days ?? days))}
          </Typography.Title>
          <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
            {t("galaxy.ledger.totalsHint")}
          </Typography.Paragraph>
          {/* 限宽：三列加起来不到 460，铺满整个卡片会把「笔数」和金额甩到屏幕两端，
              而这三个数本来是要放在一起读的。 */}
          <div style={{ maxWidth: 560 }}>
            <Table<LedgerTypeTotal>
              rowKey="type"
              size="small"
              columns={totalColumns}
              dataSource={page?.totals ?? []}
              pagination={false}
              scroll={{ x: 460 }}
            />
          </div>
        </section>
      ) : null}

      <Table<LedgerEntry>
        rowKey="txnId"
        size="small"
        loading={loading}
        columns={columns}
        dataSource={page?.entries ?? []}
        scroll={{ x: 1090 }}
        pagination={{
          current: pageIndex,
          pageSize: PAGE_SIZE,
          total: page?.total ?? 0,
          showSizeChanger: false,
          onChange: setPageIndex,
        }}
        expandable={{
          rowExpandable: (row) => Boolean(row.unitId || row.relatedUserId || row.balanceAfter),
          expandedRowRender: (row) => (
            <Space direction="vertical" size={4} style={{ width: "100%" }}>
              {row.unitId && side !== "platform" ? (
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {`${t("galaxy.ledger.unitId")}：`}
                  <span className="manager-mono">{row.unitId}</span>
                </Typography.Text>
              ) : null}
              {row.balanceAfter ? (
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {`${t("galaxy.ledger.balanceAfter")}：`}
                  <span className="manager-mono">{compact(row.balanceAfter)}</span>
                </Typography.Text>
              ) : null}
              {row.relatedUserId ? (
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {`${t("galaxy.ledger.relatedUser")}：`}
                  <span className="manager-mono">{row.relatedUserId}</span>
                </Typography.Text>
              ) : null}
            </Space>
          ),
        }}
        locale={{ emptyText: <Empty description={t("galaxy.ledger.empty")} /> }}
      />
    </div>
  );
}
