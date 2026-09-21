"use client";

import {
  CloudUploadOutlined,
  EditOutlined,
  FileTextOutlined,
  FileZipOutlined,
  InboxOutlined,
  ReloadOutlined,
  UndoOutlined,
} from "@ant-design/icons";
import {
  Alert,
  Button,
  Form,
  Input,
  Modal,
  Popconfirm,
  Progress,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
  Upload,
  message,
} from "antd";
import type { ColumnsType } from "antd/es/table";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useLocale, type TranslationKey } from "@/i18n/LocaleProvider";
import { useCanWrite } from "@/components/permission/WritePermission";
import {
  fetchBridgeReleases,
  saveSetting,
  setBridgeReleaseStatus,
  uploadBridgeRelease,
  type AdminBridgeReleasePage,
  type BridgeReleaseStatus,
  type BridgeReleaseView,
  type ClientDownloadSlot,
} from "../api/galaxy.api";

/**
 * 平台名和顺序都照契约：与 ai-bridge-native/scripts/build-cli.cjs 的 TARGETS 一致，
 * 也是公开清单里平台的固定顺序。表格和「各平台当前最新」都按它排，运营对照清单时不用来回找。
 */
const PLATFORMS = ["linux-x64", "linux-arm64", "darwin-arm64", "darwin-x64", "windows-x64", "windows-arm64"];

/**
 * 包名 ai-bridge-<版本>-<平台>.<扩展名>。版本号自己可以带「-」（0.2.0-beta.1），平台名里也有「-」，
 * 按「-」切是切不开的；所以平台按枚举从尾巴上认，前面剩下的整段才是版本。
 */
const ARCHIVE_NAME = new RegExp(`^ai-bridge-(.+)-(${PLATFORMS.join("|")})\\.(tar\\.gz|zip)$`);

/** 契约里的版本号正则。 */
const VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

/** Ed25519 签名固定 64 字节，标准 base64 带填充正好 88 个字符。 */
const SIGNATURE = /^[A-Za-z0-9+/]{86}==$/;

/** 与服务端的包大小上限一致。前端先挡一道：超了的包 base64 之后还要再大三分之一，传完才被拒是白等。 */
const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;

/** 真正的 .sig 就一行 88 个字符；大得多的一定是拿错了文件，别往文本框里灌。 */
const MAX_SIGNATURE_FILE_BYTES = 1024;

/**
 * 契约的版本比较：先比三段数字；数字相同时没有预发布后缀的更大；两个都有后缀按字符串比。
 * 节点和服务端都照这个比。换成 localeCompare 或者按段比后缀，「当前最新」就会和节点实际升级到的版本对不上。
 */
function compareVersions(a: string, b: string) {
  const split = (version: string) => {
    const dash = version.indexOf("-");
    const core = dash < 0 ? version : version.slice(0, dash);
    return {
      numbers: core.split(".").map((part) => Number.parseInt(part, 10) || 0),
      suffix: dash < 0 ? "" : version.slice(dash + 1),
    };
  };
  const left = split(a);
  const right = split(b);
  for (let index = 0; index < 3; index += 1) {
    const diff = (left.numbers[index] ?? 0) - (right.numbers[index] ?? 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  if (left.suffix === right.suffix) return 0;
  if (!left.suffix) return 1;
  if (!right.suffix) return -1;
  return left.suffix > right.suffix ? 1 : -1;
}

function platformRank(platform: string) {
  const rank = PLATFORMS.indexOf(platform);
  return rank < 0 ? PLATFORMS.length : rank;
}

/** 每个平台版本最高的已发布包 —— 也就是清单里给出、节点会升级到的那一个。 */
function latestPublished(rows: BridgeReleaseView[]) {
  const latest = new Map<string, BridgeReleaseView>();
  for (const row of rows) {
    if (row.status !== "published") continue;
    const current = latest.get(row.platform);
    if (!current || compareVersions(row.version, current.version) > 0) {
      latest.set(row.platform, row);
    }
  }
  return latest;
}

/** 文案里的 {name} 占位符。 */
function fill(template: string, values: Record<string, string>) {
  return template.replace(/\{(\w+)\}/g, (whole, key: string) => values[key] ?? whole);
}

function formatSize(bytes: number) {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

function isSignatureFile(file: File) {
  return file.name.toLowerCase().endsWith(".sig");
}

/** 整个包读成标准 base64。readAsDataURL 出来是 data:<类型>;base64,<内容>，逗号前面那截不是包的内容。 */
function readAsBase64(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      resolve(result.slice(result.indexOf(",") + 1));
    };
    reader.onerror = () => reject(reader.error ?? new Error("read failed"));
    reader.readAsDataURL(file);
  });
}

