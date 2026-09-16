"use client";

import { ReloadOutlined, SearchOutlined } from "@ant-design/icons";
import { Alert, Button, Empty, Input, Segmented, Space, Switch, Table, Tag, Typography, message } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useCallback, useEffect, useRef, useState } from "react";
import { useLocale } from "@/i18n/LocaleProvider";
import {
  fetchReferrals,
  type AdminReferralPage,
  type GalaxySide,
  type InviterRank,
  type ReferralRecord,
} from "../api/galaxy.api";

const PAGE_SIZE = 20;
/** 积分在库里是「微积分」：除以它得到积分。1 积分 = ¥1。 */
const MICRO = 1_000_000;

function points(micros: number): string {
  return (micros / MICRO).toLocaleString("en-US", { maximumFractionDigits: 2 });
}

/**
 * 邀请返现。
 *
 * 两端各有一套，而且**是两套码**：使用端买套餐返给邀请人，共享端出算力返给邀请人，
 * 注册时按端分流，码不通用。所以这一页先选端，不是把两批人拌在一起列。
 *
 * 此前管理端只有一个「默认比例」开关 —— 返出去的钱一分都看不见。谁在真的带量、
 * 平台为这个活动付了多少，都答不上来。一个开着的活动，钱在流出而没人看得见流向，
 * 这本身就是个问题。
 */
