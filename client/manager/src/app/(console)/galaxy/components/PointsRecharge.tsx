"use client";

import { PlusOutlined, ReloadOutlined, SearchOutlined } from "@ant-design/icons";
import { Alert, Button, Form, Input, InputNumber, Modal, Select, Space, Table, Typography, message } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useCallback, useEffect, useRef, useState } from "react";
import { useLocale } from "@/i18n/LocaleProvider";
import { useCanWrite } from "@/components/permission/WritePermission";
import {
  fetchPointsLedger,
  fetchPointsSummary,
  listGalaxyUsers,
  rechargePoints,
  type GalaxyAccountView,
  type PointsLedgerEntry,
  type PointsSummaryView,
} from "../api/galaxy.api";

const PAGE_SIZE = 20;
/** 积分和金额在库里都是「微」：除以它得到积分 / 元。1 积分 = ¥1。 */
const MICRO = 1_000_000;

function points(micros: number): string {
  return (micros / MICRO).toLocaleString("en-US", { maximumFractionDigits: 2 });
}

/** 打开充值框时生成一次的请求号。管理端可能跑在 http 上，crypto.randomUUID 在非安全上下文里不存在。 */
function newRequestId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/**
 * 给使用者充积分，以及充值明细。
 *
 * 使用端没有自助充值：对方线下付款之后由运营在这里充进去，然后对方用积分在 Orbit 里买套餐、拿密钥。
 * 充值明细就是积分流水里 type=recharge 的那些行，谁充的、实付多少、充完剩多少都在上面。
 *
 * 几条要紧的：
 * - **请求号在打开充值框时生成**：超时重试、连点两下，服务端只认一次，第二次原样回第一次的结果。
 *   关掉再打开会换一个新号 —— 那就是真的想再充一笔。
 * - 实付金额只记账，不参与计算；送积分就把它填 0。
 * - 只能充给使用端账号。
 */
export function PointsRecharge() {
  const { t } = useLocale();
  // 充值是直接发钱，只读角色看不到入口。
  const canWrite = useCanWrite();
  const [keyword, setKeyword] = useState("");
  const [pageIndex, setPageIndex] = useState(1);
  const [rows, setRows] = useState<PointsLedgerEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const latest = useRef(0);

  const load = useCallback(async () => {
    const seq = ++latest.current;
    setLoading(true);
    try {
      const page = await fetchPointsLedger({ type: "recharge", keyword, offset: (pageIndex - 1) * PAGE_SIZE, limit: PAGE_SIZE });
      if (seq !== latest.current) return;
      setRows(page.entries ?? []);
      setTotal(page.total);
    } catch (error) {
      if (seq !== latest.current) return;
      message.error((error as Error).message || t("galaxy.loadFailed"));
    } finally {
      if (seq === latest.current) setLoading(false);
    }
  }, [keyword, pageIndex, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const columns: ColumnsType<PointsLedgerEntry> = [
    {
      title: t("galaxy.points.time"),
      dataIndex: "createdAt",
      width: 170,
      render: (value: string) => (value ? new Date(value).toLocaleString() : "-"),
    },
    {
      title: t("galaxy.points.user"),
      dataIndex: "ownerUserId",
      width: 240,
      render: (ownerUserId: string, row) => (
        <Space direction="vertical" size={0}>
          <span style={{ fontWeight: 600 }}>{row.ownerName || ownerUserId}</span>
          {row.ownerName ? (
            <Typography.Text type="secondary" className="manager-mono" style={{ fontSize: 12 }}>
              {ownerUserId}
            </Typography.Text>
          ) : null}
        </Space>
      ),
    },
    {
      title: t("galaxy.points.amount"),
      dataIndex: "amount",
      width: 120,
      align: "right",
      render: (value: number) => <span className="manager-mono">+{points(value)}</span>,
    },
    {
      title: t("galaxy.points.paid"),
      dataIndex: "baseAmount",
      width: 120,
      align: "right",
      render: (value: number) => (value > 0 ? `¥${(value / MICRO).toFixed(2)}` : t("galaxy.points.gift")),
    },
    {
      title: t("galaxy.points.balanceAfter"),
      dataIndex: "balanceAfter",
      width: 120,
      align: "right",
      render: (value: number) => <span className="manager-mono">{points(value)}</span>,
    },
    { title: t("galaxy.points.remark"), dataIndex: "remark", render: (value: string) => value || "-" },
    {
      title: t("galaxy.points.operator"),
      dataIndex: "operator",
      width: 160,
      render: (value: string) => <span className="manager-mono">{value || "-"}</span>,
    },
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <Space wrap>
        {canWrite ? (
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setOpen(true)}>
            {t("galaxy.points.recharge")}
          </Button>
        ) : null}
        <Input.Search
          allowClear
          style={{ width: 280 }}
          placeholder={t("galaxy.points.keyword")}
          enterButton={<SearchOutlined />}
          onSearch={(value) => {
            setKeyword(value);
            setPageIndex(1);
          }}
        />
        <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void load()}>
          {t("galaxy.refresh")}
        </Button>
      </Space>

      <Table<PointsLedgerEntry>
        rowKey="txnId"
        size="small"
        loading={loading}
        columns={columns}
        dataSource={rows}
        locale={{ emptyText: t("galaxy.points.empty") }}
        pagination={{
          current: pageIndex,
          pageSize: PAGE_SIZE,
          total,
          showSizeChanger: false,
          onChange: setPageIndex,
        }}
        scroll={{ x: 1100 }}
      />

      <RechargeModal
        open={open}
        onClose={() => setOpen(false)}
        onDone={() => {
          setOpen(false);
          setPageIndex(1);
          void load();
        }}
      />
    </div>
  );
}

