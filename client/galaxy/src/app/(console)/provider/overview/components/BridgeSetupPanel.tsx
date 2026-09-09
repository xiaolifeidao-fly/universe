"use client";

import { CheckCircleFilled, ExclamationCircleFilled, ReloadOutlined } from "@ant-design/icons";
import { Alert, Button, Form, Input, Space, Spin, Tag, Typography, message } from "antd";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useLocale } from "@/i18n/LocaleProvider";
import { formatTime } from "@/utils/format";
import type { PairingCode } from "../../api/provider.api";
import {
  clearBridgeConnFromUrl,
  fetchBridgeState,
  finishBridge,
  pairWithBridge,
  type BridgeCapability,
  type BridgeConn,
  type BridgeState,
} from "../../api/bridge.api";

const { Paragraph } = Typography;

interface PairValues {
  hubURL: string;
  displayName: string;
  code: string;
}

/**
 * 本机配置向导，搬到控制台里。
 *
 * 这一块直连**用户自己机器上**的 ai-bridge（跨源，见 bridge.api.ts），不经过平台。
 * 能搬进来的只有 bridge 独有的两件事，别的都不该在这儿：
 *   · 配对 —— 要把长期令牌写进本机文件，只有本机进程干得了；
 *   · 探测 —— 要读本机的订阅登录态，平台看不见。
 *
 * 「共享哪几种能力、共享多少」**不在这里**，在「贡献授权」页 —— 那是提供者的唯一
 * 配置入口，额度以平台为权威。这里把探测结果**只读**列出来，只是让主人确认一眼
 * 「这台机器上探得到什么」；真要开启和给额度，配对完节点上报之后去那边。
 */
