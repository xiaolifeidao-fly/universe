"use client";

import { ReloadOutlined } from "@ant-design/icons";
import { Button, Select, Space, Tabs, message } from "antd";
import { useCallback, useEffect, useState } from "react";
import { useLocale } from "@/i18n/LocaleProvider";
import { fetchKeys, type ConsumerKeyView } from "../../api/consumer.api";
import { DisputeList } from "./DisputeList";
import { JobList } from "./JobList";
import { SessionList } from "./SessionList";

/**
 * 「我在池子里跑着什么」。
 *
 * relay 是同步的，请求回来就结束了，用量在账单页看得到；会话和任务不是 ——
 * 会话能开着好几天并一直钉着一个座位，任务能跑几个小时。这两样必须有个地方
 * 能看见状态、能主动收回，否则忘掉的会话就是一直在烧的钱。
 */
export function ConsumerWorkloads() {
  const { t } = useLocale();
  const [keys, setKeys] = useState<ConsumerKeyView[]>([]);
  const [keyId, setKeyId] = useState<string>("");
  const [tab, setTab] = useState("sessions");
  const [refreshToken, setRefreshToken] = useState(0);

  useEffect(() => {
    fetchKeys()
      .then(setKeys)
      .catch((error: Error) => message.error(error.message || t("common.loadFailed")));
  }, [t]);

  const refresh = useCallback(() => setRefreshToken((value) => value + 1), []);

  // 申诉列表按人查，不按密钥 —— 一张工单是对某一次执行提的，密钥只是它的属性之一。
  // 所以那个标签页里不显示密钥筛选器，免得点了没反应。
  const filter = (
    <Space size={12}>
      {tab === "disputes" ? null : (
        <Select
          value={keyId}
          onChange={setKeyId}
          style={{ minWidth: 220 }}
          options={[
            { value: "", label: t("workloads.allKeys") },
            ...keys.map((key) => ({ value: key.keyId, label: key.alias || key.keyId })),
          ]}
        />
      )}
      <Button icon={<ReloadOutlined />} onClick={refresh}>
        {t("common.refresh")}
      </Button>
    </Space>
  );

  return (
    <Tabs
      activeKey={tab}
      onChange={setTab}
      tabBarExtraContent={filter}
      items={[
        {
          key: "sessions",
          label: t("workloads.tab.sessions"),
          children: <SessionList keyId={keyId} refreshToken={refreshToken} onChanged={refresh} />,
        },
        {
          key: "jobs",
          label: t("workloads.tab.jobs"),
          children: <JobList keyId={keyId} refreshToken={refreshToken} onChanged={refresh} />,
        },
        {
          key: "disputes",
          label: t("workloads.tab.disputes"),
          children: <DisputeList refreshToken={refreshToken} onChanged={refresh} />,
        },
      ]}
    />
  );
}
