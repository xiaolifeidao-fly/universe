export interface MobileUser {
  id: number;
  username: string;
  displayName: string;
  writableBizLines: string[];
}

export interface MobileSession {
  token: string;
  user: MobileUser;
  /**
   * 当前空间编码。登录时可以是空串 —— 空间由应用内的切换器解析和保存，
   * 不再要求用户在登录页手输一个编码。
   */
  bizLine: string;
  /** 当前空间显示名，仅用于展示；缺失时回落到编码。 */
  bizLineName?: string;
}

const SESSION_KEY = "delivery-mobile.session.v1";

function storage(remember: boolean) {
  if (typeof window === "undefined") return null;
  return remember ? window.localStorage : window.sessionStorage;
}

function isValidSession(value: unknown): value is MobileSession {
  if (!value || typeof value !== "object") return false;
  const session = value as Partial<MobileSession>;
  return Boolean(session.token && session.user?.id && session.user?.username && typeof session.bizLine === "string");
}

export function getSession(): MobileSession | null {
  if (typeof window === "undefined") return null;
  const raw = window.localStorage.getItem(SESSION_KEY) || window.sessionStorage.getItem(SESSION_KEY);
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return isValidSession(parsed) ? parsed : null;
  } catch {
    clearSession();
    return null;
  }
}

export function saveSession(session: MobileSession, remember: boolean) {
  if (typeof window === "undefined") return;
  clearSession();
  storage(remember)?.setItem(SESSION_KEY, JSON.stringify(session));
}

export function clearSession() {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(SESSION_KEY);
  window.sessionStorage.removeItem(SESSION_KEY);
}

/**
 * 只改会话里的当前空间，令牌和用户信息原样保留。
 *
 * 必须写回原来那份存储：登录时勾了「保留登录状态」的用 localStorage，
 * 没勾的用 sessionStorage。写错地方会让「不保留」的会话在关掉浏览器后复活。
 */
export function setSessionSpace(bizLine: string, bizLineName?: string) {
  if (typeof window === "undefined") return null;
  const target = window.localStorage.getItem(SESSION_KEY) ? window.localStorage : window.sessionStorage;
  const raw = target.getItem(SESSION_KEY);
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isValidSession(parsed)) return null;
    const next: MobileSession = { ...parsed, bizLine, bizLineName: bizLineName || bizLine };
    target.setItem(SESSION_KEY, JSON.stringify(next));
    return next;
  } catch {
    clearSession();
    return null;
  }
}

export function currentToken() {
  return getSession()?.token ?? "";
}

export function currentBizLine() {
  return getSession()?.bizLine ?? "";
}

export function currentBizLineName() {
  const session = getSession();
  return session?.bizLineName || session?.bizLine || "";
}
