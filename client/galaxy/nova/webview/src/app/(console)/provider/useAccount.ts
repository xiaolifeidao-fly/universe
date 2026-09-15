"use client";

/**
 * 当前账号，控制台几页共用。
 *
 * 先给登录那一刻存在本地的快照（同步就有，首屏不闪），再拿库里最新的覆盖、并写回本地。
 * 非这么取不可，是因为「散户 / 工作室」决定了整块机房入口给不给：运营把人改成工作室之后，
 * 本地那份不会自己跟着变，只按快照走的话，人要重新登录一次才看得见自己的机器。
 *
 * 取不到就先用快照，不弹报错：这一份只决定显示什么，不该让整页看起来坏了。
 */

import { useEffect, useState } from "react";
import { getAuthUser, isAuthTokenRemembered, setAuthUser, type AuthUser } from "@/utils/auth";
import { fetchCurrentAccount } from "./api/account.api";

export function useCurrentAccount(): AuthUser | null {
  const [account, setAccount] = useState<AuthUser | null>(null);

  useEffect(() => {
    let alive = true;
    // 登录态在 localStorage 里，服务端读不到：直接在渲染期读会让 SSR 的 HTML 和水合结果对不上。
    setAccount(getAuthUser());
    void fetchCurrentAccount()
      .then((fresh) => {
        if (!alive) return;
        setAccount(fresh);
        setAuthUser(fresh, isAuthTokenRemembered());
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  return account;
}
