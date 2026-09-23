"use client";

import { KeyVaultApi } from "@galaxy/common/eleapi/keyvault.api";
import { getAuthUser } from "@/utils/auth";

/**
 * 密钥明文的本机保险箱。
 *
 * 签发（买一把新的、换发）那一刻明文会经过页面一次，这里顺手存一份下来：之后「查看」「复制」
 * 「一键使用」都先问本机，问不到才回服务端取。这样服务端那份密文就从「唯一来源」退成
 * 「换了台电脑的兜底」。
 *
 * 两个后端，同一套接口：
 *   Orbit 桌面端  主进程的 SQLite（userData/key-vault.db，权限 0600），见 orbit/electron/src/modules/keyvault。
 *   浏览器        localStorage，一把一条。
 *
 * 存的是能直接花钱的东西。浏览器那一份挡不住同源的脚本注入 —— 这是「不用每次回服务端取明文」
 * 换来的代价，桌面端因此是更稳妥的那一侧。两边都按账号分区，换个账号登录看不到上一个人的。
 *
 * 这里的每个函数都不抛错：保险箱只是快路径，坏了就当没有，页面回落到服务端。
 * 唯一例外是 remember 的返回值 —— 存没存下要如实告诉用户，因为服务端未必取得回。
 */

const vault = new KeyVaultApi();
const PREFIX = "galaxy_consumer_key_secret";

/** 桌面端是 sqlite，浏览器是 localStorage，都没有（没登录、服务端渲染）是 none。 */
export type KeyVaultKind = "sqlite" | "browser" | "none";

export function keyVaultKind(): KeyVaultKind {
  if (!owner()) return "none";
  if (vault.isAvailable()) return "sqlite";
  return canUseLocalStorage() ? "browser" : "none";
}

function owner(): string {
  return getAuthUser()?.id ?? "";
}

function canUseLocalStorage(): boolean {
  try {
    return typeof window !== "undefined" && Boolean(window.localStorage);
  } catch {
    // 浏览器把站点数据整个禁掉时，光是碰一下 localStorage 就会抛。
    return false;
  }
}

function storageKey(ownerId: string, keyId: string): string {
  return `${PREFIX}:${ownerId}:${keyId}`;
}

interface StoredSecret {
  alias: string;
  secret: string;
  savedAt: string;
}

/** 存一份到本机。回 false 表示没存下 —— 调用方要让用户知道这份明文只在眼前这一次。 */
export async function rememberKeySecret(keyId: string, alias: string, secret: string): Promise<boolean> {
  const ownerId = owner();
  if (!ownerId || !keyId || !secret) return false;
  try {
    if (vault.isAvailable()) {
      await vault.save({ ownerId, keyId, alias, secret });
      return true;
    }
    if (!canUseLocalStorage()) return false;
    const stored: StoredSecret = { alias, secret, savedAt: new Date().toISOString() };
    window.localStorage.setItem(storageKey(ownerId, keyId), JSON.stringify(stored));
    return true;
  } catch {
    return false;
  }
}

/** 本机没有这一把时回空串。 */
export async function readKeySecret(keyId: string): Promise<string> {
  const ownerId = owner();
  if (!ownerId || !keyId) return "";
  try {
    if (vault.isAvailable()) return (await vault.read({ ownerId, keyId })).secret;
    if (!canUseLocalStorage()) return "";
    const raw = window.localStorage.getItem(storageKey(ownerId, keyId));
    return raw ? ((JSON.parse(raw) as StoredSecret).secret ?? "") : "";
  } catch {
    return "";
  }
}

/** 本机存着哪几把。画卡片只要知道「有没有」，不为此把一堆明文拉进页面。 */
export async function listLocalKeyIds(): Promise<string[]> {
  const ownerId = owner();
  if (!ownerId) return [];
  try {
    if (vault.isAvailable()) return (await vault.list(ownerId)).map((entry) => entry.keyId);
    if (!canUseLocalStorage()) return [];
    const prefix = `${PREFIX}:${ownerId}:`;
    const ids: string[] = [];
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const name = window.localStorage.key(index);
      if (name?.startsWith(prefix)) ids.push(name.slice(prefix.length));
    }
    return ids;
  } catch {
    return [];
  }
}

/** 密钥吊销、换发之后把本机这份丢掉：留着也用不了，只是多一处明文。 */
export async function forgetKeySecret(keyId: string): Promise<void> {
  const ownerId = owner();
  if (!ownerId || !keyId) return;
  try {
    if (vault.isAvailable()) {
      await vault.remove({ ownerId, keyId });
      return;
    }
    if (canUseLocalStorage()) window.localStorage.removeItem(storageKey(ownerId, keyId));
  } catch {
    // 删不掉不影响任何一步操作，不打扰用户。
  }
}