/** sha256 和签名太长，表里只放开头一截；复制拿到的是完整值，对照 sha256sum 输出或 .sig 文件时用。 */
function Digest({ value }: { value: string }) {
  if (!value) return <span>-</span>;
  return (
    <Typography.Text className="manager-mono" style={{ fontSize: 12 }} copyable={{ text: value }}>
      <Tooltip title={<span className="manager-mono" style={{ wordBreak: "break-all" }}>{value}</span>}>
        <span>{value.length > 12 ? `${value.slice(0, 12)}…` : value}</span>
      </Tooltip>
    </Typography.Text>
  );
}

/**
 * ai-bridge 发布包。
 *
 * 运营在这里上传、下架、重新上架命令行版 ai-bridge 的安装包。几条要紧的语义：
 *
 * - **节点只升级到本平台最新的已发布版本**，而且不降级。所以要紧的不只是列表，更是每个平台
 *   「现在最新的是哪一版」—— 表格上面单独列一行。
 * - **包必须带发布签名**。签名离线生成，服务端收包时验一遍，节点装之前再验一遍；
 *   Hub 下发的地址和 sha256 都不单独可信。
 * - **下架不是删除**：包还在，随时能重新上架；已经装上它的机器不受影响。
 * - 同一版本 + 平台已经发布时不能再传，要先下架；已下架的再传会覆盖那一份。
 */
