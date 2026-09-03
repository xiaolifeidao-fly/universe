"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Bell, LogOut, ShieldCheck, Smartphone } from "lucide-react";
import { ApiError } from "@/api/client";
import { getPushConfig, removePushSubscription, savePushSubscription, type PushConfig } from "@/api/push.api";
import { clearSession, getSession } from "@/lib/auth";
import { useSpace } from "@/components/space-provider";
import { SpaceSwitcher } from "@/components/space-switcher";

type NoticeState = "loading" | "ready" | "unavailable" | "disabled" | "denied" | "error";

function applicationServerKey(value: string) {
  const padded = `${value.replace(/-/g, "+").replace(/_/g, "/")}${"=".repeat((4 - (value.length % 4)) % 4)}`;
  const bytes = window.atob(padded);
  return Uint8Array.from(bytes, (character) => character.charCodeAt(0));
}

function browserSupportsPush() {
  return typeof window !== "undefined" && "serviceWorker" in navigator && "Notification" in window && "PushManager" in window;
}

export function SettingsScreen() {
  const router = useRouter();
  const { spaceName, bizLine, canWrite } = useSpace();
  const [session, setSession] = useState<ReturnType<typeof getSession>>(null);
  const [notices, setNotices] = useState(false);
  const [noticeState, setNoticeState] = useState<NoticeState>("loading");
  const [noticeMessage, setNoticeMessage] = useState("");
  const [pushConfig, setPushConfig] = useState<PushConfig | null>(null);
  const [updatingNotices, setUpdatingNotices] = useState(false);

  useEffect(() => {
    setSession(getSession());
    let active = true;
    const loadPushState = async () => {
      if (!browserSupportsPush()) {
        if (active) { setNoticeState("unavailable"); setNoticeMessage("当前浏览器不支持通知订阅。"); }
        return;
      }
      try {
        const config = await getPushConfig();
        if (!active) return;
        setPushConfig(config);
        if (!config.enabled) {
          setNoticeState("disabled");
          setNoticeMessage("服务端尚未配置通知服务。");
          return;
        }
        if (Notification.permission === "denied") {
          setNoticeState("denied");
          setNoticeMessage("通知权限已被拒绝，请在浏览器设置中重新开启。");
          return;
        }
        if (process.env.NODE_ENV !== "production") {
          setNoticeState("unavailable");
          setNoticeMessage("通知订阅仅在生产 PWA 中启用。");
          return;
        }
        const registration = await navigator.serviceWorker.ready;
        const subscription = await registration.pushManager.getSubscription();
        if (active) { setNotices(Boolean(subscription)); setNoticeState("ready"); setNoticeMessage(subscription ? "此设备已接收后台通知。" : "可在此设备接收后台通知。"); }
      } catch (reason) {
        if (active) {
          setNoticeState("error");
          setNoticeMessage(reason instanceof ApiError ? reason.message : "无法读取通知状态。");
        }
      }
    };
    void loadPushState();
    return () => { active = false; };
  }, []);

  const toggleNotices = async (enabled: boolean) => {
    if (!pushConfig?.enabled || !browserSupportsPush() || updatingNotices) return;
    setUpdatingNotices(true);
    setNoticeMessage("");
    try {
      const registration = await navigator.serviceWorker.ready;
      const current = await registration.pushManager.getSubscription();
      if (!enabled) {
        if (current) {
          await removePushSubscription(current.endpoint);
          await current.unsubscribe();
        }
        setNotices(false);
        setNoticeMessage("此设备已停止接收通知。");
        return;
      }
      if (Notification.permission !== "granted" && await Notification.requestPermission() !== "granted") {
        setNotices(false);
        setNoticeState("denied");
        setNoticeMessage("需要通知权限才能开启提醒。");
        return;
      }
      const subscription = current ?? await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: applicationServerKey(pushConfig.applicationServerKey),
      });
      const json = subscription.toJSON();
      const p256dh = json.keys?.p256dh;
      const auth = json.keys?.auth;
      if (!json.endpoint || !p256dh || !auth) throw new Error("浏览器返回的订阅信息不完整。");
      try {
        await savePushSubscription({ endpoint: json.endpoint, keys: { p256dh, auth } });
      } catch (reason) {
        if (!current) await subscription.unsubscribe();
        throw reason;
      }
      setNotices(true);
      setNoticeState("ready");
      setNoticeMessage("此设备已接收后台通知。");
    } catch (reason) {
      setNotices(false);
      setNoticeState("error");
      setNoticeMessage(reason instanceof ApiError ? reason.message : reason instanceof Error ? reason.message : "通知订阅未完成。");
    } finally {
      setUpdatingNotices(false);
    }
  };

  const signOut = () => {
    clearSession();
    router.replace("/login");
  };

  return (
    <main className="screen">
      <div className="screen-title-row"><div><p className="eyebrow">账户与设备</p><h1>设置</h1><p>管理当前移动工作台会话。</p></div></div>
      <section className="card">
        <h2 className="section-heading"><span>{session?.user.displayName || "当前用户"}</span><ShieldCheck size={21} aria-hidden="true" /></h2>
        <div className="detail-list">
          <div className="detail-row"><span>账号</span><strong>{session?.user.username || "-"}</strong></div>
          <div className="detail-row"><span>当前空间</span><strong>{spaceName || "-"}</strong></div>
          <div className="detail-row"><span>空间编码</span><strong>{bizLine || "-"}</strong></div>
          <div className="detail-row"><span>本空间权限</span><strong>{canWrite ? "可写入" : "只读"}</strong></div>
          <div className="detail-row"><span>可访问空间</span><SpaceSwitcher /></div>
        </div>
      </section>
      <section className="card section">
        <h2 className="section-heading"><span>通知</span><Bell size={21} aria-hidden="true" /></h2>
        <div className="detail-row"><span>后台通知</span><label className="notification-switch"><input type="checkbox" checked={notices} onChange={(event) => void toggleNotices(event.target.checked)} disabled={noticeState !== "ready" || updatingNotices} aria-label="后台通知" /><span aria-hidden="true" /></label></div>
        <p className={`field-help${noticeState === "error" || noticeState === "denied" ? " is-error" : ""}`}>{noticeState === "loading" ? "正在读取通知状态。" : noticeMessage}</p>
      </section>
      <section className="card section">
        <h2 className="section-heading"><span>此设备</span><Smartphone size={21} aria-hidden="true" /></h2>
        <p className="muted" style={{ margin: 0 }}>可添加到主屏幕。离线时会保留应用壳，不会直接连接本机执行器。</p>
      </section>
      <button className="button button-secondary full-width" style={{ marginTop: 14 }} type="button" onClick={signOut}><LogOut size={20} aria-hidden="true" />退出登录</button>
    </main>
  );
}
