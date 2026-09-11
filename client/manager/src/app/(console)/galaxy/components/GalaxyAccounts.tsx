"use client";

import { KeyOutlined, ReloadOutlined, SearchOutlined, StopOutlined, TeamOutlined } from "@ant-design/icons";
import {
  Alert,
  Button,
  Form,
  Input,
  Modal,
  Popconfirm,
  Segmented,
  Select,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
  message,
} from "antd";
import type { ColumnsType } from "antd/es/table";
import { useCallback, useEffect, useRef, useState } from "react";
import { useLocale } from "@/i18n/LocaleProvider";
import { useCanWrite } from "@/components/permission/WritePermission";
import {
  listGalaxyUsers,
  resetGalaxyUserPassword,
  setGalaxyUserStatus,
  setProviderType,
  type GalaxyAccountStatus,
  type GalaxyAccountView,
  type GalaxySide,
  type ProviderType,
} from "../api/galaxy.api";

const PAGE_SIZE = 20;

/** bcrypt 只看前 72 个字节，服务端超了直接拒。按字节算：一个汉字占三个。 */
const PASSWORD_MAX_BYTES = 72;

/**
 * Galaxy 账号：共享端（Nova）和使用端（Orbit）两批人。
 *
 * 和「用户管理」里的业务用户、管理端账号都不是一套，这里的人只能登录 Nova / Orbit。
 * 运营在这里能做三件事：
 *
 * - **设工作室**：注册出来一律是散户，工作室只能由运营设（这里，或者节点那一栏的机器行上）。
 * - **停用 / 启用**：停用只挡登录控制台，名下在跑的机器、发出去的算力密钥不跟着停。
 * - **重置密码**：没有自助找回，忘了密码只能找运营。重置出来的是临时密码，本人下次登录必须先改掉。
 */
