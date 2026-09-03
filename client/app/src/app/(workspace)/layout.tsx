"use client";

import type { ReactNode } from "react";
import { AuthGate } from "@/components/auth-gate";
import { MessagesProvider } from "@/components/messages-provider";
import { MobileShell } from "@/components/mobile-shell";
import { SpaceProvider } from "@/components/space-provider";

export default function WorkspaceLayout({ children }: { children: ReactNode }) {
  return (
    <AuthGate>
      <SpaceProvider>
        {/* MessagesProvider 依赖当前空间，必须在 SpaceProvider 之内 */}
        <MessagesProvider>
          <MobileShell>{children}</MobileShell>
        </MessagesProvider>
      </SpaceProvider>
    </AuthGate>
  );
}
