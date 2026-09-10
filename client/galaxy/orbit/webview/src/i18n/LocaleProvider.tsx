"use client";

/**
 * Orbit 的文案字典与 i18n Provider。用法和 web / manager 的 useLocale() 一致。
 *
 * 为什么这里没有用 @shared/i18n/createLocaleProvider：
 *
 * client/shared 没有自己的 node_modules，靠 client/shared/node_modules 这个**唯一的**
 * 符号链接解析裸导入，而它指向第一个安装的那个 app（manager）。于是 shared 里那个
 * `<ConfigProvider>` 来自 manager 的 antd 实例，本应用页面里的组件来自自己那份 ——
 * 两份实例就是两套 React context，主题 token 传不过去。
 *
 * shared 里其余几个文件没有这个问题，继续用：galaxyTheme 是纯数据，
 * createAuthStore 只碰 localStorage，createHttpClient 只碰 axios ——
 * 它们都不渲染 antd 组件，也就不依赖 React context 的同一性。
 *
 * 只开中英两种（和 manager 一致）。加页面时两个语言都要补 key —— 这是硬约束，
 * 缺一个 key 在另一种语言下就会露出裸键名。
 */

import { ConfigProvider } from "antd";
import enUS from "antd/locale/en_US";
import zhCN from "antd/locale/zh_CN";
import { createContext, type PropsWithChildren, useContext, useEffect, useMemo, useState } from "react";
import { galaxyTheme } from "@/styles/theme";

const SUPPORTED_LOCALES = ["zh-CN", "en-US"] as const;
const STORAGE_KEY = "galaxy-console-locale";

