# 前端架构

## 1. 路由与组件层级

```
src/app/layout.tsx                    ← 唯一的服务端组件
  AntdRegistry                          antd SSR 样式收集
   └ AppLocaleProvider                  语言 + antd ConfigProvider + modernTheme
      └ BusinessLineProvider            当前业务线
         └ {children}

src/app/(console)/layout.tsx          ← "use client"，鉴权守卫
  isAuthenticated() ? <ManagerShell>{children}</ManagerShell> : router.replace("/login")

src/app/(console)/{page}/page.tsx     ← "use client"，只做一件事
  export default function XxxPage() { return <Xxx />; }
```

`(console)` 是**路由组**（括号目录不进 URL），作用是让这一组页面共享鉴权守卫和 `ManagerShell` 外壳。`/login` 在组外，所以不受守卫影响。

**`page.tsx` 永远只有三行。** 所有内容在 `components/{PascalCase}.tsx` 里。这样组件能被别的页面复用，也让 page.tsx 保持成一个纯路由声明。

```tsx
"use client";
import { DevicePool } from "./components/DevicePool";
export default function DevicePoolPage() { return <DevicePool />; }
```

## 2. 页面目录结构

```
src/app/(console)/device-pool/
├── page.tsx                       路由声明（3 行）
├── api/device.api.ts              该页面的 API 层
├── components/DevicePool.tsx      页面主组件
└── hooks/useXxx.ts                （可选）数据获取与操作逻辑
```

拆分时机：

- **`components/` 拆子组件**：主组件超过 ~250 行，或某块 UI（表单弹窗、详情抽屉）有独立状态。参考 `user/components/{UserManagementDemo.tsx, UserFormModal.tsx}`。
- **`hooks/` 抽 hook**：页面有增删改查全套 + 分页 + 筛选 + 缓存时。参考 `user/hooks/useUserManagement.ts`（列表、统计、分页、sessionStorage 缓存、CRUD 全在里面，组件只负责渲染）。
- 简单的只读列表页（device-pool、proxies）**不需要 hook**，`useEffect` 直接写在组件里就行，别为了对称硬拆。

## 3. API 层

### 归属

**每个页面的 API 层放自己目录下的 `api/{单数资源}.api.ts`，不集中。** 理由与服务端「handler 归各 `{层}-api/pkg/` 自己」一致：归属即边界。

跨页面复用时（比如两个页面都要设备列表），把请求函数放在**主要拥有方**的页面 api 里，另一方 import 相对路径；三个以上页面在用才考虑提到 `src/api/`。

### 文件结构

固定四段：

```ts
"use client";

// ① 依赖
import { getData, getPage, instance, unwrapApiResponse, type ApiResponse } from "@/utils/axios";
import { withBizLine } from "@/utils/bizLine";
import type { BusinessLineId } from "@/business-lines/BusinessLineProvider";

// ② 枚举字面量类型 —— 与服务端 description 标签里的取值一一对应
export type DeviceKind = "cloud" | "real" | "browser";
export type DeviceStatus = "online" | "busy" | "idle" | "offline";

// ③ 响应模型：class + 字段默认值，字段名 = 服务端 json tag
export class DeviceRecord {
  deviceId = "";

  kind: DeviceKind = "cloud";

  concurrency = 0;

  lastHeartbeatAt?: string;      // 服务端 *time.Time → 可选 string

  /** 以下四项由服务端聚合绑定表得到，前端不再自己拼。 */
  boundNumber = "";

  boundProxy = "";
}

// 继承复用：详情 = 列表字段 + 额外字段
export class DeviceDetail extends DeviceRecord {
  paramGroups: ParamGroup[] = [];
}

// ④ 入参 interface（不参与反序列化，用 interface 没问题）+ 请求函数
export interface DeviceListQuery {
  pageIndex?: number;
  pageSize?: number;
  kind?: DeviceKind | "";
}

export async function fetchDevices(bizLine: BusinessLineId, query: DeviceListQuery = {}) {
  return getPage(DeviceRecord, "/resource/devices", withBizLine(bizLine, query));
}
```

