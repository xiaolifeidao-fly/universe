"use client";

import type { ReactNode } from "react";
import { ConnectionBanner, NetworkProvider } from "@/components/network-provider";
import { InstallPrompt } from "@/components/pwa/install-prompt";
import { ServiceWorkerRegistrar } from "@/components/pwa/service-worker-registrar";

export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <NetworkProvider>
      <ServiceWorkerRegistrar />
      {children}
      <ConnectionBanner />
      <InstallPrompt />
    </NetworkProvider>
  );
}