export function ReferralList() {
  const { t } = useLocale();
  const [side, setSide] = useState<GalaxySide>("consumer");
  const [keyword, setKeyword] = useState("");
  const [invitedOnly, setInvitedOnly] = useState(true);
  const [inviterId, setInviterId] = useState("");
  const [pageIndex, setPageIndex] = useState(1);
  const [page, setPage] = useState<AdminReferralPage | null>(null);
  const [loading, setLoading] = useState(true);
  const latest = useRef(0);

  const load = useCallback(async () => {
    const seq = ++latest.current;
    setLoading(true);
    try {
      const result = await fetchReferrals({
        side,
        keyword,
        inviterId,
        invitedOnly,
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
  }, [side, keyword, inviterId, invitedOnly, pageIndex, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const top = page?.top ?? [];

  const topColumns: ColumnsType<InviterRank> = [
    {
      title: t("galaxy.referral.inviter"),
      dataIndex: "inviterId",
      render: (value: string, row) => (
        <Space direction="vertical" size={0}>
          <span style={{ fontWeight: 600 }}>{row.inviterName || t("galaxy.referral.unknownUser")}</span>
          <Typography.Text type="secondary" className="manager-mono" style={{ fontSize: 12 }}>
            {value}
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: t("galaxy.referral.invitees"),
      dataIndex: "invitees",
      align: "right",
      width: 120,
      render: (value: number) => <span className="manager-mono">{value}</span>,
    },
    {
      title: t("galaxy.referral.payout"),
      dataIndex: "payout",
      align: "right",
      width: 150,
      render: (value: number) => <span className="manager-mono">{points(value)}</span>,
    },
    {
      title: t("galaxy.actions"),
      key: "actions",
      width: 110,
      render: (_, row) => (
        <Button
          type="link"
          size="small"
          onClick={() => {
            setInviterId(row.inviterId === inviterId ? "" : row.inviterId);
            setPageIndex(1);
          }}
        >
          {row.inviterId === inviterId ? t("galaxy.referral.clearFilter") : t("galaxy.referral.filter")}
        </Button>
      ),
    },
  ];

  const columns: ColumnsType<ReferralRecord> = [
    {
      title: t("galaxy.referral.user"),
      dataIndex: "userId",
      width: 260,
      render: (value: string, row) => (
        <Space direction="vertical" size={0}>
          <span style={{ fontWeight: 600 }}>{row.userName || t("galaxy.referral.unknownUser")}</span>
          <Typography.Text type="secondary" className="manager-mono" style={{ fontSize: 12 }}>
            {value}
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: t("galaxy.referral.code"),
      dataIndex: "inviteCode",
      width: 140,
      render: (value: string) => <Tag className="manager-mono">{value || "-"}</Tag>,
    },
    {
      title: t("galaxy.referral.invitedBy"),
      dataIndex: "invitedBy",
      render: (value: string, row) =>
        value ? (
          <Space direction="vertical" size={0}>
            <span>{row.inviterName || t("galaxy.referral.unknownUser")}</span>
            <Typography.Text type="secondary" className="manager-mono" style={{ fontSize: 12 }}>
              {value}
            </Typography.Text>
          </Space>
        ) : (
          <Typography.Text type="secondary">{t("galaxy.referral.selfSignup")}</Typography.Text>
        ),
    },
    {
      title: t("galaxy.referral.joinedAt"),
      dataIndex: "createdTime",
      width: 170,
      render: (value: string) => (value ? new Date(value).toLocaleString() : "-"),
    },
  ];

  // 两端的比例来源不一样：使用端那个是运营在后台设的，共享端那个在配置文件里。
  // 混成一句话说会让人以为共享端那个也在后台改得动。
  const rateHint =
    side === "consumer"
      ? t("galaxy.referral.consumerRate").replace("{pct}", ((page?.defaultBps ?? 0) / 100).toFixed(2))
      : t("galaxy.referral.providerRate")
          .replace("{pct}", ((page?.providerRate ?? 0) * 100).toFixed(1))
          .replace("{days}", page?.providerDays ? String(page.providerDays) : t("galaxy.referral.forever"));

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <Alert type="info" showIcon message={t("galaxy.referral.hint")} description={rateHint} />

      <Space wrap>
        <Segmented
          value={side}
          onChange={(value) => {
            setSide(value as GalaxySide);
            setInviterId("");
            setPageIndex(1);
          }}
          options={[
            { value: "consumer", label: t("galaxy.account.side.consumer") },
            { value: "provider", label: t("galaxy.account.side.provider") },
          ]}
        />
        <Input.Search
          allowClear
          style={{ width: 280 }}
          placeholder={t("galaxy.referral.keyword")}
          enterButton={<SearchOutlined />}
          onSearch={(value) => {
            setKeyword(value.trim());
            setPageIndex(1);
          }}
        />
        <Space size={6}>
          <Switch
            size="small"
            checked={invitedOnly}
            onChange={(checked) => {
              setInvitedOnly(checked);
              setPageIndex(1);
            }}
          />
          <span style={{ fontSize: "var(--manager-fs-sm)" }}>{t("galaxy.referral.invitedOnly")}</span>
        </Space>
        {inviterId ? (
          <Tag closable color="processing" onClose={() => setInviterId("")}>
            {t("galaxy.referral.filtered")} {inviterId}
          </Tag>
        ) : null}
        <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void load()}>
          {t("galaxy.refresh")}
        </Button>
      </Space>

      {/* 排行在前：逐行翻看不出谁在真的带量。 */}
      {top.length > 0 ? (
        <section className="manager-data-card" style={{ padding: 16 }}>
          <Typography.Title level={5} style={{ marginTop: 0 }}>
            {t("galaxy.referral.topTitle")}
          </Typography.Title>
          <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
            {t("galaxy.referral.topHint")}
          </Typography.Paragraph>
          <Table<InviterRank>
            rowKey="inviterId"
            size="small"
            columns={topColumns}
            dataSource={top}
            pagination={false}
            scroll={{ x: 640 }}
          />
        </section>
      ) : null}

      <Table<ReferralRecord>
        rowKey="userId"
        size="small"
        loading={loading}
        columns={columns}
        dataSource={page?.records ?? []}
        scroll={{ x: 860 }}
        pagination={{
          current: pageIndex,
          pageSize: PAGE_SIZE,
          total: page?.total ?? 0,
          showSizeChanger: false,
          onChange: setPageIndex,
        }}
        locale={{ emptyText: <Empty description={t("galaxy.referral.empty")} /> }}
      />
    </div>
  );
}