export function BridgeSetupPanel({
  conn,
  code,
  onPaired,
}: {
  conn: BridgeConn;
  /** 控制台刚签发的配对码。给了就自动填进表单，用户不用复制粘贴。 */
  code?: PairingCode | null;
  onPaired: () => void;
}) {
  const { t } = useLocale();
  const [form] = Form.useForm<PairValues>();
  const [state, setState] = useState<BridgeState | null>(null);
  // 常驻接口没有 /api/state（能力清单是机器指纹，只在有令牌的临时向导里给），
  // 所以那一档没有要加载的东西，直接进表单。
  const [loading, setLoading] = useState(!conn.resident);
  const [failed, setFailed] = useState("");
  const [pairing, setPairing] = useState(false);
  const [finished, setFinished] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const [repaired, setRepaired] = useState(false);

  const load = useCallback(async () => {
    if (conn.resident) return;
    setLoading(true);
    try {
      const result = await fetchBridgeState(conn);
      setState(result);
      setFailed("");
      // 平台地址和机器名由本机报上来（分别来自本机配置和 hostname），预填好，
      // 主人一般不用改 —— 但留着可改：自建部署的 Hub 不在默认那个地址上。
      form.setFieldsValue({ hubURL: result.hubURL, displayName: result.displayName });
    } catch (error) {
      setFailed((error as Error).message);
      setState(null);
    } finally {
      setLoading(false);
    }
  }, [conn, form]);


  useEffect(() => {
    void load();
  }, [load]);

  // 控制台一签发配对码就自动填进来。这个框是只读的：码是平台发的，手改只会改错，
  // 而「复制上面那串再粘到下面」本来就是一步没有意义的搬运。
  useEffect(() => {
    if (code?.code) form.setFieldValue("code", code.code);
  }, [code, form]);

  const pair = async (values: PairValues) => {
    setPairing(true);
    try {
      const result = await pairWithBridge(conn, {
        // 常驻接口用启动时锁定的 Hub，传了也会被忽略；临时向导才需要它。
        ...(conn.resident ? {} : { hubURL: values.hubURL }),
        displayName: values.displayName,
        code: values.code,
      });
      message.success(t("provider.bridge.pairedOk").replace("{nodeId}", result.nodeId));
      // 配完把令牌从地址栏抹掉，免得跟着历史记录和「复制网址」跑出去。
      clearBridgeConnFromUrl();
      form.setFieldValue("code", "");
      setRepaired(result.restarting === true);
      await load();
      onPaired();
    } catch (error) {
      message.error((error as Error).message || t("common.actionFailed"));
    } finally {
      setPairing(false);
    }
  };

  const finish = async () => {
    setFinishing(true);
    // 先翻状态再发请求：/api/finish 会把那个进程关掉，响应回来之前连接就断了，
    // 等它「成功」再翻会卡在 loading 上。请求失败也无所谓 —— 15 分钟无操作它自己也会退。
    setFinished(true);
    clearBridgeConnFromUrl();
    await finishBridge(conn);
    setFinishing(false);
  };

  // 退出之后本机那个接口就没了，任何请求都会失败。这一支必须排在最前面，
  // 否则下面的 loading / failed 分支会把「正常结束」显示成一个错误。
  if (finished) {
    return (
      <Alert
        type="success"
        showIcon
        message={t("provider.bridge.finished")}
        description={
          <>
            <Paragraph style={{ marginBottom: 8 }}>{t("provider.bridge.finishedHint")}</Paragraph>
            <Link href="/provider/contributions">{t("provider.bridge.next")}</Link>
          </>
        }
      />
    );
  }

  if (loading && !state) {
    return (
      <div style={{ padding: 40, display: "grid", placeItems: "center" }}>
        <Spin />
      </div>
    );
  }

  // 连不上最常见的原因就是向导自己退了（15 分钟无操作）。说清楚怎么再来一次，
  // 别让人对着一个「网络错误」猜。
  if (failed) {
    return (
      <Alert
        type="warning"
        showIcon
        message={t("provider.bridge.disconnected")}
        description={
          <>
            <Paragraph style={{ marginBottom: 8 }}>{failed}</Paragraph>
            <Paragraph style={{ margin: 0, color: "var(--manager-text-muted)" }}>
              {t("provider.bridge.disconnectedHint")}
            </Paragraph>
          </>
        }
        action={
          <Button size="small" icon={<ReloadOutlined />} onClick={() => void load()}>
            {t("common.refresh")}
          </Button>
        }
      />
    );
  }

  return (
    <div>
      <Space wrap style={{ marginBottom: 14 }}>
        <Tag color="success">
          {t(conn.resident ? "provider.bridge.connectedResident" : "provider.bridge.connected").replace(
            "{port}",
            String(conn.port),
          )}
        </Tag>
        {state?.paired ? (
          <Tag icon={<CheckCircleFilled />} color="success">
            {t("provider.bridge.paired").replace("{nodeId}", state.nodeId ?? "")}
          </Tag>
        ) : null}
      </Space>

      {/* 这句原来在本机那个页面上。界面搬到控制台之后更要说 —— 页面是平台的，
          但这几个请求是浏览器直接发给你自己机器的，凭据一步都没经过平台。 */}
      <Paragraph style={{ marginBottom: 16, color: "var(--manager-text-muted)" }}>
        {t("provider.bridge.localOnly")}
      </Paragraph>

      <Form<PairValues> form={form} layout="vertical" onFinish={(values) => void pair(values)}>
        <Paragraph style={{ marginBottom: 12, color: "var(--manager-text-muted)" }}>
          {t("provider.bridge.hint")}
        </Paragraph>

        <Space size={12} style={{ display: "flex", flexWrap: "wrap" }}>
          {/* 常驻接口的 Hub 在启动时就锁死了，摆一个改不动的输入框只会误导。 */}
          {conn.resident ? null : (
            <Form.Item
              label={t("provider.bridge.hubURL")}
              name="hubURL"
              rules={[{ required: true, message: t("provider.bridge.hubURLRequired") }]}
              style={{ minWidth: 280, flex: 1 }}
            >
              <Input placeholder="http://127.0.0.1:10004" />
            </Form.Item>
          )}
          <Form.Item
            label={t("provider.bridge.displayName")}
            name="displayName"
            style={{ minWidth: 240, flex: 1 }}
          >
            <Input />
          </Form.Item>
        </Space>

        <Form.Item
          label={t("provider.bridge.code")}
          name="code"
          rules={[{ required: true, message: t("provider.bridge.codeRequired") }]}
          extra={code ? t("provider.join.pairExpires").replace("{time}", formatTime(code.expiresAt)) : undefined}
        >
          {/* readOnly 而不是 disabled：disabled 会把文字变灰、也选不中，
              而这串码用户可能想核对或复制；readOnly 只是不让改。 */}
          <Input readOnly autoComplete="off" placeholder={t("provider.bridge.codeAuto")} />
        </Form.Item>

        <Button type="primary" htmlType="submit" loading={pairing}>
          {t("provider.bridge.pair")}
        </Button>
      </Form>

      {conn.resident ? null : (
        <div style={{ marginTop: 24 }}>
          <div style={{ fontWeight: 600, marginBottom: 6 }}>{t("provider.bridge.caps")}</div>
          <Paragraph style={{ marginBottom: 12, color: "var(--manager-text-muted)" }}>
            {t("provider.bridge.capsHint")}
          </Paragraph>
          <CapabilityList capabilities={state?.capabilities ?? []} />
        </div>
      )}

      {repaired ? (
        <Alert
          type="success"
          showIcon
          style={{ marginTop: 16 }}
          message={t("provider.bridge.restarting")}
          description={
            <>
              <Paragraph style={{ marginBottom: 8 }}>{t("provider.bridge.restartingHint")}</Paragraph>
              <Link href="/provider/contributions">{t("provider.bridge.next")}</Link>
            </>
          }
        />
      ) : state?.paired ? (
        <Alert
          type="success"
          showIcon
          style={{ marginTop: 16 }}
          message={t("provider.bridge.nextTitle")}
          description={
            <>
              <Paragraph style={{ marginBottom: 8 }}>{t("provider.bridge.nextHint")}</Paragraph>
              <Link href="/provider/contributions">{t("provider.bridge.next")}</Link>
            </>
          }
        />
      ) : null}

      {/* 本机那个临时接口开着就是攻击面，配完就该关。不关也不会烂在那儿 ——
          15 分钟无操作会自己退 —— 但让用户能主动收工比让他等强。 */}
      {/* 常驻接口不该被「完成」关掉 —— 它一直在才是随时可配的前提。 */}
      {conn.resident ? null : (
        <div style={{ marginTop: 20 }}>
          <Button loading={finishing} onClick={() => void finish()}>
            {t("provider.bridge.finish")}
          </Button>
        </div>
      )}
    </div>
  );
}

