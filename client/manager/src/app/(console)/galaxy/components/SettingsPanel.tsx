"use client";

import { ReloadOutlined, UndoOutlined } from "@ant-design/icons";
import { Alert, Button, Input, InputNumber, Popconfirm, Space, Table, Tag, Tooltip, Typography, message } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useCallback, useEffect, useState } from "react";
import { useLocale, type TranslationKey } from "@/i18n/LocaleProvider";
import { useCanWrite } from "@/components/permission/WritePermission";
import { fetchSettings, saveSetting, type AdminSettingsPage, type SettingView } from "../api/galaxy.api";

/**
 * 库里的值 → 界面上填的数，要除以多少。
 *
 * duration 型在库里一律是毫秒；credit 型是**微积分**（1,000,000 = 1 积分 = ¥1）。
 * 不换算的话，起提金额那一格会显示成 5000000 —— 而全站每一页说的都是「5 积分」。
 * 同一个数在两个地方长成两个样子，运营迟早会照着这一格去改别处。
 */
const SCALE_BY_UNIT: Record<string, number> = {
  second: 1000,
  minute: 60_000,
  hour: 3_600_000,
  day: 86_400_000,
  credit: 1_000_000,
};

/** 这一项界面上填的数要乘回多少才是库里的值。没有换算就是 1。 */
function scaleOf(row: SettingView): number {
  if (row.kind === "duration") return SCALE_BY_UNIT[row.unit] ?? 1000;
  return SCALE_BY_UNIT[row.unit] ?? 1;
}

/** 改动它会让已经发出去的同意记录全部失效，界面上要单独拦一道。 */
const CONSENT_KEYS = new Set(["terms.provider_version", "notice.consumer_version"]);

/**
 * 分组在界面上的顺序，和服务端给的顺序一致。
 *
 * 服务端的 client 分组（两个客户端安装包下载地址）**故意不在这张表里**：它们摆在
 * 「ai-bridge 版本」页顶上那张卡片里，那一页回答的就是「用户要装的东西从哪儿拿」。
 * 两处都能改，运营就得先想清楚该信哪一处。下面这个循环只画列进来的分组，
 * 所以没列 = 不显示。
 */
const GROUPS: { key: string; labelKey: TranslationKey }[] = [
  { key: "placement", labelKey: "galaxy.setting.group.placement" },
  { key: "score", labelKey: "galaxy.setting.group.score" },
  { key: "key", labelKey: "galaxy.setting.group.key" },
  { key: "artifact", labelKey: "galaxy.setting.group.artifact" },
  { key: "risk", labelKey: "galaxy.setting.group.risk" },
  { key: "payout", labelKey: "galaxy.setting.group.payout" },
  { key: "referral", labelKey: "galaxy.setting.group.referral" },
  { key: "compliance", labelKey: "galaxy.setting.group.compliance" },
];

/** 库里的字符串 → 界面上填的数。 */
function toDisplay(row: SettingView): number | string {
  if (row.kind === "text") return row.value;
  const raw = Number(row.value);
  if (Number.isNaN(raw)) return row.value;
  return raw / scaleOf(row);
}

/** 界面上填的数 → 库里的字符串。换算过的取整 —— 半个毫秒、半个微积分都没有意义。 */
function toStored(row: SettingView, value: number | string): string {
  if (row.kind === "text") return String(value);
  const raw = Number(value);
  if (Number.isNaN(raw)) return String(value);
  const scale = scaleOf(row);
  return scale === 1 ? String(raw) : String(Math.round(raw * scale));
}

/**
 * 运行参数。
 *
 * 这批值原本只在 application.properties 里：改一个起提金额要登服务器、改文件、
 * 重启进程，而重启期间在跑的请求全断。它们是**运营策略**，不是部署事实。
 *
 * 部署事实仍然留在配置文件里，而且这一页不显示它们 —— 本机地址、加密密钥、
 * 契约版本、心跳超时。前两个改了本来就要重新部署，后两个改错一次会让整池
 * 节点连不上或者集体判成离线。
 *
 * 生效不是立刻的：各进程按自己的节奏回查同一张表。顶上那句话把秒数原样说出来，
 * 否则运营改完刷新没看到效果，就会再改一遍、再改一遍。
 */
