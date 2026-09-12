/**
 * 本机密钥保险箱：签发那一刻拿到的 sk- 明文存一份在这台设备上。
 *
 * 为什么要存：额度跟着密钥走，密钥要反复被用 —— 接到 Claude Code / Codex、复制到别的机器、
 * 贴进 CI。每次都回服务端取，等于让服务端必须一直留着明文；存在本机，服务端那份就只剩
 * 「换了台电脑还能找回」这一个兜底作用。
 *
 * 存的是能直接花钱的东西，所以：按账号分区（同一台机器上两个使用端账号互不可见），
 * 明文只在真的要用的那一刻按 keyId 单独取一条，列表接口只回 keyId。
 */

/** 保险箱里有哪些密钥。不带明文 —— 页面画卡片只需要知道「这把在本机有」。 */
export interface KeyVaultEntry {
  keyId: string;
  alias: string;
  /** ISO 时间串，存进来的那一刻。 */
  savedAt: string;
}

export interface SaveSecretInput {
  /** 使用端账号的业务键 cu_…。同一台机器上按它分区。 */
  ownerId: string;
  keyId: string;
  alias: string;
  /** sk-galaxy-… 明文。 */
  secret: string;
}

export interface KeyRef {
  ownerId: string;
  keyId: string;
}

export interface SecretResult {
  keyId: string;
  /** 本机没有这一把时是空串 —— 不当成错误，调用方据此回落到服务端取。 */
  secret: string;
}