/**
 * 探测结果，**只读**。
 *
 * 刻意不画成勾选框：这里根本不接受输入，画成 checkbox 只会让人以为勾了就生效了。
 * 不可用的那条原因是本机报上来的人话（「请运行 claude auth login」），原样显示 ——
 * 它通常直接告诉主人该敲哪条命令。
 */
function CapabilityList({ capabilities }: { capabilities: BridgeCapability[] }) {
  const { t } = useLocale();
  if (capabilities.length === 0) {
    return (
      <Paragraph style={{ color: "var(--manager-text-muted)" }}>{t("provider.bridge.capsEmpty")}</Paragraph>
    );
  }
  return (
    <Space direction="vertical" size={10} style={{ width: "100%" }}>
      {capabilities.map((capability) => {
        const kindKey = `provider.kind.${capability.kind}`;
        const kindName = t(kindKey as never);
        return (
          <div
            key={`${capability.kind}:${capability.provider}`}
            style={{
              display: "flex",
              gap: 10,
              alignItems: "flex-start",
              padding: "10px 12px",
              borderRadius: 8,
              background: "var(--manager-surface-muted, rgba(0,0,0,0.02))",
              opacity: capability.available ? 1 : 0.7,
            }}
          >
            {capability.available ? (
              <CheckCircleFilled style={{ color: "var(--manager-success, #52c41a)", marginTop: 3 }} />
            ) : (
              <ExclamationCircleFilled style={{ color: "var(--manager-warning, #faad14)", marginTop: 3 }} />
            )}
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 600 }}>
                {/* 没有对应文案的 kind 直接显示原值，总比显示一个键名强 */}
                {kindName === kindKey ? capability.kind : kindName} · {capability.provider}
              </div>
              <div style={{ color: "var(--manager-text-muted)", fontSize: 12, wordBreak: "break-word" }}>
                {capability.available ? t("provider.bridge.available") : capability.detail}
              </div>
            </div>
          </div>
        );
      })}
    </Space>
  );
}
