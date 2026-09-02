import type { ReactNode } from "react";

/** tone 决定图标底色：默认走品牌靛蓝，error 走危险红，和 PC 的状态语义一致。 */
export function EmptyState({
  icon,
  title,
  description,
  action,
  tone = "default",
}: {
  icon: ReactNode;
  title: string;
  description: string;
  action?: ReactNode;
  tone?: "default" | "error";
}) {
  return (
    <section className={`card empty-state${tone === "error" ? " is-error" : ""}`}>
      <div className="empty-state__icon" aria-hidden="true">{icon}</div>
      <h2>{title}</h2>
      <p>{description}</p>
      {action ? <div className="stack-actions" style={{ justifyContent: "center", marginTop: 16 }}>{action}</div> : null}
    </section>
  );
}
