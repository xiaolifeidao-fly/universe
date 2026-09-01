import type { ReactNode } from "react";

export function EmptyState({ icon, title, description, action }: { icon: ReactNode; title: string; description: string; action?: ReactNode }) {
  return (
    <section className="card empty-state">
      <div className="empty-state__icon" aria-hidden="true">{icon}</div>
      <h2>{title}</h2>
      <p>{description}</p>
      {action ? <div className="stack-actions" style={{ justifyContent: "center", marginTop: 16 }}>{action}</div> : null}
    </section>
  );
}
