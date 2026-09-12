"use client";

import { EyeOutlined, ReloadOutlined, SearchOutlined } from "@ant-design/icons";
import { Alert, Button, Input, Modal, Select, Space, Table, Tag, Tooltip, Typography, message } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useCallback, useEffect, useRef, useState } from "react";
import { useLocale } from "@/i18n/LocaleProvider";
import { useCanWrite } from "@/components/permission/WritePermission";
import { fetchAdminKeys, revealAdminKey, type AdminKeyView, type KeySecretView } from "../api/galaxy.api";

const PAGE_SIZE = 20;

const STATUS_COLORS: Record<string, string> = { active: "success", expired: "warning", frozen: "warning", revoked: "error" };

/** 1.21M / 316k。token 这种大基数要一眼读出量级。 */
function compact(value: number): string {
  if (Math.abs(value) >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (Math.abs(value) >= 10_000) return `${Math.round(value / 1000)}k`;
  return value.toLocaleString("en-US");
}

/**
 * 转交给使用者的那一段文字：地址 + 密钥，再附上两个客户端各自怎么填。
 * Claude Code 填主机根（SDK 自己拼 /v1/messages），Codex 的 base_url 要带 /v1 —— 这是最常被填错的一步。
 */
function handoverText(secret: KeySecretView, t: (key: string) => string): string {
  const base = secret.baseUrl.replace(/\/+$/, "");
  if (!base) return `${t("galaxy.keys.handoverKey")}：${secret.secret}`;
  const api = base.endsWith("/v1") ? base : `${base}/v1`;
  return [
    `${t("galaxy.keys.handoverBase")}：${api}`,
    `${t("galaxy.keys.handoverKey")}：${secret.secret}`,
    "",
    "Claude Code（~/.claude/settings.json 的 env）",
    `ANTHROPIC_BASE_URL=${api.replace(/\/v1$/, "")}`,
    `ANTHROPIC_AUTH_TOKEN=${secret.secret}`,
    "",
    "Codex（~/.codex/config.toml）",
    'model_provider = "galaxy"',
    "[model_providers.galaxy]",
    'name = "Galaxy"',
    `base_url = "${api}"`,
    'wire_api = "responses"',
    `experimental_bearer_token = "${secret.secret}"`,
  ].join("\n");
}

async function copy(value: string, t: (key: string) => string) {
  try {
    await navigator.clipboard.writeText(value);
    message.success(t("galaxy.keys.copied"));
  } catch {
    // 管理端跑在 http 上时浏览器不给剪贴板权限：明文就在弹框里，手动选中复制。
    message.warning(t("galaxy.keys.copyManually"));
  }
}

/**
 * 全站算力密钥。
 *
 * 运营在这里随时看得到任何一把密钥的明文，连同接入地址一起转交给使用者。明文不跟着列表下发：
 * 点「查看密钥」那一下才取，取的接口只授给有写权限的角色（只读角色只授 GET）。
 *
 * 取不回明文的有两种：密钥签发于平台开始保存明文之前（只存了哈希）—— 让本人换发一把；
 * 或者 manager-api 和 galaxy-api 配的 galaxy.key_cipher_secret 不一致 —— 弹框里会直接说。
 */
export function ConsumerKeyList() {
  const { t } = useLocale();
  const canWrite = useCanWrite();
  const [keyword, setKeyword] = useState("");
  const [status, setStatus] = useState("");
  const [pageIndex, setPageIndex] = useState(1);
  const [rows, setRows] = useState<AdminKeyView[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [revealing, setRevealing] = useState("");
  const [shown, setShown] = useState<{ key: AdminKeyView; secret: KeySecretView } | null>(null);
  const latest = useRef(0);

  const load = useCallback(async () => {
    const seq = ++latest.current;
    setLoading(true);
    try {
      const page = await fetchAdminKeys({ keyword, status, offset: (pageIndex - 1) * PAGE_SIZE, limit: PAGE_SIZE });
      if (seq !== latest.current) return;
      setRows(page.keys ?? []);
      setTotal(page.total);
    } catch (error) {
      if (seq !== latest.current) return;
      message.error((error as Error).message || t("galaxy.loadFailed"));
    } finally {
      if (seq === latest.current) setLoading(false);
    }
  }, [keyword, status, pageIndex, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const reveal = async (row: AdminKeyView) => {
    setRevealing(row.keyId);
    try {
      setShown({ key: row, secret: await revealAdminKey(row.keyId) });
    } catch (error) {
      message.error((error as Error).message || t("galaxy.actionFailed"));
    } finally {
      setRevealing("");
    }
  };

  const columns: ColumnsType<AdminKeyView> = [
    {
      title: t("galaxy.keys.key"),
      dataIndex: "keyId",
      width: 240,
      render: (keyId: string, row) => (
        <Space direction="vertical" size={0}>
          <span style={{ fontWeight: 600 }}>{row.alias || keyId}</span>
          <Typography.Text type="secondary" className="manager-mono" style={{ fontSize: 12 }}>
            {keyId}
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: t("galaxy.keys.owner"),
      dataIndex: "ownerUserId",
      width: 220,
      render: (ownerUserId: string, row) => (
        <Space direction="vertical" size={0}>
          <span>{row.ownerName || <span className="manager-mono">{ownerUserId}</span>}</span>
          {row.ownerName ? (
            <Typography.Text type="secondary" className="manager-mono" style={{ fontSize: 12 }}>
              {ownerUserId}
            </Typography.Text>
          ) : null}
        </Space>
      ),
    },
    {
      title: t("galaxy.keys.category"),
      dataIndex: "category",
      width: 150,
      render: (category: string, row) => (
        <Space direction="vertical" size={0}>
          <Tag>{t(`galaxy.keys.category.${category || "other"}`)}</Tag>
          {row.modelId ? (
            <Typography.Text type="secondary" className="manager-mono" style={{ fontSize: 12 }}>
              {row.modelId}
            </Typography.Text>
          ) : null}
        </Space>
      ),
    },
    {
      title: t("galaxy.keys.status"),
      dataIndex: "status",
      width: 90,
      render: (value: string) => <Tag color={STATUS_COLORS[value] ?? "default"}>{t(`galaxy.keys.status.${value}`)}</Tag>,
    },
    {
      title: t("galaxy.keys.balance"),
      dataIndex: "balance",
      width: 130,
      align: "right",
      // 头条只看输出 token：计费按它走，把输入加进来是一个谁都用不上的大数。
      render: (balance: Record<string, number>) => {
        const value = balance?.["llm.output_tokens"] ?? Object.values(balance ?? {})[0] ?? 0;
        return <span className="manager-mono">{compact(value)}</span>;
      },
    },
    {
      title: t("galaxy.keys.expiresAt"),
      dataIndex: "expiresAt",
      width: 170,
      render: (value: string) => (value ? new Date(value).toLocaleString() : "-"),
    },
    {
      title: t("galaxy.actions"),
      key: "actions",
      width: 130,
      render: (_, row) => {
        if (!canWrite) return null;
        if (!row.revealable) {
          return (
            <Tooltip title={t("galaxy.keys.notRevealable")}>
              <Button size="small" icon={<EyeOutlined />} disabled>
                {t("galaxy.keys.reveal")}
              </Button>
            </Tooltip>
          );
        }
        return (
          <Button size="small" icon={<EyeOutlined />} loading={revealing === row.keyId} onClick={() => void reveal(row)}>
            {t("galaxy.keys.reveal")}
          </Button>
        );
      },
    },
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <Space wrap>
        <Input.Search
          allowClear
          style={{ width: 300 }}
          placeholder={t("galaxy.keys.keyword")}
          enterButton={<SearchOutlined />}
          onSearch={(value) => {
            setKeyword(value);
            setPageIndex(1);
          }}
        />
        <Select
          style={{ width: 140 }}
          value={status}
          onChange={(value) => {
            setStatus(value);
            setPageIndex(1);
          }}
          options={[
            { value: "", label: t("galaxy.keys.status.all") },
            ...["active", "expired", "frozen", "revoked"].map((value) => ({ value, label: t(`galaxy.keys.status.${value}`) })),
          ]}
        />
        <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void load()}>
          {t("galaxy.refresh")}
        </Button>
      </Space>

      <Table<AdminKeyView>
        rowKey="keyId"
        size="small"
        loading={loading}
        columns={columns}
        dataSource={rows}
        locale={{ emptyText: t("galaxy.keys.empty") }}
        pagination={{ current: pageIndex, pageSize: PAGE_SIZE, total, showSizeChanger: false, onChange: setPageIndex }}
        scroll={{ x: 1150 }}
      />

      <Modal
        open={Boolean(shown)}
        title={t("galaxy.keys.revealTitle").replace("{alias}", shown?.key.alias || shown?.key.keyId || "")}
        onCancel={() => setShown(null)}
        footer={[
          <Button key="close" onClick={() => setShown(null)}>
            {t("galaxy.keys.close")}
          </Button>,
          <Button key="copy" type="primary" onClick={() => shown && void copy(handoverText(shown.secret, t), t)}>
            {t("galaxy.keys.copyHandover")}
          </Button>,
        ]}
        width={640}
        destroyOnClose
      >
        {shown ? (
          <Space direction="vertical" size={12} style={{ display: "flex" }}>
            <Typography.Text type="secondary">
              {shown.key.ownerName || shown.key.ownerUserId} · <span className="manager-mono">{shown.key.keyId}</span>
            </Typography.Text>
            <Space.Compact style={{ width: "100%" }}>
              <Input readOnly className="manager-mono" value={shown.secret.secret} />
              <Button onClick={() => void copy(shown.secret.secret, t)}>{t("galaxy.keys.copyKey")}</Button>
            </Space.Compact>
            {shown.secret.baseUrl ? (
              <Space.Compact style={{ width: "100%" }}>
                <Input readOnly className="manager-mono" value={shown.secret.baseUrl} />
                <Button onClick={() => void copy(shown.secret.baseUrl, t)}>{t("galaxy.keys.copyBase")}</Button>
              </Space.Compact>
            ) : (
              <Alert type="warning" showIcon message={t("galaxy.keys.noBaseUrl")} />
            )}
            <Input.TextArea readOnly autoSize={{ minRows: 4, maxRows: 16 }} className="manager-mono" value={handoverText(shown.secret, t)} />
            <Alert type="info" showIcon message={t("galaxy.keys.revealHint")} />
          </Space>
        ) : null}
      </Modal>
    </div>
  );
}
