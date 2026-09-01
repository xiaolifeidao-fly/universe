"use client";

import { Download, Share } from "lucide-react";
import { useEffect, useState } from "react";

type DeferredInstallPrompt = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

const DISMISS_KEY = "delivery-mobile.install-dismissed.v1";

function standaloneMode() {
  return window.matchMedia("(display-mode: standalone)").matches || Boolean((navigator as Navigator & { standalone?: boolean }).standalone);
}

function iosSafari() {
  const appleTouchDevice = /iphone|ipad|ipod/i.test(navigator.userAgent)
    || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  return appleTouchDevice && /safari/i.test(navigator.userAgent) && !/crios|fxios|edgios|opios/i.test(navigator.userAgent);
}

export function InstallPrompt() {
  const [deferred, setDeferred] = useState<DeferredInstallPrompt | null>(null);
  const [showIosHelp, setShowIosHelp] = useState(false);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (standaloneMode() || window.localStorage.getItem(DISMISS_KEY)) return;
    const onBeforeInstall = (event: Event) => {
      event.preventDefault();
      setDeferred(event as DeferredInstallPrompt);
      setVisible(true);
    };
    window.addEventListener("beforeinstallprompt", onBeforeInstall);
    if (iosSafari()) setVisible(true);
    return () => window.removeEventListener("beforeinstallprompt", onBeforeInstall);
  }, []);

  if (!visible) return null;

  const dismiss = () => {
    window.localStorage.setItem(DISMISS_KEY, "1");
    setVisible(false);
  };

  const install = async () => {
    if (!deferred) {
      setShowIosHelp(true);
      return;
    }
    await deferred.prompt();
    const choice = await deferred.userChoice;
    if (choice.outcome === "accepted") setVisible(false);
    setDeferred(null);
  };

  return (
    <aside className="install-prompt" aria-live="polite">
      <div className="install-prompt__title">
        {showIosHelp ? <Share size={18} aria-hidden="true" /> : <Download size={18} aria-hidden="true" />}
        {showIosHelp ? "添加到主屏幕" : "安装交付台"}
      </div>
      <p>{showIosHelp ? "在 Safari 点按分享，再选择“添加到主屏幕”。" : "添加到主屏幕后，可从桌面快速打开并保留离线应用壳。"}</p>
      <div className="install-prompt__actions">
        <button className="button button-quiet" type="button" onClick={dismiss}>
          稍后
        </button>
        <button className="button button-primary" type="button" onClick={() => void install()}>
          {deferred ? "安装" : "查看方法"}
        </button>
      </div>
    </aside>
  );
}
