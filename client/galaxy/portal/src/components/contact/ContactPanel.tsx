"use client";

/**
 * 联系我们。左边表单，右边直接联系方式。
 *
 * 三件事值得说明：
 *
 *  1. 表单里有一个 website 蜜罐字段。它不是 display:none —— 有些脚本会跳过隐藏
 *     字段，所以是挪到屏幕外、并 aria-hidden + tabIndex=-1，真人碰不到它。
 *  2. 没配的联系方式显示成 [待填写]，不编一个。编一个假邮箱的代价是有人真的
 *     往那儿发信，然后再也没有下文。
 *  3. 已经是用户的人应该去控制台而不是填这张表 —— 账单争议在那边有正经流程，
 *     比留言快。右栏第一件事就是把他们送走。
 */

import { Form, Input, Select, message } from "antd";
import { useState } from "react";
import { useLocale } from "@/i18n/LocaleProvider";
import { Card, LinkBtn, Section, TextLink } from "@/components/site/kit";
import { IconArrowRight, IconChat, IconCheck, IconMail } from "@/components/site/icons";
import { PageHero } from "@/components/home/HomeSections";
import { submitLead, type SubmitLeadRequest } from "@/app/(site)/contact/api/contact.api";
import { orPlaceholder, siteConfig } from "@/utils/site";
import type { PortalOverview } from "@/utils/portal";

const TOPICS = ["enterprise", "support", "business", "other"] as const;

