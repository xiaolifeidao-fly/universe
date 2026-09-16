"use client";

import { ReloadOutlined, SearchOutlined, StopOutlined } from "@ant-design/icons";
import { Alert, Button, Empty, Form, Input, Modal, Segmented, Select, Space, Table, Tag, Typography, message } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useCallback, useEffect, useRef, useState } from "react";
import { useLocale } from "@/i18n/LocaleProvider";
import { useCanWrite } from "@/components/permission/WritePermission";
import {
  cancelUnit,
  fetchUnits,
  TERMINAL_UNIT_STATES,
  type AdminUnitPage,
  type AdminUnitView,
  type UnitState,
} from "../api/galaxy.api";

const PAGE_SIZE = 20;

const STATE_COLOR: Record<string, string> = {
  queued: "default",
  placed: "processing",
  running: "processing",
  streaming: "processing",
  completed: "success",
  failed: "error",
  cancelled: "warning",
  expired: "warning",
};

const STATES: UnitState[] = ["queued", "placed", "running", "streaming", "completed", "failed", "cancelled", "expired"];

/**
 * 运行工单：池子里此刻在跑什么、刚才那一批为什么失败。
 *
 * 按人查的那条路一直都在（消费者控制台的「执行记录」），但运营没有跨租户的 ——
 * 「现在有多少在跑」「这十分钟的失败是不是都落在同一条贡献上」这两个排障问题，
 * 此前只能进库 SELECT。
 *
 * 这里**不显示任何请求内容**：工单表上本来就不存它，运营也不该看得到。
 * 能看到的是路由与结果：落在哪条贡献、哪个 Hub 实例、第几次尝试、错在哪一类。
 */
