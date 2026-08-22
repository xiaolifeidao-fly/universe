"use client";

import { Result } from "antd";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { getAuthUser } from "@/utils/auth";
import { useLocale } from "@/i18n/LocaleProvider";
import { UserManagementDemo } from "./components/UserManagementDemo";

// 用户管理只对系统管理员开放。导航已经不给别人显示这一项，
// 但直接敲地址也进不来 —— 服务端的 /system/users 同样只认管理员。
export default function UserPage() {
  const router = useRouter();
  const { t } = useLocale();
  const [isAdmin, setIsAdmin] = useState<boolean | null>(null);

  useEffect(() => {
    setIsAdmin(getAuthUser()?.role === "admin");
  }, []);

  if (isAdmin === null) return null;
  if (!isAdmin) {
    return <Result status="403" title="403" subTitle={t("shell.noPermission")} extra={<a onClick={() => router.replace("/my-work")}>{t("invite.back")}</a>} />;
  }
  return <UserManagementDemo />;
}
