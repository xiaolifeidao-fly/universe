import { request } from "@/api/client";
import type { MobileSession, MobileUser } from "@/lib/auth";

interface LoginResponse {
  token: string;
  user: {
    id: number;
    username: string;
    displayName?: string;
    writableBizLines?: string[];
  };
}

/**
 * 登录只认账号密码。空间不在这里决定：登录后由空间切换器读取真实的可访问
 * 空间列表并选定，这样输错一个业务线编码不会换来满屏「无权访问该空间」。
 */
export async function signIn(username: string, password: string): Promise<MobileSession> {
  const response = await request<LoginResponse>("/auth/login", {
    method: "POST",
    authenticated: false,
    body: { username, password },
  });
  const user: MobileUser = {
    id: response.user.id,
    username: response.user.username,
    displayName: response.user.displayName || response.user.username,
    writableBizLines: response.user.writableBizLines ?? [],
  };
  return { token: response.token, user, bizLine: "" };
}