export function GalaxyAccounts({
  refreshKey = 0,
  onProviderTypeChange,
}: {
  /** 节点那一栏改了身份时由外面加一，这边跟着重拉。 */
  refreshKey?: number;
  onProviderTypeChange?: () => void;
}) {
  const { t } = useLocale();
  // 停用会把人踢下线，重置密码等于让运营握着一串能登进去的密码 —— 只读角色一律看不到入口。
  const canWrite = useCanWrite();
  const [side, setSide] = useState<GalaxySide>("provider");
  const [keyword, setKeyword] = useState("");
  const [status, setStatus] = useState<GalaxyAccountStatus | "">("");
  const [providerType, setProviderTypeFilter] = useState<ProviderType | "">("");
  const [pageIndex, setPageIndex] = useState(1);
  const [rows, setRows] = useState<GalaxyAccountView[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  // 目标和开关分开存：关弹窗时目标不清，否则关闭动画那几百毫秒里提示语上的名字先没了。
  const [passwordTarget, setPasswordTarget] = useState<GalaxyAccountView | null>(null);
  const [passwordOpen, setPasswordOpen] = useState(false);
  // 只认最后一次请求：连着打字或者来回切端时，先发的那次可能后回来，把另一端的人填进表里。
  const latest = useRef(0);

  const load = useCallback(async () => {
    const seq = ++latest.current;
    setLoading(true);
    try {
      const page = await listGalaxyUsers({
        side,
        keyword,
        status,
        providerType,
        offset: (pageIndex - 1) * PAGE_SIZE,
        limit: PAGE_SIZE,
      });
      if (seq !== latest.current) return;
      const list = page.list ?? [];
      // 停用、改身份之后，这一行可能不再满足筛选；最后一页因此空掉时退回到还有数据的那一页。
      const lastPage = Math.max(1, Math.ceil(page.total / PAGE_SIZE));
      if (list.length === 0 && pageIndex > lastPage) {
        setPageIndex(lastPage);
        return;
      }
      setRows(list);
      setTotal(page.total);
    } catch (error) {
      if (seq !== latest.current) return;
      message.error((error as Error).message || t("galaxy.loadFailed"));
    } finally {
      if (seq === latest.current) setLoading(false);
    }
  }, [side, keyword, status, providerType, pageIndex, t]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  // 身份挂在账号上，名下机器一起变，所以节点那一栏也要重拉。
  const changeProviderType = async (row: GalaxyAccountView, next: ProviderType) => {
    try {
      await setProviderType(row.id, next);
      message.success(t("galaxy.provider.saved"));
      void load();
      onProviderTypeChange?.();
    } catch (error) {
      message.error((error as Error).message || t("galaxy.actionFailed"));
    }
  };

  const changeStatus = async (row: GalaxyAccountView, next: GalaxyAccountStatus) => {
    try {
      await setGalaxyUserStatus(row.id, next);
      message.success(t("galaxy.account.statusSaved"));
      void load();
    } catch (error) {
      message.error((error as Error).message || t("galaxy.actionFailed"));
    }
  };

  const columns: ColumnsType<GalaxyAccountView> = [
    {
      title: t("galaxy.account.account"),
      dataIndex: "username",
      width: 180,
      render: (username: string, row) => (
        <Space direction="vertical" size={0}>
          <span style={{ fontWeight: 600 }}>{row.displayName || username}</span>
          {row.displayName && row.displayName !== username ? (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {username}
            </Typography.Text>
          ) : null}
        </Space>
      ),
    },
    {
      title: t("galaxy.account.id"),
      dataIndex: "id",
      width: 240,
      render: (id: string) => <span className="manager-mono">{id}</span>,
    },
    {
      title: t("galaxy.account.providerType"),
      dataIndex: "providerType",
      width: 90,
      // 使用端没有散户 / 工作室之分。
      hidden: side !== "provider",
      render: (value?: ProviderType) =>
        value === "studio" ? (
          <Tag color="geekblue">{t("galaxy.provider.studio")}</Tag>
        ) : (
          <Tag>{t("galaxy.provider.individual")}</Tag>
        ),
    },
    {
      title: t("galaxy.account.status"),
      dataIndex: "status",
      width: 190,
      render: (value: GalaxyAccountStatus, row) => (
        <Space size={4} wrap>
          {value === "disabled" ? (
            <Tag color="error">{t("galaxy.account.status.disabled")}</Tag>
          ) : (
            <Tag color="success">{t("galaxy.account.status.active")}</Tag>
          )}
          {/* 临时密码没改掉之前，这个人登录进去除了改密码什么都干不了，列表上得看得出来。 */}
          {row.mustChangePassword ? (
            <Tooltip title={t("galaxy.account.mustChangePasswordHint")}>
              <Tag color="warning">{t("galaxy.account.mustChangePassword")}</Tag>
            </Tooltip>
          ) : null}
        </Space>
      ),
    },
    {
      title: t("galaxy.account.createdAt"),
      dataIndex: "createdAt",
      width: 170,
      render: (value: string) => (value ? new Date(value).toLocaleString() : "-"),
    },
    {
      title: t("galaxy.account.lastLoginAt"),
      dataIndex: "lastLoginAt",
      width: 170,
      render: (value?: string) => (value ? new Date(value).toLocaleString() : "-"),
    },
    {
      title: t("galaxy.actions"),
      key: "actions",
      width: 320,
      render: (_, row) => {
        if (!canWrite) {
          return null;
        }
        const toStudio = row.providerType !== "studio";
        const disabling = row.status !== "disabled";
        return (
          <Space size={6} wrap>
            {row.side === "provider" ? (
              <Popconfirm
                title={toStudio ? t("galaxy.provider.toStudio") : t("galaxy.provider.toIndividual")}
                description={
                  <div style={{ maxWidth: 300 }}>
                    {toStudio ? t("galaxy.provider.toStudioHint") : t("galaxy.provider.toIndividualHint")}
                  </div>
                }
                okText={t("galaxy.confirm")}
                cancelText={t("galaxy.cancel")}
                onConfirm={() => void changeProviderType(row, toStudio ? "studio" : "individual")}
              >
                <Button size="small" icon={<TeamOutlined />}>
                  {toStudio ? t("galaxy.provider.toStudio") : t("galaxy.provider.toIndividual")}
                </Button>
              </Popconfirm>
            ) : null}
            <Popconfirm
              title={disabling ? t("galaxy.account.disable") : t("galaxy.account.enable")}
              description={
                <div style={{ maxWidth: 300 }}>
                  {disabling ? t("galaxy.account.disableHint") : t("galaxy.account.enableHint")}
                </div>
              }
              okText={t("galaxy.confirm")}
              cancelText={t("galaxy.cancel")}
              onConfirm={() => void changeStatus(row, disabling ? "disabled" : "active")}
            >
              <Button size="small" danger={disabling} icon={<StopOutlined />}>
                {disabling ? t("galaxy.account.disable") : t("galaxy.account.enable")}
              </Button>
            </Popconfirm>
            <Button
              size="small"
              icon={<KeyOutlined />}
              onClick={() => {
                setPasswordTarget(row);
                setPasswordOpen(true);
              }}
            >
              {t("galaxy.account.resetPassword")}
            </Button>
          </Space>
        );
      },
    },
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div className="manager-toolbar">
        {/* 两端是两批人，混在一张表里翻没有意义，所以是切换而不是筛选。换端时关键字和状态留着：
            同一个用户名在两端可以各有一个账号，运营常要两边都查一眼。 */}
        <Segmented<GalaxySide>
          value={side}
          onChange={(value) => {
            setSide(value);
            setPageIndex(1);
          }}
          options={[
            { value: "provider", label: t("galaxy.account.side.provider") },
            { value: "consumer", label: t("galaxy.account.side.consumer") },
          ]}
        />
        <Input
          allowClear
          className="manager-filter-input"
          style={{ maxWidth: 300 }}
          prefix={<SearchOutlined />}
          placeholder={t("galaxy.account.keyword")}
          value={keyword}
          onChange={(event) => {
            setKeyword(event.target.value);
            setPageIndex(1);
          }}
        />
        <Select<GalaxyAccountStatus | "">
          className="manager-filter-input"
          style={{ minWidth: 120 }}
          value={status}
          onChange={(value) => {
            setStatus(value);
            setPageIndex(1);
          }}
          options={[
            { value: "", label: t("galaxy.account.status.all") },
            { value: "active", label: t("galaxy.account.status.active") },
            { value: "disabled", label: t("galaxy.account.status.disabled") },
          ]}
        />
        {side === "provider" ? (
          <Select<ProviderType | "">
            className="manager-filter-input"
            style={{ minWidth: 120 }}
            value={providerType}
            onChange={(value) => {
              setProviderTypeFilter(value);
              setPageIndex(1);
            }}
            options={[
              { value: "", label: t("galaxy.account.providerType.all") },
              { value: "individual", label: t("galaxy.provider.individual") },
              { value: "studio", label: t("galaxy.provider.studio") },
            ]}
          />
        ) : null}
        <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void load()}>
          {t("galaxy.refresh")}
        </Button>
      </div>

      <Table<GalaxyAccountView>
        rowKey="id"
        size="small"
        loading={loading}
        columns={columns}
        dataSource={rows}
        locale={{ emptyText: t("galaxy.account.empty") }}
        pagination={{
          current: pageIndex,
          pageSize: PAGE_SIZE,
          total,
          showSizeChanger: false,
          onChange: (next) => setPageIndex(next),
        }}
        scroll={{ x: 1300 }}
      />

      <ResetPasswordModal
        account={passwordTarget}
        open={passwordOpen}
        onClose={() => setPasswordOpen(false)}
        onDone={load}
      />
    </div>
  );
}

function ResetPasswordModal({
  account,
  open,
  onClose,
  onDone,
}: {
  account: GalaxyAccountView | null;
  open: boolean;
  onClose: () => void;
  onDone: () => void;
}) {
  const { t } = useLocale();
  const [form] = Form.useForm<{ password: string }>();
  const [submitting, setSubmitting] = useState(false);

  // 每次打开都清空：表单实例比弹窗活得长，不清的话上一个人的临时密码会原样出现在下一个人的框里。
  useEffect(() => {
    if (open) form.resetFields();
  }, [open, form]);

  const submit = async () => {
    if (!account) return;
    const values = await form.validateFields();
    setSubmitting(true);
    try {
      await resetGalaxyUserPassword(account.id, values.password);
      message.success(t("galaxy.account.passwordReset"));
      onClose();
      // 重拉一次，「待改临时密码」的标记要出现在这一行上。
      onDone();
    } catch (error) {
      message.error((error as Error).message || t("galaxy.actionFailed"));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={open}
      title={t("galaxy.account.resetPassword")}
      okText={t("galaxy.confirm")}
      cancelText={t("galaxy.cancel")}
      confirmLoading={submitting}
      onOk={() => void submit()}
      onCancel={onClose}
      destroyOnClose
    >
      <Alert
        type="warning"
        showIcon
        style={{ marginBottom: 16 }}
        message={t("galaxy.account.resetPasswordHint").replace("{name}", account?.displayName || account?.username || "")}
      />
      <Form form={form} layout="vertical">
        <Form.Item
          name="password"
          label={t("galaxy.account.newPassword")}
          extra={t("galaxy.account.passwordRule")}
          rules={[
            { required: true, min: 8, message: t("galaxy.account.passwordTooShort") },
            {
              validator: (_, value?: string) =>
                new TextEncoder().encode(value ?? "").length > PASSWORD_MAX_BYTES
                  ? Promise.reject(new Error(t("galaxy.account.passwordTooLong")))
                  : Promise.resolve(),
            },
          ]}
        >
          {/* new-password：别让浏览器把运营自己的管理端密码自动填进来。 */}
          <Input.Password autoComplete="new-password" />
        </Form.Item>
      </Form>
    </Modal>
  );
}