export function UnitList() {
  const { t } = useLocale();
  // 强制取消会打断一条正在跑的请求，只读角色看不到入口。
  const canWrite = useCanWrite();
  const [days, setDays] = useState(1);
  const [state, setState] = useState<UnitState | "">("");
  const [keyword, setKeyword] = useState("");
  const [pageIndex, setPageIndex] = useState(1);
  const [page, setPage] = useState<AdminUnitPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [target, setTarget] = useState<AdminUnitView | null>(null);
  const latest = useRef(0);

  const load = useCallback(async () => {
    const seq = ++latest.current;
    setLoading(true);
    try {
      const result = await fetchUnits({
        state,
        days,
        // 一个输入框同时当贡献和密钥用：排障时手上是哪个都可能。
        cid: keyword.startsWith("ck_") ? "" : keyword,
        consumerKey: keyword.startsWith("ck_") ? keyword : "",
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
  }, [state, days, keyword, pageIndex, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const counts = page?.counts ?? {};
  const running = STATES.filter((value) => !TERMINAL_UNIT_STATES.has(value)).reduce(
    (sum, value) => sum + (counts[value] ?? 0),
    0,
  );

  const columns: ColumnsType<AdminUnitView> = [
    {
      title: t("galaxy.unit.unit"),
      dataIndex: "unitId",
      width: 215,
      render: (unitId: string, row) => (
        <Space direction="vertical" size={0}>
          <span style={{ fontWeight: 600 }}>{row.kind}</span>
          <Typography.Text type="secondary" className="manager-mono" style={{ fontSize: 12 }}>
            {unitId}
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: t("galaxy.unit.route"),
      key: "route",
      width: 215,
      render: (_, row) => (
        <Space direction="vertical" size={0}>
          <span>{row.model || row.provider || "-"}</span>
          <Typography.Text type="secondary" className="manager-mono" style={{ fontSize: 12 }}>
            {row.cid || t("galaxy.unit.unplaced")}
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: t("galaxy.unit.consumer"),
      dataIndex: "consumerKey",
      width: 170,
      render: (value: string) => <span className="manager-mono">{value || "-"}</span>,
    },
    {
      title: t("galaxy.unit.state"),
      dataIndex: "state",
      width: 120,
      render: (value: string, row) => (
        <Space direction="vertical" size={0}>
          <Tag color={STATE_COLOR[value] ?? "default"}>{t(`galaxy.unit.state.${value}`)}</Tag>
          {row.attempt > 1 ? (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {t("galaxy.unit.attempt").replace("{n}", String(row.attempt))}
            </Typography.Text>
          ) : null}
        </Space>
      ),
    },
    {
      title: t("galaxy.unit.duration"),
      dataIndex: "durationMs",
      align: "right",
      width: 90,
      render: (value: number) => (value > 0 ? <span className="manager-mono">{(value / 1000).toFixed(1)}s</span> : "-"),
    },
    {
      title: t("galaxy.unit.createdAt"),
      dataIndex: "createdTime",
      width: 165,
      render: (value: string) => (value ? new Date(value).toLocaleString() : "-"),
    },
    {
      title: t("galaxy.actions"),
      key: "actions",
      width: 110,
      fixed: "right",
      render: (_, row) =>
        // 已经结束的取消不了：写一个取消标记只会在事件流上留下一条误导后来人的记录。
        canWrite && !TERMINAL_UNIT_STATES.has(row.state) ? (
          <Button type="link" size="small" danger icon={<StopOutlined />} onClick={() => setTarget(row)}>
            {t("galaxy.unit.cancel")}
          </Button>
        ) : null,
    },
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <Alert type="info" showIcon message={t("galaxy.unit.hint")} />

      <Space wrap>
        <Segmented
          value={days}
          onChange={(value) => {
            setDays(Number(value));
            setPageIndex(1);
          }}
          options={[
            { value: 1, label: t("galaxy.unit.day1") },
            { value: 7, label: t("galaxy.unit.day7") },
            { value: 30, label: t("galaxy.unit.day30") },
          ]}
        />
        <Select
          style={{ width: 150 }}
          value={state}
          onChange={(value) => {
            setState(value);
            setPageIndex(1);
          }}
          options={[
            { value: "", label: t("galaxy.unit.state.all") },
            ...STATES.map((value) => ({
              value,
              label: `${t(`galaxy.unit.state.${value}`)}${counts[value] ? ` (${counts[value]})` : ""}`,
            })),
          ]}
        />
        <Input.Search
          allowClear
          style={{ width: 280 }}
          placeholder={t("galaxy.unit.keyword")}
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

      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        {t("galaxy.unit.summary")
          .replace("{running}", String(running))
          .replace("{failed}", String(counts.failed ?? 0))
          .replace("{days}", String(page?.days ?? days))}
      </Typography.Text>

      <Table<AdminUnitView>
        rowKey="unitId"
        size="small"
        loading={loading}
        columns={columns}
        dataSource={page?.units ?? []}
        // 各列加起来 1085：常见宽度下整张表放得下，操作列（fixed right）
        // 就不会压住「提交时间」的尾巴 —— 而那一列正是排障时最要看的。
        scroll={{ x: 1085 }}
        pagination={{
          current: pageIndex,
          pageSize: PAGE_SIZE,
          total: page?.total ?? 0,
          showSizeChanger: false,
          onChange: setPageIndex,
        }}
        expandable={{
          rowExpandable: (row) => Boolean(row.errorCode || row.errorMessage || row.instance),
          expandedRowRender: (row) => (
            <Space direction="vertical" size={4} style={{ width: "100%" }}>
              {row.errorCode || row.errorMessage ? (
                <Typography.Text type="danger" style={{ fontSize: 12 }}>
                  {[row.errorClass, row.errorCode].filter(Boolean).join(" · ")}
                  {row.errorMessage ? `：${row.errorMessage}` : ""}
                </Typography.Text>
              ) : null}
              {row.instance ? (
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {`${t("galaxy.unit.instance")}：`}
                  <span className="manager-mono">{row.instance}</span>
                </Typography.Text>
              ) : null}
            </Space>
          ),
        }}
        locale={{ emptyText: <Empty description={t("galaxy.unit.empty")} /> }}
      />

      <CancelModal unit={target} onClose={() => setTarget(null)} onCancelled={load} />
    </div>
  );
}

function CancelModal({
  unit,
  onClose,
  onCancelled,
}: {
  unit: AdminUnitView | null;
  onClose: () => void;
  onCancelled: () => void;
}) {
  const { t } = useLocale();
  const [form] = Form.useForm<{ reason: string }>();
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (unit) form.setFieldsValue({ reason: "" });
  }, [unit, form]);

  const submit = async () => {
    if (!unit) return;
    const values = await form.validateFields();
    setSubmitting(true);
    try {
      await cancelUnit(unit.unitId, values.reason?.trim() ?? "");
      message.success(t("galaxy.unit.cancelled"));
      onClose();
      onCancelled();
    } catch (error) {
      message.error((error as Error).message || t("galaxy.actionFailed"));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={unit !== null}
      title={t("galaxy.unit.cancelTitle")}
      okText={t("galaxy.confirm")}
      okButtonProps={{ danger: true }}
      cancelText={t("galaxy.cancel")}
      confirmLoading={submitting}
      onOk={() => void submit()}
      onCancel={onClose}
      destroyOnClose
    >
      {/* 取消是**请求**不是命令：标记搭在节点已有的长轮询上下发，真正 abort 上游的是节点。
          说清楚这一点，运营才不会在点完之后盯着状态没变就再点五次。 */}
      <Alert type="warning" showIcon style={{ marginBottom: 16 }} message={t("galaxy.unit.cancelHint")} />
      <Form form={form} layout="vertical">
        <Form.Item name="reason" label={t("galaxy.unit.reason")} rules={[{ required: true }]}>
          <Input maxLength={200} placeholder={t("galaxy.unit.reasonPlaceholder")} />
        </Form.Item>
      </Form>
    </Modal>
  );
}
