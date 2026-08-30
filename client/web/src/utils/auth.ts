"use client";

const AUTH_TOKEN_KEY = "phoenix_manager_token";
const PASSWORD_CHANGE_REQUIRED_KEY = "phoenix_manager_password_change_required";
const AUTH_USER_KEY = "phoenix_manager_user";

export type WorkPersona = "business" | "product_research";

export interface AuthUser {
  id: number;
  username: string;
  displayName: string;
  role: string;
	/** 主身份仅用于兼容升级前的浏览器缓存；权限判断一律使用 personas。 */
	persona?: WorkPersona;
	/** 用户可以同时拥有业务方和产品产研身份。 */
	personas?: WorkPersona[];
  mustChangePassword: boolean;
	writableBizLines?: string[];
	managedBizLines?: string[];
	managedPrograms?: Array<{ bizLine: string; programId: number }>;
}

function canUseBrowserStorage() {
  return typeof window !== "undefined";
}

export function getAuthToken() {
  if (!canUseBrowserStorage()) {
    return "";
  }
  return window.localStorage.getItem(AUTH_TOKEN_KEY) || window.sessionStorage.getItem(AUTH_TOKEN_KEY) || "";
}

export function setAuthToken(token: string, remember = true) {
  if (!canUseBrowserStorage()) {
    return;
  }
  clearAuthToken();
  const storage = remember ? window.localStorage : window.sessionStorage;
  storage.setItem(AUTH_TOKEN_KEY, token);
}

export function clearAuthToken() {
  if (!canUseBrowserStorage()) {
    return;
  }
  window.localStorage.removeItem(AUTH_TOKEN_KEY);
  window.sessionStorage.removeItem(AUTH_TOKEN_KEY);
  window.localStorage.removeItem(PASSWORD_CHANGE_REQUIRED_KEY);
  window.sessionStorage.removeItem(PASSWORD_CHANGE_REQUIRED_KEY);
  window.localStorage.removeItem(AUTH_USER_KEY);
  window.sessionStorage.removeItem(AUTH_USER_KEY);
}

export function isAuthenticated() {
  return getAuthToken().trim().length > 0;
}

export function isAuthTokenRemembered() {
  if (!canUseBrowserStorage()) return true;
  return Boolean(window.localStorage.getItem(AUTH_TOKEN_KEY));
}

export function setAuthUser(user: AuthUser, remember = true) {
  if (!canUseBrowserStorage()) return;
  const storage = remember ? window.localStorage : window.sessionStorage;
  storage.setItem(AUTH_USER_KEY, JSON.stringify(user));
}

export function getAuthUser(): AuthUser | null {
  if (!canUseBrowserStorage()) return null;
  const raw = window.localStorage.getItem(AUTH_USER_KEY) || window.sessionStorage.getItem(AUTH_USER_KEY);
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as AuthUser;
    return value.id > 0 && value.username ? value : null;
  } catch {
    return null;
  }
}

export function authPersonas(user: AuthUser | null = getAuthUser()): WorkPersona[] {
	const values = user?.personas?.length ? user.personas : user?.persona ? [user.persona] : ["product_research"];
	return Array.from(new Set(values)).filter((value): value is WorkPersona => value === "business" || value === "product_research");
}

export function hasAuthPersona(persona: WorkPersona, user: AuthUser | null = getAuthUser()) {
	return authPersonas(user).includes(persona);
}

export function isBusinessOnlyUser(user: AuthUser | null = getAuthUser()) {
	return hasAuthPersona("business", user) && !hasAuthPersona("product_research", user);
}

/** Browser preferences belong to the signed-in person, not the browser session. */
export function getUserScopedStorageKey(baseKey: string) {
  const user = getAuthUser();
  return user && baseKey ? `${baseKey}:${user.id}` : "";
}

export function setPasswordChangeRequired(required: boolean) {
  if (!canUseBrowserStorage()) return;
  if (required) {
    window.localStorage.setItem(PASSWORD_CHANGE_REQUIRED_KEY, "1");
    return;
  }
  window.localStorage.removeItem(PASSWORD_CHANGE_REQUIRED_KEY);
  window.sessionStorage.removeItem(PASSWORD_CHANGE_REQUIRED_KEY);
}

export function isPasswordChangeRequired() {
  if (!canUseBrowserStorage()) return false;
  return window.localStorage.getItem(PASSWORD_CHANGE_REQUIRED_KEY) === "1" || window.sessionStorage.getItem(PASSWORD_CHANGE_REQUIRED_KEY) === "1";
}
