import { Suspense } from "react";
import { LoadingState } from "@/components/loading-state";
import { ProgressScreen } from "@/components/workbench/progress-screen";

export default function RequirementProgressPage({ params }: { params: { requirementKey: string } }) {
  return (
    <Suspense fallback={<LoadingState title="正在读取任务进度" />}>
      <ProgressScreen requirementKey={decodeURIComponent(params.requirementKey)} />
    </Suspense>
  );
}
