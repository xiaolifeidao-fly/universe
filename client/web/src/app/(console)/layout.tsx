"use client";

import { Spin } from "antd";
import { usePathname, useRouter } from "next/navigation";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { ManagerShell } from "@/components/manager-shell/ManagerShell";
import { getAuthUser, isAuthenticated, isBusinessOnlyUser } from "@/utils/auth";

export default function ConsoleLayout({
  children,
}: Readonly<{
  children: ReactNode;
}>) {
  const router = useRouter();
	const pathname = usePathname();
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!isAuthenticated()) {
      router.replace("/login");
      return;
    }
		const user = getAuthUser();
		const isBusinessOnly = isBusinessOnlyUser(user);
		const hasBusiness = !isBusinessOnly && user?.personas?.includes("business");
		if (isBusinessOnly && pathname !== "/business-workbench") {
			router.replace("/business-workbench");
			return;
		}
		if (!isBusinessOnly && !hasBusiness && pathname === "/business-workbench") {
			router.replace("/my-work");
			return;
		}
    setReady(true);
	}, [pathname, router]);

  if (!ready) {
    return (
      <div style={{ minHeight: "100vh", display: "grid", placeItems: "center" }}>
        <Spin size="large" />
      </div>
    );
  }

  return <ManagerShell>{children}</ManagerShell>;
}
