"use client";

import { EyeOutlined, ReloadOutlined, SearchOutlined } from "@ant-design/icons";
import {
  Alert,
  Badge,
  Button,
  Empty,
  Form,
  Input,
  Modal,
  Segmented,
  Space,
  Table,
  Tag,
  Typography,
  message,
} from "antd";
import type { ColumnsType } from "antd/es/table";
import { useCallback, useEffect, useRef, useState } from "react";
import { useLocale } from "@/i18n/LocaleProvider";
import { useCanWrite } from "@/components/permission/WritePermission";
import {
  fetchPayouts,
  handlePayout,
  revealPayoutAccount,
  type AdminPayoutPage,
  type AdminPayoutView,
  type PayoutStatus,
} from "../api/galaxy.api";

const PAGE_SIZE = 20;
/** 积分和金额在库里都是「微」：除以它得到积分 / 元。1 积分 = ¥1。 */
const MICRO = 1_000_000;

const STATUS_COLOR: Record<string, string> = {
  pending: "processing",
  paid: "success",
  rejected: "default",
};

function points(micros: number): string {
  return (micros / MICRO).toLocaleString("en-US", { maximumFractionDigits: 2 });
}

/**
 * 提现审批队列。
 *
 * **这一页是那笔钱唯一的出口**：申请提交的那一刻积分就从共享者的账户里扣走了
 * （CreatePayout 先扣再建单，否则进程挂在两步之间会白送一笔）。单子停在待处理，
 * 等于钱既不在用户手上、也没打出去 —— 没有这一页，唯一的办法是有人去库里手工
 * UPDATE，而手工 UPDATE 不会退积分。
 *
 * 两个动作的性质完全不同，所以分成两个按钮而不是一个下拉：
 * - 「确认已打款」只是记一笔「钱出去了」，不动账；
 * - 「驳回」会把积分原路退回账户并在账本上记一笔反向流水，必须写明原因。
 *
 * 收款账号在列表里是打码的。真要打款时单独取一次明文 —— 它进了列表就会进日志、进截图。
 */
