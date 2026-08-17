"use client";

import dynamic from "next/dynamic";
import { Spin } from "antd";

// three.js 只有这一页用，懒加载；ssr:false 是必须的 —— three 在模块顶层就摸 window。
const PanoramaWorkspace = dynamic(
  () => import("./components/PanoramaWorkspace").then((module) => module.PanoramaWorkspace),
  {
    ssr: false,
    loading: () => (
      <div style={{ minHeight: 480, display: "grid", placeItems: "center" }}>
        <Spin size="large" />
      </div>
    ),
  },
);

export default function PanoramaPage() {
  return <PanoramaWorkspace />;
}
