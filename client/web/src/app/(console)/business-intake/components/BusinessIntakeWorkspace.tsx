"use client";

import { FileSearchOutlined, ReloadOutlined } from "@ant-design/icons";
import { Alert, Button, Divider, Drawer, Empty, List, Spin, message } from "antd";
import { useCallback, useEffect, useState } from "react";
import { useBusinessLine } from "@/business-lines/BusinessLineProvider";
import { useLocale } from "@/i18n/LocaleProvider";
import {
  type BusinessRequirementConversation,
  type BusinessRequirementMessage,
  type BusinessRequirementRecord,
  fetchCollectedBusinessRequirementConversation,
  fetchCollectedBusinessRequirements,
} from "../api/businessIntake.api";
import { SessionMarkdown } from "../../delivery/components/DeliverySessionMessage";
import { BusinessRequirementDocuments } from "../../business-workbench/components/BusinessRequirementDocuments";

function formatTime(value: string | undefined, locale: string) {
  if (!value) return "-";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "-" : date.toLocaleString(locale, { hour12: false });
}

export function BusinessIntakeWorkspace() {
  const { t, locale } = useLocale();
  const { activeBusinessLine, businessLinesLoaded } = useBusinessLine();
  const [requirements, setRequirements] = useState<BusinessRequirementRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<BusinessRequirementConversation | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const loadRequirements = useCallback(async () => {
    if (!activeBusinessLine.id) {
      setRequirements([]);
      setTotal(0);
      return;
    }
    setLoading(true);
    try {
      const page = await fetchCollectedBusinessRequirements(activeBusinessLine.id);
      setRequirements(page.data);
      setTotal(page.total);
    } catch (error) {
      setRequirements([]);
      setTotal(0);
      message.error((error as Error).message);
    } finally {
      setLoading(false);
    }
  }, [activeBusinessLine.id]);

  useEffect(() => {
    if (businessLinesLoaded) void loadRequirements();
  }, [businessLinesLoaded, loadRequirements]);

  const openDetail = async (requirement: BusinessRequirementRecord) => {
    if (!activeBusinessLine.id) return;
    setDetailLoading(true);
    try {
      setSelected(await fetchCollectedBusinessRequirementConversation(activeBusinessLine.id, requirement.id));
    } catch (error) {
      message.error((error as Error).message);
    } finally {
      setDetailLoading(false);
    }
  };

  if (!businessLinesLoaded) return null;

  return (
    <div className="manager-page-stack">
      {!activeBusinessLine.id ? <Alert type="info" showIcon message={t("businessIntake.noSpace")} /> : null}
      <section className="manager-section-title">
        <h2>{t("businessIntake.title")}</h2>
        <span className="manager-mono" style={{ fontSize: 12, color: "var(--manager-text-faint)" }}>
          BUSINESS INTAKE · {total}
        </span>
        <span className="manager-section-rule" />
        <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void loadRequirements()}>{t("businessIntake.refresh")}</Button>
      </section>

      <section className="manager-data-card">
        <p className="manager-card-hint">{t("businessIntake.intro")}</p>
        <List<BusinessRequirementRecord>
          className="manager-business-intake__list"
          loading={loading}
          locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("businessIntake.empty")} /> }}
          dataSource={requirements}
          renderItem={(item) => (
            <List.Item className="manager-business-intake__item" actions={[
              <Button key="view" type="link" onClick={() => void openDetail(item)}>{t("businessIntake.view")}</Button>,
            ]}>
              <List.Item.Meta
                avatar={<span className="manager-business-intake__icon"><FileSearchOutlined /></span>}
                title={<button type="button" className="manager-business-intake__title" onClick={() => void openDetail(item)}>{item.title || t("businessIntake.untitled")}</button>}
                description={(
                  <div>
                    <p>{item.detail || t("businessIntake.draft")}</p>
                    <span className="manager-mono">{t("businessIntake.project")} {item.programName || item.programCode || `#${item.programId}`} · {t("businessIntake.raisedBy")} {item.createdByName || item.createdBy || "-"} · {formatTime(item.updatedAt || item.createdAt, locale)}</span>
                  </div>
                )}
              />
            </List.Item>
          )}
        />
      </section>

      <Drawer
        open={Boolean(selected) || detailLoading}
        onClose={() => { if (!detailLoading) setSelected(null); }}
        width={760}
        title={selected ? `${t("businessIntake.detailTitle")} · ${selected.requirement.title || t("businessIntake.untitled")}` : t("businessIntake.detailTitle")}
      >
        {detailLoading && !selected ? <div className="manager-business-intake__loading"><Spin size="large" /></div> : selected ? (
          <>
            <Divider orientation="left">{t("businessIntake.documents")}</Divider>
            <BusinessRequirementDocuments documents={selected.documents} collapsible defaultOpen={false} />
            <Divider orientation="left">{t("businessIntake.conversation")}</Divider>
            <div className="manager-business-intake__messages">
              {selected.messages.map((item: BusinessRequirementMessage) => {
                const isBusiness = item.role === "user";
                return (
                  <article key={item.id} className={`manager-business-chat__message${isBusiness ? " manager-business-chat__message--user" : ""}`}>
                    <div className="manager-business-chat__message-meta">
                      {isBusiness ? t("businessIntake.businessUser") : t("businessIntake.ai")}
                      <span>{formatTime(item.createdAt, locale)}</span>
                    </div>
                    <div className="manager-business-chat__bubble"><SessionMarkdown text={item.content} /></div>
                  </article>
                );
              })}
            </div>
          </>
        ) : null}
      </Drawer>
    </div>
  );
}
