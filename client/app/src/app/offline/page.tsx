import { WifiOff } from "lucide-react";

export default function OfflinePage() {
  return (
    <main className="offline-page">
      <div className="offline-mark" aria-hidden="true">
        <WifiOff size={30} strokeWidth={2.2} />
      </div>
      <h1>暂时无法连接</h1>
      <p>应用壳已经保留。连接恢复后可继续查看最新交付信息。</p>
      <a className="button button-primary" href="/">
        再试一次
      </a>
    </main>
  );
}
