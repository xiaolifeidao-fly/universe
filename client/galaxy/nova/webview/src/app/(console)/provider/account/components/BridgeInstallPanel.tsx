"use client";

/**
 * 安装 ai-bridge：服务器上独立部署的那一份从这里拿。
 *
 * 摆在「其他机器」和「接入密钥」中间，照着接一台服务器的顺序：先装，再拿密钥注册。
 * 真正拿去用的那条一行命令在签发密钥的弹窗里 —— 带着刚签出来的密钥，装完直接注册；
 * 这里是占位符版本外加安装包下载，给密钥已经在手上的人，和机器上拉不到脚本、只能拷包进去的人。
 *
 * 默认停在 Linux：要单独装 ai-bridge 的多半是机房服务器，不是主人坐着的这台 —— 这台的 Nova 自带一份。
 *
 * 手动安装默认收起：一行命令能用时没人去看，摊开就是一大块没人复制的代码。
 * 这里只列最短的几步，长版本在安装包里的 README。
 */

import { message } from "antd";
import { useState, type ReactNode } from "react";
import { IconCheck, IconChevronDown, IconCopy, IconDownload } from "@/components/ui/icons";
import { Btn, Card, CardHead, Loading, Note } from "@/components/ui/kit";
import { useLocale } from "@/i18n/LocaleProvider";
import { copyText, formatBytes, formatDay } from "@/utils/format";
import { openExternal } from "@/utils/shell";
import type { BridgeReleaseManifest, BridgeReleasePackage } from "../../api/provider.api";
import { Blank, CommandBlock, TabStrip } from "./parts";

type Os = "linux" | "darwin" | "windows";

const SYSTEMS: { value: Os; label: string }[] = [
  { value: "linux", label: "Linux" },
  { value: "darwin", label: "macOS" },
  { value: "windows", label: "Windows" },
];

const ellipsis = { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } as const;

/** 一行装好并注册。签发密钥的弹窗里那条带真密钥的也用它，写法只有一处。 */
export function unixInstallCommand(script: string, key: string): string {
  return `curl -fsSL ${script} | sh -s -- --key ${key}`;
}

function windowsInstallCommand(script: string, key: string): string {
  return `powershell -ExecutionPolicy Bypass -Command "& ([scriptblock]::Create((irm ${script}))) -Key ${key}"`;
}

/** 平台名是 <系统>-<架构>。 */
function splitPlatform(platform: string): { os: string; arch: string } {
  const [os = "", ...rest] = (platform ?? "").split("-");
  return { os, arch: rest.join("-") };
}

function shortHash(hash: string): string {
  const value = hash ?? "";
  return value.length > 16 ? `${value.slice(0, 8)}…${value.slice(-4)}` : value;
}

/**
 * 最短的手动步骤，装出来和安装脚本同一个样子：整包解进安装目录（deploy/ 模板跟着一起），软链进 PATH。
 *
 * chown 那一行不能省：远程升级要替换可执行文件，目录不归运行它的用户，节点就报「目录不可写」，
 * 上面机器列表里那台只剩一句原因、没有升级按钮。
 */
function manualCommand(os: Os, item: BridgeReleasePackage, hub: string): string {
  const file = item.fileName ?? "";
  const stem = file.replace(/\.(tar\.gz|zip)$/, "");
  if (os === "windows") {
    const exe = `"$env:LOCALAPPDATA\\ai-bridge\\ai-bridge.exe"`;
    return [
      `Expand-Archive .\\${file} $env:TEMP -Force`,
      `New-Item -ItemType Directory -Force "$env:LOCALAPPDATA\\ai-bridge" | Out-Null`,
      `Copy-Item "$env:TEMP\\${stem}\\*" "$env:LOCALAPPDATA\\ai-bridge" -Recurse -Force`,
      `& ${exe} register --hub ${hub} --key gpk-…`,
      `& ${exe} run`,
    ].join("\n");
  }
  return [
    "sudo mkdir -p /opt/ai-bridge",
    `sudo tar -xzf ${file} -C /opt/ai-bridge --strip-components 1`,
    `sudo chown -R "$(id -un)" /opt/ai-bridge`,
    "sudo ln -sf /opt/ai-bridge/ai-bridge /usr/local/bin/ai-bridge",
    `ai-bridge register --hub ${hub} --key gpk-…`,
    "ai-bridge run",
  ].join("\n");
}

