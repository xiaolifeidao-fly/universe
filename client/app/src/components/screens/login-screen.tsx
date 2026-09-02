"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Command, LogIn } from "lucide-react";
import { signIn } from "@/api/auth.api";
import { ApiError } from "@/api/client";
import { canAccessWorkspaceRoute, defaultWorkspaceRoute, getSession, saveSession } from "@/lib/auth";
import { getLastRoute } from "@/lib/navigation";

export function LoginScreen() {
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (getSession()) router.replace(getLastRoute() || "/");
  }, [router]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitting(true);
    setError("");
    try {
      const session = await signIn(username.trim(), password);
      saveSession(session, remember);
      const next = new URLSearchParams(window.location.search).get("next");
      const remembered = getLastRoute();
      const fallback = defaultWorkspaceRoute(session);
      const target = next?.startsWith("/") ? next : remembered || fallback;
      router.replace(canAccessWorkspaceRoute(target, session) ? target : fallback);
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.message : "暂时无法登录，请稍后重试。");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="login-screen">
      <div className="login-panel">
        <div className="login-brand">
          <span className="brand-mark" aria-hidden="true"><Command size={20} strokeWidth={2.3} /></span>
          <strong>交付台</strong>
        </div>
        <section className="login-card">
          <p className="eyebrow">移动工作台</p>
          <h1 className="login-title">继续你的交付工作</h1>
          <p className="login-copy">登录后可恢复最近查看的位置和未完成操作。</p>
          <form className="login-form" onSubmit={submit}>
            <div className="field">
              <label htmlFor="username">账号</label>
              <input id="username" autoComplete="username" value={username} onChange={(event) => setUsername(event.target.value)} required />
            </div>
            <div className="field">
              <label htmlFor="password">密码</label>
              <input id="password" type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required />
            </div>
            <label className="muted" style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <input type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)} />
              在此设备保留登录状态
            </label>
            {error ? <p className="form-message is-error" role="alert">{error}</p> : null}
            <button className="button button-primary full-width" type="submit" disabled={submitting}>
              <LogIn size={18} aria-hidden="true" />
              {submitting ? "正在登录" : "登录"}
            </button>
          </form>
        </section>
      </div>
    </main>
  );
}
