# 新增页面 / 接口对接向导

## 1. 新增一个控制台页面

以「告警规则」页为例，路由 `/risk-alerts`，对接服务端 `/api/risk/alerts*`。

### Step 1 — 先确认服务端契约

拿到（或先写）服务端的 DTO 定义，逐字段抄 `json` tag。**不要凭猜写字段名** —— 名字不一致时前端拿到的是 `undefined`，且不报错。

```
GET  /api/risk/alerts          → {total, data:[AlertRuleView]}
GET  /api/risk/alerts/overview → AlertRuleOverview
POST /api/risk/alerts          → null
```

若原型里有对应页（查 `design-qa.md` 的路由映射表），先读 `demo/auto_prototype/` 下的 HTML。

### Step 2 — 目录与 page.tsx

```
src/app/(console)/risk-alerts/
├── page.tsx
├── api/riskAlert.api.ts
└── components/RiskAlerts.tsx
```

```tsx
// page.tsx
"use client";
import { RiskAlerts } from "./components/RiskAlerts";
export default function RiskAlertsPage() { return <RiskAlerts />; }
```

### Step 3 — API 层

```ts
"use client";

import { getData, getPage, instance, unwrapApiResponse, type ApiResponse } from "@/utils/axios";
import { withBizLine } from "@/utils/bizLine";
import type { BusinessLineId } from "@/business-lines/BusinessLineProvider";

export type AlertLevel = "info" | "warn" | "critical";

export class AlertRuleRecord {
  ruleId = "";

  name = "";

  level: AlertLevel = "info";

  threshold = 0;

  enabled = false;

  updatedAt?: string;
}

export class AlertRuleOverview {
  total = 0;

  enabled = 0;

  levelCounts: Record<string, number> = {};
}

export interface AlertRuleQuery {
  pageIndex?: number;
  pageSize?: number;
  level?: AlertLevel | "";
}

export async function fetchAlertRules(bizLine: BusinessLineId, query: AlertRuleQuery = {}) {
  return getPage(AlertRuleRecord, "/risk/alerts", withBizLine(bizLine, query));
}

export async function fetchAlertRuleOverview(bizLine: BusinessLineId) {
  return getData(AlertRuleOverview, "/risk/alerts/overview", withBizLine(bizLine));
}

export interface SaveAlertRulePayload {
  ruleId: string;
  name: string;
  level: AlertLevel;
  threshold: number;
  enabled: boolean;
}

export async function saveAlertRule(bizLine: BusinessLineId, payload: SaveAlertRulePayload) {
  const response = await instance.post<ApiResponse<null>>("/risk/alerts", { bizLine, ...payload });
  return unwrapApiResponse(response.data);
}
```

自检：class 有默认值？字段名 == `json` tag？路径不带 `/api` 前缀？每个函数首参是 `bizLine`？

### Step 4 — i18n（三种语言都要）

`src/i18n/LocaleProvider.tsx` 的 `messages` 里，**先加 `zh-CN`**（它是 `TranslationKey` 的权威源），再补 `en-US`、`id-ID`：

```ts
"nav.riskAlerts": "告警规则",
"page.riskAlerts.title": "告警规则",
"page.riskAlerts.subtitle": "阈值配置 · 分级通知 · Alert Rules",
"alert.name": "规则名称",
"alert.level": "级别",
"alert.level.info": "提示",
"alert.level.warn": "警告",
"alert.level.critical": "严重",
"alert.threshold": "阈值",
"alert.enabled": "启用",
"alert.saveSuccess": "保存成功",
```

三个文件段落里键必须完全一致 —— 缺键会直接显示键名。

### Step 5 — 页面组件

