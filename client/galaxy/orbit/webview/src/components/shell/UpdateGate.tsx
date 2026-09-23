"use client";

/**
 * 桌面壳的版本更新提示。
 *
 * 界面部署在远端，桌面壳装在用户机器上 —— 页面天天都是最新的，壳不是。这一块就是
 * 壳那一侧的更新入口：主进程去 OSS 上问清单、下载、装（common/electron/update/），
 * 这里只负责「问用户要不要」和把进度画出来。
 *
 * 三条产品决定：
 *
 *   1. **不强制**。有新版本先弹一次，用户点「稍后再说」就记下这个版本号，
 *      直到下一版才会再问（记在 localStorage，换一台机器会重新问一次，可以接受）。
 *   2. **下载可以转后台**。弹窗随时能关，下载不会跟着停；关掉之后右下角留一个小胶囊，
 *      点回来还是这个弹窗。
 *   3. **失败不打扰**。后台检查失败（断网、清单还没发）一律安静吞掉，只有用户正看着
 *      弹窗的时候才把失败摆出来 —— 更新出问题不该变成一个天天弹的错误框。
 *
 * 浏览器里、以及装着旧版壳的人打开这个新页面时，`isAvailable()` 是 false，整块不画。
 */

import { Modal, message } from "antd";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { UpdateApi } from "@galaxy/common/eleapi/update.api";
import { idleUpdateStatus, type UpdateStatus } from "@galaxy/common/eleapi/update.model";
import { Btn, Meter, Note } from "@/components/ui/kit";
import { useLocale } from "@/i18n/LocaleProvider";
import { formatBytes } from "@/utils/format";

/** 用户说过「稍后再说」的那个版本号。按版本记，不是一个永久的「别再烦我」。 */
const SKIPPED_KEY = "galaxy-update-skipped";

// 正在检查 / 正在下载时问得勤一点，其余时候三十秒一次。
// 一次 getStatus() 就是读主进程里的一个结构，没有网络请求。
const FAST_POLL = 1500;
const SLOW_POLL = 30_000;

