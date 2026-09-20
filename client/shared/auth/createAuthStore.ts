/**
 * 通用登录态存储工厂 —— 机制照 client/web/src/utils/auth.ts 的模式抽出来。
 *
 * web 那份 AuthUser 带了 web 自己的业务字段（WorkPersona、writableBizLines、
 * managedPrograms……），是「业务方 / 产研」这套身份体系专属的，不适合直接当成
 * 通用形状。这里只留最小公分母（id / username / displayName / role /
 * mustChangePassword），各 app 需要更多字段就自己在调用处扩展 AuthUser 泛型。
 *
 * 每个 app 传自己的 storage key 前缀，避免同源部署时 localStorage 撞车。这已经不是
 * 防患于未然了：Nova（galaxy_provider_*）、Orbit（galaxy_consumer_*）和管理端
 * （manager_*）线上挂在同一个 www.galaxy.rodeo 上，只是路径不同 —— 同源共享一份
 * localStorage，前缀撞了就是「登了 Orbit 把管理端踢下线」这种查不动的串台。
 *
 * TODO(shared-auth): web 的 src/utils/auth.ts 还是它自己那份手写实现（字段更多，
 * 且被 ManagerShell 等一堆现有组件直接引用），没有改造成基于这个工厂 —— 这次
 * 新建 client/manager 没有动 web 的现有文件，留给后续单独评估再做。
 */

"use client";

export interface BaseAuthUser {
  id: number;
  username: string;
  displayName: string;
  role: string;
  mustChangePassword: boolean;
}

export interface AuthStoreKeys {
  /** 建议用 "<app>_auth_token" 这种带 app 前缀的形式，比如 "manager_auth_token"。 */
  token: string;
  passwordChangeRequired: string;
  user: string;
}

function canUseBrowserStorage() {
  return typeof window !== "undefined";
}

/**
 * 约束只要求 id 和 username —— 工厂里真正用到的就这两个（id 做 per-user 存储键，
 * username 用来判断读出来的不是半个脏对象），`role` 等字段一次都没读。
 *
 * 卡死整个 BaseAuthUser 的话，账号体系形状不同的 app 就用不了这个工厂：
 * 管理端的账号主键是字符串业务键、也没有单一 role（它有一组角色），套不进去。
 */
export function createAuthStore<User extends { id: string | number; username: string } = BaseAuthUser>(
  keys: AuthStoreKeys,
) {
  function getAuthToken() {
    if (!canUseBrowserStorage()) return "";
    return window.localStorage.getItem(keys.token) || window.sessionStorage.getItem(keys.token) || "";
  }

  function clearAuthToken() {
    if (!canUseBrowserStorage()) return;
    window.localStorage.removeItem(keys.token);
    window.sessionStorage.removeItem(keys.token);
    window.localStorage.removeItem(keys.passwordChangeRequired);
    window.sessionStorage.removeItem(keys.passwordChangeRequired);
    window.localStorage.removeItem(keys.user);
    window.sessionStorage.removeItem(keys.user);
  }

  function setAuthToken(token: string, remember = true) {
    if (!canUseBrowserStorage()) return;
    clearAuthToken();
    const storage = remember ? window.localStorage : window.sessionStorage;
    storage.setItem(keys.token, token);
  }

  function isAuthenticated() {
    return getAuthToken().trim().length > 0;
  }

  function isAuthTokenRemembered() {
    if (!canUseBrowserStorage()) return true;
    return Boolean(window.localStorage.getItem(keys.token));
  }

  function setAuthUser(user: User, remember = true) {
    if (!canUseBrowserStorage()) return;
    const storage = remember ? window.localStorage : window.sessionStorage;
    storage.setItem(keys.user, JSON.stringify(user));
  }

  function getAuthUser(): User | null {
    if (!canUseBrowserStorage()) return null;
    const raw = window.localStorage.getItem(keys.user) || window.sessionStorage.getItem(keys.user);
    if (!raw) return null;
    try {
      const value = JSON.parse(raw) as User;
      // id 可能是数字自增主键，也可能是字符串业务键 —— 两种都要能过。
      // 这一步不是校验，是挡住「存了半个对象」那种脏数据：读到它会让页面
      // 在渲染期崩掉，而不是干脆地跳回登录页。
      const hasID = typeof value.id === "number" ? value.id > 0 : Boolean(value.id);
      return hasID && value.username ? value : null;
    } catch {
      return null;
    }
  }

  function getUserScopedStorageKey(baseKey: string) {
    const user = getAuthUser();
    return user && baseKey ? `${baseKey}:${user.id}` : "";
  }

  function setPasswordChangeRequired(required: boolean) {
    if (!canUseBrowserStorage()) return;
    if (required) {
      window.localStorage.setItem(keys.passwordChangeRequired, "1");
      return;
    }
    window.localStorage.removeItem(keys.passwordChangeRequired);
    window.sessionStorage.removeItem(keys.passwordChangeRequired);
  }

  function isPasswordChangeRequired() {
    if (!canUseBrowserStorage()) return false;
    return (
      window.localStorage.getItem(keys.passwordChangeRequired) === "1" ||
      window.sessionStorage.getItem(keys.passwordChangeRequired) === "1"
    );
  }

  return {
    getAuthToken,
    setAuthToken,
    clearAuthToken,
    isAuthenticated,
    isAuthTokenRemembered,
    setAuthUser,
    getAuthUser,
    getUserScopedStorageKey,
    setPasswordChangeRequired,
    isPasswordChangeRequired,
  };
}