export function SettingsPanel() {
  const { t } = useLocale();
  // 这些值直接决定池子怎么跑，只读角色一律看不到入口。
  const canWrite = useCanWrite();
  const [page, setPage] = useState<AdminSettingsPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState("");
  // 正在编辑的那些：键 → 界面上填的值。没在里面的跟着服务端走。
  const [drafts, setDrafts] = useState<Record<string, number | string>>({});

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await fetchSettings();
      setPage(result);
      setDrafts({});
    } catch (error) {
      message.error((error as Error).message || t("galaxy.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const commit = async (row: SettingView, payload: { value?: string; reset?: boolean }) => {
    setSaving(row.key);
    try {
      await saveSetting({ key: row.key, ...payload });
      message.success(
        t("galaxy.setting.saved").replace("{seconds}", String(page?.propagationSeconds ?? 0)),
      );
      await load();
    } catch (error) {
      message.error((error as Error).message || t("galaxy.actionFailed"));
    } finally {
      setSaving("");
    }
  };

  const columns: ColumnsType<SettingView> = [
    {
      title: t("galaxy.setting.item"),
      dataIndex: "key",
      width: 300,
      render: (key: string) => {
        const label = t(`galaxy.setting.key.${key}` as TranslationKey);
        return (
          <Space direction="vertical" size={0}>
            <span style={{ fontWeight: 600 }}>{label === `galaxy.setting.key.${key}` ? key : label}</span>
            <Typography.Text type="secondary" className="manager-mono" style={{ fontSize: 12 }}>
              {key}
            </Typography.Text>
          </Space>
        );
      },
    },
    {
      title: t("galaxy.setting.value"),
      key: "value",
      width: 260,
      render: (_, row) => {
        const draft = drafts[row.key] ?? toDisplay(row);
        const suffix = row.unit ? t(`galaxy.setting.unit.${row.unit}` as TranslationKey) : "";
        if (row.kind === "text") {
          return (
            <Input
              disabled={!canWrite}
              value={String(draft)}
              maxLength={200}
              onChange={(event) => setDrafts((prev) => ({ ...prev, [row.key]: event.target.value }))}
            />
          );
        }
        return (
          <InputNumber
            disabled={!canWrite}
            value={Number(draft)}
            style={{ width: "100%" }}
            // 范围也要按界面单位换算：服务端给的 min/max 是库里的量纲（毫秒、微积分），
            // 而这里填的是秒、天、积分 —— 不换算的话，填一个合法的天数会被前端拦下来。
            min={row.min ? row.min / scaleOf(row) : undefined}
            max={row.max ? row.max / scaleOf(row) : undefined}
            step={row.kind === "float" ? 0.01 : 1}
            addonAfter={suffix || undefined}
            onChange={(value) => setDrafts((prev) => ({ ...prev, [row.key]: value ?? 0 }))}
          />
        );
      },
    },
    {
      title: t("galaxy.setting.state"),
      key: "state",
      width: 190,
      render: (_, row) =>
        row.overridden ? (
          <Space direction="vertical" size={0}>
            <Tag color="processing">{t("galaxy.setting.overridden")}</Tag>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {row.updatedBy || "-"}
              {row.updatedAt ? ` · ${new Date(row.updatedAt).toLocaleDateString()}` : ""}
            </Typography.Text>
          </Space>
        ) : (
          <Tooltip title={t("galaxy.setting.defaultIs").replace("{value}", row.default)}>
            <Tag>{t("galaxy.setting.fromConfig")}</Tag>
          </Tooltip>
        ),
    },
    {
      title: t("galaxy.actions"),
      key: "actions",
      width: 160,
      fixed: "right",
      render: (_, row) => {
        if (!canWrite) return null;
        const draft = drafts[row.key];
        const dirty = draft !== undefined && toStored(row, draft) !== row.value;
        const save = () => void commit(row, { value: toStored(row, draft ?? toDisplay(row)) });
        return (
          <Space size={4}>
            {/* 改条款版本会让已经发出去的同意记录全部失效，单独拦一道。 */}
            {CONSENT_KEYS.has(row.key) ? (
              <Popconfirm
                title={t("galaxy.setting.consentTitle")}
                description={t("galaxy.setting.consentHint")}
                okText={t("galaxy.confirm")}
                cancelText={t("galaxy.cancel")}
                okButtonProps={{ danger: true }}
                disabled={!dirty}
                onConfirm={save}
              >
                <Button type="link" size="small" disabled={!dirty} loading={saving === row.key}>
                  {t("galaxy.setting.save")}
                </Button>
              </Popconfirm>
            ) : (
              <Button type="link" size="small" disabled={!dirty} loading={saving === row.key} onClick={save}>
                {t("galaxy.setting.save")}
              </Button>
            )}
            <Tooltip title={t("galaxy.setting.resetHint")}>
              <Button
                type="link"
                size="small"
                icon={<UndoOutlined />}
                disabled={!row.overridden}
                onClick={() => void commit(row, { reset: true })}
              >
                {t("galaxy.setting.reset")}
              </Button>
            </Tooltip>
          </Space>
        );
      },
    },
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <Alert
        type="info"
        showIcon
        message={t("galaxy.setting.propagation").replace("{seconds}", String(page?.propagationSeconds ?? 0))}
        description={t("galaxy.setting.excluded")}
      />

      <Space>
        <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void load()}>
          {t("galaxy.refresh")}
        </Button>
      </Space>

      {GROUPS.map((group) => {
        const rows = (page?.settings ?? []).filter((row) => row.group === group.key);
        if (rows.length === 0) return null;
        return (
          <section key={group.key} className="manager-data-card" style={{ padding: 16 }}>
            <Typography.Title level={5} style={{ marginTop: 0 }}>
              {t(group.labelKey)}
            </Typography.Title>
            <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
              {t(`galaxy.setting.groupHint.${group.key}` as TranslationKey)}
            </Typography.Paragraph>
            <Table<SettingView>
              rowKey="key"
              size="small"
              loading={loading}
              columns={columns}
              dataSource={rows}
              pagination={false}
              scroll={{ x: 910 }}
            />
          </section>
        );
      })}
    </div>
  );
}
