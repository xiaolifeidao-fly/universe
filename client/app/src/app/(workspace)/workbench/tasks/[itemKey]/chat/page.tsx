import { Suspense } from "react";
import { LoadingState } from "@/components/loading-state";
import { ConversationScreen } from "@/components/workbench/conversation-screen";

export default function TaskChatPage({ params }: { params: { itemKey: string } }) {
  const itemKey = decodeURIComponent(params.itemKey);
  return (
    <Suspense fallback={<LoadingState title="正在打开任务对话" />}>
      <ConversationScreen scope="task" targetKey={itemKey} title={itemKey} />
    </Suspense>
  );
}
