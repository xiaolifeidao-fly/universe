"use client";

import { Suspense } from "react";
import { DeliveryWorkspace } from "./components/DeliveryWorkspace";

export default function DeliveryPage() {
  return (
    <Suspense fallback={null}>
      <DeliveryWorkspace />
    </Suspense>
  );
}
