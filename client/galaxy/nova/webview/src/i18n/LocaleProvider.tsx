"use client";

/**
 * Nova 的文案字典与 i18n Provider。用法和 web / manager 的 useLocale() 一致。
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

    "brand.subtitle": "GALAXY · 贡献端",

    "shell.logout": "退出登录",

    "common.refresh": "刷新",
    "common.saved": "已保存",
    "common.cancel": "取消",
    "common.confirm": "确认",
    "common.loadFailed": "加载失败",
    "common.actionFailed": "操作失败",
    "common.all": "全部",
    "common.discard": "放弃",
    "common.today": "今天",
    "common.yesterday": "昨天",
    "common.days7": "近 7 天",

    "nav.today": "今天",
    "nav.share": "共享设置",
    "nav.earnings": "收益",
    "nav.records": "使用记录",
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
    "login.tagline1": "把闲置的订阅算力，",
    "login.tagline2": "变成每天都在涨的积分。",
    "login.point1.title": "自己说了算",
    "login.point1.desc": "共享哪几种、共享多少、什么时段共享，随时可以改，也随时能停",
    "login.point2.title": "凭据不出本机",
    "login.point2.desc": "订阅登录态只在你的机器上读取，平台和使用者都拿不到",
    "login.point3.title": "收益逐笔可查",
    "login.point3.desc": "谁用了、用了多少、给了多少积分，一条一条列给你看",
    "login.foot": "登录后 Nova 会在本机检测可共享的能力（Claude / Codex 订阅），检测不发任何请求，也不消耗你的额度。",

    "today.title": "今天",
    "today.masterSwitch": "共享总开关",
    "today.sharing": "正在共享",
    "today.paused": "已暂停共享",
    "today.offline": "未连接",
    "today.streak": "已连续 {value}",
    "today.earned": "今日收益",
    "today.credits": "积分",
    "today.week": "本周",
    "today.month": "本月",
    "today.total": "累计",
    "today.window": "共享时段",
    "today.windowAdjust": "调整",
    "today.windowAllDay": "全天共享 · 没有设置时段",
    "today.windowLeft": "本轮共享还剩 {value}",
    "today.windowNext": "下一轮从 {value} 开始",
    "today.quota": "今日额度",
    "today.quotaHint": "任意一条用完，今天就停止接单",
    "today.quotaEmpty": "还没有设置额度上限",
    "today.recent": "刚刚在你机器上跑过的",
    "today.recentAll": "全部记录",
    "today.capability": "本机能力",
    "today.capabilityHint": "你的登录态只在本机读取。平台看到的只是「一个能跑 sonnet 的座位」。",
    "today.soon": "即将支持",
    "today.gpu": "本机 GPU / 视频渲染",
    "today.notShared": "已检测到，未共享",
    "today.emptyTitle": "还没有机器接进共享池",
    "today.emptyHint": "把这台机器接进来，它就能在你允许的时段接单。",
    "today.emptyAction": "连接本机",
    "today.col.time": "时间",
    "today.col.model": "模型",
    "today.col.io": "输入 → 输出",
    "today.col.cost": "耗时",
    "today.col.credit": "积分",

    "pair.title": "连接本机",
    "pair.step": "3 步里的第 {value} 步",
    "pair.heroTitle": "把这台机器接进共享池",
    "pair.heroDesc": "Nova 通过 Electron 内部通道直接和本机的 bridge 对话，不走 HTTP、不开端口。下面三步走完，这台机器就能在你允许的时段接单。",
    "pair.step1": "找到本机的 bridge",
    "pair.step1Ok": "已检测到本机 bridge，配置在 {path}。",
    "pair.step1Fail": "没有检测到本机 bridge。请在 Nova 桌面应用里打开这一页。",
    "pair.step2": "读取可共享的能力",
    "pair.step2Empty": "还没有检测到可共享的能力。装好 Claude 或 Codex 并登录后重试。",
    "pair.step2Hint": "只解析凭据，不发请求。",
    "pair.step3": "与平台配对",
    "pair.step3Desc": "用你账号里的一次性配对码换取节点令牌。令牌以哈希落盘，明文只在内存。",
    "pair.privacy": "配对只证明「这台机器是你的」，不会上传任何登录态或文件。",
    "pair.code": "配对码",
    "pair.codeHint": "10 分钟内有效，只能用一次",
    "pair.codeIssue": "生成配对码",
    "pair.deviceName": "给这台机器起个名字",
    "pair.terms": "我已阅读并同意《算力共享条款》{version}",
    "pair.submit": "配对并加入共享池",
    "pair.foot": "配对完成后再决定共享什么，默认什么都不共享",
    "pair.done": "已配对：{name}",
    "pair.desktopOnly": "本机能力由 Nova 桌面应用提供，请在桌面应用里完成配对。",
    "pair.available": "可用",
    "pair.unavailable": "不可用",

    "share.title": "共享设置",
    "share.subtitle": "共享什么、共享多少、什么时候共享",
    "share.detected": "本机检测到",
    "share.detectedHint": "检测只解析本机凭据，不向上游发任何请求。「机器上装了」和「我愿意共享」是两件事，中间要你点一下头。",
    "share.on": "共享中",
    "share.off": "已关闭",
    "share.enable": "共享这项能力",
    "share.syncHint": "下面每一项改完都会同步到平台，平台侧生效值为准",
    "share.models": "允许调用的模型",
    "share.modelsHint": "划掉的不接单 · opus 更贵，也更吃额度",
    "share.modelsAllow": "允许",
    "share.modelsDeny": "拒绝",
    "share.modelsPlaceholder": "claude-sonnet-*",
    "share.seats": "座位数",
    "share.seatsHint": "同时最多接待 {value} 位使用者",
    "share.concurrency": "每座并发",
    "share.concurrencyHint": "每位使用者同时最多 {value} 个请求",
    "share.quota": "每日上限",
    "share.quotaHint": "每天 00:00 重置 · 任一条到顶就停",
    "share.quotaAdd": "加一条额度",
    "share.window": "共享时段",
    "share.windowHint": "点格子选时段，不选表示全天共享",
    "share.dirty": "有 {value} 处未保存的修改",
    "share.submit": "保存并同步",
    "share.bound": "有 {value} 位使用者绑在上面，现在关掉会打断他们",
    "share.unavailable": "本机现在干不了这件事",
    "share.authorize": "去授权",
    "share.authLaunched": "已在本机打开登录流程，完成后最迟 15 秒自动恢复",
    "share.authAlready": "本机凭据仍然有效，不需要重新登录",
    "share.authManual": "请在本机执行：{command}",
    "share.emptyTitle": "还没有可共享的能力",
    "share.emptyHint": "先把这台机器接进共享池，Nova 会自动读出它能共享什么。",

    "earnings.title": "收益",
    "earnings.subtitle": "积分逐笔记账，随时对得上",
    "earnings.available": "可提现积分",
    "earnings.pending": "待结算",
    "earnings.pendingHint": "· {days} 天争议期后可提",
    "earnings.withdrawn": "已提现",
    "earnings.withdraw": "提现",
    "earnings.rules": "积分规则",
    "earnings.rulesBody": "按 kind 分成：llm.chat 的调用费用 70% 归你，平台留 30%。{rate} 积分兑 1 元，{days} 天争议期满后可提。",
    "earnings.week": "这一周",
    "earnings.weekSummary": "{value} 积分 · 今天还在涨",
    "earnings.ledger": "积分账本",
    "earnings.export": "导出 CSV",
    "earnings.type.all": "全部",
    "earnings.type.settle": "收益",
    "earnings.type.payout": "提现",
    "earnings.type.clawback": "扣回",
    "earnings.type.contribute": "贡献",
    "earnings.col.date": "日期",
    "earnings.col.type": "类型",
    "earnings.col.detail": "说明",
    "earnings.col.credit": "积分",
    "earnings.ledgerEmpty": "还没有积分流水。有人用你的机器跑过之后，这里会一条条列出来。",
    "earnings.summary": "第 {from}–{to} 条，共 {total} 条",

    "withdraw.title": "提现",
    "withdraw.hint": "积分按 {rate} : 1 兑换成人民币，工作日 24 小时内到账",
    "withdraw.credits": "提现积分",
    "withdraw.max": "/ 可提 {value}",
    "withdraw.all": "全部",
    "withdraw.method": "收款方式",
    "withdraw.method.alipay": "支付宝",
    "withdraw.method.wechat": "微信",
    "withdraw.method.bank": "银行卡",
    "withdraw.account": "收款账号",
    "withdraw.accountPlaceholder": "支付宝账号 / 手机号",
    "withdraw.amount": "到账金额",
    "withdraw.exchange": "兑换",
    "withdraw.fee": "手续费",
    "withdraw.pendingNote": "待结算的 {value} 积分争议期满后自动转入可提",
    "withdraw.submit": "确认提现 {amount}",
    "withdraw.done": "提现申请已受理",
    "withdraw.status.pending": "待打款",
    "withdraw.status.paid": "已到账",
    "withdraw.status.rejected": "已驳回",

    "records.title": "使用记录",
    "records.subtitle": "谁在你的机器上跑了什么",
    "records.calls": "今日调用",
    "records.callsDelta": "较昨日 {value}",
    "records.output": "输出 tokens",
    "records.outputHint": "占今日上限 {value}",
    "records.latency": "平均耗时",
    "records.latencyHint": "上游响应，不含排队",
    "records.failed": "失败",
    "records.failedHint": "失败不计费",
    "records.search": "搜 unitId",
    "records.allModels": "全部模型",
    "records.allContributions": "全部能力",
    "records.anonymous": "使用者已匿名化 · 你看不到他们的密钥，他们也看不到你",
    "records.col.time": "时间",
    "records.col.unit": "unitId",
    "records.col.model": "模型",
    "records.col.in": "输入",
    "records.col.out": "输出",
    "records.col.cost": "耗时",
    "records.col.state": "状态",
    "records.state.completed": "完成",
    "records.state.failed": "失败",
    "records.state.running": "进行中",
    "records.empty": "这段时间没有人用过你的机器",
    "records.summary": "第 {from}–{to} 条，共 {total} 条",

    "account.title": "账户",
    "account.subtitle": "个人信息与安全",
    "account.profile": "基本资料",
    "account.node": "本机节点",
    "account.nodeNone": "尚未配对",
    "account.security": "登录与安全",
    "account.securityHint": "登录令牌保存在这台电脑上，退出登录会一并清掉。",
    "account.unbindHint": "解绑后这台机器不再接单，未结算的积分照常在争议期后到账。重新绑定要再走一次配对。",
    "account.unbindAction": "解绑本机",
    "account.unbindConfirm": "解绑后这台机器立刻停止接单，确定吗？",
    "account.unbound": "已解绑",
    "account.logout": "退出登录",
    "account.locale": "界面语言",

    "bridge.builtin": "ai-bridge 已内置于 Nova，无需单独安装或启动。",
    "bridge.desktopRequired": "请在 Nova 桌面应用中管理本机共享服务。",
    "bridge.runtime": "本机服务",
    "bridge.start": "启动",
    "bridge.stop": "停止",
    "bridge.restart": "重启",
    "bridge.state.stopped": "已停止",
    "bridge.state.starting": "正在连接",
    "bridge.state.running": "运行中",
    "bridge.state.error": "运行异常",
    "bridge.tools": "本机工具",
    "bridge.toolsUpgrade": "升级",
    "bridge.toolsUpgrading": "{name} 正在后台升级，装完刷新一下",
    "bridge.toolsLatest": "已是最新",
    "bridge.toolsMissing": "未安装",
  },
  "en-US": {
    "locale.zh-CN": "简体中文",
    "locale.en-US": "English",

    "brand.subtitle": "GALAXY · PROVIDER",

    "shell.logout": "Sign out",

    "common.refresh": "Refresh",
    "common.saved": "Saved",
    "common.cancel": "Cancel",
    "common.confirm": "Confirm",
    "common.loadFailed": "Failed to load",
    "common.actionFailed": "Action failed",
    "common.all": "All",
    "common.discard": "Discard",
    "common.today": "Today",
    "common.yesterday": "Yesterday",
    "common.days7": "Last 7 days",

    "nav.today": "Today",
    "nav.share": "Sharing",
    "nav.earnings": "Earnings",
    "nav.records": "Activity",
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
    "login.tagline1": "Turn the subscription you",
    "login.tagline2": "aren't using into daily credits.",
    "login.point1.title": "You decide",
    "login.point1.desc": "Which capabilities, how much, which hours — change or stop any time",
    "login.point2.title": "Credentials stay local",
    "login.point2.desc": "Subscription logins are read on your machine only; neither platform nor users see them",
    "login.point3.title": "Every credit is traceable",
    "login.point3.desc": "Who ran what, how much it used, what it paid — line by line",
    "login.foot": "After signing in, Nova detects what this machine can share (Claude / Codex). Detection sends no upstream requests and spends none of your quota.",

    "today.title": "Today",
    "today.masterSwitch": "Sharing",
    "today.sharing": "Sharing",
    "today.paused": "Paused",
    "today.offline": "Not connected",
    "today.streak": "Up for {value}",
    "today.earned": "Earned today",
    "today.credits": "credits",
    "today.week": "This week",
    "today.month": "This month",
    "today.total": "All time",
    "today.window": "Sharing hours",
    "today.windowAdjust": "Adjust",
    "today.windowAllDay": "All day · no schedule set",
    "today.windowLeft": "{value} left in this window",
    "today.windowNext": "Next window starts {value}",
    "today.quota": "Today's caps",
    "today.quotaHint": "Whichever runs out first stops new work for the day",
    "today.quotaEmpty": "No caps configured yet",
    "today.recent": "Just ran on your machine",
    "today.recentAll": "All activity",
    "today.capability": "This machine",
    "today.capabilityHint": "Your logins are read locally. The platform only sees “a seat that can run sonnet”.",
    "today.soon": "Coming soon",
    "today.gpu": "Local GPU / video render",
    "today.notShared": "Detected, not shared",
    "today.emptyTitle": "No machine in the pool yet",
    "today.emptyHint": "Connect this machine and it will take work during the hours you allow.",
    "today.emptyAction": "Connect this machine",
    "today.col.time": "Time",
    "today.col.model": "Model",
    "today.col.io": "In → out",
    "today.col.cost": "Took",
    "today.col.credit": "Credits",

    "pair.title": "Connect this machine",
    "pair.step": "Step {value} of 3",
    "pair.heroTitle": "Put this machine into the pool",
    "pair.heroDesc": "Nova talks to the local bridge over an Electron channel — no HTTP, no open port. Three steps and this machine can take work during the hours you allow.",
    "pair.step1": "Find the local bridge",
    "pair.step1Ok": "Found the local bridge, configured at {path}.",
    "pair.step1Fail": "No local bridge detected. Open this page in the Nova desktop app.",
    "pair.step2": "Read shareable capabilities",
    "pair.step2Empty": "Nothing shareable detected yet. Install and sign in to Claude or Codex, then retry.",
    "pair.step2Hint": "Credentials are parsed locally; no request is sent.",
    "pair.step3": "Pair with the platform",
    "pair.step3Desc": "Exchange a one-time pairing code for a node token. The token is stored hashed; the plaintext only lives in memory.",
    "pair.privacy": "Pairing only proves the machine is yours. No login state or file is uploaded.",
    "pair.code": "Pairing code",
    "pair.codeHint": "Valid for 10 minutes, single use",
    "pair.codeIssue": "Get a pairing code",
    "pair.deviceName": "Name this machine",
    "pair.terms": "I have read and accept the sharing terms {version}",
    "pair.submit": "Pair and join the pool",
    "pair.foot": "Decide what to share after pairing — nothing is shared by default",
    "pair.done": "Paired: {name}",
    "pair.desktopOnly": "Local capabilities come from the Nova desktop app. Pair from there.",
    "pair.available": "Available",
    "pair.unavailable": "Unavailable",

    "share.title": "Sharing",
    "share.subtitle": "What to share, how much, and when",
    "share.detected": "Detected on this machine",
    "share.detectedHint": "Detection only parses local credentials — no upstream request. “Installed” and “I want to share it” are two different things, and the second one needs your nod.",
    "share.on": "Sharing",
    "share.off": "Off",
    "share.enable": "Share this capability",
    "share.syncHint": "Every change below syncs to the platform; the platform value wins",
    "share.models": "Models allowed",
    "share.modelsHint": "Struck-through ones are declined · opus costs more and burns quota faster",
    "share.modelsAllow": "Allow",
    "share.modelsDeny": "Deny",
    "share.modelsPlaceholder": "claude-sonnet-*",
    "share.seats": "Seats",
    "share.seatsHint": "Serve at most {value} users at once",
    "share.concurrency": "Per-seat concurrency",
    "share.concurrencyHint": "At most {value} in-flight requests per user",
    "share.quota": "Daily caps",
    "share.quotaHint": "Resets at 00:00 · whichever hits first stops new work",
    "share.quotaAdd": "Add a cap",
    "share.window": "Sharing hours",
    "share.windowHint": "Click the cells to pick hours; none selected means all day",
    "share.dirty": "{value} unsaved change(s)",
    "share.submit": "Save and sync",
    "share.bound": "{value} user(s) are bound here — turning it off now interrupts them",
    "share.unavailable": "This machine can't do that right now",
    "share.authorize": "Authorize",
    "share.authLaunched": "Login started on this machine; it recovers within 15 seconds once done",
    "share.authAlready": "Local credentials are still valid, no need to sign in again",
    "share.authManual": "Run this on the machine: {command}",
    "share.emptyTitle": "Nothing to share yet",
    "share.emptyHint": "Connect this machine first — Nova reads what it can share automatically.",

    "earnings.title": "Earnings",
    "earnings.subtitle": "Credits are booked line by line",
    "earnings.available": "Withdrawable",
    "earnings.pending": "Settling",
    "earnings.pendingHint": "· available after the {days}-day dispute window",
    "earnings.withdrawn": "Withdrawn",
    "earnings.withdraw": "Withdraw",
    "earnings.rules": "How credits work",
    "earnings.rulesBody": "Split by kind: you keep 70% of what an llm.chat call charges, the platform keeps 30%. {rate} credits per CNY, withdrawable after the {days}-day dispute window.",
    "earnings.week": "This week",
    "earnings.weekSummary": "{value} credits · still climbing",
    "earnings.ledger": "Credit ledger",
    "earnings.export": "Export CSV",
    "earnings.type.all": "All",
    "earnings.type.settle": "Earned",
    "earnings.type.payout": "Withdrawal",
    "earnings.type.clawback": "Clawback",
    "earnings.type.contribute": "Contribution",
    "earnings.col.date": "Date",
    "earnings.col.type": "Type",
    "earnings.col.detail": "Detail",
    "earnings.col.credit": "Credits",
    "earnings.ledgerEmpty": "No credit entries yet. Once someone runs on your machine they show up here.",
    "earnings.summary": "{from}–{to} of {total}",

    "withdraw.title": "Withdraw",
    "withdraw.hint": "{rate} credits per CNY, paid out within one business day",
    "withdraw.credits": "Credits to withdraw",
    "withdraw.max": "/ {value} available",
    "withdraw.all": "Max",
    "withdraw.method": "Payout method",
    "withdraw.method.alipay": "Alipay",
    "withdraw.method.wechat": "WeChat Pay",
    "withdraw.method.bank": "Bank card",
    "withdraw.account": "Payout account",
    "withdraw.accountPlaceholder": "Alipay account / phone",
    "withdraw.amount": "You receive",
    "withdraw.exchange": "Exchange",
    "withdraw.fee": "Fee",
    "withdraw.pendingNote": "{value} settling credits move to withdrawable once the dispute window closes",
    "withdraw.submit": "Withdraw {amount}",
    "withdraw.done": "Withdrawal request accepted",
    "withdraw.status.pending": "Processing",
    "withdraw.status.paid": "Paid",
    "withdraw.status.rejected": "Rejected",

    "records.title": "Activity",
    "records.subtitle": "What ran on your machine",
    "records.calls": "Calls today",
    "records.callsDelta": "{value} vs yesterday",
    "records.output": "Output tokens",
    "records.outputHint": "{value} of today's cap",
    "records.latency": "Average duration",
    "records.latencyHint": "Upstream response, queueing excluded",
    "records.failed": "Failed",
    "records.failedHint": "Failures are not billed",
    "records.search": "Search unitId",
    "records.allModels": "All models",
    "records.allContributions": "All capabilities",
    "records.anonymous": "Users are anonymised · you can't see their keys and they can't see you",
    "records.col.time": "Time",
    "records.col.unit": "unitId",
    "records.col.model": "Model",
    "records.col.in": "In",
    "records.col.out": "Out",
    "records.col.cost": "Took",
    "records.col.state": "State",
    "records.state.completed": "Done",
    "records.state.failed": "Failed",
    "records.state.running": "Running",
    "records.empty": "Nobody used your machine in this period",
    "records.summary": "{from}–{to} of {total}",

    "account.title": "Account",
    "account.subtitle": "Profile and security",
    "account.profile": "Profile",
    "account.node": "This machine",
    "account.nodeNone": "Not paired",
    "account.security": "Sign-in and security",
    "account.securityHint": "The session token lives on this computer; signing out clears it.",
    "account.unbindHint": "After unpairing this machine takes no more work. Unsettled credits still land after the dispute window. Re-binding means pairing again.",
    "account.unbindAction": "Unpair this machine",
    "account.unbindConfirm": "This machine stops taking work immediately. Continue?",
    "account.unbound": "Unpaired",
    "account.logout": "Sign out",
    "account.locale": "Interface language",

    "bridge.builtin": "ai-bridge ships inside Nova — nothing to install or start.",
    "bridge.desktopRequired": "Manage the local sharing service from the Nova desktop app.",
    "bridge.runtime": "Local service",
    "bridge.start": "Start",
    "bridge.stop": "Stop",
    "bridge.restart": "Restart",
    "bridge.state.stopped": "Stopped",
    "bridge.state.starting": "Connecting",
    "bridge.state.running": "Running",
    "bridge.state.error": "Error",
    "bridge.tools": "Local tools",
    "bridge.toolsUpgrade": "Upgrade",
    "bridge.toolsUpgrading": "{name} is upgrading in the background — refresh once it's done",
    "bridge.toolsLatest": "Up to date",
    "bridge.toolsMissing": "Not installed",
  },
} as const;

export type AppLocale = (typeof SUPPORTED_LOCALES)[number];
export type TranslationKey = keyof (typeof messages)["zh-CN"];

interface LocaleContextValue {
  locale: AppLocale;
  setLocale: (locale: AppLocale) => void;
  /**
   * 取文案。第二个参数是占位符替换：t("today.streak", { value: "6 天 14 小时" })。
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