export function UpdateGate() {
  const { t } = useLocale();
  const api = useMemo(() => new UpdateApi(), []);
  const [status, setStatus] = useState<UpdateStatus>(idleUpdateStatus);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  /**
   * 用户刚点过按钮。它只有一个用处：把下面那条轮询立刻重排一次。
   *
   * 点「立即更新」的那一刻，轮询多半正停在三十秒那一档（上一轮看到的还是
   * available），不踢它一脚的话进度条会先愣住半分钟 —— 看上去就是点了没反应。
   */
  const [pulse, setPulse] = useState(0);
  const skipped = useRef("");
  /** 已经为哪一件事自动弹过窗。同一个版本不重复弹，用户关掉就是关掉了。 */
  const prompted = useRef("");

  useEffect(() => {
    if (!api.isAvailable()) return undefined;
    // 无痕窗口、禁用站点数据时读它会抛。读不到就是「没跳过任何版本」。
    try {
      skipped.current = window.localStorage.getItem(SKIPPED_KEY) ?? "";
    } catch {
      skipped.current = "";
    }
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      let next: UpdateStatus | null = null;
      try {
        next = await api.getStatus();
      } catch {
        // 壳里那条 IPC 出问题不该把页面带下去，下一轮再问。
        next = null;
      }
      if (!alive) return;
      if (next) {
        setStatus(next);
        const mark = `${next.state}:${next.version}`;
        const fresh = next.state === "available" && next.version && next.version !== skipped.current;
        // 下完了一定要弹一次：这时候要的是一次重启，用户不点就永远停在旧版本上。
        if ((fresh || next.state === "downloaded") && prompted.current !== mark) {
          prompted.current = mark;
          setOpen(true);
        }
      }
      const fast = next?.state === "checking" || next?.state === "downloading";
      timer = setTimeout(() => void tick(), fast ? FAST_POLL : SLOW_POLL);
    };
    void tick();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
    // pulse 变了就重来一遍：清掉在排的那个 timeout，立刻再问一次。
  }, [api, pulse]);

  const run = useCallback(
    async (action: () => Promise<UpdateStatus>) => {
      setBusy(true);
      try {
        setStatus(await action());
      } catch (error) {
        message.error((error as Error).message || t("update.failed"));
      } finally {
        setBusy(false);
        setPulse((value) => value + 1);
      }
    },
    [t],
  );

  /** 「稍后再说」：记下版本号，这一版不再弹。下一版照问。 */
  const later = () => {
    skipped.current = status.version;
    try {
      window.localStorage.setItem(SKIPPED_KEY, status.version);
    } catch {
      /* 存不下就只是这次会话内不再弹 */
    }
    setOpen(false);
  };

  if (!api.isAvailable()) return null;

  const { state } = status;
  const showPill = !open && (state === "downloading" || state === "downloaded");
  const inModal = open && (state === "available" || state === "downloading" || state === "downloaded" || state === "error");

  return (
    <>
      {showPill ? (
        <button type="button" className="gx-update-pill" onClick={() => setOpen(true)}>
          <span className="gx-update-pill__dot" />
          {state === "downloading"
            ? t("update.pillDownloading", { percent: status.percent })
            : t("update.pillReady")}
        </button>
      ) : null}

      <Modal
        open={inModal}
        title={modalTitle(status, t)}
        onCancel={() => setOpen(false)}
        footer={footer(status, {
          t,
          busy,
          later,
          close: () => setOpen(false),
          download: () => void run(() => api.download()),
          install: () => void run(() => api.install()),
          check: () => void run(() => api.check()),
        })}
        width={460}
        destroyOnHidden
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 14, paddingTop: 4 }}>
          <span className="gx-card__hint gx-mono">
            {t("update.version", { current: status.currentVersion || "—", next: status.version || "—" })}
          </span>

          {state === "available" && status.notes ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <span className="gx-label">{t("update.notes")}</span>
              {/* 版本说明是运营在管理端写的纯文本，按原样换行展示，不解析任何标记。 */}
              <span style={{ whiteSpace: "pre-wrap", fontSize: 13, color: "var(--gx-soft)" }}>{status.notes}</span>
            </div>
          ) : null}

          {state === "downloading" ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <span className="gx-card__hint">{t("update.downloading")}</span>
              <Meter used={status.percent} limit={100} />
              <span className="gx-card__hint gx-mono">
                {status.total > 0
                  ? `${formatBytes(status.transferred)} / ${formatBytes(status.total)}`
                  : `${status.percent}%`}
              </span>
            </div>
          ) : null}

          {state === "downloaded" ? (
            <span className="gx-card__hint">
              {status.manualInstall ? t("update.manualHint") : t("update.readyHint")}
            </span>
          ) : null}

          {/* 出错的原文一起给：运维要的正是 "Cannot find latest-mac.yml" 这种原话。 */}
          {state === "error" && status.message ? <Note tone="warn">{status.message}</Note> : null}
        </div>
      </Modal>
    </>
  );
}

function modalTitle(status: UpdateStatus, t: (key: string, vars?: Record<string, string | number>) => string): string {
  if (status.state === "error") return t("update.failed");
  if (status.state !== "downloaded") return t("update.title");
  return status.manualInstall ? t("update.manualTitle") : t("update.readyTitle");
}

function footer(
  status: UpdateStatus,
  actions: {
    t: (key: string, vars?: Record<string, string | number>) => string;
    busy: boolean;
    later: () => void;
    close: () => void;
    download: () => void;
    install: () => void;
    check: () => void;
  },
) {
  const { t, busy } = actions;
  if (status.state === "error") {
    return [
      <Btn key="close" tone="ghost" onClick={actions.close}>
        {t("update.dismiss")}
      </Btn>,
      <Btn key="retry" tone="accent" loading={busy} onClick={actions.check}>
        {t("update.retry")}
      </Btn>,
    ];
  }
  if (status.state === "downloading") {
    return [
      <Btn key="bg" tone="ghost" onClick={actions.close}>
        {t("update.background")}
      </Btn>,
    ];
  }
  if (status.state === "downloaded") {
    return [
      <Btn key="later" tone="ghost" onClick={actions.close}>
        {status.manualInstall ? t("update.dismiss") : t("update.restartLater")}
      </Btn>,
      <Btn key="install" tone="accent" loading={busy} onClick={actions.install}>
        {status.manualInstall ? t("update.openFile") : t("update.restart")}
      </Btn>,
    ];
  }
  return [
    <Btn key="later" tone="ghost" onClick={actions.later}>
      {t("update.later")}
    </Btn>,
    <Btn key="now" tone="accent" loading={busy} onClick={actions.download}>
      {t("update.now")}
    </Btn>,
  ];
}