export function BridgeReleases() {
  const { t } = useLocale();
  // 发布和下架决定全网节点升级到哪一版，只读角色一律看不到入口。
  const canWrite = useCanWrite();
  const [page, setPage] = useState<AdminBridgeReleasePage | null>(null);
  const [loading, setLoading] = useState(true);
  // 拉成功过一次才画「各平台当前最新」：没拉回来之前画出来是一排「无」，那是假话。
  const [loaded, setLoaded] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setPage(await fetchBridgeReleases());
      setLoaded(true);
    } catch (error) {
      message.error((error as Error).message || t("galaxy.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  // ?? [] 是护栏：Go 那边一个包都没有时，空切片可能编成 null。
  // 引用要稳住 —— 下面几个 useMemo 都按它做依赖，每次渲染换一个新数组等于白 memo。
  const rows = useMemo(() => page?.releases ?? [], [page]);

  // 服务端已经是版本新的在前；这里按契约的比较规则再排一遍，同一版本内按清单的平台顺序。
  // sort 是稳定的，比不出先后的行保持服务端给的顺序。
  const sorted = useMemo(
    () =>
      [...rows].sort(
        (a, b) => compareVersions(b.version, a.version) || platformRank(a.platform) - platformRank(b.platform),
      ),
    [rows],
  );
  const latest = useMemo(() => latestPublished(rows), [rows]);

  const changeStatus = async (row: BridgeReleaseView, status: BridgeReleaseStatus) => {
    try {
      await setBridgeReleaseStatus(row.releaseId, status);
      message.success(t("galaxy.bridge.statusSaved"));
      void load();
    } catch (error) {
      message.error((error as Error).message || t("galaxy.actionFailed"));
    }
  };

  /** 下架前把后果说清楚：下的要是这个平台当前最新的那一版，节点的升级目标会跟着变。 */
  const withdrawHint = (row: BridgeReleaseView) => {
    const current = latest.get(row.platform);
    if (current && current.releaseId !== row.releaseId) {
      return fill(t("galaxy.bridge.withdrawHint"), { platform: row.platform, latest: current.version });
    }
    const fallback = latestPublished(rows.filter((item) => item.releaseId !== row.releaseId)).get(row.platform);
    return fallback
      ? fill(t("galaxy.bridge.withdrawLatestHint"), { platform: row.platform, fallback: fallback.version })
      : fill(t("galaxy.bridge.withdrawLastHint"), { platform: row.platform });
  };

  /** 重新上架的版本比当前最新的还新，就会直接变成这个平台的升级目标。 */
  const republishHint = (row: BridgeReleaseView) => {
    const current = latest.get(row.platform);
    return current && compareVersions(row.version, current.version) <= 0
      ? fill(t("galaxy.bridge.republishHint"), { platform: row.platform, latest: current.version })
      : fill(t("galaxy.bridge.republishLatestHint"), { platform: row.platform });
  };

  const columns: ColumnsType<BridgeReleaseView> = [
    {
      title: t("galaxy.bridge.version"),
      dataIndex: "version",
      width: 120,
      render: (version: string) => (
        <span className="manager-mono" style={{ fontWeight: 600 }}>
          {version}
        </span>
      ),
    },
    {
      title: t("galaxy.bridge.platform"),
      dataIndex: "platform",
      width: 130,
      render: (platform: string) => <span className="manager-mono">{platform}</span>,
    },
    {
      title: t("galaxy.bridge.file"),
      dataIndex: "fileName",
      width: 330,
      render: (fileName: string, row) => (
        <Space direction="vertical" size={0}>
          <span className="manager-mono" style={{ fontSize: 13 }}>
            {fileName}
          </span>
          <Tooltip title={`${row.size.toLocaleString()} B`}>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {formatSize(row.size)}
            </Typography.Text>
          </Tooltip>
        </Space>
      ),
    },
    {
      title: "sha256",
      dataIndex: "sha256",
      width: 160,
      render: (sha256: string) => <Digest value={sha256} />,
    },
    {
      title: t("galaxy.bridge.signature"),
      dataIndex: "signature",
      width: 160,
      render: (signature: string) => <Digest value={signature} />,
    },
    {
      title: t("galaxy.bridge.status"),
      dataIndex: "status",
      width: 170,
      render: (status: BridgeReleaseStatus, row) => (
        <Space size={4} wrap>
          {status === "published" ? (
            <Tag color="success">{t("galaxy.bridge.published")}</Tag>
          ) : (
            <Tag>{t("galaxy.bridge.withdrawn")}</Tag>
          )}
          {latest.get(row.platform)?.releaseId === row.releaseId ? (
            <Tooltip title={t("galaxy.bridge.latestTip")}>
              <Tag color="processing">{t("galaxy.bridge.latest")}</Tag>
            </Tooltip>
          ) : null}
        </Space>
      ),
    },
    {
      title: t("galaxy.bridge.publishedBy"),
      dataIndex: "publishedBy",
      width: 120,
      render: (value: string) => value || "-",
    },
    {
      title: t("galaxy.bridge.publishedAt"),
      dataIndex: "publishedAt",
      width: 170,
      render: (value?: string) => (value ? new Date(value).toLocaleString() : "-"),
    },
    {
      title: t("galaxy.bridge.notes"),
      dataIndex: "notes",
      width: 220,
      ellipsis: { showTitle: false },
      // 说明可能有好几行，悬停时按原样换行给全文。
      render: (notes: string) =>
        notes ? (
          <Tooltip placement="topLeft" title={<div style={{ whiteSpace: "pre-wrap" }}>{notes}</div>}>
            {notes}
          </Tooltip>
        ) : (
          "-"
        ),
    },
    {
      title: t("galaxy.actions"),
      key: "actions",
      width: 110,
      hidden: !canWrite,
      render: (_, row) => {
        const withdrawing = row.status === "published";
        return (
          <Popconfirm
            title={withdrawing ? t("galaxy.bridge.withdraw") : t("galaxy.bridge.republish")}
            description={<div style={{ maxWidth: 320 }}>{withdrawing ? withdrawHint(row) : republishHint(row)}</div>}
            okText={t("galaxy.confirm")}
            cancelText={t("galaxy.cancel")}
            onConfirm={() => void changeStatus(row, withdrawing ? "withdrawn" : "published")}
          >
            <Button size="small" danger={withdrawing}>
              {withdrawing ? t("galaxy.bridge.withdraw") : t("galaxy.bridge.republish")}
            </Button>
          </Popconfirm>
        );
      },
    },
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <ClientDownloadCard page={page} canWrite={canWrite} onSaved={() => void load()} />

      <Space>
        {canWrite ? (
          <Button type="primary" icon={<CloudUploadOutlined />} onClick={() => setUploadOpen(true)}>
            {t("galaxy.bridge.upload")}
          </Button>
        ) : null}
        <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void load()}>
          {t("galaxy.refresh")}
        </Button>
      </Space>

      {/* 节点点「升级」时拿的就是这一行里本平台的版本；空着的平台只会得到「还没有适用于 xx 的安装包」。 */}
      {loaded ? (
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6 }}>
          <Typography.Text type="secondary">{t("galaxy.bridge.latestSummary")}</Typography.Text>
          {PLATFORMS.map((platform) => {
            const current = latest.get(platform);
            return current ? (
              <Tag key={platform} color="processing" style={{ marginInlineEnd: 0 }}>
                <span className="manager-mono">{platform}</span> <b>{current.version}</b>
              </Tag>
            ) : (
              <Tooltip key={platform} title={t("galaxy.bridge.latestNoneTip")}>
                <Tag style={{ marginInlineEnd: 0 }}>
                  <span className="manager-mono">{platform}</span> {t("galaxy.bridge.latestNone")}
                </Tag>
              </Tooltip>
            );
          })}
        </div>
      ) : null}

      <Table<BridgeReleaseView>
        rowKey="releaseId"
        size="small"
        loading={loading}
        columns={columns}
        dataSource={sorted}
        locale={{ emptyText: t("galaxy.bridge.empty") }}
        // 一页 30 行 = 五个版本 × 六个平台，平台发齐的时候同一个版本不会被拆到两页。
        pagination={{ pageSize: 30, showSizeChanger: false }}
        scroll={{ x: 1690 }}
      />

      {canWrite ? (
        <UploadReleaseModal
          open={uploadOpen}
          releases={rows}
          onClose={() => setUploadOpen(false)}
          onUploaded={() => void load()}
        />
      ) : null}
    </div>
  );
}