export function PayoutQueue() {
  const { t } = useLocale();
  // 处置提现是真金白银出账，只读角色一律看不到入口。
  const canWrite = useCanWrite();
  const [status, setStatus] = useState<PayoutStatus | "all">("pending");
  const [keyword, setKeyword] = useState("");
  const [pageIndex, setPageIndex] = useState(1);
  const [page, setPage] = useState<AdminPayoutPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [target, setTarget] = useState<{ row: AdminPayoutView; decision: "paid" | "rejected" } | null>(null);
  const latest = useRef(0);

  const load = useCallback(async () => {
    const seq = ++latest.current;
    setLoading(true);
    try {
      const result = await fetchPayouts({
        status: status === "all" ? "" : status,
        keyword,
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
  }, [status, keyword, pageIndex, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const counts = page?.counts ?? {};
  const pending = counts.pending ?? 0;

  const columns: ColumnsType<AdminPayoutView> = [
    {
      title: t("galaxy.payout.owner"),
      dataIndex: "ownerUserId",
      width: 220,
      render: (ownerUserId: string, row) => (
        <Space direction="vertical" size={0}>
          <span style={{ fontWeight: 600 }}>{row.ownerName || ownerUserId}</span>
          <Typography.Text type="secondary" className="manager-mono" style={{ fontSize: 12 }}>
            {row.payoutId}
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: t("galaxy.payout.credits"),
      dataIndex: "credits",
      align: "right",
      width: 130,
      render: (value: number) => <span className="manager-mono">{points(value)}</span>,
    },
    {
      title: t("galaxy.payout.amount"),
      dataIndex: "amount",
      align: "right",
      width: 130,
      render: (value: number, row) => (
        <Space direction="vertical" size={0} style={{ alignItems: "flex-end" }}>
          <span className="manager-mono">¥{(value / MICRO).toFixed(2)}</span>
          {row.fee > 0 ? (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {t("galaxy.payout.fee")} ¥{(row.fee / MICRO).toFixed(2)}
            </Typography.Text>
          ) : null}
        </Space>
      ),
    },
    {
      title: t("galaxy.payout.account"),
      dataIndex: "account",
      width: 268,
      render: (account: string, row) => <AccountCell row={row} masked={account} />,
    },
    {
      title: t("galaxy.payout.status"),
      dataIndex: "status",
      width: 110,
      render: (value: string) => <Tag color={STATUS_COLOR[value] ?? "default"}>{t(`galaxy.payout.status.${value}`)}</Tag>,
    },
    {
      title: t("galaxy.payout.createdAt"),
      dataIndex: "createdTime",
      width: 165,
      render: (value: string) => (value ? new Date(value).toLocaleString() : "-"),
    },
    {
      title: t("galaxy.actions"),
      key: "actions",
      // 两个按钮并排，宽度要留够 —— 差几像素，「驳回」就被钉在表格右边缘上，
      // 看着像被裁掉了一半。
      width: 172,
      fixed: "right",
      render: (_, row) =>
        canWrite && row.status === "pending" ? (
          <Space size={4}>
            <Button type="link" size="small" onClick={() => setTarget({ row, decision: "paid" })}>
              {t("galaxy.payout.markPaid")}
            </Button>
            <Button type="link" size="small" danger onClick={() => setTarget({ row, decision: "rejected" })}>
              {t("galaxy.payout.reject")}
            </Button>
          </Space>
        ) : null,
    },
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {/* 待处理不是零就顶上说一句：这笔钱此刻既不在用户手上，也没打出去。 */}
      {pending > 0 ? (
        <Alert
          type="info"
          showIcon
          message={t("galaxy.payout.pendingTitle").replace("{count}", String(pending))}
          description={t("galaxy.payout.pendingHint")}
        />
      ) : null}

      <Space wrap>
        <Segmented
          value={status}
          onChange={(value) => {
            setStatus(value as PayoutStatus | "all");
            setPageIndex(1);
          }}
          options={[
            { value: "pending", label: <Badge count={pending} size="small" offset={[8, -2]}>{t("galaxy.payout.status.pending")}</Badge> },
            { value: "paid", label: t("galaxy.payout.status.paid") },
            { value: "rejected", label: t("galaxy.payout.status.rejected") },
            { value: "all", label: t("galaxy.payout.all") },
          ]}
        />
        <Input
          allowClear
          style={{ width: 240 }}
          prefix={<SearchOutlined />}
          placeholder={t("galaxy.payout.keyword")}
          onChange={(event) => {
            if (!event.target.value) {
              setKeyword("");
              setPageIndex(1);
            }
          }}
          onPressEnter={(event) => {
            setKeyword((event.target as HTMLInputElement).value.trim());
            setPageIndex(1);
          }}
        />
        <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void load()}>
          {t("galaxy.refresh")}
        </Button>
      </Space>

      {/* 起提金额与争议期解释「为什么这个人提不出来」，是运营最常被问到的一句。 */}
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        {t("galaxy.payout.rules")
          .replace("{min}", points(page?.minCredits ?? 0))
          .replace("{days}", String(page?.holdDays ?? 0))}
      </Typography.Text>

      <Table<AdminPayoutView>
        rowKey="payoutId"
        size="small"
        loading={loading}
        columns={columns}
        dataSource={page?.payouts ?? []}
        scroll={{ x: 1200 }}
        pagination={{
          current: pageIndex,
          pageSize: PAGE_SIZE,
          total: page?.total ?? 0,
          showSizeChanger: false,
          onChange: setPageIndex,
        }}
        expandable={{
          rowExpandable: (row) => Boolean(row.note || row.handledBy),
          expandedRowRender: (row) => (
            <Space direction="vertical" size={4} style={{ width: "100%" }}>
              {row.note ? <Typography.Text>{`${t("galaxy.payout.note")}：${row.note}`}</Typography.Text> : null}
              {row.handledBy ? (
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {`${t("galaxy.payout.handledBy")}：${row.handledBy}`}
                  {row.handledAt ? ` · ${new Date(row.handledAt).toLocaleString()}` : ""}
                </Typography.Text>
              ) : null}
            </Space>
          ),
        }}
        locale={{ emptyText: <Empty description={t("galaxy.payout.empty")} /> }}
      />

      <HandleModal target={target} onClose={() => setTarget(null)} onHandled={load} />
    </div>
  );
}

/**
 * 收款账号：默认打码，点一下才取明文。
 *
 * 明文只落在这一个单元格的组件状态里，不写回列表数据 —— 刷新、翻页之后它就没了，
 * 而运营真正需要它的时间只有「复制到网银那一下」。
 */
function AccountCell({ row, masked }: { row: AdminPayoutView; masked: string }) {
  const { t } = useLocale();
  const [plain, setPlain] = useState("");
  const [loading, setLoading] = useState(false);

  const reveal = async () => {
    setLoading(true);
    try {
      const view = await revealPayoutAccount(row.payoutId);
      setPlain(view.account);
    } catch (error) {
      message.error((error as Error).message || t("galaxy.actionFailed"));
    } finally {
      setLoading(false);
    }
  };

  return (
    <Space direction="vertical" size={0}>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        {row.method ? t(`galaxy.payout.method.${row.method}`) : "-"}
      </Typography.Text>
      {plain ? (
        <Typography.Text className="manager-mono" copyable={{ text: plain }}>
          {plain}
        </Typography.Text>
      ) : (
        <Space size={4}>
          {/* 卡号打码之后仍然有十几位，让它换行会把一行拉成三行 —— 一列待办看上去就像一堆段落。 */}
          <span className="manager-mono" style={{ whiteSpace: "nowrap" }}>
            {masked || "-"}
          </span>
          <Button type="link" size="small" icon={<EyeOutlined />} loading={loading} onClick={() => void reveal()}>
            {t("galaxy.payout.reveal")}
          </Button>
        </Space>
      )}
    </Space>
  );
}

/**
 * 处置弹窗。两个决定的后果不一样，所以文案是两套 ——
 * 一个通用的「确定吗」在这里等于什么都没说。
 */
function HandleModal({
  target,
  onClose,
  onHandled,
}: {
  target: { row: AdminPayoutView; decision: "paid" | "rejected" } | null;
  onClose: () => void;
  onHandled: () => void;
}) {
  const { t } = useLocale();
  const [form] = Form.useForm<{ note: string }>();
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (target) form.setFieldsValue({ note: "" });
  }, [target, form]);

  const rejecting = target?.decision === "rejected";

  const submit = async () => {
    if (!target) return;
    const values = await form.validateFields();
    setSubmitting(true);
    try {
      await handlePayout(target.row.payoutId, target.decision, values.note?.trim() ?? "");
      message.success(t("galaxy.payout.handled"));
      onClose();
      onHandled();
    } catch (error) {
      message.error((error as Error).message || t("galaxy.actionFailed"));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={target !== null}
      title={rejecting ? t("galaxy.payout.rejectTitle") : t("galaxy.payout.markPaidTitle")}
      okText={t("galaxy.confirm")}
      okButtonProps={{ danger: rejecting }}
      cancelText={t("galaxy.cancel")}
      confirmLoading={submitting}
      onOk={() => void submit()}
      onCancel={onClose}
      destroyOnClose
    >
      <Alert
        type={rejecting ? "warning" : "info"}
        showIcon
        style={{ marginBottom: 16 }}
        message={
          rejecting
            ? t("galaxy.payout.rejectHint").replace("{credits}", points(target?.row.credits ?? 0))
            : t("galaxy.payout.markPaidHint").replace("{amount}", ((target?.row.amount ?? 0) / MICRO).toFixed(2))
        }
      />
      <Form form={form} layout="vertical">
        {/*
          驳回的说明会原样给到申请人，所以必填 —— 一个没有理由的驳回，他只会原样再提一次。
          确认打款时它是可选的（那笔钱已经出去了），提示词也换一套：拿驳回那句
          「收款账号与实名不一致」去提示一个正在确认打款的人，读起来像在说这笔单子有问题。
        */}
        <Form.Item
          name="note"
          label={rejecting ? t("galaxy.payout.note") : t("galaxy.payout.noteOptional")}
          rules={rejecting ? [{ required: true, message: t("galaxy.payout.noteRequired") }] : undefined}
          extra={rejecting ? t("galaxy.payout.noteHint") : undefined}
        >
          <Input.TextArea
            rows={3}
            maxLength={256}
            showCount
            placeholder={rejecting ? t("galaxy.payout.notePlaceholder") : t("galaxy.payout.paidNotePlaceholder")}
          />
        </Form.Item>
      </Form>
    </Modal>
  );
}
