import { Suspense } from "react";
import { LoadingState } from "@/components/loading-state";
import { ConversationScreen } from "@/components/workbench/conversation-screen";

export default function RequirementChatPage({ params }: { params: { requirementKey: string } }) {
  const requirementKey = decodeURIComponent(params.requirementKey);
  return (
    <Suspense fallback={<LoadingState title="正在打开需求对话" />}>
      <ConversationScreen scope="requirement" targetKey={requirementKey} title={requirementKey} />
    </Suspense>
  );
}
