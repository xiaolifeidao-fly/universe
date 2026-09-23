const labels: Record<string, string> = {
  active: "推进中",
  attention: "需关注",
  paused: "已暂停",
  done: "已完成",
};

const classNames: Record<string, string> = {
  active: "is-active",
  attention: "is-warning",
  paused: "is-danger",
  done: "is-active",
};

export function ProjectStatus({ status }: { status: string }) {
  return <span className={`status ${classNames[status] ?? "is-warning"}`}>{(labels[status] ?? status) || "未设置"}</span>;
}
