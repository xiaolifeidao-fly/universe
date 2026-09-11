# Galaxy 门户站（portal）

未登录也能打开的那一面：首页、模型、定价、联系我们，以及一个指向**控制台**
（Orbit）的入口。控制台仍然是 `orbit/webview`，门户不接管它的任何功能 ——
门户回答「你们卖什么、多少钱、怎么接」，控制台回答「我这把密钥还剩多少」。

```text
client/galaxy/portal/
├── src/app/
│   ├── layout.tsx              antd Registry + i18n Provider + 站点 metadata
│   ├── globals.css             门户自己的设计系统（.gp-*），见下
│   ├── icon.svg                浏览器标签页图标
│   └── (site)/
│       ├── layout.tsx          顶栏 + 页脚
│       ├── page.tsx            首页
│       ├── models/page.tsx     模型
│       ├── pricing/page.tsx    定价
│       └── contact/
│           ├── page.tsx        联系我们
│           └── api/contact.api.ts   本页自己的接口层（全站唯一一条写接口）
├── src/components/
│   ├── site/                   顶栏、页脚、图标、kit（.gp-* 的 React 层）
│   ├── home/                   首屏、轨道图、价格滚动条、接入示例、各段落
│   ├── models/ModelExplorer.tsx
│   ├── pricing/PricingBoard.tsx
│   └── contact/ContactPanel.tsx
├── src/i18n/LocaleProvider.tsx 中英文案字典（加文案两种语言都要补）
├── src/utils/
│   ├── portal.ts               数据形状（客户端组件也要用）
│   ├── portal.server.ts        服务端取数（只能在 RSC 里调）
│   ├── site.ts                 NEXT_PUBLIC_* 站点常量
│   ├── format.ts               金额 / token / 上下文的展示格式化
│   └── axios.ts                浏览器侧 HTTP（只给联系我们用）
└── src/pages/api/[...all].ts   到 Go 服务端的通配代理（和两个控制台同一份实现）
```

## 数据从哪来

服务端只有一组公开路由，全部挂在 `/api/galaxy/portal/*` 下，**不带鉴权**：

| 路由 | 用途 |
| --- | --- |
| `GET /overview` | 整站数据：模型目录、额度包、单价表、统计、服务地址 |
| `GET /models` / `GET /pricing` | `overview` 的两个切片，方便看出哪一页在用哪份数据 |
| `POST /leads` | 「联系我们」留资。蜜罐 + 按 IP 限流 + 整站每小时上限，都在服务端 |

模型目录来自 `zt_galaxy_model`；这张表为空时，服务端回落到 `galaxy.models` 声明的
那份清单（relay 的 `/v1/models` 用的同一份），只显示模型名与按 kind 的统一单价。
种子在 `server/galaxy_seed.sql`，建表在 `server/migrations/20260911_galaxy_portal.sql`。

**当前计费按 kind 统一定价，与模型无关。** `zt_galaxy_model` 上那三列单模型单价
默认留 0（含义是「按 kind 统一价显示」，不是免费），卡片上会标一个「统一价」。
在那三列里填数字之前，先确认计费引擎真的按模型计价了 —— 门户上写的和账单上扣的
对不上，是最不该出现的一种不一致。

## 取数为什么在服务端

三个读页面都是 React Server Component，直接 fetch Go 服务端，ISR 60 秒：

- 门户是给陌生人和搜索引擎看的。浏览器取数意味着首屏是一圈转菊花，
  价格和模型进不了 HTML —— 一个搜不到自家模型和价格的门户没有意义；
- 这几条接口没有用户维度，没有 token 要带，服务端取正合适。

代价：构建时连不上 `SERVER_TARGET` 的话，页面会被预渲染成空态，直到部署后第一个
访问触发重新生成。要避开这一秒，让 CI 构建时能连到后端。

写接口（联系我们）仍然走浏览器 → Next.js `/api/*` 代理 → Go，和两个控制台一致。

## 视觉

| 位置 | 内容 |
| --- | --- |
| `src/app/globals.css` | 门户的结构与组件类（`.gp-*`）+ 调色板。改色只改这里 |
| `src/styles/theme.ts` | antd 主题。antd 只负责表单与浮层，版面全是 `.gp-*` |
| `src/components/site/kit.tsx` | `.gp-*` 的 React 层：什么时候加哪个 class |

和两个控制台（`.gx-*`）是**同一个牌子的两副面孔，不是同一套组件**：控制台是坐下来
干活的地方，密度高、13px、一屏塞满；门户是陌生人站着看三十秒的地方，留白、大字、
一次只说一件事。共用的只有字体（`client/shared/styles/tokens.css` 里自托管的
Instrument Serif / JetBrains Mono）和那支青绿 `#0f7b74` —— 青绿必须和 Orbit 一模一样，
用户从门户点进控制台的那一刻颜色一变，他会以为跳到了另一家公司。

不做深色模式。

## 开发

```bash
# 在 client/galaxy
npm install
cp portal/.env.example portal/.env    # 配 SERVER_TARGET 与 NEXT_PUBLIC_CONSOLE_URL
npm run dev:portal                    # http://127.0.0.1:17900
npm run build:portal                  # 产出 .desktop/portal（要部署到服务器的 standalone 包）
```

`NEXT_PUBLIC_*` 必须写成 `process.env.NEXT_PUBLIC_XXX` 这样的**字面量**（见
`src/utils/site.ts` 顶部）：Next 是打包时做字符串替换把值塞进浏览器包的，
动态取法在服务端读得到、浏览器里是 undefined，同一个链接两边渲染不一致，水合会失败。

没配的联系方式在页面上显示成 `[待填写]`，不编一个 —— 编一个假邮箱的代价是
有人真的往那儿发信，然后再也没有下文。

## 已知限制

- 模型的 `summary` 与标签由运营在库里维护，只有一份文案，切到英文界面时它们仍是原文。
  界面文案（导航、按钮、FAQ）中英各一份，在 `src/i18n/LocaleProvider.tsx`。
- 「联系我们」的线索在管理端还没有界面，目前只有接口：
  `GET/POST /api/galaxy/admin/portal/leads*`（需要平台管理员）。