/**
 * 和服务端同一条规矩：只收 http(s) 的完整地址。
 *
 * 前端这一道是为了省一趟往返（填成文件名、内网路径、一句说明当场就看得出），
 * **不是**那道门 —— 真正的校验在 service/galaxy 的 applyURL 里，保存接口和
 * 进程回查都走它。
 */
function isDownloadURL(value: string) {
  try {
    const parsed = new URL(value.trim());
    return (parsed.protocol === "http:" || parsed.protocol === "https:") && parsed.host !== "";
  } catch {
    return false;
  }
}

/**
 * 平台 → 那一行的标题。空串是通用下载页。
 *
 * 行是服务端排的（dto.DesktopPlatforms），这里只负责取标题：表里没有的平台
 * 照原样显示平台名，而不是画一行没有标题的空格子 —— 服务端加了平台、界面还没跟上时，
 * 运营至少看得出那一行是干什么的。
 */
const CLIENT_PLATFORM_LABELS: Record<string, TranslationKey> = {
  "": "galaxy.bridge.clientPlatformAny",
  windows: "galaxy.bridge.clientPlatformWindows",
  "mac-x64": "galaxy.bridge.clientPlatformMacX64",
  "mac-arm64": "galaxy.bridge.clientPlatformMacArm64",
};

/**
 * 两个桌面客户端的安装包下载地址。
 *
 * 摆在 ai-bridge 的包上面，照着「谁装什么」的顺序：绝大多数人装的是客户端，
 * 要单独在服务器上部署 ai-bridge 的才往下看。
 *
 * 每个端四行：通用下载页，加 Windows / mac Intel / mac Apple 芯片各一条。分平台不是
 * 为了整齐 —— Apple 芯片和 Intel 的包**不能互相代替**（arm64 的包在 Intel 机器上
 * 装完直接起不来），而浏览器认不出对面是哪种芯片，只能把填过的那几条都摆出来让人自己挑。
 *
 * 通用那条是兜底：某个平台没填就用它，四条都没填那一块就不显示。
 *
 * 值存在运行参数表里（client.*_download_url[.平台]），不在配置文件里 —— 换个桶放安装包
 * 不该要一次重新部署，而且管理端和使用端服务是两个进程，留在配置文件里就得两边各配一遍。
 * 代价是改完不立刻到处生效：各进程按自己的节奏回查同一行，所以保存提示里把秒数原样说出来。
 *
 * 地址没填就是空着。这里不摆一个猜出来的地址，猜错只会换来一次 404。
 */
function ClientDownloadCard({
  page,
  canWrite,
  onSaved,
}: {
  page: AdminBridgeReleasePage | null;
  canWrite: boolean;
  onSaved: () => void;
}) {
  const { t } = useLocale();
  // 还没拉回来之前不画：空地址和「没填」长得一样，而那是两件事。
  if (!page) return null;
  return (
    <section className="manager-data-card" style={{ padding: 16 }}>
      <Typography.Title level={5} style={{ marginTop: 0 }}>
        {t("galaxy.bridge.clientsTitle")}
      </Typography.Title>
      <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
        {t("galaxy.bridge.clientsHint")}
      </Typography.Paragraph>
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <ClientDownloadGroup
          label={t("galaxy.bridge.clientProvider")}
          hint={t("galaxy.bridge.clientProviderHint")}
          slots={page.clients?.provider ?? []}
          canWrite={canWrite}
          propagationSeconds={page.propagationSeconds}
          onSaved={onSaved}
        />
        <ClientDownloadGroup
          label={t("galaxy.bridge.clientConsumer")}
          hint={t("galaxy.bridge.clientConsumerHint")}
          slots={page.clients?.consumer ?? []}
          canWrite={canWrite}
          propagationSeconds={page.propagationSeconds}
          onSaved={onSaved}
        />
      </div>
    </section>
  );
}

