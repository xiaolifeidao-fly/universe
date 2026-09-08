"use client";

import { DeleteOutlined, PlusOutlined } from "@ant-design/icons";
import { Button, Col, Form, Input, InputNumber, Row, Select, Space, message } from "antd";
import { useEffect, useState } from "react";
import { useLocale } from "@/i18n/LocaleProvider";
import { unitLabel } from "@/utils/format";
import {
  saveContributionLimits,
  type ContributionView,
  type QuotaGrantInput,
  type ScheduleWindow,
} from "../../api/provider.api";

/** kind 声明了自己允许哪些计量单位。这里给 llm.chat 的常用四个，其余 kind 直接手填。 */
const COMMON_UNITS = [
  "llm.output_tokens",
  "llm.input_tokens",
  "llm.calls",
  "time.seconds",
  "cpu.seconds",
  "video.output_seconds",
];

const WINDOWS = ["day", "week", "month", "total"];

interface FormValues {
  modelsAllow: string[];
  modelsDeny: string[];
  seats: number;
  seatConcurrency: number;
  quota: QuotaGrantInput[];
  schedule: ScheduleWindow[];
}

/**
 * 改一条贡献的授权。
 *
 * 这里改完立刻生效，不等节点下次 hello —— 主人按下「把额度调小」通常是因为现在
 * 就想少跑一点，让它等 15 秒心跳都算慢。节点那边的本地配置从此只是展示副本。
 */
export function GrantForm({ contribution, onSaved }: { contribution: ContributionView; onSaved: () => void }) {
  const { t } = useLocale();
  const [form] = Form.useForm<FormValues>();
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    form.setFieldsValue({
      modelsAllow: contribution.modelsAllow ?? [],
      modelsDeny: contribution.modelsDeny ?? [],
      seats: contribution.seats,
      seatConcurrency: contribution.seatConcurrency,
      quota: contribution.quota.map((item) => ({
        unit: item.unit,
        limit: item.limit,
        window: item.window || "day",
        resetAt: item.windowKey ? undefined : undefined,
      })),
      schedule: contribution.schedule ?? [],
    });
  }, [contribution, form]);

  const submit = async (values: FormValues) => {
    const quota = (values.quota ?? []).filter((item) => item?.unit && item.limit > 0);
    if (quota.length === 0) {
      message.warning(t("provider.limits.quotaRequired"));
      return;
    }
    setSaving(true);
    try {
      await saveContributionLimits({
        cid: contribution.cid,
        modelsAllow: values.modelsAllow ?? [],
        modelsDeny: values.modelsDeny ?? [],
        seats: values.seats,
        seatConcurrency: values.seatConcurrency,
        quota,
        schedule: (values.schedule ?? []).filter((item) => item?.from && item?.to),
      });
      message.success(t("common.saved"));
      onSaved();
    } catch (error) {
      message.error((error as Error).message || t("common.loadFailed"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Form<FormValues> form={form} layout="vertical" onFinish={(values) => void submit(values)}>
      <Row gutter={16}>
        <Col xs={24} md={12}>
          <Form.Item label={t("provider.limits.modelsAllow")} name="modelsAllow">
            <Select mode="tags" tokenSeparators={[","]} placeholder={t("provider.limits.modelsPlaceholder")} />
          </Form.Item>
        </Col>
        <Col xs={24} md={12}>
          <Form.Item label={t("provider.limits.modelsDeny")} name="modelsDeny">
            <Select mode="tags" tokenSeparators={[","]} placeholder={t("provider.limits.modelsPlaceholder")} />
          </Form.Item>
        </Col>
        <Col xs={12} md={6}>
          <Form.Item label={t("provider.limits.seats")} name="seats">
            <InputNumber min={1} max={10} style={{ width: "100%" }} />
          </Form.Item>
        </Col>
        <Col xs={12} md={6}>
          <Form.Item label={t("provider.limits.seatConcurrency")} name="seatConcurrency">
            <InputNumber min={1} max={16} style={{ width: "100%" }} />
          </Form.Item>
        </Col>
      </Row>

      <div style={{ marginBottom: 8, fontWeight: 600 }}>{t("provider.quota.title")}</div>
      <Form.List name="quota">
        {(fields, { add, remove }) => (
          <Space direction="vertical" size={8} style={{ width: "100%", marginBottom: 16 }}>
            {fields.map((field) => (
              <Row key={field.key} gutter={8} align="middle">
                <Col xs={24} md={7}>
                  <Form.Item {...field} name={[field.name, "unit"]} noStyle>
                    <Select
                      showSearch
                      placeholder={t("provider.quota.unit")}
                      options={COMMON_UNITS.map((unit) => ({ value: unit, label: `${unitLabel(unit)}（${unit}）` }))}
                    />
                  </Form.Item>
                </Col>
                <Col xs={12} md={6}>
                  <Form.Item {...field} name={[field.name, "limit"]} noStyle>
                    <InputNumber min={1} style={{ width: "100%" }} placeholder={t("provider.quota.limit")} />
                  </Form.Item>
                </Col>
                <Col xs={12} md={5}>
                  <Form.Item {...field} name={[field.name, "window"]} noStyle>
                    <Select options={WINDOWS.map((value) => ({ value, label: value }))} />
                  </Form.Item>
                </Col>
                <Col xs={20} md={5}>
                  <Form.Item {...field} name={[field.name, "resetAt"]} noStyle>
                    {/* 归零时刻带时区偏移，按主人自己的时区算，不是 UTC 零点 */}
                    <Input placeholder="00:00+08:00" />
                  </Form.Item>
                </Col>
                <Col xs={4} md={1}>
                  <Button type="text" danger icon={<DeleteOutlined />} onClick={() => remove(field.name)} />
                </Col>
              </Row>
            ))}
            <Button type="dashed" icon={<PlusOutlined />} onClick={() => add({ unit: "", limit: 1, window: "day" })}>
              {t("provider.limits.quotaAdd")}
            </Button>
          </Space>
        )}
      </Form.List>

      <div style={{ marginBottom: 8, fontWeight: 600 }}>{t("provider.contribution.schedule")}</div>
      <Form.List name="schedule">
        {(fields, { add, remove }) => (
          <Space direction="vertical" size={8} style={{ width: "100%", marginBottom: 16 }}>
            {fields.map((field) => (
              <Row key={field.key} gutter={8} align="middle">
                <Col xs={7} md={5}>
                  <Form.Item {...field} name={[field.name, "from"]} noStyle>
                    <Input placeholder={`${t("provider.limits.scheduleFrom")} 22:00`} />
                  </Form.Item>
                </Col>
                <Col xs={7} md={5}>
                  <Form.Item {...field} name={[field.name, "to"]} noStyle>
                    <Input placeholder={`${t("provider.limits.scheduleTo")} 08:00`} />
                  </Form.Item>
                </Col>
                <Col xs={8} md={6}>
                  <Form.Item {...field} name={[field.name, "tz"]} noStyle>
                    <Input placeholder="Asia/Shanghai" />
                  </Form.Item>
                </Col>
                <Col xs={2} md={1}>
                  <Button type="text" danger icon={<DeleteOutlined />} onClick={() => remove(field.name)} />
                </Col>
              </Row>
            ))}
            <Button type="dashed" icon={<PlusOutlined />} onClick={() => add({ from: "22:00", to: "08:00", tz: "" })}>
              {t("provider.limits.scheduleAdd")}
            </Button>
          </Space>
        )}
      </Form.List>

      <Button type="primary" htmlType="submit" loading={saving}>
        {t("common.save")}
      </Button>
    </Form>
  );
}