约定：

- **响应模型必须是 `class` 且每个字段有默认值**（`= ""` / `= 0` / `= {}` / `?: string`）。`plainToInstance` 靠类和已声明字段工作，`interface` 会被编译擦除。
- 字段名必须与服务端 DTO 的 `json` tag **完全一致**（camelCase）。不一致就是静默拿到 `undefined`。
- 可空时间字段用 `?: string`（服务端 `*time.Time`），渲染前判空。
- **每个请求函数第一个参数是 `bizLine: BusinessLineId`。**
- 函数命名：读 `fetchXxx` / `fetchXxxOverview` / `fetchXxxDetail`，写 `saveXxx` / `applyXxx` / `importXxx` / `acquireXxx`。
- 服务端聚合出来的字段（`boundNumber`、`boundNumberCount`）要写注释说明来源，避免有人在前端重新拼一遍。

### 四个请求函数

| 函数 | 服务端返回形状 | 用途 |
|---|---|---|
| `getPage(Cls, url, params)` | `{total, data:[]}` | 分页列表，返回 `{total, data: Cls[]}` |
| `getDataList(Cls, url, params)` | `[]` | 不分页列表，返回 `Cls[]` |
| `getData(Cls, url, params)` | 对象 | 单个 / 概览 / 详情，返回 `Cls` |
| `instance.post/put/delete` | 任意 | 写操作，配 `unwrapApiResponse(response.data)` |

服务端返回什么形状必须先确认 —— `getPage` 打到一个返数组的接口上，会得到 `total: undefined`。

写操作的完整写法：

```ts
export async function saveDevice(bizLine: BusinessLineId, payload: SaveDevicePayload) {
  const response = await instance.post<ApiResponse<null>>("/resource/devices", { bizLine, ...payload });
  return unwrapApiResponse(response.data);
}
```

`unwrapApiResponse` 会在 `success===false` 时 `throw new Error(error || message)` —— 这个错误文案直接来自服务端，可以直接 `message.error(err.message)`。

**项目里只用 GET 和 POST**（服务端 upsert 语义走 `POST /xxxs`）。别引入 PUT/DELETE。

## 4. axios 封装做了什么

`src/utils/axios.ts`：

```ts
export const instance = axios.create({ baseURL: "/api", timeout: 10000 });

instance.interceptors.request.use((config) => {
  const token = getAuthToken();
  if (token) config.headers.token = token;    // 注意：头名是 token，不是 Authorization
  return config;
});
```

`unwrapResponse` 的行为：

1. `success === true` → 返 `data`
2. `success === false` → 先看 `message + error` 是否含 `not login`；含则 `clearAuthToken()` + 跳 `/login`
3. 然后 `throw new Error(error || message || "Request failed")`

所以**页面里只需要 try/catch，不需要判 `success`**：

```ts
try {
  await saveDevice(bizLine, payload);
  message.success(t("device.saveSuccess"));
} catch (error) {
  message.error((error as Error).message);
}
```

三个细节：

- `baseURL: "/api"`，所以 api 文件里写 `/resource/devices`，**不写 `/api/resource/devices`**。
- `timeout: 10000` —— 超 10 秒的接口（批量导入、LLM 决策）要在调用处单独传 `{ timeout }`。
- 服务端**失败也返 HTTP 200**，靠 `success` 判定。若服务端返了 4xx/5xx，会走 axios 的 error 分支，`error.message` 是 axios 的英文文案而不是服务端文案。

## 5. 业务线贯穿

```ts
// src/utils/bizLine.ts
export function withBizLine<T extends object>(bizLine: BusinessLineId, params?: T) {
  return { bizLine, ...(params ?? {}) } as Record<string, string | number | undefined>;
}
```

组件里：

