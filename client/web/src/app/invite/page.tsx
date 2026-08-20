"use client";

import { Suspense } from "react";
import { Spin } from "antd";
import { InviteJoinCard } from "./components/InviteJoinCard";

export default function InvitePage() {
	return (
		<Suspense fallback={<div style={{ minHeight: "100vh", display: "grid", placeItems: "center" }}><Spin size="large" /></div>}>
			<InviteJoinCard />
		</Suspense>
	);
}