export function ContactPanel({ overview }: { overview: PortalOverview }) {
  const { t } = useLocale();
  const [form] = Form.useForm<SubmitLeadRequest>();
  const [sending, setSending] = useState(false);
  const [done, setDone] = useState(false);
  const [toast, contextHolder] = message.useMessage();

  async function onSubmit(values: SubmitLeadRequest) {
    // 每次提交都先把上一条的成功提示收掉。不收的话，第二次提交被限流时
    // 屏幕上会同时挂着一条「已收到」和一条「没发出去」。
    setDone(false);
    setSending(true);
    try {
      await submitLead(values);
      setDone(true);
      form.resetFields();
    } catch (error) {
      toast.error(`${t("contact.form.failed")}：${(error as Error).message}`);
    } finally {
      setSending(false);
    }
  }

  return (
    <>
      {contextHolder}
      <PageHero eyebrow={t("nav.contact")} title={t("contact.title")} lead={t("contact.lead")} />

      <Section>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "minmax(0, 1.35fr) minmax(0, 1fr)",
            gap: "clamp(20px, 3vw, 40px)",
            alignItems: "start",
          }}
          className="gp-contact"
        >
          <Card style={{ padding: "clamp(22px, 3vw, 32px)" }}>
            <h2 className="gp-h3" style={{ fontSize: 20, marginBottom: 20 }}>
              {t("contact.form.title")}
            </h2>

            {done ? (
              <div className="gp-note">
                <IconCheck />
                <span>{t("contact.form.success")}</span>
              </div>
            ) : null}

            <Form
              form={form}
              layout="vertical"
              requiredMark={false}
              onFinish={onSubmit}
              initialValues={{ topic: "enterprise" }}
              style={{ marginTop: done ? 18 : 0 }}
            >
              <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: "0 16px" }}>
                <Form.Item name="name" label={t("contact.form.name")}>
                  <Input placeholder={t("contact.form.namePlaceholder")} maxLength={64} />
                </Form.Item>
                <Form.Item
                  name="contact"
                  label={t("contact.form.contact")}
                  rules={[{ required: true, message: t("contact.form.contactRequired") }]}
                >
                  <Input placeholder={t("contact.form.contactPlaceholder")} maxLength={128} />
                </Form.Item>
                <Form.Item name="company" label={t("contact.form.company")}>
                  <Input placeholder={t("contact.form.companyPlaceholder")} maxLength={128} />
                </Form.Item>
                <Form.Item name="topic" label={t("contact.form.topic")}>
                  <Select
                    options={TOPICS.map((topic) => ({
                      value: topic,
                      label: t(`contact.topic.${topic}` as "contact.topic.other"),
                    }))}
                  />
                </Form.Item>
              </div>

              <Form.Item name="scale" label={t("contact.form.scale")}>
                <Input placeholder={t("contact.form.scalePlaceholder")} maxLength={32} />
              </Form.Item>

              <Form.Item name="message" label={t("contact.form.message")}>
                <Input.TextArea
                  rows={5}
                  maxLength={1000}
                  showCount
                  placeholder={t("contact.form.messagePlaceholder")}
                />
              </Form.Item>

              {/* 蜜罐。真人看不见也 tab 不到；脚本会填，服务端见到非空就静默丢弃。 */}
              <div className="gp-honeypot" aria-hidden="true">
                <Form.Item name="website" label="Website">
                  <Input tabIndex={-1} autoComplete="off" />
                </Form.Item>
              </div>

              <div style={{ display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap", marginTop: 4 }}>
                <button type="submit" className="gp-btn gp-btn--primary gp-btn--lg" disabled={sending}>
                  {sending ? t("contact.form.submitting") : t("contact.form.submit")}
                  {sending ? null : <IconArrowRight size={17} />}
                </button>
                <span style={{ fontSize: 12.5, color: "var(--gp-faint)", maxWidth: "38ch", lineHeight: 1.6 }}>
                  {t("contact.form.privacy")}
                </span>
              </div>
            </Form>
          </Card>

          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <Card>
              <h3 className="gp-h3">{t("contact.side.title")}</h3>
              <div style={{ display: "flex", flexDirection: "column", gap: 14, marginTop: 16 }}>
                <ContactRow icon={<IconMail size={18} />} label={t("contact.side.email")}>
                  {siteConfig.contactEmail ? (
                    <a className="gp-mono" style={{ fontSize: 13 }} href={`mailto:${siteConfig.contactEmail}`}>
                      {siteConfig.contactEmail}
                    </a>
                  ) : (
                    <span className="gp-mono" style={{ fontSize: 13, color: "var(--gp-faint)" }}>
                      {orPlaceholder("")}
                    </span>
                  )}
                </ContactRow>
                <ContactRow icon={<IconChat size={18} />} label={t("contact.side.wechat")}>
                  <span className="gp-mono" style={{ fontSize: 13 }}>
                    {orPlaceholder(siteConfig.contactWechat)}
                  </span>
                </ContactRow>
              </div>
            </Card>

            <Card>
              <h3 className="gp-h3">{t("contact.side.console")}</h3>
              <p className="gp-body" style={{ marginTop: 8, fontSize: 13.5 }}>
                {t("contact.side.consoleBody")}
              </p>
              <div style={{ marginTop: 14 }}>
                <LinkBtn href={siteConfig.consoleURL} tone="ghost" size="sm">
                  {t("contact.side.consoleLink")}
                  <IconArrowRight size={15} />
                </LinkBtn>
              </div>
            </Card>

            <Card className="gp-card--flat">
              <h3 className="gp-h3" style={{ fontSize: 15 }}>
                {t("contact.side.hoursTitle")}
              </h3>
              <p className="gp-body" style={{ marginTop: 8, fontSize: 13.5 }}>
                {t("contact.side.hoursBody")}
              </p>
              {overview.models.length > 0 ? (
                <div style={{ marginTop: 14 }}>
                  <TextLink href="/models" arrow>
                    {t("common.viewModels")}
                  </TextLink>
                </div>
              ) : null}
            </Card>
          </div>
        </div>
      </Section>
    </>
  );
}

function ContactRow({
  icon,
  label,
  children,
}: {
  icon: React.ReactNode;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
      <span
        style={{
          display: "grid",
          placeItems: "center",
          width: 34,
          height: 34,
          borderRadius: 10,
          background: "var(--gp-surface-2)",
          color: "var(--gp-soft)",
          flex: "0 0 auto",
        }}
      >
        {icon}
      </span>
      <span style={{ minWidth: 0 }}>
        <span style={{ display: "block", fontSize: 11.5, color: "var(--gp-faint)" }}>{label}</span>
        {children}
      </span>
    </div>
  );
}
