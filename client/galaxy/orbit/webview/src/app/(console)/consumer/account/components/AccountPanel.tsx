"use client";

/**
 * 账户。
 *
 * 资料只读、密钥概况、数据告知、界面语言、改密码、退出登录。改密码是单独一页（/password）：
 * 运营重置过密码的人登进来也被挡到那一页，两种人共用一套表单。
 * 原型上还画了发票抬头、设备列表 —— 这一版只做已经有真实数据支撑的部分。
 */

import { message } from "antd";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { PageHeader } from "@/components/shell/GalaxyShell";
import { IconKey, IconLock, IconLogout, IconShield } from "@/components/ui/icons";
import { Btn, Card, CardHead, Loading, Note, Pill, Seg } from "@/components/ui/kit";
import { useLocale } from "@/i18n/LocaleProvider";
import { clearAuthToken, getAuthUser, isAuthTokenRemembered, setAuthUser, type AuthUser } from "@/utils/auth";
import { formatCompact } from "@/utils/format";
import { acceptNotice, fetchDashboard, fetchNotice, type ConsumerDashboard, type NoticeStatus } from "../../api/consumer.api";
import { fetchCurrentAccount } from "../api/account.api";

export function AccountPanel() {
  const { t, locale, setLocale } = useLocale();
  const router = useRouter();
  const [user, setUser] = useState<AuthUser | null>(null);
  const [dashboard, setDashboard] = useState<ConsumerDashboard | null>(null);
  const [notice, setNotice] = useState<NoticeStatus | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const [summary, noticeResult] = await Promise.all([fetchDashboard(), fetchNotice()]);
      setDashboard(summary);
      setNotice(noticeResult);
    } catch (error) {
      message.error((error as Error).message || t("common.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    let alive = true;
    setUser(getAuthUser());
    // 本地那份是登录那一刻的快照，现取一次把昵称这些对齐。取不到就先用快照，不弹报错。
    void fetchCurrentAccount()
      .then((fresh) => {
        if (!alive) return;
        setUser(fresh);
        setAuthUser(fresh, isAuthTokenRemembered());
      })
      .catch(() => undefined);
    void load();
    return () => {
      alive = false;
    };
  }, [load]);

  // 同密钥卡片：只看输出 token，那才是计费口径。
  const balance = dashboard?.balance?.["llm.output_tokens"] ?? 0;

  return (
    <>
      <PageHeader title={t("account.title")} meta={t("account.subtitle")} />
      <div className="gx-body">
        <Card className="gx-rise">
          <CardHead title={t("account.profile")} />
          <div style={{ display: "flex", alignItems: "center", gap: 16, padding: "0 22px 20px" }}>
            <span className="gx-avatar" style={{ width: 56, height: 56, fontSize: 22 }}>
              {(user?.displayName || user?.username || "·").slice(0, 1)}
            </span>
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <span style={{ fontSize: 17, fontWeight: 600 }}>{user?.displayName || user?.username || "—"}</span>
              <span className="gx-mono" style={{ fontSize: 12, color: "var(--gx-faint)" }}>
                {user?.username}
              </span>
            </div>
          </div>
        </Card>

        <Card className="gx-rise gx-rise--1">
          <CardHead title={t("account.keys")} />
          {loading ? (
            <Loading />
          ) : (
            <div style={{ display: "flex", alignItems: "center", gap: 14, padding: "0 22px 20px" }}>
              <IconKey size={18} style={{ color: "var(--gx-faint)" }} />
              <span style={{ flex: 1, fontSize: 13.5 }}>
                {t("account.keysHint", { active: dashboard?.activeKeys ?? 0, total: dashboard?.keys ?? 0 })}
              </span>
              <span className="gx-mono" style={{ fontSize: 13 }}>
                {formatCompact(balance)} tokens
              </span>
              <Btn tone="ghost" small onClick={() => router.push("/consumer/keys")}>
                {t("nav.keys")}
              </Btn>
            </div>
          )}
        </Card>

        <Card className="gx-rise gx-rise--2">
          <CardHead title={t("account.notice")} />
          <div style={{ display: "flex", alignItems: "center", gap: 14, padding: "0 22px 20px" }}>
            <IconShield size={18} style={{ color: "var(--gx-faint)" }} />
            <span style={{ flex: 1, fontSize: 12.5, lineHeight: 1.65, color: "var(--gx-soft)" }}>{t("notice.body")}</span>
            {notice?.accepted ? (
              <Pill tone="ok">{t("notice.accepted", { version: notice.version })}</Pill>
            ) : (
              <Btn
                tone="accent"
                small
                onClick={async () => {
                  try {
                    await acceptNotice();
                    void load();
                  } catch (error) {
                    message.error((error as Error).message || t("common.actionFailed"));
                  }
                }}
              >
                {t("notice.accept")}
              </Btn>
            )}
          </div>
        </Card>

        <Card className="gx-rise gx-rise--2">
          <CardHead title={t("account.security")} hint={t("account.securityHint")} />
          <div style={{ display: "flex", alignItems: "center", gap: 16, padding: "0 22px 20px" }}>
            <span style={{ fontSize: 13, color: "var(--gx-soft)" }}>{t("account.locale")}</span>
            <Seg
              value={locale}
              onChange={(next) => setLocale(next)}
              options={[
                { value: "zh-CN" as const, label: t("locale.zh-CN") },
                { value: "en-US" as const, label: t("locale.en-US") },
              ]}
            />
            <span style={{ flex: 1 }} />
            <Btn tone="ghost" icon={<IconLock size={16} />} onClick={() => router.push("/password")}>
              {t("account.changePassword")}
            </Btn>
            <Btn
              tone="ghost"
              icon={<IconLogout size={16} />}
              onClick={() => {
                clearAuthToken();
                router.replace("/login");
              }}
            >
              {t("account.logout")}
            </Btn>
          </div>
        </Card>

        <Card className="gx-rise gx-rise--3">
          <CardHead title={t("account.danger")} />
          <div style={{ padding: "0 22px 20px", display: "flex", flexDirection: "column", gap: 12 }}>
            <Note tone="danger">{t("account.dangerHint")}</Note>
            <span className="gx-card__hint">{t("account.dangerContact")}</span>
          </div>
        </Card>
      </div>
    </>
  );
}
