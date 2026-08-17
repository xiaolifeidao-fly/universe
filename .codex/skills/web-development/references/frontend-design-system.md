# 设计系统

两套东西配合：**antd Token**（组件内部观感）+ **`manager-*` CSS 体系**（页面布局与自定义块）。视觉基准是 `demo/auto_prototype/app.css`，`src/app/globals.css`（2700+ 行）是它的移植。

**不引入 Tailwind、CSS Modules、styled-components。** 布局用 `manager-*` 类，颜色用 `var(--manager-*)`，一次性微调用内联 `style`。

## 1. CSS 变量（`src/app/globals.css` 的 `:root`）

配色是浅色主题、绿色主色，`color-scheme: light`（**没有暗色模式**，不要写 `prefers-color-scheme`）。

### 表面与线条

| 变量 | 值 | 用途 |
|---|---|---|
| `--manager-bg` | `#eef1f6` | 页面底色 |
| `--manager-bg-soft` | `#f2f5f9` | 次级底色 |
| `--manager-surface` | `#ffffff` | 卡片 / 面板 |
| `--manager-surface-raised` | `#ffffff` | 浮起层 |
| `--manager-panel` | `#f2f5f9` | 内嵌面板 |
| `--manager-panel-muted` | `rgba(16,24,40,.07)` | 弱化块 |
| `--manager-border` | `rgba(16,24,40,.09)` | 常规描边 |
| `--manager-border-strong` | `rgba(16,24,40,.14)` | 强调描边 |

### 文字

| 变量 | 值 | 用途 |
|---|---|---|
| `--manager-text` | `#101828` | 正文 / 标题 |
| `--manager-text-soft` | `#3d4757` | 次要文字 |
| `--manager-text-faint` | `#667085` | 说明、英文副标、单位 |

### 语义色

| 变量 | 值 | 语义 |
|---|---|---|
| `--manager-primary` / `--manager-green` / `--manager-success` | `#12a150` | 主色 / 正常 / 在线 |
| `--manager-primary-hover` | `#0e8544` | 主色悬停 |
| `--manager-primary-light` / `--manager-primary-muted` | 10% / 16% 绿 | 主色浅底 |
| `--manager-cyan` | `#0e8ba8` | 资源域 / 链接 |
| `--manager-blue` | `#2563eb` | 编排域 |
| `--manager-violet` | `#7c3aed` | 风控域 |
| `--manager-amber` / `--manager-warning` | `#c07600` | 平台域 / 警告 |
| `--manager-orange` | `#e0631b` | 强提醒 |
| `--manager-red` / `--manager-danger` | `#dc2626` | 危险 / 离线 |

**分组配色有语义**（与 `ManagerShell` 的 `NavGroup.tone` 一致）：green 工作台 / cyan 资源 / blue 编排 / violet 风控 / amber 平台。新页面用它所属分组的色，别随便挑。

### 圆角、阴影、动效、字体

```
--manager-r-sm: 8px   --manager-r: 12px   --manager-r-lg: 16px   --manager-r-xl: 20px
--manager-shadow-sm / --manager-shadow / --manager-shadow-md / --manager-shadow-lg
--manager-ring: 0 0 0 3px rgba(18,161,80,.22)      聚焦环
--manager-ease: cubic-bezier(.4,0,.2,1)   --manager-t: .18s var(--manager-ease)
--manager-sans:  "Noto Sans SC", "PingFang SC", ...
--manager-mono:  "JetBrains Mono", ui-monospace, ...
--manager-serif: "Instrument Serif", Georgia, serif
```

三个字体从 Google Fonts `@import` 加载（globals.css 第一行）。

## 2. `.manager-mono`：技术字段必用

```css
.manager-mono { font-family: var(--manager-mono); font-variant-numeric: tabular-nums; }
```

**所有技术标识与数字都要套它**：设备号 `CP-096`、代理号 `IP-92`、手机号、任务 ID、版本号、时间戳、健康分、计数。`tabular-nums` 让表格里的数字纵向对齐。