```tsx
"use client";

import { Button, Segmented, Space, Switch, Table, message } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useEffect, useState } from "react";
import { useLocale } from "@/i18n/LocaleProvider";
import { useBusinessLine } from "@/business-lines/BusinessLineProvider";
import {
  fetchAlertRuleOverview, fetchAlertRules, saveAlertRule,
  type AlertLevel, type AlertRuleRecord,
} from "../api/riskAlert.api";

export function RiskAlerts() {
  const { t } = useLocale();
  const { activeBusinessLine } = useBusinessLine();
  const [level, setLevel] = useState<"all" | AlertLevel>("all");
  const [rows, setRows] = useState<AlertRuleRecord[]>([]);
  const [overview, setOverview] = useState({ total: 0, enabled: 0, levelCounts: {} as Record<string, number> });
  const [loading, setLoading] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let active = true;
    setLoading(true);
    Promise.all([
      fetchAlertRules(activeBusinessLine.id, { pageIndex: 1, pageSize: 200, level: level === "all" ? "" : level }),
      fetchAlertRuleOverview(activeBusinessLine.id),
    ]).then(([page, view]) => {
      if (!active) return;
      setRows(page.data);
      setOverview(view);
    }).catch(() => {
      if (!active) return;
      setRows([]);
      setOverview({ total: 0, enabled: 0, levelCounts: {} });
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [activeBusinessLine.id, level, reloadKey]);   // ★ 业务线在依赖里

  const toggle = async (record: AlertRuleRecord, enabled: boolean) => {
    try {
      await saveAlertRule(activeBusinessLine.id, { ...record, enabled });
      message.success(t("alert.saveSuccess"));
      setReloadKey((value) => value + 1);
    } catch (error) {
      message.error((error as Error).message);
    }
  };

  const columns: ColumnsType<AlertRuleRecord> = [
    { title: t("alert.name"), dataIndex: "name", width: 200 },
    { title: t("alert.level"), dataIndex: "level", width: 110,
      render: (value: AlertLevel) => t(`alert.level.${value}`) },
    { title: t("alert.threshold"), dataIndex: "threshold", width: 110,
      render: (value: number) => <span className="manager-mono">{value}</span> },
    { title: t("alert.enabled"), dataIndex: "enabled", width: 100, fixed: "right", align: "right",
      render: (value: boolean, record) => <Switch checked={value} onChange={(next) => void toggle(record, next)} /> },
  ];

  return (
    <div className="manager-page-stack">
      <section className="manager-section-title">
        <h2>{t("page.riskAlerts.title")}</h2>
        <span className="manager-mono" style={{ fontSize: 12, color: "var(--manager-text-faint)" }}>
          ALERT RULES · {overview.enabled}/{overview.total} ENABLED
        </span>
        <span className="manager-section-rule" />
        <Segmented
          value={level}
          onChange={(value) => setLevel(value as "all" | AlertLevel)}
          options={[
            { label: t("alert.all"), value: "all" },
            ...(["info", "warn", "critical"] as AlertLevel[]).map((item) => ({ label: t(`alert.level.${item}`), value: item })),
          ]}
        />
      </section>
      <section className="manager-data-card manager-table">
        <Table<AlertRuleRecord>
          rowKey="ruleId" loading={loading} columns={columns} dataSource={rows}
          scroll={{ x: 620 }} pagination={{ pageSize: 10, showSizeChanger: false }} />
      </section>
    </div>
  );
}
```

### Step 6 — 挂导航

`src/components/manager-shell/ManagerShell.tsx`：

```tsx
const PAGE_TITLES: Record<string, [string, string]> = {
  // ...
  "/risk-alerts": ["page.riskAlerts.title", "page.riskAlerts.subtitle"],
};

// NAV_GROUPS 的 grp-risk 分组
children: [
  { key: "/attribution-config", label: "nav.attributionConfig", icon: <span>⚙️</span> },
  { key: "/attribution-analysis", label: "nav.attributionAnalysis", icon: <span>🔬</span> },
  { key: "/risk-alerts", label: "nav.riskAlerts", icon: <span>🔔</span> },
],
```

### Step 7 — 验证

```bash
cd client/web && npm run dev
```

访问 `http://localhost:7892/risk-alerts`（服务端要在 `:10001` 跑着）。检查：

- 表格出数据（Network 里看 `/api/risk/alerts` 的响应 `success:true`）
- 切换业务线数据重新拉
- 切换筛选无竞态（快速连点几次筛选，最终显示的是最后一次的结果）
- 切换三种语言无键名裸露
- 失败路径：停掉服务端，页面应显示空表而不是白屏

### 清单

