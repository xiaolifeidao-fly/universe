"use client";

import type { ReactNode } from "react";
import { AuthGate } from "@/components/auth-gate";
import { MobileShell } from "@/components/mobile-shell";
import { SpaceProvider } from "@/components/space-provider";

export default function WorkspaceLayout({ children }: { children: ReactNode }) {
  return (
    <AuthGate>
      <SpaceProvider>
        <MobileShell>{children}</MobileShell>
      </SpaceProvider>
    </AuthGate>
  );
}
