"use client";

import { PauseCircleOutlined, PlayCircleOutlined, StopOutlined, ThunderboltFilled } from "@ant-design/icons";
import { Button, Popconfirm, Space, Tag, Tooltip, message } from "antd";
import { useState } from "react";
import { QuotaBars } from "@/components/galaxy/QuotaBars";
import { useLocale } from "@/i18n/LocaleProvider";
import { formatTime } from "@/utils/format";
import { setContributionStatus, type ContributionView } from "../../api/provider.api";

/**
 * 一条贡献一张卡。主人扫一眼要能回答三个问题：现在接不接单、还剩多少、为什么不接。
 * 所以状态标签、三维额度、限流原因是并排的，不是藏在详情里。
 */
export function ContributionCard({ contribution, onChanged }: { contribution: ContributionView; onChanged: () => void }) {
  const { t } = useLocale();
  const [busy, setBusy] = useState(false);

  const change = async (status: "active" | "paused" | "disabled") => {
    setBusy(true);
    try {
      await setContributionStatus(contribution.cid, status);
      message.success(t("provider.contribution.statusSaved"));
      onChanged();
    } catch (error) {
      message.error((error as Error).message || t("common.loadFailed"));
    } finally {
      setBusy(false);
    }
  };

  const throttled = contribution.throttledUntil ? new Date(contribution.throttledUntil) > new Date() : false;
  const paused = contribution.status === "paused";
  const disabled = contribution.status === "disabled";

  return (
    <div className="galaxy-contribution">
      <div className="galaxy-contribution__title">
        <strong title={contribution.cid}>{contribution.cid}</strong>
        <span style={{ flex: 1 }} />
        {contribution.online ? (
          <Tag color="success">{t("provider.node.online")}</Tag>
        ) : (
          <Tag>{t("provider.node.offline")}</Tag>
        )}
        {paused ? <Tag color="warning">{t("provider.contribution.pause")}</Tag> : null}
        {disabled ? <Tag>{t("provider.contribution.disable")}</Tag> : null}
      </div>

      <div className="galaxy-meta">
        <span>
          {contribution.kind} · {contribution.provider}
        </span>
        <span>
          {t("provider.contribution.seats")}{" "}
          <b>
            {t("provider.contribution.seatsUsed")
              .replace("{used}", String(contribution.seatsUsed))
              .replace("{effective}", String(contribution.seatsEffective))}
          </b>
        </span>
        <span>
          {t("provider.contribution.inflight")} <b>{contribution.inflight}</b>
        </span>
        <span>
          {t("provider.contribution.reputation")} <b>{contribution.reputation.toFixed(2)}</b>
        </span>
      </div>

      <div className="galaxy-meta">
        <span>
          {t("provider.contribution.models")}{" "}
          <b>{contribution.modelsAllow.length > 0 ? contribution.modelsAllow.join(", ") : t("common.unlimited")}</b>
          {contribution.modelsDeny.length > 0 ? <span> · ✕ {contribution.modelsDeny.join(", ")}</span> : null}
        </span>
        <span>
          {t("provider.contribution.schedule")}{" "}
          <b>
            {contribution.schedule.length > 0
              ? contribution.schedule.map((item) => `${item.from}-${item.to}`).join(", ")
              : t("provider.contribution.allDay")}
          </b>
        </span>
      </div>

      {throttled ? (
        <Tag icon={<ThunderboltFilled />} color="warning">
          {t("provider.contribution.throttled").replace("{time}", formatTime(contribution.throttledUntil))}
        </Tag>
      ) : null}

      <QuotaBars quota={contribution.quota} />

      <Space wrap>
        {paused || disabled ? (
          <Button size="small" icon={<PlayCircleOutlined />} loading={busy} onClick={() => void change("active")}>
            {t("provider.contribution.resume")}
          </Button>
        ) : (
          <Tooltip title={t("provider.contribution.pauseHint")}>
            <Button size="small" icon={<PauseCircleOutlined />} loading={busy} onClick={() => void change("paused")}>
              {t("provider.contribution.pause")}
            </Button>
          </Tooltip>
        )}
        {!disabled ? (
          <Popconfirm
            title={t("provider.contribution.disable")}
            description={t("provider.contribution.pauseHint")}
            okText={t("common.confirm")}
            cancelText={t("common.cancel")}
            onConfirm={() => void change("disabled")}
          >
            <Button size="small" danger icon={<StopOutlined />} loading={busy}>
              {t("provider.contribution.disable")}
            </Button>
          </Popconfirm>
        ) : null}
      </Space>
    </div>
  );
}