- [ ] `page.tsx` 三行，`"use client"`
- [ ] api 文件在页面目录的 `api/` 下，命名 `{单数资源}.api.ts`
- [ ] 响应模型是 class + 默认值，字段名 == 服务端 `json` tag
- [ ] 路径不带 `/api` 前缀
- [ ] 每个请求函数首参 `bizLine`，用 `withBizLine` 或 `{ bizLine, ...payload }`
- [ ] 没有手写 `fetch`
- [ ] `useEffect` 依赖含 `activeBusinessLine.id`，有 `active` 竞态标志，catch 里清空
- [ ] 全部文案走 `t()`，三种语言都补
- [ ] 布局用 `manager-*` 类，颜色用 `var(--manager-*)`
- [ ] `ManagerShell` 的 `PAGE_TITLES` + `NAV_GROUPS` 已挂
- [ ] 无 `any`，`npm run lint` 通过

---

## 2. 把 mock 页面改造成真接口

12 个页面仍用组件内 mock：`ai`、`ai-config`、`attribution`、`commands`、`contacts`、`device-timeline`、`exec-guard`、`growth-strategy`、`operations-strategy`、`orchestration`、`scoring`、`survival`、`task-library`。

改造顺序：

**① 找出 mock 数据的形状。** 在组件里（或 `data.ts` / `deviceData.ts`）找常量数组，这就是页面实际需要的字段集合。

**② 与服务端 DTO 对齐。** 读对应层的 `service/{domain}/dto/dto.go`。三种情况：

- 服务端已有对应 DTO 且字段够 → 直接建 api 文件
- 字段不够 → 服务端补 DTO 字段 + View 转换（后端技能 `backend-api-design.md` §6）
- 接口不存在 → 按后端技能 `backend-new-module-guide.md` §A 新增接口

**层归属看路径前缀**：`contacts` → `/resource/contacts`（第 1 层）；`task-library`、`commands`、`exec-guard` → `/task/*`（第 2 层）；`scoring`、`survival`、`attribution` → `/risk/*`（第 3 层）；`growth-strategy`、`operations-strategy` → `/strategy/*`（第 4 层）；`ai`、`ai-config` → `/aisched/*`（第 5 层）；`orchestration`、`device-timeline` → `/orchestration/*`（第 6 层）。

**③ 建 `api/{name}.api.ts`**，把 mock 常量的 TS 类型翻成 class + 默认值。

**④ 替换组件里的数据来源**：常量 → `useState` + `useEffect`（照 Step 5 的模板），加 `loading` 传给 `<Table>` / `<Spin>`。

**⑤ 删掉 mock 常量和 `data.ts`。** 留着会有人误以为还在用。

**⑥ 逐字段对比页面**，确认没有字段变 `undefined`（typo 的常见后果是显示成空白而不报错）。

**⑦ 补 loading 与失败态。** mock 页面通常两个都没有。

改造时不要顺手重写 UI —— `design-qa.md` 已逐页验收过视觉；先只换数据源，UI 改动单独提。

---

## 3. 常见坑

| 现象 | 原因 |
|---|---|
| 字段显示空白，无报错 | class 字段名与服务端 `json` tag 不一致 |
| `total: undefined` | 服务端返数组，却用了 `getPage`（该用 `getDataList`） |
| 列表永远空 | 请求没带 `bizLine` |
| 切业务线数据不变 | `useEffect` 依赖漏了 `activeBusinessLine.id` |
| 快速切筛选后显示旧数据 | 没有 `active` 竞态标志 |
| 时间显示「公元一年」 | 服务端零值 `time.Time`，该用 `*time.Time` |
| 报 404 | 路径多写了 `/api` 前缀（`baseURL` 已经是 `/api`） |
| 报错文案是英文 axios 文案 | 服务端返了非 200，应该返 200 + `success:false` |
| 页面显示键名而非文案 | 只在 zh-CN 加了键，另两种语言漏了 |
| `plainToInstance` 返空对象 | 响应模型用了 `interface` 或字段没有默认值 |
| 批量导入 / LLM 接口超时 | `instance` 默认 `timeout: 10000`，调用处单独放宽 |
