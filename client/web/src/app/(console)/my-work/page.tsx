"use client";

import { Suspense } from "react";
import { MyWorkWorkspace } from "./components/MyWorkWorkspace";

export default function MyWorkPage() {
  return (
    <Suspense fallback={null}>
      <MyWorkWorkspace />
    </Suspense>
  );
}