```tsx
{ title: t("device.identifier"), dataIndex: "deviceId", width: 132,
  render: (value: string) => <span className="manager-mono">{value}</span> }
```

中文标签不套（`JetBrains Mono` 没有中文字形，会回退）。

## 3. 页面骨架

```tsx
<div className="manager-page-stack">        {/* flex column, gap 16 —— 每个页面的最外层 */}
  <section className="manager-stats-grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))" }}>
    {/* KPI 卡片 */}
  </section>

  <section className="manager-section-title">
    <h2>{t("device.inventory")}</h2>                        {/* h2 自带左侧绿色竖条 */}
    <span className="manager-mono" style={{ fontSize: 12, color: "var(--manager-text-faint)" }}>
      FLEET INVENTORY · {total} DEVICES                      {/* 英文全大写副标，项目惯例 */}
    </span>
    <span className="manager-section-rule" />                {/* 撑开的渐变分隔线 */}
    <Segmented ... />                                        {/* 右侧筛选控件 */}
  </section>

  <section className="manager-data-card manager-table">
    <Table ... />
  </section>
</div>
```

- `.manager-page-stack` — flex column + `gap: 16px`。**每个页面组件的根元素。**
- `.manager-stats-grid` — grid，`gap: 16px`；列数在内联 `style` 里给 `gridTemplateColumns`（常用 `repeat(auto-fit, minmax(240px, 1fr))`）。
- `.manager-section-title` — flex 行，`gap: 12px`，`flex-wrap`。`h2` 有 `::before` 绿色竖条，`.manager-section-rule` 是自动撑开的渐变线，右侧放筛选控件。
- `.manager-data-card` — 白底、`--manager-r-lg` 圆角、`--manager-border` 描边、`--manager-shadow`、`padding: 20px`。
- `.manager-table` — 与 `.manager-data-card` 叠用，调 antd Table 的内部间距。

## 4. KPI 卡片

```tsx
<div className={`manager-kpi-tile ${item.accent}`}>          {/* accent = manager-accent-cyan 等 */}
  <span style={{ fontSize: 22 }}>{item.icon}</span>
  <span className="manager-kpi-tile__label"
        style={{ fontSize: 15, color: "var(--manager-text)", fontWeight: 700 }}>
    {t(`device.type.${item.kind}`)}
  </span>
  <span className="manager-kpi-tile__value">{item.total}<small>{t("device.unit")}</small></span>
  <span className="manager-kpi-tile__hint">{item.desc}</span>
  <span className="manager-mono" style={{ fontSize: 11, color: "var(--manager-text-faint)" }}>
    {t("device.currentOnline")} {overview.online}/{overview.total}
  </span>
</div>
```

`.manager-kpi-tile` 有 `::before` 顶部色条，颜色由 accent 修饰类决定：

```
manager-accent-green  manager-accent-cyan  manager-accent-blue
manager-accent-violet manager-accent-amber manager-accent-red
```

子元素：`__label`（标题）、`__value`（大数字，内嵌 `<small>` 放单位）、`__hint`（说明文字）。

## 5. antd 主题 Token

`src/styles/theme.ts` 的 `modernTheme`，由 `LocaleProvider` 挂到 `ConfigProvider`。关键值：

```ts
token: {
  colorPrimary: "#12a150", colorSuccess: "#12a150", colorWarning: "#c07600",
  colorError: "#dc2626", colorInfo: "#0e8ba8",
  colorLink: "#0e8ba8", colorLinkHover: "#12a150",
  fontSize: 13,                                    // 比 antd 默认 14 小
  borderRadius: 12, borderRadiusLG: 16, borderRadiusSM: 8,
  colorBgLayout: "#eef1f6", colorBgContainer: "#ffffff",
  colorText: "#101828", colorTextSecondary: "#3d4757", colorTextTertiary: "#667085",
}
components: {
  Button / Input / InputNumber / Select / DatePicker: { controlHeight: 34, borderRadius: 8 },
}
```