const messages = {
  "zh-CN": {
    "locale.zh-CN": "简体中文",
    "locale.en-US": "English",

    "brand.subtitle": "GALAXY · 使用端",

    "shell.logout": "退出登录",

    "common.refresh": "刷新",
    "common.cancel": "取消",
    "common.confirm": "确认",
    "common.copy": "复制",
    "common.empty": "暂时没有数据",
    "common.loadFailed": "加载失败",
    "common.actionFailed": "操作失败",
    "common.all": "全部",
    "common.today": "今天",
    "common.days7": "近 7 天",
    "common.days30": "近 30 天",

    "nav.keys": "密钥",
    "nav.store": "充值",
    "nav.usage": "使用记录",
    "nav.chat": "对话",
    "nav.account": "账户",

    "login.welcome": "欢迎回来",
    "login.account": "账号",
    "login.accountPlaceholder": "手机号或邮箱",
    "login.accountRequired": "请输入登录账号",
    "login.password": "密码",
    "login.passwordPlaceholder": "登录密码",
    "login.passwordRequired": "请输入登录密码",
    "login.remember": "这台电脑上保持登录",
    "login.forgot": "忘记密码",
    "login.submit": "登录",
    "login.success": "登录成功",
    "login.mustChangePassword": "这是初始密码，请尽快修改",
    "login.noAccount": "还没有账号？",
    "login.register": "注册一个",
    "login.tagline1": "一把密钥，",
    "login.tagline2": "用上别人闲着的算力。",
    "login.point1.title": "官方 SDK 直接接",
    "login.point1.desc": "改一个 base_url 就能用，不改代码",
    "login.point2.title": "按需买，不订阅",
    "login.point2.desc": "额度包用多少扣多少，到期余额可转到新密钥",
    "login.point3.title": "每一笔都查得到",
    "login.point3.desc": "输入 / 输出 tokens 分行记，扣费与请求号一一对应",
    "login.foot": "算力密钥的明文只在签发那一刻显示一次，之后平台也查不回来。",

    "notice.body": "你的请求会经第三方提供者的机器处理。平台不留存请求内容，提供者也看不到你是谁。确认之后才能购买额度与使用密钥。",
    "notice.accept": "我已阅读并确认",
    "notice.accepted": "已确认 {version}",

    "keys.title": "密钥",
    "keys.subtitle": "额度跟着密钥走",
    "keys.new": "买一把新密钥",
    "keys.newHint": "密钥明文只在创建那一刻显示一次。丢了就换发：新密钥继承余额与范围，旧的立刻作废。",
    "keys.balance": "剩余额度",
    "keys.expiresAt": "{value} 到期",
    "keys.created": "创建于 {value}",
    "keys.reissue": "换发",
    "keys.reissueHint": "新密钥继承余额与允许范围，旧的立刻作废",
    "keys.reissueConfirm": "换发后旧密钥立刻失效，改代码前请先停掉在跑的调用。继续？",
    "keys.reissued": "已换发",
    "keys.topup": "续额",
    "keys.revoke": "吊销",
    "keys.revokeConfirm": "吊销后这把密钥立刻失效，且不可恢复。继续？",
    "keys.revoked": "已吊销",
    "keys.quota": "额度构成",
    "keys.quotaHint": "按计量单位分别记账，各扣各的",
    "keys.scope": "允许范围",
    "keys.scopeAll": "不限",
    "keys.freezeHint": "到期后冻结 {days} 天，期间可换发、余额转入新密钥；冻结期满未处理则按规则退回。",
    "keys.connect": "接入方式",
    "keys.connectHint": "每次响应头都带 X-Galaxy-Request-Id，排障、申诉都用它。",
    "keys.baseUrl": "服务地址",
    "keys.emptyTitle": "还没有算力密钥",
    "keys.emptyHint": "买一个额度包，平台会在支付到账时签发一把密钥。",
    "keys.status.active": "生效中",
    "keys.status.expired": "已过期",
    "keys.status.frozen": "冻结中",
    "keys.status.revoked": "已吊销",
    "keys.concurrency": "并发 / 速率",

    "secret.title": "密钥「{alias}」已创建",
    "secret.body1": "下面这串明文",
    "secret.body2": "只显示这一次",
    "secret.body3": "，关掉之后平台也查不回来。丢了就换发一把新的，余额会跟过去。",
    "secret.saved": "我已经保存好了",
    "secret.goStore": "去充值",

    "store.title": "充值",
    "store.subtitle": "买多少用多少，不订阅",
    "store.tab.packages": "额度包",
    "store.tab.orders": "充值记录",
    "store.category": "商品",
    "store.category.claude": "Claude 对话",
    "store.category.codex": "Codex 编程",
    "store.category.video": "视频渲染",
    "store.category.other": "通用额度",
    "store.categoryHint": "额度与单价在下单那一刻快照进订单，之后调价不影响已买的。",
    "store.packages": "{category} · 额度包",
    "store.priceHint": "{price} / 1M · {days} 天有效",
    "store.best": "最划算",
    "store.billing": "计费规则",
    "store.billingBody": "按输出 tokens 计费，输入按各自单价分别记账。失败的调用不扣费；扣错了 7 天内可申诉，裁决成立原路退回额度。",
    "store.confirm": "确认订单",
    "store.target": "充到哪把密钥",
    "store.targetNew": "签发一把新密钥",
    "store.channel": "支付方式",
    "store.channelSandbox": "沙箱 · 不扣真钱",
    "store.channelEmpty": "这套部署还没接支付渠道，下单后由平台确认到账。",
    "store.total": "合计",
    "store.pay": "立即支付",
    "store.paySandbox": "沙箱支付",
    "store.terms": "支付即同意《算力使用条款》",
    "store.awaiting": "等待支付…付完自动到账，不用刷新",
    "store.awaitingOrder": "订单 {order} · 15 分钟内有效",
    "store.paid": "已到账",
    "store.ordered": "订单已创建",
    "store.cancelOrder": "取消订单",
    "store.cancelled": "订单已取消",
    "store.switchChannel": "换支付方式",
    "store.packagesEmpty": "暂时没有上架的额度包",
    "store.getsUnits": "到账",
    "store.emptyKeys": "你还没有密钥，这一单会签发一把新的。",
    "store.comingSoon": "即将上线",

    "orders.paidTotal": "累计充值",
    "orders.paidCount": "{value} 笔已到账",
    "orders.pending": "待支付",
    "orders.pendingCount": "{value} 笔",
    "orders.pendingHint": "点进去可以继续付款",
    "orders.invoice": "发票",
    "orders.invoiceHint": "可开 · 先在账户里填抬头",
    "orders.col.time": "时间",
    "orders.col.order": "订单号",
    "orders.col.package": "额度包",
    "orders.col.units": "额度",
    "orders.col.target": "充到",
    "orders.col.amount": "金额",
    "orders.col.status": "状态",
    "orders.status.pending": "待支付",
    "orders.status.paid": "处理中",
    "orders.status.fulfilled": "已到账",
    "orders.status.cancelled": "已取消",
    "orders.empty": "还没有充值记录",
    "orders.newKey": "新密钥",

    "usage.title": "使用记录",
    "usage.subtitle": "每一笔扣费都对得上一次请求",
    "usage.spent": "最近 {days} 天消耗",
    "usage.spentHint": "{tokens} tokens · 按购买时单价折算",
    "usage.calls": "今日调用",
    "usage.callsHint": "成功 {ok} · 失败 {failed}",
    "usage.firstByte": "平均首字",
    "usage.firstByteHint": "排队 + 上游",
    "usage.left": "剩余可用",
    "usage.leftHint": "{keys} 把密钥合计",
    "usage.search": "按请求号查",
    "usage.allKeys": "全部密钥",
    "usage.export": "导出账单",
    "usage.rowHint": "点任意一行看请求号与申诉入口",
    "usage.col.time": "时间",
    "usage.col.key": "密钥",
    "usage.col.model": "模型",
    "usage.col.in": "输入",
    "usage.col.out": "输出",
    "usage.col.cost": "耗时",
    "usage.col.charge": "扣费",
    "usage.col.state": "状态",
    "usage.state.completed": "完成",
    "usage.state.failed": "失败 · 未扣费",
    "usage.state.running": "进行中",
    "usage.empty": "这段时间没有调用",
    "usage.summary": "第 {from}–{to} 条，共 {total} 条",
    "usage.tab.records": "逐笔扣费",
    "usage.tab.bill": "账单汇总",
    "usage.tab.sessions": "会话",
    "usage.tab.jobs": "任务",
    "usage.tab.disputes": "申诉",
    "usage.total": "合计",
    "usage.notPriced": "不计价",

    "detail.title": "这一次请求",
    "detail.requestId": "请求号",
    "detail.provider": "上游",
    "detail.unknownProvider": "已清理",
    "detail.usage": "用量",
    "detail.charge": "扣费",
    "detail.dispute": "对这一笔提出申诉",
    "detail.disputeReason": "申诉理由",
    "detail.disputeDetail": "补充说明",
    "detail.disputeDetailHint": "不要粘贴请求内容 —— 平台本来就不留存它，粘上来只会多一份副本。",
    "detail.disputeSubmit": "提交申诉",
    "detail.disputed": "申诉已提交，平台会在裁决后原路退回额度",

    "dispute.reason.not_delivered": "没有交付结果",
    "dispute.reason.wrong_output": "结果明显不对",
    "dispute.reason.overcharged": "扣费与用量对不上",
    "dispute.reason.forged": "怀疑响应是伪造的",
    "dispute.reason.other": "其它",
    "dispute.status.open": "待裁决",
    "dispute.status.accepted": "已支持",
    "dispute.status.rejected": "已驳回",
    "dispute.status.withdrawn": "已撤回",
    "dispute.withdraw": "撤回",
    "dispute.empty": "没有申诉记录",
    "dispute.col.time": "时间",
    "dispute.col.unit": "请求号",
    "dispute.col.reason": "理由",
    "dispute.col.status": "状态",
    "dispute.col.refund": "退回",

    "sessions.empty": "没有有状态会话",
    "sessions.col.sid": "会话",
    "sessions.col.kind": "能力",
    "sessions.col.state": "状态",
    "sessions.col.turns": "回合",
    "sessions.col.time": "最近一次",
    "sessions.close": "关闭会话",
    "sessions.closed": "会话已关闭",
    "sessions.migrated": "换过节点",

    "jobs.empty": "没有长任务",
    "jobs.col.job": "任务",
    "jobs.col.kind": "能力",
    "jobs.col.state": "状态",
    "jobs.col.progress": "进度",
    "jobs.col.time": "创建时间",
    "jobs.cancel": "取消",
    "jobs.cancelled": "任务已取消",

    "chat.title": "对话",
    "chat.subtitle": "直接用密钥额度聊，不用另外配环境",
    "chat.soonTitle": "对话还没开放",
    "chat.soonHint": "这一版先把密钥、充值和账单做扎实。在那之前，把 base_url 指到下面这个地址，用官方 SDK 或 Claude Code 就能跑。",
    "chat.goKeys": "去看接入方式",

    "account.title": "账户",
    "account.subtitle": "个人信息与安全",
    "account.profile": "基本资料",
    "account.security": "登录与安全",
    "account.securityHint": "登录令牌保存在这台电脑上，退出登录会一并清掉。",
    "account.keys": "我的密钥",
    "account.keysHint": "{active} 把生效中，共 {total} 把",
    "account.notice": "数据告知",
    "account.logout": "退出登录",
    "account.locale": "界面语言",
    "account.danger": "注销账号",
    "account.dangerHint": "注销前请先用完或退回密钥里的余额。注销后密钥立即失效，使用记录保留 90 天以备申诉。",
    "account.dangerContact": "注销需要人工核对余额与在途订单，请联系平台客服办理。",
  },
  "en-US": {
    "locale.zh-CN": "简体中文",
    "locale.en-US": "English",

    "brand.subtitle": "GALAXY · CONSUMER",

    "shell.logout": "Sign out",

    "common.refresh": "Refresh",
    "common.cancel": "Cancel",
    "common.confirm": "Confirm",
    "common.copy": "Copy",
    "common.empty": "Nothing here yet",
    "common.loadFailed": "Failed to load",
    "common.actionFailed": "Action failed",
    "common.all": "All",
    "common.today": "Today",
    "common.days7": "Last 7 days",
    "common.days30": "Last 30 days",

    "nav.keys": "Keys",
    "nav.store": "Top up",
    "nav.usage": "Usage",
    "nav.chat": "Chat",
    "nav.account": "Account",

    "login.welcome": "Welcome back",
    "login.account": "Account",
    "login.accountPlaceholder": "Phone or email",
    "login.accountRequired": "Enter your account",
    "login.password": "Password",
    "login.passwordPlaceholder": "Password",
    "login.passwordRequired": "Enter your password",
    "login.remember": "Stay signed in on this computer",
    "login.forgot": "Forgot password",
    "login.submit": "Sign in",
    "login.success": "Signed in",
    "login.mustChangePassword": "This is the initial password — change it soon",
    "login.noAccount": "No account yet?",
    "login.register": "Create one",
    "login.tagline1": "One key,",
    "login.tagline2": "and someone else's idle compute.",
    "login.point1.title": "Works with official SDKs",
    "login.point1.desc": "Point base_url at Galaxy — no code changes",
    "login.point2.title": "Pay as you go",
    "login.point2.desc": "Packs are drawn down per call; leftover balance moves to a new key",
    "login.point3.title": "Every charge is traceable",
    "login.point3.desc": "Input and output tokens are booked separately, each tied to a request id",
    "login.foot": "A key's plaintext is shown once at issue time — not even the platform can read it back.",

    "notice.body": "Your requests are executed on third-party providers' machines. The platform does not retain request content, and providers cannot see who you are. Confirm before buying quota or using a key.",
    "notice.accept": "I have read and confirm",
    "notice.accepted": "Confirmed {version}",

    "keys.title": "Keys",
    "keys.subtitle": "Quota travels with the key",
    "keys.new": "Buy a new key",
    "keys.newHint": "A key's plaintext is shown once at creation. Lost it? Reissue: the new key inherits balance and scope, the old one dies immediately.",
    "keys.balance": "Remaining",
    "keys.expiresAt": "expires {value}",
    "keys.created": "created {value}",
    "keys.reissue": "Reissue",
    "keys.reissueHint": "The new key inherits balance and scope; the old one dies immediately",
    "keys.reissueConfirm": "The old key stops working right away. Stop in-flight calls before you swap. Continue?",
    "keys.reissued": "Reissued",
    "keys.topup": "Top up",
    "keys.revoke": "Revoke",
    "keys.revokeConfirm": "The key stops working immediately and cannot be restored. Continue?",
    "keys.revoked": "Revoked",
    "keys.quota": "Balance by unit",
    "keys.quotaHint": "Each meter unit is booked separately",
    "keys.scope": "Scope",
    "keys.scopeAll": "Unrestricted",
    "keys.freezeHint": "After expiry the key is frozen for {days} days — reissue during that window moves the balance to the new key; otherwise it is returned per policy.",
    "keys.connect": "How to connect",
    "keys.connectHint": "Every response carries X-Galaxy-Request-Id — use it for debugging and disputes.",
    "keys.baseUrl": "Base URL",
    "keys.emptyTitle": "No compute keys yet",
    "keys.emptyHint": "Buy a quota pack — a key is issued once the payment lands.",
    "keys.status.active": "Active",
    "keys.status.expired": "Expired",
    "keys.status.frozen": "Frozen",
    "keys.status.revoked": "Revoked",
    "keys.concurrency": "Concurrency / RPM",

    "secret.title": "Key “{alias}” created",
    "secret.body1": "This plaintext is shown",
    "secret.body2": "only once",
    "secret.body3": " — after you close this, not even the platform can read it back. Lost it? Reissue and the balance follows.",
    "secret.saved": "I've saved it",
    "secret.goStore": "Top up",

    "store.title": "Top up",
    "store.subtitle": "Buy what you use, no subscription",
    "store.tab.packages": "Packs",
    "store.tab.orders": "Orders",
    "store.category": "Product",
    "store.category.claude": "Claude chat",
    "store.category.codex": "Codex coding",
    "store.category.video": "Video render",
    "store.category.other": "General quota",
    "store.categoryHint": "Quota and unit price are snapshotted into the order — later price changes don't touch what you bought.",
    "store.packages": "{category} · packs",
    "store.priceHint": "{price} / 1M · {days} days",
    "store.best": "Best value",
    "store.billing": "How billing works",
    "store.billingBody": "Charged on output tokens; input is booked at its own price. Failed calls are never billed, and a wrong charge can be disputed within 7 days — accepted disputes return the quota.",
    "store.confirm": "Confirm order",
    "store.target": "Top up which key",
    "store.targetNew": "Issue a new key",
    "store.channel": "Payment",
    "store.channelSandbox": "Sandbox · no real money",
    "store.channelEmpty": "No payment channel configured in this deployment — the platform confirms payment manually.",
    "store.total": "Total",
    "store.pay": "Pay now",
    "store.paySandbox": "Sandbox pay",
    "store.terms": "Paying accepts the usage terms",
    "store.awaiting": "Waiting for payment… it lands automatically, no refresh needed",
    "store.awaitingOrder": "Order {order} · valid for 15 minutes",
    "store.paid": "Credited",
    "store.ordered": "Order created",
    "store.cancelOrder": "Cancel order",
    "store.cancelled": "Order cancelled",
    "store.switchChannel": "Change payment",
    "store.packagesEmpty": "No packs on sale right now",
    "store.getsUnits": "You get",
    "store.emptyKeys": "You have no key yet — this order issues one.",
    "store.comingSoon": "Coming soon",

    "orders.paidTotal": "Total paid",
    "orders.paidCount": "{value} credited",
    "orders.pending": "Awaiting payment",
    "orders.pendingCount": "{value} order(s)",
    "orders.pendingHint": "Open one to finish paying",
    "orders.invoice": "Invoice",
    "orders.invoiceHint": "Available · add a billing title in Account first",
    "orders.col.time": "Time",
    "orders.col.order": "Order",
    "orders.col.package": "Pack",
    "orders.col.units": "Quota",
    "orders.col.target": "Into",
    "orders.col.amount": "Amount",
    "orders.col.status": "Status",
    "orders.status.pending": "Awaiting payment",
    "orders.status.paid": "Processing",
    "orders.status.fulfilled": "Credited",
    "orders.status.cancelled": "Cancelled",
    "orders.empty": "No orders yet",
    "orders.newKey": "new key",

    "usage.title": "Usage",
    "usage.subtitle": "Every charge maps to one request",
    "usage.spent": "Spent in {days} days",
    "usage.spentHint": "{tokens} tokens · at the price you paid",
    "usage.calls": "Calls today",
    "usage.callsHint": "{ok} ok · {failed} failed",
    "usage.firstByte": "First byte",
    "usage.firstByteHint": "Queue + upstream",
    "usage.left": "Remaining",
    "usage.leftHint": "across {keys} key(s)",
    "usage.search": "Search by request id",
    "usage.allKeys": "All keys",
    "usage.export": "Export",
    "usage.rowHint": "Open a row for its request id and the dispute entry",
    "usage.col.time": "Time",
    "usage.col.key": "Key",
    "usage.col.model": "Model",
    "usage.col.in": "In",
    "usage.col.out": "Out",
    "usage.col.cost": "Took",
    "usage.col.charge": "Charged",
    "usage.col.state": "State",
    "usage.state.completed": "Done",
    "usage.state.failed": "Failed · not billed",
    "usage.state.running": "Running",
    "usage.empty": "No calls in this period",
    "usage.summary": "{from}–{to} of {total}",
    "usage.tab.records": "Per call",
    "usage.tab.bill": "Bill",
    "usage.tab.sessions": "Sessions",
    "usage.tab.jobs": "Jobs",
    "usage.tab.disputes": "Disputes",
    "usage.total": "Total",
    "usage.notPriced": "Not priced",

    "detail.title": "This request",
    "detail.requestId": "Request id",
    "detail.provider": "Upstream",
    "detail.unknownProvider": "cleared",
    "detail.usage": "Usage",
    "detail.charge": "Charged",
    "detail.dispute": "Dispute this charge",
    "detail.disputeReason": "Reason",
    "detail.disputeDetail": "Details",
    "detail.disputeDetailHint": "Don't paste request content — the platform doesn't store it, and pasting only creates another copy.",
    "detail.disputeSubmit": "Submit dispute",
    "detail.disputed": "Dispute filed. Accepted disputes return the quota the same way it was charged.",

    "dispute.reason.not_delivered": "Nothing was delivered",
    "dispute.reason.wrong_output": "The output is clearly wrong",
    "dispute.reason.overcharged": "Charge doesn't match usage",
    "dispute.reason.forged": "The response looks forged",
    "dispute.reason.other": "Something else",
    "dispute.status.open": "Under review",
    "dispute.status.accepted": "Accepted",
    "dispute.status.rejected": "Rejected",
    "dispute.status.withdrawn": "Withdrawn",
    "dispute.withdraw": "Withdraw",
    "dispute.empty": "No disputes",
    "dispute.col.time": "Time",
    "dispute.col.unit": "Request",
    "dispute.col.reason": "Reason",
    "dispute.col.status": "Status",
    "dispute.col.refund": "Returned",

    "sessions.empty": "No stateful sessions",
    "sessions.col.sid": "Session",
    "sessions.col.kind": "Capability",
    "sessions.col.state": "State",
    "sessions.col.turns": "Turns",
    "sessions.col.time": "Last turn",
    "sessions.close": "Close",
    "sessions.closed": "Session closed",
    "sessions.migrated": "migrated",

    "jobs.empty": "No jobs",
    "jobs.col.job": "Job",
    "jobs.col.kind": "Capability",
    "jobs.col.state": "State",
    "jobs.col.progress": "Progress",
    "jobs.col.time": "Created",
    "jobs.cancel": "Cancel",
    "jobs.cancelled": "Job cancelled",

    "chat.title": "Chat",
    "chat.subtitle": "Spend key quota straight from here — no environment setup",
    "chat.soonTitle": "Chat isn't open yet",
    "chat.soonHint": "This release focuses on keys, top-ups and billing. Until then, point base_url at the address below and use an official SDK or Claude Code.",
    "chat.goKeys": "See how to connect",

    "account.title": "Account",
    "account.subtitle": "Profile and security",
    "account.profile": "Profile",
    "account.security": "Sign-in and security",
    "account.securityHint": "The session token lives on this computer; signing out clears it.",
    "account.keys": "My keys",
    "account.keysHint": "{active} active of {total}",
    "account.notice": "Data notice",
    "account.logout": "Sign out",
    "account.locale": "Interface language",
    "account.danger": "Close account",
    "account.dangerHint": "Spend or return the balance on your keys first. Closing revokes every key immediately; usage records are kept 90 days for disputes.",
    "account.dangerContact": "Closing needs a manual check of balances and in-flight orders — contact support to start it.",
  },
} as const;

