import { Suspense } from "react";
import { LoadingState } from "@/components/loading-state";
import { NewRequirementScreen } from "@/components/workbench/new-requirement-screen";

export default function NewRequirementChatPage() {
  return (
    <Suspense fallback={<LoadingState title="正在打开需求对话" />}>
      <NewRequirementScreen />
    </Suspense>
  );
}
