import { CircleDashed } from "lucide-react";
import { EmptyState } from "@/components/empty-state";

export function LoadingState({ title = "正在加载" }: { title?: string }) {
  return <EmptyState icon={<CircleDashed size={21} className="spin-icon" />} title={title} description="正在从服务端恢复最新数据。" />;
}
