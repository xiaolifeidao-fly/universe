"use client";

import { CloudUploadOutlined, InboxOutlined, ReloadOutlined } from "@ant-design/icons";
import {
  Alert,
  Button,
  Form,
  Input,
  Modal,
  Popconfirm,
  Progress,
  Select,
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
import { useLocale } from "@/i18n/LocaleProvider";
import { useCanWrite } from "@/components/permission/WritePermission";
import {
  fetchDesktopReleases,
  prepareDesktopRelease,
  publishDesktopRelease,
  setDesktopReleaseStatus,
  uploadDesktopAsset,
  type DesktopReleasePage,
  type DesktopReleaseStatus,
  type DesktopReleaseView,
} from "../api/galaxy.api";

/** 清单文件名 → 平台通道。名字是 electron-updater 定死的，服务端认的也是这三个。 */
const MANIFESTS: Record<string, string> = {
  "latest-mac.yml": "mac",
  "latest.yml": "win",
  "latest-linux.yml": "linux",
};

const PRODUCT_LABELS: Record<string, string> = { nova: "Nova", orbit: "Orbit" };

/** 文案里的 {name} 占位符。 */
function fill(template: string, values: Record<string, string | number>) {
  return template.replace(/\{(\w+)\}/g, (whole, key: string) => String(values[key] ?? whole));
}

function formatSize(bytes: number) {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

/**
 * 桌面客户端（Nova 共享端 / Orbit 使用端）的发版。
 *
 * 客户端那一侧是 electron-updater：应用按平台去 OSS 上取一个固定文件名的清单，
 * 比版本号，下载、校验、装上。**它不打服务端的任何接口** —— 所以这一页做的事
 * 就是「把 electron-builder 的产物放到那个目录里去」。
 *
 * 几条要紧的语义：
 *
 * - **发布 = 写清单**。上传只是把包放上去，点了发布，全网客户端下一次检查才会看到它。
 * - **同一个通道只有一个当前版本**：版本最高的那个在架的。补发一个更旧的版本不会顶掉它。
 * - **下架不是删除**：包还在，只是清单换回上一个在架版本；已经更新过的人不受影响
 *   （桌面应用不会自己降级）。
 * - 包一百多兆，**浏览器直传对象存储**，不经过 manager-api。所以桶要允许管理端这个源
 *   跨域 PUT，发布目录还要公开读 —— 这两条配不对时，这一页会在上传那一步报错。
 */
export function DesktopReleases() {
  const { t } = useLocale();
  // 发版决定全网客户端更新到哪一版，只读角色一律看不到入口。
  const canWrite = useCanWrite();
  const [page, setPage] = useState<DesktopReleasePage | null>(null);
  const [loading, setLoading] = useState(true);
  const [uploadOpen, setUploadOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setPage(await fetchDesktopReleases());
    } catch (error) {
      message.error((error as Error).message || t("galaxy.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const rows = useMemo(() => page?.releases ?? [], [page]);
  const products = page?.products?.length ? page.products : ["nova", "orbit"];
  const channels = page?.channels?.length ? page.channels : ["mac", "win", "linux"];

  const changeStatus = async (row: DesktopReleaseView, status: DesktopReleaseStatus) => {
    try {
      await setDesktopReleaseStatus(row.releaseId, status);
      message.success(t("galaxy.desktop.statusSaved"));
      void load();
    } catch (error) {
      message.error((error as Error).message || t("galaxy.actionFailed"));
    }
  };

  const columns: ColumnsType<DesktopReleaseView> = [
    {
      title: t("galaxy.desktop.product"),
      dataIndex: "product",
      width: 110,
      render: (product: string) => <span style={{ fontWeight: 600 }}>{PRODUCT_LABELS[product] ?? product}</span>,
    },
    {
      title: t("galaxy.desktop.channel"),
      dataIndex: "channel",
      width: 150,
      render: (channel: string, row) => (
        <Space direction="vertical" size={0}>
          <span className="manager-mono">{channel}</span>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {row.manifestFile}
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: t("galaxy.desktop.version"),
      dataIndex: "version",
      width: 110,
      render: (version: string) => (
        <span className="manager-mono" style={{ fontWeight: 600 }}>
          {version}
        </span>
      ),
    },
    {
      title: t("galaxy.desktop.files"),
      dataIndex: "files",
      width: 320,
      render: (_, row) => (
        <Space direction="vertical" size={0}>
          {(row.files ?? []).map((file) => (
            <span key={file.name} className="manager-mono" style={{ fontSize: 12 }}>
              {file.name}
              <Typography.Text type="secondary" style={{ marginInlineStart: 8 }}>
                {formatSize(file.size)}
              </Typography.Text>
            </span>
          ))}
        </Space>
      ),
    },
    {
      title: t("galaxy.desktop.status"),
      dataIndex: "status",
      width: 170,
      render: (status: DesktopReleaseStatus, row) => (
        <Space size={4} wrap>
          {status === "published" ? (
            <Tag color="success">{t("galaxy.desktop.published")}</Tag>
          ) : status === "withdrawn" ? (
            <Tag>{t("galaxy.desktop.withdrawn")}</Tag>
          ) : (
            <Tooltip title={t("galaxy.desktop.stagingTip")}>
              <Tag color="warning">{t("galaxy.desktop.staging")}</Tag>
            </Tooltip>
          )}
          {row.current ? (
            <Tooltip title={t("galaxy.desktop.currentTip")}>
              <Tag color="processing">{t("galaxy.desktop.current")}</Tag>
            </Tooltip>
          ) : null}
        </Space>
      ),
    },
    {
      title: t("galaxy.desktop.publishedBy"),
      dataIndex: "publishedBy",
      width: 120,
      render: (value: string) => value || "-",
    },
    {
      title: t("galaxy.desktop.publishedAt"),
      dataIndex: "publishedAt",
      width: 170,
      render: (value?: string) => (value ? new Date(value).toLocaleString() : "-"),
    },
    {
      title: t("galaxy.desktop.notes"),
      dataIndex: "notes",
      width: 220,
      ellipsis: { showTitle: false },
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
        // 还没传完的那一行没有可操作的状态：它对客户端不存在，重新走一遍上传流程就会覆盖它。
        if (row.status === "staging") return <Typography.Text type="secondary">-</Typography.Text>;
        const withdrawing = row.status === "published";
        return (
          <Popconfirm
            title={withdrawing ? t("galaxy.desktop.withdraw") : t("galaxy.desktop.republish")}
            description={
              <div style={{ maxWidth: 320 }}>
                {withdrawing
                  ? row.current
                    ? t("galaxy.desktop.withdrawCurrentHint")
                    : t("galaxy.desktop.withdrawHint")
                  : t("galaxy.desktop.republishHint")}
              </div>
            }
            okText={t("galaxy.confirm")}
            cancelText={t("galaxy.cancel")}
            onConfirm={() => void changeStatus(row, withdrawing ? "withdrawn" : "published")}
          >
            <Button size="small" danger={withdrawing}>
              {withdrawing ? t("galaxy.desktop.withdraw") : t("galaxy.desktop.republish")}
            </Button>
          </Popconfirm>
        );
      },
    },
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <Space>
        {canWrite ? (
          <Button type="primary" icon={<CloudUploadOutlined />} onClick={() => setUploadOpen(true)}>
            {t("galaxy.desktop.upload")}
          </Button>
        ) : null}
        <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void load()}>
          {t("galaxy.refresh")}
        </Button>
      </Space>

      {/* 客户端不打我们的接口，它读的是对象存储上这个目录。地址配错的症状是「谁都收不到更新」，
          而那件事没有任何报警 —— 所以把真正的落点摆在页面最上面。 */}
      <Alert
        type="info"
        showIcon
        message={t("galaxy.desktop.feedTitle")}
        description={
          <Space direction="vertical" size={2}>
            <span>
              {t("galaxy.desktop.feedRoot")}
              <Typography.Text code copyable={{ text: page?.objectRoot ?? "" }}>
                {page?.objectRoot || t("galaxy.desktop.feedRootMissing")}
              </Typography.Text>
            </span>
            <Typography.Text type="secondary">{t("galaxy.desktop.feedHint")}</Typography.Text>
          </Space>
        }
      />

      {/* 每个端每个通道当前对外的是哪一版。运营发完版要看的就是这一行。 */}
      {page ? (
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6 }}>
          <Typography.Text type="secondary">{t("galaxy.desktop.currentSummary")}</Typography.Text>
          {products.map((product) =>
            channels.map((channel) => {
              const current = rows.find(
                (row) => row.product === product && row.channel === channel && row.current,
              );
              return current ? (
                <Tag key={`${product}-${channel}`} color="processing" style={{ marginInlineEnd: 0 }}>
                  {PRODUCT_LABELS[product] ?? product} <span className="manager-mono">{channel}</span>{" "}
                  <b>{current.version}</b>
                </Tag>
              ) : (
                <Tooltip key={`${product}-${channel}`} title={t("galaxy.desktop.currentNoneTip")}>
                  <Tag style={{ marginInlineEnd: 0 }}>
                    {PRODUCT_LABELS[product] ?? product} <span className="manager-mono">{channel}</span>{" "}
                    {t("galaxy.desktop.currentNone")}
                  </Tag>
                </Tooltip>
              );
            }),
          )}
        </div>
      ) : null}

      <Table<DesktopReleaseView>
        rowKey="releaseId"
        size="small"
        loading={loading}
        columns={columns}
        dataSource={rows}
        locale={{ emptyText: t("galaxy.desktop.empty") }}
        pagination={{ pageSize: 20, showSizeChanger: false }}
        scroll={{ x: 1480 }}
      />

      {canWrite ? (
        <PublishModal
          open={uploadOpen}
          products={products}
          onClose={() => setUploadOpen(false)}
          onPublished={() => void load()}
        />
      ) : null}
    </div>
  );
}

type PublishForm = { product: string; notes: string };

/** 选中的一批文件：一个清单 + 它点名的那些包。 */
type Picked = { manifest: File | null; assets: File[] };

type Phase = "idle" | "preparing" | "uploading" | "publishing";

function PublishModal({
  open,
  products,
  onClose,
  onPublished,
}: {
  open: boolean;
  products: string[];
  onClose: () => void;
  onPublished: () => void;
}) {
  const { t } = useLocale();
  const [form] = Form.useForm<PublishForm>();
  const [picked, setPicked] = useState<Picked>({ manifest: null, assets: [] });
  const [phase, setPhase] = useState<Phase>("idle");
  /** 每个文件传到哪儿了。键是文件名。 */
  const [progress, setProgress] = useState<Record<string, number>>({});
  const [error, setError] = useState("");
  const busy = phase !== "idle";

  useEffect(() => {
    if (!open) return;
    form.resetFields();
    setPicked({ manifest: null, assets: [] });
    setPhase("idle");
    setProgress({});
    setError("");
  }, [open, form]);

  /**
   * 运营把 release/<端>/ 里的东西整个拖进来：认得出的清单挑出来，其余当安装包。
   *
   * .blockmap 直接丢掉：客户端关掉了差量下载（见 common/electron/update/runtime.ts），
   * 传上去也没人取，还要多等几秒。
   */
  const pickFiles = (files: File[]) => {
    const manifests = files.filter((file) => MANIFESTS[file.name] !== undefined);
    const assets = files.filter((file) => MANIFESTS[file.name] === undefined && !file.name.endsWith(".blockmap"));
    if (manifests.length > 1) {
      setError(t("galaxy.desktop.oneManifest"));
      return;
    }
    setError("");
    setPicked((current) => ({
      manifest: manifests[0] ?? current.manifest,
      // 同名的以新选的为准，其余保留 —— 分两次拖进来是常事。
      assets: [...current.assets.filter((old) => !assets.some((file) => file.name === old.name)), ...assets],
    }));
    // 包名带着产品名（artifactName 是 ${productName}-…），能猜就先替运营选上，仍然可改。
    const guess = assets.find((file) => products.some((product) => file.name.toLowerCase().startsWith(product)));
    if (guess && !form.getFieldValue("product")) {
      form.setFieldsValue({ product: guess.name.split("-")[0].toLowerCase() });
    }
  };

  const channel = picked.manifest ? MANIFESTS[picked.manifest.name] : "";

  const submit = async () => {
    const values = await form.validateFields().catch(() => null);
    if (!values) return;
    if (!picked.manifest) {
      setError(t("galaxy.desktop.manifestRequired"));
      return;
    }
    setError("");
    setPhase("preparing");
    try {
      const manifest = await picked.manifest.text();
      const upload = await prepareDesktopRelease({
        product: values.product,
        fileName: picked.manifest.name,
        manifest,
        notes: values.notes?.trim() ?? "",
      });

      // 清单点名的文件必须都在手上。缺一个就发出去，客户端会在下载那一步 404 ——
      // 服务端发布前也会再查一遍对象存储，这里先拦是为了不让人白传一轮。
      const missing = upload.uploads.filter((target) => !picked.assets.some((file) => file.name === target.name));
      if (missing.length > 0) {
        setPhase("idle");
        setError(fill(t("galaxy.desktop.missingFiles"), { names: missing.map((item) => item.name).join("、") }));
        return;
      }
      const mismatched = upload.uploads.filter((target) => {
        const file = picked.assets.find((item) => item.name === target.name);
        return file && file.size !== target.size;
      });
      if (mismatched.length > 0) {
        // 包重新打过、清单没跟着更新：sha512 也一定对不上，客户端下完会校验失败。
        setPhase("idle");
        setError(fill(t("galaxy.desktop.sizeMismatch"), { names: mismatched.map((item) => item.name).join("、") }));
        return;
      }

      setPhase("uploading");
      setProgress(Object.fromEntries(upload.uploads.map((target) => [target.name, 0])));
      for (const target of upload.uploads) {
        const file = picked.assets.find((item) => item.name === target.name);
        if (!file) continue;
        await uploadDesktopAsset(target, file, {
          onProgress: (percent) => setProgress((current) => ({ ...current, [target.name]: percent })),
        });
      }

      setPhase("publishing");
      const view = await publishDesktopRelease(upload.releaseId);
      message.success(
        fill(t(view.current ? "galaxy.desktop.publishedNow" : "galaxy.desktop.publishedOlder"), {
          version: view.version,
          channel: view.channel,
        }),
      );
      onClose();
      onPublished();
    } catch (requestError) {
      const detail = (requestError as Error).message || t("galaxy.actionFailed");
      // 直传失败最常见的原因是桶没放行管理端这个源（浏览器里只会给一句含糊的 Network Error）。
      setError(phase === "uploading" ? fill(t("galaxy.desktop.uploadFailed"), { detail }) : detail);
      setPhase("idle");
      // 传了一半的包留在对象存储上不影响任何人：那一版停在「待上传」，客户端看不到它。
      onPublished();
    }
  };

  const total = picked.assets.reduce((sum, file) => sum + file.size, 0);

  return (
    <Modal
      open={open}
      title={t("galaxy.desktop.upload")}
      okText={t("galaxy.desktop.publish")}
      cancelText={t("galaxy.cancel")}
      confirmLoading={busy}
      okButtonProps={{ disabled: !picked.manifest || picked.assets.length === 0 }}
      // 传的过程中不让关：请求不会跟着弹窗停下，关掉之后既看不到结果，还可能又开一次重复上传。
      cancelButtonProps={{ disabled: busy }}
      closable={!busy}
      maskClosable={!busy}
      keyboard={!busy}
      width={680}
      onOk={() => void submit()}
      onCancel={onClose}
      destroyOnHidden
    >
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message={t("galaxy.desktop.howTitle")}
        description={<div style={{ whiteSpace: "pre-line" }}>{t("galaxy.desktop.howHint")}</div>}
      />

      <Upload.Dragger
        accept=".yml,.zip,.dmg,.exe,.AppImage,.deb,.rpm"
        multiple
        showUploadList={false}
        disabled={busy}
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
        <p className="ant-upload-text">{t("galaxy.desktop.dropTitle")}</p>
        <p className="ant-upload-hint">{t("galaxy.desktop.dropHint")}</p>
      </Upload.Dragger>

      {picked.manifest ? (
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, marginTop: 12 }}>
          <Tag color="processing" style={{ marginInlineEnd: 0 }}>
            <span className="manager-mono">{picked.manifest.name}</span>
          </Tag>
          <Tag style={{ marginInlineEnd: 0 }}>
            {t("galaxy.desktop.channel")} <b>{channel}</b>
          </Tag>
          <Typography.Text type="secondary">
            {fill(t("galaxy.desktop.assetCount"), { count: picked.assets.length, size: formatSize(total) })}
          </Typography.Text>
        </div>
      ) : null}

      {picked.assets.length > 0 ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 8 }}>
          {picked.assets.map((file) => (
            <div key={file.name} style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span className="manager-mono" style={{ fontSize: 12, flex: 1, wordBreak: "break-all" }}>
                {file.name}
              </span>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {formatSize(file.size)}
              </Typography.Text>
              {phase === "uploading" || phase === "publishing" ? (
                <Progress
                  percent={progress[file.name] ?? 0}
                  size="small"
                  style={{ width: 160, marginBottom: 0 }}
                  status={(progress[file.name] ?? 0) >= 100 ? "success" : "active"}
                />
              ) : null}
            </div>
          ))}
        </div>
      ) : null}

      {error ? <Alert type="error" showIcon style={{ marginTop: 12 }} message={error} /> : null}

      <Form form={form} layout="vertical" disabled={busy} initialValues={{ product: "", notes: "" }} style={{ marginTop: 16 }}>
        <Form.Item
          name="product"
          label={t("galaxy.desktop.product")}
          rules={[{ required: true, message: t("galaxy.desktop.productRequired") }]}
          extra={t("galaxy.desktop.productHint")}
        >
          <Select
            placeholder={t("galaxy.desktop.productRequired")}
            options={products.map((product) => ({ value: product, label: PRODUCT_LABELS[product] ?? product }))}
          />
        </Form.Item>
        <Form.Item name="notes" label={t("galaxy.desktop.notes")} extra={t("galaxy.desktop.notesHint")} style={{ marginBottom: 0 }}>
          <Input.TextArea rows={3} maxLength={1000} showCount placeholder={t("galaxy.desktop.notesPlaceholder")} />
        </Form.Item>
      </Form>

      {busy ? (
        <Typography.Text type="secondary" style={{ display: "block", marginTop: 12 }}>
          {phase === "preparing"
            ? t("galaxy.desktop.preparing")
            : phase === "uploading"
              ? t("galaxy.desktop.uploading")
              : t("galaxy.desktop.publishing")}
        </Typography.Text>
      ) : null}
    </Modal>
  );
}