export function BridgeInstallPanel({
  manifest,
  failed,
  hubUrl,
  onRetry,
}: {
  /** null 是还没拿到。 */
  manifest: BridgeReleaseManifest | null;
  failed: boolean;
  /** 清单里没带 Hub 地址时的退路，同接入密钥那一块。 */
  hubUrl: string;
  onRetry: () => void;
}) {
  const { t } = useLocale();
  const [picked, setPicked] = useState<Os | null>(null);
  const [showManual, setShowManual] = useState(false);

  const packages = manifest?.platforms ?? [];
  // 没挑过就停在第一个有包的系统上（Linux → macOS → Windows），一个包都没有时是 Linux。
  const os = picked ?? SYSTEMS.find((system) => packages.some((item) => splitPlatform(item.platform).os === system.value))?.value ?? "linux";
  const osLabel = SYSTEMS.find((system) => system.value === os)?.label ?? os;
  const mine = packages.filter((item) => splitPlatform(item.platform).os === os);
  const hub = manifest?.hubUrl || hubUrl || "https://hub.example.com";
  const script = (os === "windows" ? manifest?.installPowerShell : manifest?.installScript) ?? "";
  const oneLiner = script ? (os === "windows" ? windowsInstallCommand(script, "gpk-…") : unixInstallCommand(script, "gpk-…")) : "";

  const download = async (item: BridgeReleasePackage) => {
    try {
      if (await openExternal(item.downloadUrl)) return;
      // 旧版 Nova 的壳里没有 ShellApi，window.open 又被拦：把地址交给主人自己去浏览器里开。
      if (await copyText(item.downloadUrl)) message.info(t("install.openCopied"));
      else message.info(t("install.openManual", { url: item.downloadUrl }));
    } catch (error) {
      message.error((error as Error).message || t("common.actionFailed"));
    }
  };

  const hint = manifest?.version ? (
    // 发布说明不单占一行：悬停看就够了，要细看的人去安装包里的 README。
    <span title={manifest.notes || undefined}>
      {t("install.latest", { version: manifest.version })}
      {manifest.publishedAt ? ` · ${t("install.published", { date: formatDay(manifest.publishedAt) })}` : ""}
    </span>
  ) : undefined;

  let body: ReactNode;
  if (!manifest) {
    // 拿不到只影响这一块，就在这一块里说，给个重试（同「已解绑」那一栏）。
    body = failed ? (
      <Blank
        title={t("install.failed")}
        action={
          <Btn tone="ghost" small onClick={onRetry}>
            {t("account.retry")}
          </Btn>
        }
      />
    ) : (
      <Loading />
    );
  } else if (packages.length === 0) {
    body = <Blank title={t("install.empty")} hint={t("install.emptyHint")} />;
  } else {
    body = (
      <>
        <TabStrip value={os} onChange={setPicked} options={SYSTEMS.map((system) => ({ value: system.value, label: system.label }))} />
        <div role="tabpanel">
          {mine.length === 0 ? (
            <Blank title={t("install.osEmpty", { os: osLabel })} />
          ) : (
            <>
              {oneLiner ? (
                <div style={{ display: "flex", flexDirection: "column", gap: 6, padding: "14px 18px 12px" }}>
                  <CommandBlock title={t("install.oneLiner")} command={oneLiner} />
                  <span className="gx-card__hint" style={{ lineHeight: 1.6 }}>
                    {t("install.oneLinerHint")}
                  </span>
                </div>
              ) : null}
              {mine.map((item, index) => (
                <PackageRow key={item.platform} item={item} first={index === 0 && !oneLiner} onDownload={() => void download(item)} />
              ))}
              <div style={{ display: "flex", flexDirection: "column", gap: 10, padding: "12px 18px 16px", borderTop: "1px solid var(--gx-line)" }}>
                <button
                  type="button"
                  className="gx-link"
                  aria-expanded={showManual}
                  style={{ alignSelf: "flex-start" }}
                  onClick={() => setShowManual((open) => !open)}
                >
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                    {t("install.manual")}
                    <IconChevronDown size={13} style={{ transition: "transform .15s ease", transform: showManual ? "rotate(180deg)" : undefined }} />
                  </span>
                </button>
                {showManual ? (
                  <>
                    <CommandBlock
                      // 两个架构都有包时拿第一个举例：命令里写 <arch> 占位符的话，没人能直接复制去跑。
                      title={
                        mine.length > 1
                          ? t("install.manualWhereArch", { arch: splitPlatform(mine[0].platform).arch })
                          : t("install.manualWhere")
                      }
                      command={manualCommand(os, mine[0], hub)}
                    />
                    <Note>{t(os === "windows" ? "install.manualWindows" : "install.manualUnix")}</Note>
                  </>
                ) : null}
              </div>
            </>
          )}
        </div>
      </>
    );
  }

  return (
    <Card className="gx-rise gx-rise--2">
      <CardHead title={t("install.title")} hint={hint} />
      {body}
    </Card>
  );
}