**token 值与 CSS 变量是手工对齐的两份。** 改配色必须同时改 `theme.ts` 和 `globals.css` 的 `:root`，否则 antd 组件和自定义块会不一致。

控件高度统一 34px（默认 32），字号 13（默认 14）—— 控制台信息密度高。用 antd 组件时**不要覆盖 `size`**，让 token 生效。

## 6. 表格约定

```tsx
const columns: ColumnsType<DeviceRecord> = [
  { title: t("device.identifier"), dataIndex: "deviceId", width: 132,
    render: (value: string) => <span className="manager-mono">{value}</span> },

  // 枚举 → i18n 文案
  { title: t("device.resourceType"), dataIndex: "kind", width: 132,
    render: (value: DeviceKind) => <span>{t(`device.type.${value}`)}</span> },

  // 空值统一显示 "-"
  { title: t("device.currentTask"), dataIndex: "currentTask", width: 150,
    render: (value: string) => value || "-" },

  // 进度条 + 阈值配色
  { title: t("device.health"), dataIndex: "health", width: 118,
    render: (value: number) => (
      <Progress percent={value} size="small" strokeColor={healthColor(value)}
        format={(percent) => <span className="manager-mono">{percent}</span>} /> ) },

  // 操作列固定右侧、右对齐、type="link" size="small"
  { title: t("device.actions"), key: "actions", width: 162, fixed: "right", align: "right",
    render: (_, record) => (
      <Space size={0}>
        <Button type="link" size="small" icon={<EyeOutlined />}
          onClick={() => void showDetail(record)}>{t("device.viewParameters")}</Button>
      </Space> ) },
];

<Table<DeviceRecord>
  rowKey="deviceId"                                    // 用业务键，不用 index
  loading={loading}
  columns={columns}
  dataSource={rows}
  scroll={{ x: 1592 }}                                 // = 各列 width 之和
  pagination={{ pageSize: 10, showSizeChanger: false }}
/>
```

规则：

- **每列都给 `width`**，`scroll.x` 填各列宽度之和。不给的话窄屏会挤压。
- **`rowKey` 用业务键**（`deviceId` / `accountId` / `ruleId`）。
- **空值统一 `"-"`**，不显示空白也不显示 `null`。
- **枚举一律经 `t()`**，不直接渲染服务端返回的 `"cloud"`。
- 操作列 `fixed: "right"` + `align: "right"` + `<Space size={0}>` + `type="link" size="small"`。
- 阈值配色抽成函数：

```tsx
function healthColor(health: number) {
  if (health >= 80) return "var(--manager-success)";
  if (health >= 60) return "var(--manager-warning)";
  return "var(--manager-danger)";
}
```

时间格式化统一 24 小时制中文：

```tsx
function formatTime(value?: string) {
  return value ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "-";
}
```

## 7. 抽屉与弹窗

详情用 `Drawer`（宽 760）+ `Tabs` + `Descriptions`：

```tsx
<Drawer
  open={Boolean(selectedDevice)}
  onClose={() => setSelectedDevice(null)}
  width={760}
  title={selectedDevice ? (
    <div>
      <span>{t("device.details")} · {selectedDevice.deviceId}</span>
      <small style={{ display: "block", marginTop: 3, color: "var(--manager-text-faint)", fontWeight: 400 }}>
        {t("device.detailsCaption")}
      </small>
    </div>
  ) : null}>
  <Descriptions column={{ xs: 1, sm: 2 }} size="small" bordered items={...} />
</Drawer>
```

- 详情 → `Drawer`（宽 760，标题带 `·` 分隔的业务键 + 小字副标）
- 表单 → `Modal`（抽出到 `components/XxxFormModal.tsx`，参考 `user/components/UserFormModal.tsx`）
- 键值展示 → `Descriptions` `column={{ xs: 1, sm: 2 }}` `size="small"` `bordered`，值套 `.manager-mono`

