"use client";

import { DeleteOutlined, EditOutlined, PlusOutlined, SafetyCertificateOutlined } from "@ant-design/icons";
import { Alert, Button, Drawer, Form, Input, Modal, Popconfirm, Space, Switch, Table, Tabs, Tag, Tooltip, Tree, message } from "antd";
import type { ColumnsType } from "antd/es/table";
import type { DataNode } from "antd/es/tree";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useLocale } from "@/i18n/LocaleProvider";
import { useCanWrite } from "@/components/permission/WritePermission";
import {
  deleteRole,
  fetchResources,
  fetchRoleResourceIds,
  fetchRoles,
  saveRole,
  saveRoleResources,
  type ResourceRecord,
  type RoleRecord,
} from "../../api/console.api";

const SUPER_ADMIN = "super_admin";

/**
 * 角色与授权。
 *
 * 两道门在这里都看得见：勾选决定这个角色**够得着哪些资源**，
 * writable 开关决定它**能不能写**。两者叠加，写操作两道都得过 ——
 * 所以「取消 writable」是一句话把角色转成只读，不必逐条撤销它的写资源。
 */
export function RoleManagement() {
  const { t } = useLocale();
  const canWrite = useCanWrite();

  const [roles, setRoles] = useState<RoleRecord[]>([]);
  const [resources, setResources] = useState<ResourceRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<RoleRecord | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [grantTarget, setGrantTarget] = useState<RoleRecord | null>(null);
  const [checkedIds, setCheckedIds] = useState<number[]>([]);
  const [form] = Form.useForm();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [roleList, resourceList] = await Promise.all([fetchRoles(), fetchResources()]);
      setRoles(roleList);
      setResources(resourceList);
    } catch (error) {
      message.error((error as Error).message || t("common.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const openGrants = async (role: RoleRecord) => {
    setGrantTarget(role);
    try {
      setCheckedIds(await fetchRoleResourceIds(role.id));
    } catch (error) {
      message.error((error as Error).message || t("common.loadFailed"));
    }
  };

  const submitGrants = async () => {
    if (!grantTarget) return;
    try {
      await saveRoleResources(grantTarget.id, checkedIds);
      message.success(t("common.saved"));
      setGrantTarget(null);
      void load();
    } catch (error) {
      message.error((error as Error).message || t("common.actionFailed"));
    }
  };

  const submitRole = async () => {
    const values = await form.validateFields();
    try {
      await saveRole({ ...values, id: editing?.id });
      message.success(t("common.saved"));
      setFormOpen(false);
      void load();
    } catch (error) {
      message.error((error as Error).message || t("common.actionFailed"));
    }
  };

  const remove = async (role: RoleRecord) => {
    try {
      await deleteRole(role.id);
      message.success(t("common.saved"));
      void load();
    } catch (error) {
      message.error((error as Error).message || t("common.actionFailed"));
    }
  };

  const pageTree = useMemo(() => buildResourceTree(resources), [resources]);
  const apiTree = useMemo(() => buildAPINodes(resources), [resources]);

  const columns: ColumnsType<RoleRecord> = [
    {
      title: t("roles.name"),
      dataIndex: "name",
      render: (name: string, record) => (
        <Space direction="vertical" size={0}>
          <span style={{ fontWeight: 600 }}>{name}</span>
          <span className="manager-mono" style={{ fontSize: 12, color: "var(--manager-text-faint)" }}>
            {record.code}
          </span>
        </Space>
      ),
    },
    {
      title: t("roles.writable"),
      dataIndex: "writable",
      width: 140,
      render: (writable: boolean) =>
        writable ? <Tag color="success">{t("roles.writable")}</Tag> : <Tag>{t("common.readOnly")}</Tag>,
    },
    { title: t("roles.userCount"), dataIndex: "userCount", width: 100 },
    {
      title: t("common.status"),
      dataIndex: "status",
      width: 110,
      render: (status: string) => <Tag color={status === "active" ? "success" : "default"}>{status}</Tag>,
    },
    {
      title: t("common.actions"),
      key: "actions",
      width: 170,
      align: "right",
      render: (_, record) =>
        canWrite ? (
          <Space size={0}>
            <Tooltip title={t("roles.resources")}>
              <Button
                type="link"
                size="small"
                icon={<SafetyCertificateOutlined />}
                // 超级管理员绕过全部授权，勾选对它没有意义。
                disabled={record.code === SUPER_ADMIN}
                onClick={() => void openGrants(record)}
              />
            </Tooltip>
            <Tooltip title={t("common.edit")}>
              <Button
                type="link"
                size="small"
                icon={<EditOutlined />}
                onClick={() => {
                  setEditing(record);
                  setFormOpen(true);
                  form.setFieldsValue(record);
                }}
              />
            </Tooltip>
            {record.code === SUPER_ADMIN ? (
              <Tooltip title={t("roles.superAdminLocked")}>
                <Button type="link" size="small" disabled icon={<DeleteOutlined />} />
              </Tooltip>
            ) : (
              <Popconfirm title={t("roles.deleteConfirm")} onConfirm={() => void remove(record)}>
                <Tooltip title={t("common.delete")}>
                  <Button type="link" size="small" danger icon={<DeleteOutlined />} />
                </Tooltip>
              </Popconfirm>
            )}
          </Space>
        ) : null,
    },
  ];

  return (
    <div className="manager-page-stack">
      <section className="manager-page-heading">
        <div>
          <span className="manager-section-label">ROLES</span>
          <h1>{t("roles.title")}</h1>
          <p>{t("roles.subtitle")}</p>
        </div>
        {canWrite ? (
          <Button
            type="primary"
            icon={<PlusOutlined />}
            onClick={() => {
              setEditing(null);
              setFormOpen(true);
              form.setFieldsValue({ code: "", name: "", writable: false, remark: "" });
            }}
          >
            {t("roles.new")}
          </Button>
        ) : null}
      </section>

      <section className="manager-data-card manager-table">
        <Table
          rowKey="id"
          size="small"
          loading={loading}
          columns={columns}
          dataSource={roles}
          pagination={false}
          locale={{ emptyText: t("roles.empty") }}
          scroll={{ x: 760 }}
        />
      </section>

      <Modal
        open={formOpen}
        title={editing ? t("roles.editTitle") : t("roles.new")}
        okText={t("common.save")}
        cancelText={t("common.cancel")}
        onOk={() => void submitRole()}
        onCancel={() => setFormOpen(false)}
        destroyOnClose
      >
        <Form form={form} layout="vertical">
          <Form.Item name="code" label={t("roles.code")} rules={[{ required: true }]}>
            <Input disabled={editing?.code === SUPER_ADMIN} />
          </Form.Item>
          <Form.Item name="name" label={t("roles.name")} rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="writable" label={t("roles.writable")} valuePropName="checked" extra={t("roles.writableHint")}>
            <Switch />
          </Form.Item>
          <Form.Item name="remark" label={t("roles.remark")}>
            <Input.TextArea rows={2} maxLength={256} />
          </Form.Item>
        </Form>
      </Modal>

      <Drawer
        width={560}
        open={grantTarget !== null}
        title={`${t("roles.resourcesTitle")} · ${grantTarget?.name ?? ""}`}
        onClose={() => setGrantTarget(null)}
        extra={
          canWrite ? (
            <Button type="primary" onClick={() => void submitGrants()}>
              {t("roles.saveResources")}
            </Button>
          ) : null
        }
      >
        <Alert type="info" showIcon style={{ marginBottom: 16 }} message={t("roles.resourcesHint")} />
        <Tabs
          items={[
            {
              key: "pages",
              label: t("roles.pages"),
              children: (
                <Tree
                  checkable
                  // checkStrictly：父子不联动。菜单和它下面的页面是两条独立授权，
                  // 联动会在勾一个页面时顺手把整个目录下的都勾上。
                  checkStrictly
                  defaultExpandAll
                  disabled={!canWrite}
                  treeData={pageTree}
                  checkedKeys={{ checked: checkedIds, halfChecked: [] }}
                  onCheck={(keys) => {
                    const checked = Array.isArray(keys) ? keys : keys.checked;
                    setCheckedIds(mergeChecked(checkedIds, checked as number[], pageTree));
                  }}
                />
              ),
            },
            {
              key: "apis",
              label: t("roles.apis"),
              children: (
                <Tree
                  checkable
                  checkStrictly
                  disabled={!canWrite}
                  treeData={apiTree}
                  checkedKeys={{ checked: checkedIds, halfChecked: [] }}
                  onCheck={(keys) => {
                    const checked = Array.isArray(keys) ? keys : keys.checked;
                    setCheckedIds(mergeChecked(checkedIds, checked as number[], apiTree));
                  }}
                />
              ),
            },
          ]}
        />
      </Drawer>
    </div>
  );
}

/**
 * mergeChecked 把某一个标签页里的勾选结果并回全量集合。
 *
 * 两个 Tree 共用同一份 checkedIds，直接用某一棵树的 onCheck 结果覆盖的话，
 * 另一棵树上已经勾好的会被一起抹掉 —— 表现是「配了接口权限，一切页面标签页
 * 就全丢了」。所以只替换属于这棵树的那部分。
 */
function mergeChecked(all: number[], checkedInTree: number[], tree: DataNode[]): number[] {
  const owned = new Set<number>();
  const walk = (nodes: DataNode[]) => {
    for (const node of nodes) {
      owned.add(node.key as number);
      if (node.children) walk(node.children);
    }
  };
  walk(tree);
  const kept = all.filter((id) => !owned.has(id));
  return [...kept, ...checkedInTree.filter((id) => owned.has(id))];
}

function buildResourceTree(resources: ResourceRecord[]): DataNode[] {
  const pages = resources
    // group 是菜单里的分组标题。它不是页面，但**必须留在这棵树里** ——
    // 漏掉它，挂在它底下的页面就找不到父节点，整段权限在这里凭空消失。
    .filter((item) => item.resourceType === "menu" || item.resourceType === "group" || item.resourceType === "page")
    .sort((a, b) => a.sortId - b.sortId || a.id - b.id);
  const childrenByParent = new Map<number, ResourceRecord[]>();
  for (const item of pages) {
    const siblings = childrenByParent.get(item.parentId) ?? [];
    siblings.push(item);
    childrenByParent.set(item.parentId, siblings);
  }
  const build = (item: ResourceRecord): DataNode => {
    const children = (childrenByParent.get(item.id) ?? []).map(build);
    return {
      key: item.id,
      title: item.pageUrl ? `${item.name}  ·  ${item.pageUrl}` : item.name,
      children: children.length > 0 ? children : undefined,
    };
  };
  return (childrenByParent.get(0) ?? []).map(build);
}

/** 接口按路径前缀分组，否则上百条平铺根本没法勾。 */
function buildAPINodes(resources: ResourceRecord[]): DataNode[] {
  const apis = resources.filter((item) => item.resourceType === "api");
  const groups = new Map<string, ResourceRecord[]>();
  for (const item of apis) {
    const segments = item.resourceUrl.split("/").filter(Boolean);
    const group = segments.length > 1 ? `/${segments[0]}/${segments[1]}` : `/${segments[0] ?? ""}`;
    const bucket = groups.get(group) ?? [];
    bucket.push(item);
    groups.set(group, bucket);
  }
  const entries: [string, ResourceRecord[]][] = [];
  groups.forEach((items, group) => entries.push([group, items]));
  entries.sort((left, right) => left[0].localeCompare(right[0]));
  return entries.map(([group, items]): DataNode => ({
    // 分组节点用负数 key：它不是真实资源，勾它不该往后端提交一个不存在的 id。
    key: -Math.abs(hashGroup(group)),
    title: group,
    checkable: false,
    children: items
      .slice()
      .sort((a, b) => a.resourceUrl.localeCompare(b.resourceUrl) || a.method.localeCompare(b.method))
      .map((item) => ({ key: item.id, title: `${item.method}  ${item.resourceUrl}` })),
  }));
}

function hashGroup(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) | 0;
  }
  return hash || 1;
}