export type AppLocale = (typeof SUPPORTED_LOCALES)[number];
export type TranslationKey = keyof (typeof messages)["zh-CN"];

interface LocaleContextValue {
  locale: AppLocale;
  setLocale: (locale: AppLocale) => void;
  /**
   * 取文案。第二个参数是占位符替换：t("usage.spent", { days: 10 })。
   *
   * 之前每个调用点都写 .replace("{value}", ...)，同一个 key 在两处替换的占位符
   * 不一样时没人会发现 —— 界面上就是一句话里露出个 {days}。
   */
  t: (key: TranslationKey | string, vars?: Record<string, string | number>) => string;
}

const LocaleContext = createContext<LocaleContextValue | null>(null);

function initialLocale(): AppLocale {
  if (typeof window === "undefined") return "zh-CN";
  const saved = window.localStorage.getItem(STORAGE_KEY);
  if (saved && (SUPPORTED_LOCALES as readonly string[]).includes(saved)) return saved as AppLocale;
  return window.navigator.language.toLowerCase().startsWith("en") ? "en-US" : "zh-CN";
}

export function AppLocaleProvider({ children }: PropsWithChildren) {
  // 首屏固定用默认语言，挂载后再读 localStorage：服务端读不到它，
  // 直接按用户偏好渲染会让首屏 HTML 与水合结果对不上。
  const [locale, setLocale] = useState<AppLocale>("zh-CN");
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setLocale(initialLocale());
    setReady(true);
  }, []);

  useEffect(() => {
    if (!ready) return;
    window.localStorage.setItem(STORAGE_KEY, locale);
    document.documentElement.lang = locale;
  }, [locale, ready]);

  const value = useMemo<LocaleContextValue>(
    () => ({
      locale,
      setLocale,
      t: (key, vars) => {
        const template = (messages[locale] as Record<string, string>)[key as string] ?? String(key);
        if (!vars) return template;
        return Object.entries(vars).reduce(
          (text, [name, replacement]) => text.split(`{${name}}`).join(String(replacement)),
          template,
        );
      },
    }),
    [locale],
  );

  return (
    <LocaleContext.Provider value={value}>
      <ConfigProvider theme={galaxyTheme} locale={locale === "en-US" ? enUS : zhCN}>
        {children}
      </ConfigProvider>
    </LocaleContext.Provider>
  );
}

export function useLocale(): LocaleContextValue {
  const context = useContext(LocaleContext);
  if (!context) {
    throw new Error("useLocale must be used within AppLocaleProvider");
  }
  return context;
}

export const SUPPORTED_LOCALE_LIST = SUPPORTED_LOCALES;
