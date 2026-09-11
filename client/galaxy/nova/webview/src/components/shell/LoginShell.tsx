"use client";

/**
 * 登录、注册、改密码三页共用的骨架：左边是「为什么要用它」，右边是表单。
 *
 * 桌面应用的登录页只会被看到几次，但每一次都是第一印象 —— 所以左边那半屏
 * 不是装饰：三条卖点回答的是新用户此刻真正在犹豫的事，注册页上尤其如此。
 * 改密码页用不上卖点，但换一副骨架反而像跳进了另一个应用。
 *
 * 右边那一栏能滚：注册有四个输入框，窗口压到最矮时会比这一栏高，
 * 而 body 是 overflow: hidden 的 —— 不滚就会把提交按钮裁掉。
 */

import type { FormEvent, PropsWithChildren, ReactNode } from "react";
import { IconCheck } from "@/components/ui/icons";
import { useLocale } from "@/i18n/LocaleProvider";
import { productConfig } from "@/utils/product";

export function LoginShell({
  subtitle,
  foot,
  onSubmit,
  children,
}: PropsWithChildren<{ subtitle: ReactNode; foot?: ReactNode; onSubmit: (event: FormEvent) => void }>) {
  const { t } = useLocale();
  return (
    <main className="gx-login">
      <section className="gx-login__hero">
        <div className="gx-login__tagline">
          {t("login.tagline1")}
          <br />
          {t("login.tagline2")}
        </div>
        <div className="gx-login__points">
          {["1", "2", "3"].map((index) => (
            <div className="gx-login__point" key={index}>
              <span
                style={{
                  width: 22,
                  height: 22,
                  flex: "0 0 auto",
                  borderRadius: "50%",
                  display: "grid",
                  placeItems: "center",
                  background: "var(--gx-accent-soft)",
                  color: "var(--gx-accent)",
                }}
              >
                <IconCheck size={13} />
              </span>
              <span>
                <span style={{ display: "block", fontSize: 13.5, fontWeight: 600 }}>{t(`login.point${index}.title`)}</span>
                <span style={{ display: "block", fontSize: 12.5, lineHeight: 1.65, color: "var(--gx-faint)", marginTop: 2 }}>
                  {t(`login.point${index}.desc`)}
                </span>
              </span>
            </div>
          ))}
        </div>
      </section>

      <section className="gx-login__form" style={{ overflowY: "auto" }}>
        {/* 上下 auto 外边距代替居中：放得下时照样居中，放不下时从顶上开始排、可以滚到底。 */}
        <form className="gx-login__panel" style={{ marginBlock: "auto" }} onSubmit={onSubmit}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 6 }}>
            <span className="gx-serif" style={{ fontSize: 24 }}>
              {productConfig.name}
            </span>
            <span className="gx-mono" style={{ fontSize: 10.5, letterSpacing: "0.14em", color: "var(--gx-faint)" }}>
              {t("brand.subtitle")}
            </span>
          </div>
          <div style={{ fontSize: 13, color: "var(--gx-faint)", marginBottom: 22 }}>{subtitle}</div>

          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>{children}</div>

          {foot ? (
            <p style={{ marginTop: 26, marginBottom: 0, fontSize: 11.5, lineHeight: 1.7, color: "var(--gx-faint)" }}>{foot}</p>
          ) : null}
        </form>
      </section>
    </main>
  );
}
