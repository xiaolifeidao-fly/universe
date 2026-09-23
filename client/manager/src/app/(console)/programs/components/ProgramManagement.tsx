"use client";

import { EditOutlined, PlusOutlined, ReloadOutlined } from "@ant-design/icons";
import { Button, Empty, Form, Input, Modal, Select, Space, Table, Tag, Tooltip, message } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useLocale } from "@/i18n/LocaleProvider";
import { useCanWrite } from "@/components/permission/WritePermission";
import { BizLineRecord, fetchBizLines } from "../../business-lines/api/bizline.api";
import { fetchPrograms, saveProgram, type SaveProgramPayload, ProgramRecord } from "../api/program.api";

function formatTime(value?: string, locale = "zh-CN") {
  if (!value) return "-";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "-" : date.toLocaleString(locale, { hour12: false });
}

export function ProgramManagement() {
  const { t, locale } = useLocale();
  const canWrite = useCanWrite();
  const [bizLines, setBizLines] = useState<BizLineRecord[]>([]);
  const [bizLine, setBizLine] = useState<string>("");
  const [rows, setRows] = useState<ProgramRecord[]>([]);
  const [loading, setLoading] = useState(false);

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<ProgramRecord | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [form] = Form.useForm<SaveProgramPayload>();

  useEffect(() => {
    fetchBizLines()
      .then((list) => {
        setBizLines(list);
        setBizLine((current) => current || list[0]?.code || "");
      })
      .catch((error: Error) => message.error(error.message));
  }, []);

  const load = useCallback(async () => {
    if (!bizLine) {
      setRows([]);
      return;
    }
    setLoading(true);
    try {
      setRows(await fetchPrograms(bizLine));
    } catch (error) {
      message.error((error as Error).message);
    } finally {
      setLoading(false);
    }
  }, [bizLine]);

  useEffect(() => {
    void load();
  }, [load]);

  const openCreate = () => {
    setEditing(null);
    form.resetFields();
    form.setFieldsValue({ status: "active" });
    setFormOpen(true);
  };

  const openEdit = (record: ProgramRecord) => {
    setEditing(record);
    form.setFieldsValue({
      programCode: record.programCode,
      name: record.name,
      summary: record.summary,
      status: record.status,
    });
    setFormOpen(true);
  };

  const submitForm = async () => {
    const values = await form.validateFields();
    setSubmitting(true);
    try {
      await saveProgram(values, bizLine, editing?.programId);
      message.success(t("programs.saved"));
      setFormOpen(false);
      void load();
    } catch (error) {
      message.error((error as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  const columns = useMemo<ColumnsType<ProgramRecord>>(
    () => [
      { title: t("programs.field.programCode"), dataIndex: "programCode", width: 160, render: (value: string) => <span className="manager-mono">{value}</span> },
      { title: t("programs.field.name"), dataIndex: "name", width: 200 },
      { title: t("programs.field.summary"), dataIndex: "summary", ellipsis: true },
      {
        title: t("programs.field.status"),
        dataIndex: "status",
        width: 110,
        render: (value: string) => <Tag color={value === "active" ? "green" : "default"}>{t(value === "active" ? "programs.status.active" : "programs.status.archived")}</Tag>,
      },
      { title: t("programs.field.updatedBy"), dataIndex: "updatedBy", width: 130 },
      {
        title: t("programs.field.updatedAt"),
        dataIndex: "updatedAt",
        width: 170,
        render: (value?: string) => <span className="manager-mono">{formatTime(value, locale)}</span>,
      },
      {
        title: t("common.actions"),
        key: "actions",
        width: 90,
        fixed: "right",
        align: "right",
        render: (_, record) => (
          canWrite ? (
            <Tooltip title={t("common.edit")}>
              <Button type="link" size="small" icon={<EditOutlined />} onClick={() => openEdit(record)} />
            </Tooltip>
          ) : null
        ),
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [t, locale, canWrite],
  );

  return (
    <div className="manager-page-stack">
      <section className="manager-page-heading">
        <div>
          <span className="manager-section-label">PROGRAM MANAGEMENT</span>
          <h1>{t("programs.title")}</h1>
          <p>{t("programs.subtitle")}</p>
        </div>
        {canWrite ? (
          <Button type="primary" icon={<PlusOutlined />} disabled={!bizLine} onClick={openCreate}>
            {t("programs.new")}
          </Button>
        ) : null}
      </section>

      <section className="manager-data-card manager-table">
        <div className="manager-toolbar" style={{ marginBottom: 14 }}>
          <Select
            className="manager-filter-input"
            style={{ minWidth: 220 }}
            placeholder={t("programs.selectBizLine")}
            value={bizLine || undefined}
            onChange={(value) => setBizLine(value)}
            options={bizLines.map((line) => ({ value: line.code, label: `${line.name} (${line.code})` }))}
          />
          <Tooltip title={t("common.refresh")}>
            <Button icon={<ReloadOutlined />} loading={loading} disabled={!bizLine} onClick={() => void load()} />
          </Tooltip>
        </div>
        {!bizLine ? (
          <Empty className="manager-empty-state" description={t("programs.selectBizLine")} />
        ) : (
          <Table<ProgramRecord> rowKey="programId" loading={loading} columns={columns} dataSource={rows} scroll={{ x: 950 }} pagination={{ pageSize: 20, showSizeChanger: false }} />
        )}
      </section>

      <Modal
        wrapClassName="manager-form-skin"
        open={formOpen}
        title={editing ? t("programs.editTitle") : t("programs.newTitle")}
        confirmLoading={submitting}
        onOk={() => void submitForm()}
        onCancel={() => setFormOpen(false)}
        destroyOnClose
      >
        <Form form={form} layout="vertical">
          <Form.Item label={t("programs.field.programCode")} name="programCode" rules={[{ required: true, message: t("programs.programCodeRequired") }]}>
            <Input disabled={Boolean(editing)} autoComplete="off" />
          </Form.Item>
          <Form.Item label={t("programs.field.name")} name="name" rules={[{ required: true, message: t("programs.nameRequired") }]}>
            <Input />
          </Form.Item>
          <Form.Item label={t("programs.field.summary")} name="summary">
            <Input.TextArea rows={3} />
          </Form.Item>
          <Form.Item label={t("programs.field.status")} name="status" rules={[{ required: true }]}>
            <Select options={[{ value: "active", label: t("programs.status.active") }, { value: "archived", label: t("programs.status.archived") }]} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