type RechargeForm = {
  userId?: string;
  points: number | null;
  paid: number | null;
  remark: string;
};

function RechargeModal({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const { t } = useLocale();
  const [form] = Form.useForm<RechargeForm>();
  const [options, setOptions] = useState<GalaxyAccountView[]>([]);
  const [searching, setSearching] = useState(false);
  const [summary, setSummary] = useState<PointsSummaryView | null>(null);
  const [saving, setSaving] = useState(false);
  // 实付金额默认跟着积分走（1 积分 = ¥1）；运营手动改过一次就不再跟。
  const [paidTouched, setPaidTouched] = useState(false);
  const requestId = useRef("");
  const searchSeq = useRef(0);

  const search = useCallback(async (keyword: string) => {
    const seq = ++searchSeq.current;
    setSearching(true);
    try {
      const page = await listGalaxyUsers({ side: "consumer", keyword, status: "active", limit: 20 });
      if (seq === searchSeq.current) setOptions(page.list ?? []);
    } catch (error) {
      if (seq === searchSeq.current) message.error((error as Error).message || t("galaxy.loadFailed"));
    } finally {
      if (seq === searchSeq.current) setSearching(false);
    }
  }, [t]);

  useEffect(() => {
    if (!open) return;
    requestId.current = newRequestId();
    form.resetFields();
    setSummary(null);
    setPaidTouched(false);
    void search("");
  }, [form, open, search]);

  const pickUser = async (userId?: string) => {
    setSummary(null);
    if (!userId) return;
    try {
      setSummary(await fetchPointsSummary(userId));
    } catch {
      // 余额只是参考，拿不到不挡充值。
    }
  };

  const submit = async () => {
    const values = await form.validateFields();
    if (!values.userId || !values.points) return;
    setSaving(true);
    try {
      const entry = await rechargePoints({
        userId: values.userId,
        // 积分 / 元 → 微。四舍五入到整数：0.1 + 0.2 那类浮点误差不能带进账里。
        points: Math.round(values.points * MICRO),
        paidAmount: Math.round((values.paid ?? 0) * MICRO),
        remark: values.remark?.trim() ?? "",
        requestId: requestId.current,
      });
      message.success(t("galaxy.points.recharged").replace("{balance}", points(entry.balanceAfter)));
      onDone();
    } catch (error) {
      message.error((error as Error).message || t("galaxy.actionFailed"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      title={t("galaxy.points.recharge")}
      okText={t("galaxy.points.rechargeOk")}
      cancelText={t("galaxy.cancel")}
      confirmLoading={saving}
      onCancel={onClose}
      onOk={() => void submit()}
      destroyOnClose
      width={560}
    >
      <Alert type="info" showIcon style={{ marginBottom: 16 }} message={t("galaxy.points.rechargeHint")} />
      <Form form={form} layout="vertical" initialValues={{ points: null, paid: null, remark: "" }}>
        <Form.Item name="userId" label={t("galaxy.points.user")} rules={[{ required: true, message: t("galaxy.points.userRequired") }]}>
          <Select
            showSearch
            filterOption={false}
            loading={searching}
            placeholder={t("galaxy.points.userPlaceholder")}
            onSearch={(value) => void search(value)}
            onChange={(value: string) => void pickUser(value)}
            options={options.map((user) => ({
              value: user.id,
              label: `${user.displayName && user.displayName !== user.username ? `${user.displayName}（${user.username}）` : user.username} · ${user.id}`,
            }))}
          />
        </Form.Item>
        {summary ? (
          <Typography.Paragraph type="secondary" style={{ marginTop: -12 }}>
            {t("galaxy.points.currentBalance").replace("{balance}", points(summary.balance)).replace("{recharged}", points(summary.recharged))}
          </Typography.Paragraph>
        ) : null}
        <Space size={12} style={{ display: "flex" }} align="start">
          <Form.Item
            name="points"
            label={t("galaxy.points.amount")}
            rules={[{ required: true, message: t("galaxy.points.amountRequired") }]}
            style={{ flex: 1 }}
          >
            <InputNumber
              style={{ width: "100%" }}
              min={0.01}
              max={1_000_000}
              precision={2}
              addonAfter={t("galaxy.points.unit")}
              onChange={(value) => {
                if (!paidTouched) form.setFieldValue("paid", value);
              }}
            />
          </Form.Item>
          <Form.Item name="paid" label={t("galaxy.points.paid")} extra={t("galaxy.points.paidHint")} style={{ flex: 1 }}>
            <InputNumber style={{ width: "100%" }} min={0} precision={2} addonAfter="CNY" onChange={() => setPaidTouched(true)} />
          </Form.Item>
        </Space>
        <Form.Item name="remark" label={t("galaxy.points.remark")} extra={t("galaxy.points.remarkHint")}>
          <Input.TextArea rows={2} maxLength={256} showCount />
        </Form.Item>
      </Form>
    </Modal>
  );
}