/** 一个端的那几行：端名和说明在上，平台一行一条。 */
function ClientDownloadGroup({
  label,
  hint,
  slots,
  canWrite,
  propagationSeconds,
  onSaved,
}: {
  label: string;
  hint: string;
  /** 服务端排好的行，顺序照原样用（通用那条在前）。 */
  slots: ClientDownloadSlot[];
  canWrite: boolean;
  propagationSeconds: number;
  onSaved: () => void;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <Typography.Text strong>{label}</Typography.Text>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        {hint}
      </Typography.Text>
      {slots.map((slot) => (
        <ClientDownloadRow
          key={slot.settingKey}
          slot={slot}
          canWrite={canWrite}
          propagationSeconds={propagationSeconds}
          onSaved={onSaved}
        />
      ))}
    </div>
  );
}

function ClientDownloadRow({
  slot,
  canWrite,
  propagationSeconds,
  onSaved,
}: {
  /** 一行：填哪个平台、改它提交哪个键、现在填的是什么。键名由服务端给 —— 前端拼错了
   * 会被「这一项不是可调参数」顶回来，而那是点保存那一刻才看得到的错。 */
  slot: ClientDownloadSlot;
  canWrite: boolean;
  propagationSeconds: number;
  onSaved: () => void;
}) {
  const { t } = useLocale();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(slot.url);
  const [saving, setSaving] = useState(false);

  const url = slot.url;
  const labelKey = CLIENT_PLATFORM_LABELS[slot.platform];

  // 保存成功后父组件会重新拉一次，跟着新值走；别人改过之后刷新页面也一样。
  useEffect(() => {
    setDraft(url);
  }, [url]);

  const commit = async (payload: { value?: string; reset?: boolean }) => {
    setSaving(true);
    try {
      await saveSetting({ key: slot.settingKey, ...payload });
      message.success(t("galaxy.setting.saved").replace("{seconds}", String(propagationSeconds)));
      setEditing(false);
      onSaved();
    } catch (error) {
      message.error((error as Error).message || t("galaxy.actionFailed"));
    } finally {
      setSaving(false);
    }
  };

  const value = draft.trim();
  const dirty = value !== url;

  return (
    <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, paddingLeft: 12 }}>
      <Typography.Text style={{ width: 148, flexShrink: 0, fontSize: 13 }}>
        {labelKey ? t(labelKey) : slot.platform}
      </Typography.Text>

      {editing ? (
        <>
          <Input
            value={draft}
            autoFocus
            // 库里那一列是 varchar(1024)，这里给到 500 —— 下载地址再长也到不了，
            // 而超了长度是保存那一刻才报的错。
            maxLength={500}
            style={{ flex: "1 1 320px", minWidth: 240 }}
            placeholder={t("galaxy.bridge.clientPlaceholder")}
            status={value && !isDownloadURL(value) ? "error" : undefined}
            onChange={(event) => setDraft(event.target.value)}
            onPressEnter={() => {
              if (dirty && isDownloadURL(value)) void commit({ value });
            }}
          />
          <Button
            type="primary"
            size="small"
            loading={saving}
            disabled={!dirty || !isDownloadURL(value)}
            onClick={() => void commit({ value })}
          >
            {t("galaxy.setting.save")}
          </Button>
          <Button
            size="small"
            disabled={saving}
            onClick={() => {
              setDraft(url);
              setEditing(false);
            }}
          >
            {t("galaxy.cancel")}
          </Button>
          {value && !isDownloadURL(value) ? (
            <Typography.Text type="danger" style={{ fontSize: 12 }}>
              {t("galaxy.bridge.clientInvalid")}
            </Typography.Text>
          ) : null}
        </>
      ) : (
        <>
          {url ? (
            // 地址在服务端校验过只可能是 http(s)，所以敢直接给一个能点的链接；
            // noreferrer 是顺手的卫生，这条地址本来也不该把管理端的来路带出去。
            <Typography.Text
              className="manager-mono"
              style={{ fontSize: 13, wordBreak: "break-all" }}
              copyable={{ text: url }}
            >
              <a href={url} target="_blank" rel="noreferrer">
                {url}
              </a>
            </Typography.Text>
          ) : (
            // 平台那几行空着不是「坏了」：它退回通用下载页，所以标签只说「未填写」，
            // 旁边那句提示负责说清楚退回哪儿。
            <Tag>{t("galaxy.bridge.clientEmpty")}</Tag>
          )}
          {canWrite ? (
            <Button type="link" size="small" icon={<EditOutlined />} onClick={() => setEditing(true)}>
              {url ? t("galaxy.bridge.clientEdit") : t("galaxy.bridge.clientFill")}
            </Button>
          ) : null}
          {canWrite && url ? (
            <Popconfirm
              title={t("galaxy.bridge.clientClear")}
              description={
                <div style={{ maxWidth: 320 }}>
                  {slot.platform ? t("galaxy.bridge.clientClearPlatformHint") : t("galaxy.bridge.clientClearHint")}
                </div>
              }
              okText={t("galaxy.confirm")}
              cancelText={t("galaxy.cancel")}
              onConfirm={() => void commit({ reset: true })}
            >
              <Button type="link" size="small" icon={<UndoOutlined />} loading={saving}>
                {t("galaxy.bridge.clientClear")}
              </Button>
            </Popconfirm>
          ) : null}
        </>
      )}
    </div>
  );
}