```tsx
const { activeBusinessLine } = useBusinessLine();

useEffect(() => {
  // ...
}, [activeBusinessLine.id, filter]);   // ★ 业务线必须进依赖数组
```

**切换业务线要重新拉数据。** 忘了把 `activeBusinessLine.id` 放进 `useEffect` 依赖，切换后页面显示的还是旧业务线的数据 —— 这是个静默 bug。

`BUSINESS_LINES` 目前只有一条 `whatsapp`（`src/business-lines/BusinessLineProvider.tsx`）。新增业务线时改这个常量数组，并在服务端 `zt_bizline_def` 里注册档案 —— `contract.BizLine.Valid()` 目前只校验非空，不做白名单，所以前端传错值不会被拒，只会查不到数据。

## 6. 鉴权链路

```
浏览器 localStorage/sessionStorage "phoenix_manager_token"
  ↓ @/utils/auth getAuthToken()
axios 请求拦截器 → header: token
  ↓
Next.js 代理 src/pages/api/[...all].js（透传 req.headers）
  ↓
Go 服务端 httpx.Require*（目前 passthrough，未校验）
```

守卫在 `src/app/(console)/layout.tsx`：`useEffect` 里 `isAuthenticated()`，false 则 `router.replace("/login")`，true 才渲染 `ManagerShell`。渲染前显示 `<Spin>`。

**这是客户端守卫，不是服务端保护** —— 只挡 UI，真正的授权在服务端。

登录目前是 mock（`src/app/login/api/login.api.ts` 硬编码 `admin`/`admin123`）。接真实登录时：改这个文件调 `/auth/login`，`setAuthToken(token, remember)` 不变，其余代码零改动。

## 7. 代理链路

```
浏览器 → /api/resource/devices
  ↓ Next.js Pages Router: src/pages/api/[...all].js
GET  → http-proxy-middleware，pathRewrite "^/api" → APP_URL_PREFIX
其他 → axios 手动转发（POST/PUT/DELETE 分支）
  ↓
SERVER_TARGET + APP_URL_PREFIX + path
= http://[::1]:10001/api/resource/devices
```

环境变量（`.env`）：

```
APP_URL_PREFIX = "/api"
SERVER_TARGET  = "http://[::1]:10001"
```

`src/pages/api/file/[...all].js` 单独处理文件上传（formidable + form-data）。

**这是项目里唯一保留 Pages Router 的地方。** 保留代理层而不让浏览器直连服务端，是为了服务端拆成 6 个独立服务后**前端不需要改任何 api 文件** —— 按路径前缀分流在这里（或 nginx）做：

| 前缀 | 层 | 独立后端口 |
|---|---|---|
| `/resource/*` `/bizline/*` | 1 / 0 | 9101 |
| `/task/*` | 2 | 9102 |
| `/risk/*` | 3 | 9103 |
| `/strategy/*` | 4 | 9104 |
| `/aisched/*` | 5 | 9105 |
| `/orchestration/*` | 6 | 9106 |

## 8. 组件里的数据获取

无 hook 的标准写法（**带 `active` 标志防竞态**）：

```tsx
const [rows, setRows] = useState<DeviceRecord[]>([]);
const [overview, setOverview] = useState({ total: 0, online: 0, kindCounts: {} as Record<string, number> });
const [loading, setLoading] = useState(false);

useEffect(() => {
  let active = true;
  setLoading(true);
  Promise.all([
    fetchDevices(activeBusinessLine.id, { pageIndex: 1, pageSize: 200, kind: filter === "all" ? "" : filter }),
    fetchDeviceOverview(activeBusinessLine.id),
  ]).then(([page, view]) => {
    if (!active) return;
    setRows(page.data);
    setOverview(view);
  }).catch(() => {
    if (!active) return;
    setRows([]);                                        // 失败时清空，不留旧业务线数据
    setOverview({ total: 0, online: 0, kindCounts: {} });
  }).finally(() => { if (active) setLoading(false); });
  return () => { active = false; };
}, [activeBusinessLine.id, filter]);
```