## 8. 已有的成套块（复用前先看这里）

`globals.css` 里已有大量业务块，别重复实现。按用途：

| 用途 | 类名前缀 |
|---|---|
| 外壳 / 侧栏 / 顶栏 | `manager-shell-*`、`manager-sidebar-*`、`manager-nav-*`、`manager-brand-*`、`manager-topbar-kicker`、`manager-console*` |
| 看板 | `manager-dashboard-*`、`manager-board-*`（module/focus/grid，含 `--green/cyan/blue/violet` 变体） |
| 通用块 | `manager-page-stack`、`manager-page-heading`、`manager-section-title`、`manager-section-rule`、`manager-section-label`、`manager-stats-grid`、`manager-data-card`、`manager-table`、`manager-kpi-tile*`、`manager-card-hint` |
| 标签 / 徽标 | `manager-status-tag`、`manager-signal-tag`、`manager-count-tag`、`manager-info-chip`、`manager-metric-chip`、`manager-template-chip`、`manager-grade`(+`-s/-a/-b/-c/-d`) |
| 进度 / 趋势 | `manager-bar-row`、`manager-bar-track`、`manager-progress-rail`、`manager-up`、`manager-down`、`manager-value` |
| 控件皮肤 | `manager-soft-button`、`manager-icon-button`、`manager-module-button`、`manager-filter-input`、`manager-toolbar-search`、`manager-form-skin`、`manager-locale-select`、`manager-business-line-select` |
| 状态机 / 流程 | `manager-state-flow`、`manager-state-node`、`manager-state-arrow`、`manager-flow-card`、`manager-flow-drop`、`manager-flow-workspace` |
| 手机模拟 | `manager-timeline-phone*`、`manager-remote-phone*`、`manager-ai-phone-screen`、`manager-phone-timeline-grid` |
| 策略 | `manager-strategy-*`（layout/flow/detail/toolbar/table-card/boundary/guide/intro） |
| 任务模板 | `manager-task-library`、`manager-template-*`（modal/form-grid/edit/slot/id） |
| 指令库 | `manager-command-*`（layout/workspace/chat/compose/contacts/modal/…） |
| 初始化向导 | `manager-init-*` |
| 人格 / 场景 | `manager-persona-*`、`manager-scene-*` |
| 登录 | `manager-login-*` |
| 动效 | `manager-stagger-1..4`、`manager-dot-live` |
| 品牌图形 | `manager-bottle-*`、`manager-crest`、`manager-wordmark`、`manager-grid-bg` |

写新页面前 `grep 'manager-' src/app/globals.css` 找一下 —— 大概率已经有形状接近的块。

## 9. 响应式

`design-qa.md` 的验收基线：桌面默认视口 + **390 × 844** 移动端。要求：导航折叠成抽屉、表格保留横向滚动、无空白页、主操作不被裁切。

做法：

- 表格靠 `scroll={{ x }}` 横滚，不做列隐藏
- `manager-stats-grid` 用 `minmax(240px, 1fr)` 自动降列
- `Descriptions` 用 `column={{ xs: 1, sm: 2 }}`
- 移动端侧栏由 `ManagerShell` 的 `manager-mobile-menu-trigger` / `manager-mobile-sider-mask` 处理，页面不用管

## 10. 加新样式的顺序

1. 能用现成 `manager-*` 类吗？→ 用
2. 能用 antd 组件 + token 吗？→ 用
3. 一次性微调 → 内联 `style`，颜色写 `var(--manager-*)`
4. 会复用的新块 → 加到 `globals.css`，命名 `manager-{域}-{块}`，BEM 子元素 `__`，变体 `--`；**只用 CSS 变量，不写硬编码色值**

绝不要：新增 CSS 文件、引入 Tailwind、写硬编码十六进制色、写 `prefers-color-scheme`（无暗色模式）。
