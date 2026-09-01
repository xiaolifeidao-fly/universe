"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { WifiOff } from "lucide-react";

const NetworkContext = createContext(true);

export function NetworkProvider({ children }: { children: ReactNode }) {
  const [online, setOnline] = useState(true);

  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    update();
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);

  return <NetworkContext.Provider value={online}>{children}</NetworkContext.Provider>;
}

export function useNetworkStatus() {
  return useContext(NetworkContext);
}

export function ConnectionBanner() {
  const online = useNetworkStatus();
  if (online) return null;
  return (
    <aside className="connection-banner" role="status">
      <p>
        <WifiOff size={15} aria-hidden="true" style={{ verticalAlign: "-2px", marginRight: 6 }} />
        当前离线。已打开的页面仍可使用，联网后会恢复最新数据。
      </p>
    </aside>
  );
}