要点：

- **`let active = true` + cleanup 置 false**，每个 `set*` 前 `if (!active) return`。切业务线或改筛选会连发请求，慢的那个后到会覆盖新数据。
- **多个接口用 `Promise.all`**（列表 + 概览），不串行。
- **catch 里清空状态**，不要留上一次的数据。
- `loading` 传给 `<Table loading={loading}>`。
- 详情类数据点击时才拉（`fetchDeviceDetail`），列表不带重字段。

## 9. 状态管理

**没有 Redux / zustand / React Query。** 三层就够：

1. **全局 Context**：只有语言（`LocaleProvider`）和业务线（`BusinessLineProvider`）两个，都在 `src/app/layout.tsx` 挂。别再加第三个全局 Provider，除非确实跨大半个应用。
2. **页面 hook**：`hooks/useXxx.ts`，页面级的列表 + 筛选 + CRUD。
3. **组件 state**：抽屉开合、选中行、表单值。

服务端数据不做全局缓存 —— 控制台页面切换频率低，重新拉一次比维护缓存一致性便宜。需要跨页面记住筛选条件时用 sessionStorage（见 `useUserManagement` 的 `manager_user_management_cache_v1`）。

## 10. 国际化

`src/i18n/LocaleProvider.tsx` 是一个自研的扁平文案表 + Context，**不是 next-intl**：

```tsx
const { t, locale, setLocale } = useLocale();
<span>{t("device.status.online")}</span>
```

- `SUPPORTED_LOCALES = ["zh-CN", "en-US", "id-ID"]`，对应 antd 的 `zhCN` / `enUS` / `idID`。
- 文案表是文件里的 `messages` 常量对象，键用 `module.key` 或 `module.group.key`（`nav.devicePool`、`device.status.online`、`shell.search`）。
- `TranslationKey = keyof typeof messages["zh-CN"]`，所以 **zh-CN 是 key 的权威源**，先加中文键才有类型提示。
- `t()` 也接受 `string`（兜底），但新代码要让键落在 `TranslationKey` 里。
- 语言存 localStorage `zhangtian-bottle-locale`。
- `LocaleProvider` 同时挂了 `modernTheme`（`src/styles/theme.ts`）到 antd `ConfigProvider`。

新页面必须在**三种语言**里都补键。只补中文会让另外两种语言直接显示键名。

## 11. 导航挂载

`src/components/manager-shell/ManagerShell.tsx` 里三处要改：

```tsx
// ① 页面标题与副标题
const PAGE_TITLES: Record<string, [string, string]> = {
  "/device-pool": ["page.devicePool.title", "page.devicePool.subtitle"],   // 用 i18n 键
};

// ② 导航分组（tone 决定分组配色：green/cyan/blue/violet/amber）
const NAV_GROUPS: NavGroup[] = [
  { key: "grp-resources", label: "nav.resources", caption: "RESOURCES", tone: "cyan", icon: <span>🗃️</span>,
    children: [
      { key: "/device-pool", label: "nav.devicePool", icon: <span>🗄️</span> },
    ] },
];
```

`NavLeaf.key` 就是路由路径。侧栏折叠状态存 localStorage `zb.sidebar.collapsed`，分组展开状态存 `zb.nav.closedGroups`。

`PAGE_TITLES` 里有些是直接写的中文字面量（历史遗留），**新增一律用 i18n 键**。

## 12. 与原型的关系

视觉基准是 `demo/auto_prototype/` 下的 18 个 HTML 原型页面，逐页对照记录在 `design-qa.md`（含路由映射表、对比证据、验收结论）。

服务端 `SCHEMA.md` 的字段来源也是这批原型 —— **每张表都能指到具体页面上的哪一列**。所以调整字段时三边要一起看：原型页 → 表设计 → 前端 class。

新增页面若原型里有对应页，先读原型 HTML 再写；`design-qa.md` 的路由映射表告诉你哪个原型对应哪个路由。