type UploadForm = { signature: string; notes: string };

/** 选中的包，以及从包名里解析出来的版本、平台。 */
type PickedArchive = { file: File; version: string; platform: string };

type UploadPhase = "idle" | "reading" | "uploading" | "verifying";

function UploadReleaseModal({
  open,
  releases,
  onClose,
  onUploaded,
}: {
  open: boolean;
  /** 已有的包。只用来在传之前提醒「已经发布过」「会覆盖」「比当前最新旧」，省得白传一趟；拒不拒以服务端为准。 */
  releases: BridgeReleaseView[];
  onClose: () => void;
  onUploaded: () => void;
}) {
  const { t } = useLocale();
  const [form] = Form.useForm<UploadForm>();
  const [archive, setArchive] = useState<PickedArchive | null>(null);
  const [archiveError, setArchiveError] = useState<{ name?: string; reason: string } | null>(null);
  // 签名是从哪个 .sig 读进来的，用来核对它和包是不是一对。手改过文本框就不再算从文件读的。
  const [signatureFile, setSignatureFile] = useState("");
  const [phase, setPhase] = useState<UploadPhase>("idle");
  const [percent, setPercent] = useState(0);
  const submitting = phase !== "idle";

  // 每次打开都清空：表单实例和这些状态比弹窗活得长，不清的话上一个平台的签名会原样留在框里，
  // 配上这次的包，要等整个包传完、服务端验签才被拒。
  useEffect(() => {
    if (!open) return;
    form.resetFields();
    setArchive(null);
    setArchiveError(null);
    setSignatureFile("");
    setPhase("idle");
    setPercent(0);
  }, [open, form]);

  const pickArchive = (file: File) => {
    const reject = (reason: string) => {
      setArchive(null);
      setArchiveError({ name: file.name, reason });
    };
    const match = ARCHIVE_NAME.exec(file.name);
    if (!match) return reject(t("galaxy.bridge.badName"));
    const [, version, platform, extension] = match;
    if (!VERSION.test(version)) return reject(fill(t("galaxy.bridge.badVersion"), { version }));
    // 扩展名和平台是契约绑死的（windows 是 .zip，其余 .tar.gz，各平台不装东西就能解开），服务端也按这个收。
    const expected = platform.startsWith("windows-") ? "zip" : "tar.gz";
    if (extension !== expected) {
      return reject(fill(t("galaxy.bridge.badExtension"), { platform, extension: `.${expected}` }));
    }
    if (file.size === 0) return reject(t("galaxy.bridge.emptyFile"));
    if (file.size > MAX_ARCHIVE_BYTES) return reject(t("galaxy.bridge.tooLarge"));
    setArchiveError(null);
    setArchive({ file, version, platform });
  };

  const readSignatureFile = async (file: File) => {
    if (file.size > MAX_SIGNATURE_FILE_BYTES) {
      message.error(fill(t("galaxy.bridge.badSig"), { name: file.name }));
      return;
    }
    try {
      // .sig 里就是一行 base64；行尾换行和不小心带上的空白都不是签名的一部分。
      const text = (await file.text()).replace(/\s+/g, "");
      form.setFieldsValue({ signature: text });
      setSignatureFile(file.name);
      // 当场校验：拿错了文件（比如公钥）马上就能看到，不用等点上传。
      form.validateFields(["signature"]).catch(() => undefined);
    } catch {
      message.error(t("galaxy.bridge.readFailed"));
    }
  };

  /** 运营常把包和它的 .sig 一起拖进来：.sig 直接填进签名，其余的当安装包。 */
  const pickFiles = (files: File[]) => {
    const signatures = files.filter(isSignatureFile);
    const archives = files.filter((file) => !isSignatureFile(file));
    if (archives.length > 1) {
      setArchive(null);
      setArchiveError({ reason: t("galaxy.bridge.oneArchive") });
    } else if (archives.length === 1) {
      pickArchive(archives[0]);
    }
    if (signatures.length > 0) {
      const paired = archives.length === 1 ? signatures.find((file) => file.name === `${archives[0].name}.sig`) : undefined;
      void readSignatureFile(paired ?? signatures[0]);
    }
  };

  const existing = archive
    ? releases.find((row) => row.version === archive.version && row.platform === archive.platform)
    : undefined;
  const current = archive ? latestPublished(releases).get(archive.platform) : undefined;
  // 同版本同平台已经发布，服务端一定拒：直接挡住上传按钮，不让运营把整个包白传一趟。
  const blocked = existing?.status === "published";

  const notices: { type: "error" | "info" | "warning"; text: string }[] = [];
  if (archive && existing) {
    const values = { version: archive.version, platform: archive.platform };
    notices.push(
      blocked
        ? { type: "error", text: fill(t("galaxy.bridge.alreadyPublished"), values) }
        : { type: "info", text: fill(t("galaxy.bridge.overwriteWithdrawn"), values) },
    );
  }
  // 能传，但节点只升级到最新、也不降级，传上去只能按版本号下载 —— 多半是拿错了包。
  if (archive && current && compareVersions(archive.version, current.version) < 0) {
    notices.push({
      type: "warning",
      text: fill(t("galaxy.bridge.olderThanLatest"), { platform: archive.platform, latest: current.version }),
    });
  }

  const expectedSignatureFile = archive ? `${archive.file.name}.sig` : "";
  const signatureExtra = !signatureFile ? (
    t("galaxy.bridge.signatureHint")
  ) : archive && signatureFile !== expectedSignatureFile ? (
    // 只提醒不拦：签名对不对最终看验签，但名字对不上多半是拿了别的平台或版本的 .sig。
    <Typography.Text type="warning">
      {fill(t("galaxy.bridge.sigMismatch"), { name: signatureFile, expected: expectedSignatureFile })}
    </Typography.Text>
  ) : (
    fill(t("galaxy.bridge.sigFrom"), { name: signatureFile })
  );

  const [signHintBefore, signHintAfter = ""] = t("galaxy.bridge.signHint").split("{command}");

  const submit = async () => {
    if (!archive) {
      setArchiveError({ reason: t("galaxy.bridge.archiveRequired") });
      form.validateFields().catch(() => undefined);
      return;
    }
    const values = await form.validateFields().catch(() => null);
    if (!values || blocked) return;
    const { file, version, platform } = archive;

    // 读文件放到点上传这一刻：选完包到填完说明之间，不必把几十 MB 的 base64 攥在内存里。
    setPhase("reading");
    let content: string;
    try {
      content = await readAsBase64(file);
    } catch {
      setPhase("idle");
      message.error(t("galaxy.bridge.readFailed"));
      return;
    }

    setPhase("uploading");
    try {
      const view = await uploadBridgeRelease(
        {
          fileName: file.name,
          content,
          signature: values.signature.replace(/\s+/g, ""),
          notes: values.notes?.trim() ?? "",
        },
        {
          onUploadProgress: (value) => {
            setPercent(value);
            // 进度到头只说明请求体发完了，服务端还要算 sha256、验签、写 OSS 才回。
            if (value >= 100) setPhase("verifying");
          },
        },
      );
      message.success(
        fill(t(view.status === "published" ? "galaxy.bridge.uploaded" : "galaxy.bridge.uploadedWithdrawn"), {
          version: view.version || version,
          platform: view.platform || platform,
        }),
      );
      onClose();
      onUploaded();
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === "ECONNABORTED" || code === "ETIMEDOUT") {
        // 超时不等于没传上去：服务端可能已经收下、只是回得慢。重拉一次列表让运营照着判断，
        // 照原样再点一次多半只会换来一句「先下架再重新上传」。
        message.error(t("galaxy.bridge.uploadTimeout"));
        onUploaded();
      } else {
        message.error((error as Error).message || t("galaxy.actionFailed"));
      }
    } finally {
      setPhase("idle");
      setPercent(0);
    }
  };

  return (
    <Modal
      open={open}
      title={t("galaxy.bridge.upload")}
      okText={t("galaxy.bridge.uploadOk")}
      cancelText={t("galaxy.cancel")}
      confirmLoading={submitting}
      okButtonProps={{ disabled: blocked }}
      // 传的过程中不让关：请求不会跟着弹窗停下，关掉之后既看不到结果，还可能又开一次重复上传。
      cancelButtonProps={{ disabled: submitting }}
      closable={!submitting}
      maskClosable={!submitting}
      keyboard={!submitting}
      width={640}
      onOk={() => void submit()}
      onCancel={onClose}
      destroyOnHidden
    >
      {/* 节点装包前只认发布签名，Hub 给的地址和 sha256 都不单独可信。先把怎么签说清楚，免得传完被拒还不知道去哪儿补。 */}
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message={
          <span>
            {signHintBefore}
            <Typography.Text code copyable>
              {t("galaxy.bridge.signCommand")}
            </Typography.Text>
            {signHintAfter}
          </span>
        }
      />

      <Upload.Dragger
        // 除了 .tar.gz 还放 .gz：有的系统文件选择框只按最后一截扩展名匹配，只写 .tar.gz 包可能是灰的、选不中。
        // 包名到底合不合契约由 pickArchive 再判一遍。
        accept=".tar.gz,.gz,.zip,.sig"
        multiple
        showUploadList={false}
        disabled={submitting}
        beforeUpload={(file, batch) => {
          // antd 对一批里的每个文件各调一次，整批只在第一个文件上处理一次。
          if (file === batch[0]) pickFiles(batch);
          // 只是选文件：返回 false 不让 antd 自己去传。
          return false;
        }}
      >
        <p className="ant-upload-drag-icon">
          <InboxOutlined />
        </p>
        <p className="ant-upload-text">{t("galaxy.bridge.dropTitle")}</p>
        <p className="ant-upload-hint">{t("galaxy.bridge.dropHint")}</p>
      </Upload.Dragger>

      {archive ? (
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, marginTop: 12 }}>
          <FileZipOutlined />
          <span className="manager-mono">{archive.file.name}</span>
          <Typography.Text type="secondary">{formatSize(archive.file.size)}</Typography.Text>
          <Tag style={{ marginInlineEnd: 0 }}>
            {t("galaxy.bridge.version")} <b>{archive.version}</b>
          </Tag>
          <Tag style={{ marginInlineEnd: 0 }}>
            {t("galaxy.bridge.platform")} <b>{archive.platform}</b>
          </Tag>
        </div>
      ) : null}
      {archiveError ? (
        <Alert
          type="error"
          showIcon
          style={{ marginTop: 12 }}
          message={archiveError.name ? <span className="manager-mono">{archiveError.name}</span> : archiveError.reason}
          description={archiveError.name ? archiveError.reason : undefined}
        />
      ) : null}
      {notices.map((notice) => (
        <Alert key={notice.text} type={notice.type} showIcon style={{ marginTop: 12 }} message={notice.text} />
      ))}

      <Form
        form={form}
        layout="vertical"
        disabled={submitting}
        initialValues={{ signature: "", notes: "" }}
        style={{ marginTop: 16 }}
      >
        <Form.Item label={t("galaxy.bridge.signature")} required extra={signatureExtra}>
          <Form.Item
            name="signature"
            noStyle
            rules={[
              { required: true, whitespace: true, message: t("galaxy.bridge.signatureRequired") },
              {
                validator: (_, value?: string) =>
                  !value?.trim() || SIGNATURE.test(value.replace(/\s+/g, ""))
                    ? Promise.resolve()
                    : Promise.reject(new Error(t("galaxy.bridge.signatureInvalid"))),
              },
            ]}
          >
            <Input.TextArea
              rows={2}
              className="manager-mono"
              spellCheck={false}
              placeholder={t("galaxy.bridge.signaturePlaceholder")}
              onChange={() => setSignatureFile("")}
            />
          </Form.Item>
          <Upload
            accept=".sig"
            showUploadList={false}
            beforeUpload={(file) => {
              void readSignatureFile(file);
              return false;
            }}
          >
            <Button size="small" icon={<FileTextOutlined />} style={{ marginTop: 8 }}>
              {t("galaxy.bridge.pickSig")}
            </Button>
          </Upload>
        </Form.Item>
        <Form.Item name="notes" label={t("galaxy.bridge.notes")} style={{ marginBottom: submitting ? 12 : 0 }}>
          <Input.TextArea rows={3} maxLength={1000} showCount placeholder={t("galaxy.bridge.notesPlaceholder")} />
        </Form.Item>
      </Form>

      {submitting ? (
        <div>
          <Typography.Text type="secondary">
            {phase === "reading"
              ? t("galaxy.bridge.reading")
              : phase === "uploading"
                ? t("galaxy.bridge.uploading")
                : t("galaxy.bridge.verifying")}
          </Typography.Text>
          <Progress percent={phase === "verifying" ? 100 : percent} size="small" status="active" />
        </div>
      ) : null}
    </Modal>
  );
}
