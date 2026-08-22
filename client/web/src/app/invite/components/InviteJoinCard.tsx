"use client";

import { CheckCircleOutlined, TeamOutlined } from "@ant-design/icons";
import { Alert, Button, Card, Descriptions, Result, Space, Spin, Tag, Typography, message } from "antd";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { BizLineShareTarget, fetchBizLineShareTarget, joinBizLineByShareLink } from "@/api/bizline.api";
import { useBusinessLine } from "@/business-lines/BusinessLineProvider";
import { useLocale } from "@/i18n/LocaleProvider";
import { refreshAuthUser } from "@/api/auth.api";
import { isAuthenticated } from "@/utils/auth";


/**
 * 分享链接的落地页。受邀人先看到这个空间的描述和这条链接给的权限，
 * 确认加入后才成为成员 —— 空间管理员不能再直接把人塞进来。
 */
export function InviteJoinCard() {
	const { t } = useLocale();
	const router = useRouter();
	const searchParams = useSearchParams();
	const { refreshBusinessLines } = useBusinessLine();
	const token = searchParams?.get("token") ?? "";
	const [loading, setLoading] = useState(true);
	const [joining, setJoining] = useState(false);
	const [target, setTarget] = useState<BizLineShareTarget | null>(null);
	const [error, setError] = useState("");

	useEffect(() => {
		if (!isAuthenticated()) {
			// 未登录的受邀人先去登录，登录完回到这条链接继续。
			router.replace(`/login?redirect=${encodeURIComponent(`/invite?token=${token}`)}`);
		}
	}, [router, token]);

	const load = useCallback(async () => {
		if (!token || !isAuthenticated()) {
			setLoading(false);
			return;
		}
		setLoading(true);
		try {
			setTarget(await fetchBizLineShareTarget(token));
			setError("");
		} catch (caught) {
			setError((caught as Error).message || t("invite.invalid"));
		} finally {
			setLoading(false);
		}
	}, [t, token]);

	useEffect(() => {
		void load();
	}, [load]);

	const join = async () => {
		setJoining(true);
		try {
			await joinBizLineByShareLink(token);
			// 加入后本地缓存的授权范围就过时了：重新拉一次档案，
			// 否则新空间里的建项目按钮要等到下次登录才亮。
			await refreshAuthUser();
			await refreshBusinessLines().catch(() => undefined);
			message.success(t("invite.joinSuccess"));
			router.replace("/my-work");
		} catch (caught) {
			message.error((caught as Error).message);
		} finally {
			setJoining(false);
		}
	};

	if (loading) {
		return (
			<div style={{ minHeight: "100vh", display: "grid", placeItems: "center" }}>
				<Spin size="large" />
			</div>
		);
	}

	if (!target) {
		return (
			<div style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: 24 }}>
				<Result
					status="warning"
					title={t("invite.invalid")}
					subTitle={error || undefined}
					extra={
						<Button type="primary" onClick={() => router.replace("/my-work")}>
							{t("invite.back")}
						</Button>
					}
				/>
			</div>
		);
	}

	return (
		<div style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: 24 }}>
			<Card style={{ width: "100%", maxWidth: 520 }} title={<Space><TeamOutlined />{t("invite.title")}</Space>}>
				<Space direction="vertical" size="middle" style={{ width: "100%" }}>
					<Typography.Title level={4} style={{ marginBottom: 0 }} data-locale-static="false">
						{target.name || target.bizLine}
					</Typography.Title>
					<Typography.Paragraph type={target.description ? undefined : "secondary"} data-locale-static="false">
						{target.description || t("invite.noDescription")}
					</Typography.Paragraph>
					<Descriptions column={1} size="small">
						<Descriptions.Item label={t("businessLines.code")}>
							<span className="manager-mono" data-locale-static="false">{target.bizLine}</span>
						</Descriptions.Item>
						<Descriptions.Item label={t("invite.permission")}>
							<Tag color={target.permission === "write" ? "blue" : "default"}>
								{t(target.permission === "write" ? "businessLines.permissionWrite" : "businessLines.permissionRead")}
							</Tag>
						</Descriptions.Item>
						<Descriptions.Item label={t("invite.expiresAt")}>
							<span data-locale-static="false">{new Date(target.expiresAt).toLocaleString("zh-CN", { hour12: false })}</span>
						</Descriptions.Item>
					</Descriptions>
					{target.joined ? <Alert type="success" showIcon icon={<CheckCircleOutlined />} message={t("invite.joined")} /> : null}
					<Space>
						<Button type="primary" loading={joining} onClick={() => void join()}>
							{t("invite.confirm")}
						</Button>
						<Button onClick={() => router.replace("/my-work")}>{t("invite.back")}</Button>
					</Space>
				</Space>
			</Card>
		</div>
	);
}
