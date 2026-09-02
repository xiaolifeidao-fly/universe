import { Suspense } from "react";
import { LoadingState } from "@/components/loading-state";
import { WorkbenchScreen } from "@/components/workbench/workbench-screen";

export default function WorkbenchPage() {
  return (
    <Suspense fallback={<LoadingState title="正在打开工作台" />}>
      <WorkbenchScreen />
    </Suspense>
  );
}