function PackageRow({ item, first, onDownload }: { item: BridgeReleasePackage; first: boolean; onDownload: () => void }) {
  const { t } = useLocale();
  const [copied, setCopied] = useState(false);
  return (
    <div className="gx-row" style={{ gridTemplateColumns: "56px minmax(0, 1fr) auto", padding: "11px 18px", borderTop: first ? 0 : undefined }}>
      <span
        className="gx-mono"
        style={{ height: 30, borderRadius: 8, display: "grid", placeItems: "center", background: "var(--gx-muted)", color: "var(--gx-soft)", fontSize: 11.5 }}
      >
        {splitPlatform(item.platform).arch || item.platform}
      </span>
      <span style={{ minWidth: 0 }}>
        <span className="gx-mono" title={item.fileName} style={{ display: "block", fontSize: 12.5, fontWeight: 500, ...ellipsis }}>
          {item.fileName}
        </span>
        <span style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0, marginTop: 3, fontSize: 11.5, color: "var(--gx-faint)" }}>
          <span className="gx-mono" style={{ flex: "0 0 auto" }}>
            {formatBytes(item.size)} · {item.version}
          </span>
          <span aria-hidden="true">·</span>
          {/* 摘要只摆头尾几位，整串悬停看、点一下复制：64 位摆出来会把这一行撑成两行，核对时人也只比头尾。 */}
          <button
            type="button"
            title={item.sha256}
            aria-label={t("install.sha256Copy")}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              minWidth: 0,
              padding: 0,
              border: 0,
              background: "none",
              color: copied ? "var(--gx-ok)" : "inherit",
              font: "inherit",
              cursor: "pointer",
            }}
            onClick={async () => {
              // 复制失败时保持原样，不谎报「已复制」（同 CopyBtn）。
              if (await copyText(item.sha256)) setCopied(true);
            }}
          >
            <span className="gx-mono" style={ellipsis}>
              SHA256 {shortHash(item.sha256)}
            </span>
            {copied ? <IconCheck size={12} style={{ flex: "0 0 auto" }} /> : <IconCopy size={12} style={{ flex: "0 0 auto" }} />}
          </button>
        </span>
      </span>
      <Btn tone="ghost" small icon={<IconDownload size={14} />} onClick={onDownload}>
        {t("install.download")}
      </Btn>
    </div>
  );
}
