# client/galaxy

Galaxy 共享算力池的控制台——和 `client/web`（交付控制台）、`client/manager`（管理端）
并列的第三个前端应用。Next.js 14 App Router + React 18 + Ant Design 5 + TypeScript，
技术选型与 manager 对齐，机制层复用 `client/shared`。

设计文档见 [`doc/galaxy/`](../../doc/galaxy/README.md)。

## 为什么是独立应用而不是并进 client/web

三条，按分量排：

1. **受众不同，而且会越走越远。** web 是内部产研的交付控制台（身份锁在
   `product_research` persona），Galaxy 是一个准备对外开放的双边市场（需求文档 P2
   写明「对外开放注册」）。塞进内部控制台，等真要开放时只剩两条路：拆出去，
   或者给外部用户开内部控制台的门。
2. **后端是另一个服务、另一套凭证。** web 的代理指向 web-api `:10001`，
   这里指向 galaxy-api `:10004`；galaxy-api 还有 `sk-` 算力密钥与节点令牌两套
   非控制台凭证。
3. **依赖重量对不上。** web 背着 three（全景）、g2、dnd、xlsx；这里一个都用不上。

运营侧（池水位、结算、封禁、争议、审计）不在这个应用里，按架构文档第 14 节
落在 `client/manager` 的 `/galaxy/*` 下。**这个应用只服务两类终端用户**：
把机器挂上来的提供者，和买算力用的消费者。

## 快速开始

```bash
cd client/galaxy
npm install
cp .env.example .env    # SERVER_TARGET 指向你的 galaxy-api
npm run dev             # http://localhost:7898
```

端口 7898（web 7893/7899、app 7894、manager 7895、preview 7896/7897 都已占用）。

服务端要先起来：

```bash
cd server/galaxy-api && go run ./cmd/galaxyinit && ./start.sh
```

## 页面

```
/provider/overview        加入共享池、我的节点与贡献总览、紧急停机
/provider/contributions   贡献授权：模型白名单、三维额度、座位、挂机时段
/provider/records         我的机器上跑过什么（匿名化）与收益积分
/consumer/keys            算力密钥：余额、有效期、允许范围、续期换发
/consumer/billing         额度商品与订单
/consumer/usage           用量与扣费明细（input / output 分行）
```

## 两类角色是同一个人的两副面孔

侧栏分两组「我贡献的」「我使用的」，不做角色切换开关——同一个账号既可以挂机
也可以买算力，强行二选一只会让人反复退出登录。

## 目录结构

与 `client/manager` 同构，差异只在业务页面：

```
src/
├── app/
│   ├── layout.tsx                AntdRegistry → AppLocaleProvider
│   ├── globals.css               @import 共享 token + 本应用的页面样式
│   ├── login/                    登录（沿用 manager 的形状）
│   └── (console)/
│       ├── layout.tsx            鉴权守卫 + GalaxyShell
│       ├── provider/{overview,contributions,records}/
│       └── consumer/{keys,billing,usage}/
├── components/shell/GalaxyShell.tsx
├── i18n/LocaleProvider.tsx       中英双语，基于 @shared 工厂
├── styles/theme.ts               re-export @shared/theme/managerTheme
├── utils/{axios,auth}.ts         基于 @shared 工厂的薄封装
└── pages/api/[...all].ts         代理到 galaxy-api
```

每个页面自带 `api/*.api.ts`：归属即边界，和服务端「handler 归各 `{层}-api/pkg/`」
是同一个原则。

## 已知状态

- **登录接了 galaxy-api 的 `/auth/login`**（复用现有用户体系）。控制台身份是
  普通用户令牌，不是 `sk-` 算力密钥——后者是给 SDK 用的，不进浏览器。
- **签发密钥、支付回调、维护商品目录需要管理员**，页面上会提示；内测期由后台代发。
- **贡献是节点申报出来的**，控制台只能改授权（额度 / 座位 / 白名单 / 时段）与
  启停，不能凭空造一条贡献——要新增能力得在那台机器上改 `ai-bridge` 配置。
