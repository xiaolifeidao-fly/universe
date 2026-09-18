"use client";

/**
 * 门户的文案字典与 i18n Provider。用法和两个控制台的 useLocale() 一致。
 *
 * 为什么不用 @shared/i18n 那个工厂：client/shared 没有自己的 node_modules，
 * 靠一个**唯一的**符号链接解析裸导入，于是 shared 里那个 <ConfigProvider>
 * 来自另一个 app 的 antd 实例 —— 两份实例就是两套 React context，主题传不过去。
 * 详见 orbit/webview/src/i18n/LocaleProvider.tsx 顶部那段。
 *
 * 只开中英两种。加文案时两个语言都要补 key —— 缺一个在另一种语言下就露出裸键名，
 * 而门户是陌生人看到的第一屏，露出 "home.hero.title" 比写错还难看。
 */

import { ConfigProvider } from "antd";
import enUS from "antd/locale/en_US";
import zhCN from "antd/locale/zh_CN";
import { createContext, type PropsWithChildren, useContext, useEffect, useMemo, useState } from "react";
import { portalTheme } from "@/styles/theme";

const SUPPORTED_LOCALES = ["zh-CN", "en-US"] as const;
const STORAGE_KEY = "galaxy-portal-locale";

const messages = {
  "zh-CN": {
    "locale.zh-CN": "简体中文",
    "locale.en-US": "English",
    "locale.switch": "切换语言",

    "brand.name": "Orbit",
    "brand.tag": "GALAXY",

    "nav.home": "首页",
    "nav.models": "模型",
    "nav.pricing": "定价",
    "nav.contact": "联系我们",
    "nav.console": "控制台",
    "nav.menu": "菜单",

    "common.viewPricing": "查看定价",
    "common.viewModels": "查看全部模型",
    "common.copy": "复制",
    "common.copied": "已复制",
    "common.copyFailed": "复制失败，请手动选中",
    "common.empty": "暂时没有可展示的数据",
    "common.emptyHint": "服务端还没有上架内容，或者这台机器暂时连不上后端。",
    "common.perMillion": "/ 百万 token",
    "common.unified": "统一价",
    "common.unifiedHint": "当前按 token 统一计价，与具体模型无关",

    "kind.llm.chat": "对话与代码",
    "kind.delivery.task": "任务执行",
    "kind.video.edit.render": "视频渲染",

    "unit.llm.total_tokens": "总 token",
    "unit.llm.input_tokens": "输入 token",
    "unit.llm.output_tokens": "输出 token",
    "unit.llm.cache_read_tokens": "缓存读取 token",
    "unit.llm.cache_write_tokens": "缓存写入 token",
    "unit.llm.calls": "调用次数",
    "unit.video.output_seconds": "输出时长",
    "unit.video.input_seconds": "输入时长",
    "unit.cpu.seconds": "CPU 秒",
    "unit.gpu.seconds": "GPU 秒",
    "unit.time.seconds": "占用时长",

    "family.claude": "Claude",
    "family.gpt": "GPT / Codex",
    "family.gemini": "Gemini",
    "family.other": "其他",
    "family.all": "全部",

    "home.hero.eyebrow": "Claude · GPT 统一接入",
    "home.hero.title": "改一行 base_url，",
    "home.hero.title2": "Claude 和 Codex 照常用",
    "home.hero.lead":
      "Anthropic 与 OpenAI 两族模型统一接入。额度跟着密钥走，输入、输出、缓存分开记账；每一次调用都留着一个能查到的请求号。",
    "home.hero.primary": "进入控制台",
    "home.hero.secondary": "先看价格",
    "home.hero.endpoint": "服务地址",
    "home.hero.endpointEmpty": "部署后由服务端下发",

    "home.stat.models": "可用模型",
    "home.stat.vendors": "上游厂商",
    "home.stat.minTopup": "最低充值",
    "home.stat.availability": "可用性",
    "home.stat.concurrency": "最高并发",
    "home.stat.unitVendor": "家",
    "home.stat.unitModel": "个",
    "home.stat.unitConcurrency": "并发",

    "home.orbit.core": "统一网关",
    "home.orbit.cli": "Claude Code · Codex",
    "home.orbit.cliNote": "命令行工具",
    "home.orbit.app": "你的应用",
    "home.orbit.appNote": "官方 SDK · cURL",

    "home.steps.eyebrow": "接入",
    "home.steps.title": "三步，五分钟",
    "home.steps.lead": "没有 SDK 要换，没有代码要改。你原来怎么调，现在还怎么调。",
    "home.steps.1.title": "在控制台买一把密钥",
    "home.steps.1.body": "选一个额度包，付款后立刻签发。明文只显示这一次，记得先存下来。",
    "home.steps.2.title": "把地址和密钥填进环境变量",
    "home.steps.2.body": "Claude Code、Codex CLI、官方 SDK 认的都是同一组变量，右边直接抄。",
    "home.steps.3.title": "照常干活",
    "home.steps.3.body": "模型清单、流式响应、工具调用都按官方形态返回，客户端察觉不到中间这一层。",

    "home.why.eyebrow": "为什么是这里",
    "home.why.title": "把「花了多少、花在哪」摊开给你看",
    "home.why.lead": "算力这门生意最容易糊弄的就是账。所以这套系统的每一个设计，都是为了让账对得上。",

    "home.why.1.title": "官方 SDK 直接指过来",
    "home.why.1.body":
      "Anthropic 与 OpenAI 两族的 base_url 都吃，/v1/models 也在 —— 客户端的模型发现能走完，不用一个个手敲模型名。",
    "home.why.2.title": "额度跟着密钥走",
    "home.why.2.body":
      "一把密钥一份额度，输入、输出、缓存读各扣各的，按 token 记账。不换算成看不懂的「点数」，也就没有汇率可做手脚。",
    "home.why.3.title": "每一次都查得到",
    "home.why.3.body":
      "响应头带 X-Galaxy-Request-Id。控制台里能翻到那一次调用的逐笔扣费；对不上，就用这个号发起申诉。",
    "home.why.4.title": "明文只显示一次",
    "home.why.4.body": "密钥落库只存 sha256。丢了就换发 —— 新密钥继承余额与允许范围，旧的立刻作废。",
    "home.why.5.title": "到期不清零",
    "home.why.5.body": "有效期到了先冻结 {freeze} 天。这期间还能换发，把没用完的余额转进新密钥。",
    "home.why.6.title": "请求内容不留存",
    "home.why.6.body": "平台只记结构化的计量与事件，请求与响应的正文不落库、不入日志。",

    "home.models.eyebrow": "模型",
    "home.models.title": "常用的这几个",
    "home.models.lead": "完整清单和逐个模型的单价在模型页。",

    "home.faq.eyebrow": "常见问题",
    "home.faq.title": "你大概会问",

    "home.faq.1.q": "和直接买官方账号有什么区别？",
    "home.faq.1.a":
      "官方账号是按月订阅、额度按月清零，用不完是浪费、用超了要等下个月。这里是按 token 付费：买多少用多少，用不完留在密钥上；到期还有一段冻结期可以转走。另外这里一个地址同时给到 Anthropic 与 OpenAI 两族模型，不用维护两套账号和两套配置。",
    "home.faq.2.q": "我的请求内容会被保存吗？",
    "home.faq.2.a":
      "不保存。平台只记结构化的计量与执行事件（用了哪个模型、多少 token、成功还是失败），请求与响应的正文既不落库也不入日志。也正因如此，发起申诉时不需要、也请不要把请求内容粘贴进来。",
    "home.faq.3.q": "支持哪些客户端？",
    "home.faq.3.a":
      "认 base_url 的都支持：Claude Code、Codex CLI、Anthropic 官方 SDK、OpenAI 官方 SDK，以及任何能改基础地址的第三方客户端。模型清单接口也在，客户端的「连接测试 / 模型发现」这一步能正常走完。",
    "home.faq.4.q": "额度是怎么算的？",
    "home.faq.4.a":
      "按计量单位分别记账：输入 token、输出 token、缓存读取 token 各有各的单价，各扣各的余额。控制台里能看到每一次调用扣了哪几项、各扣了多少。",
    "home.faq.5.q": "密钥丢了怎么办？",
    "home.faq.5.a":
      "在控制台点「换发」。新密钥继承原来的余额、有效期和允许范围，旧密钥立刻作废。明文同样只显示这一次。",
    "home.faq.6.q": "企业采购、批量额度、开票怎么谈？",
    "home.faq.6.a": "走「联系我们」留一条，写清预估用量和需要的模型，我们看到会直接回你留的联系方式。",

    "home.cta.title": "先买最小的那个包试试",
    "home.cta.body": "额度不清零，跑一天不合适就停下来，剩下的还在密钥上。",
    "home.cta.primary": "进入控制台",
    "home.cta.secondary": "聊聊需求",

    "models.title": "模型",
    "models.lead": "平台当前提供的全部模型。改 base_url 之后，这些模型名可以直接填进客户端。",
    "models.search": "搜模型名",
    "models.count": "{count} 个模型",
    "models.none": "没有匹配的模型",
    "models.noneHint": "换个关键词，或者点「全部」看看完整清单。",
    "models.context": "上下文",
    "models.input": "输入",
    "models.output": "输出",
    "models.listPrice": "官方",
    "models.discount": "省 {rate}",
    "models.cache": "缓存读取",
    "models.priceNoteBase": "单价按每百万 token 计，与账单同口径。卡片上标「统一价」的，用的是这一类能力的通用单价，不是这个模型自己的价。",
    "models.priceNoteFlat":
      "单价按每百万 token 计，与账单同口径。当前计费按 token 统一定价，与具体模型无关 —— 卡片上那个「统一价」就是这个意思。",
    "models.endpointTitle": "填进客户端的就是这一行",

    "pricing.title": "定价",
    "pricing.lead": "买的是额度，不是月份。输入、输出、缓存读各有各的单价，各扣各的。",
    "pricing.packages": "额度包",
    "pricing.packagesLead": "在控制台下单，付款后额度直接落到一把新密钥上，也可以充进已有的密钥。",
    "pricing.unitPrices": "单价表",
    "pricing.unitPricesLead": "这张表就是账单的算式：某一项的用量 × 它的单价 ÷ 一百万。",
    "pricing.table.kind": "能力",
    "pricing.table.unit": "计量单位",
    "pricing.table.price": "每百万单位",
    "pricing.buy": "去控制台购买",
    "pricing.ttl": "有效期 {days} 天",
    "pricing.limits": "并发 {concurrency} · 每分钟 {rpm} 次",
    "pricing.includes": "含",
    "pricing.featured": "最常买",
    "pricing.emptyPackages": "还没有上架的额度包",
    "pricing.emptyPackagesHint": "运营在后台上架之后，这里会自动显示。",
    "pricing.emptyPrices": "价格表还是空的",
    "pricing.emptyPricesHint": "未定价时请求只计量、不计费。部署方需要先写入定价。",
    "pricing.howTitle": "账是怎么算的",
    "pricing.how.1.title": "按 token，不按次",
    "pricing.how.1.body": "一次请求扣多少，取决于它真的吃进和吐出了多少 token，而不是它算「一次」还是「两次」。",
    "pricing.how.2.title": "三项分开记",
    "pricing.how.2.body": "输入、输出、缓存读各有各的余额和单价。缓存命中便宜得多，所以值得让它命中。",
    "pricing.how.3.title": "失败不计费",
    "pricing.how.3.body": "没产出首字节就失败的请求会自动重试，不计费；已经产出的部分按实际产出计。",
    "pricing.faqTitle": "关于钱的几个问题",

    "contact.title": "联系我们",
    "contact.lead": "企业采购、批量额度、接入协助，或者只是想问一句能不能跑你那个场景 —— 留个话，我们直接回你。",
    "contact.form.title": "留个话",
    "contact.form.name": "怎么称呼",
    "contact.form.namePlaceholder": "张三",
    "contact.form.contact": "联系方式",
    "contact.form.contactPlaceholder": "邮箱 / 手机 / 微信，填一种能找到你的",
    "contact.form.contactRequired": "得留一个能联系到你的方式",
    "contact.form.company": "公司 / 团队",
    "contact.form.companyPlaceholder": "选填",
    "contact.form.topic": "想聊什么",
    "contact.form.scale": "预估用量",
    "contact.form.scalePlaceholder": "选填，比如「每天两三千万 token」",
    "contact.form.message": "补充说明",
    "contact.form.messagePlaceholder": "在跑什么场景、用哪些模型、卡在哪一步。写清楚一点，我们回得也具体一点。",
    "contact.form.optional": "选填",
    "contact.form.submit": "发出去",
    "contact.form.submitting": "正在发送",
    "contact.form.success": "收到了，我们会用你留的方式联系你。",
    "contact.form.failed": "没发出去",
    "contact.form.privacy": "只用于回复这条留言，不会转给第三方。为了防刷，提交时的 IP 会一并记录。",

    "contact.topic.enterprise": "企业采购",
    "contact.topic.support": "接入与技术支持",
    "contact.topic.business": "商务合作",
    "contact.topic.other": "其他",

    "contact.side.title": "也可以直接找我们",
    "contact.side.email": "邮箱",
    "contact.side.wechat": "微信",
    "contact.side.console": "已经是用户？",
    "contact.side.consoleBody": "账单对不上、某一次调用有疑问，控制台里能查到逐笔明细，也能直接发起申诉 —— 那条路比留言快。",
    "contact.side.consoleLink": "去控制台",
    "contact.side.hoursTitle": "什么时候回",
    "contact.side.hoursBody": "工作日一般当天回。企业采购会有人跟进到底。",

    "footer.product": "产品",
    "footer.resources": "资源",
    "footer.company": "关于",
    "footer.docs": "接入文档",
    "footer.console": "控制台",
    "footer.terms": "服务条款",
    "footer.privacy": "隐私说明",
    "footer.tagline": "一个地址接入 Claude 与 GPT，按 token 计费，每一笔都查得到。",
    "footer.rights": "保留所有权利。",
  },

  "en-US": {
    "locale.zh-CN": "简体中文",
    "locale.en-US": "English",
    "locale.switch": "Switch language",

    "brand.name": "Orbit",
    "brand.tag": "GALAXY",

    "nav.home": "Home",
    "nav.models": "Models",
    "nav.pricing": "Pricing",
    "nav.contact": "Contact",
    "nav.console": "Console",
    "nav.menu": "Menu",

    "common.viewPricing": "See pricing",
    "common.viewModels": "See all models",
    "common.copy": "Copy",
    "common.copied": "Copied",
    "common.copyFailed": "Copy failed — select it by hand",
    "common.empty": "Nothing to show yet",
    "common.emptyHint": "Nothing has been listed yet, or this machine cannot reach the backend.",
    "common.perMillion": "/ 1M tokens",
    "common.unified": "Flat rate",
    "common.unifiedHint": "Billing is per token at a flat rate today — it does not vary by model",

    "kind.llm.chat": "Chat & code",
    "kind.delivery.task": "Task execution",
    "kind.video.edit.render": "Video rendering",

    "unit.llm.total_tokens": "Total tokens",
    "unit.llm.input_tokens": "Input tokens",
    "unit.llm.output_tokens": "Output tokens",
    "unit.llm.cache_read_tokens": "Cache read tokens",
    "unit.llm.cache_write_tokens": "Cache write tokens",
    "unit.llm.calls": "Calls",
    "unit.video.output_seconds": "Output seconds",
    "unit.video.input_seconds": "Input seconds",
    "unit.cpu.seconds": "CPU seconds",
    "unit.gpu.seconds": "GPU seconds",
    "unit.time.seconds": "Wall seconds",

    "family.claude": "Claude",
    "family.gpt": "GPT / Codex",
    "family.gemini": "Gemini",
    "family.other": "Others",
    "family.all": "All",

    "home.hero.eyebrow": "Claude · GPT, one endpoint",
    "home.hero.title": "Change one base_url.",
    "home.hero.title2": "Keep using Claude and Codex.",
    "home.hero.lead":
      "Anthropic and OpenAI models behind one endpoint. Quota rides with the key; input, output and cache are metered separately, and every call leaves a request id you can look up.",
    "home.hero.primary": "Open the console",
    "home.hero.secondary": "See pricing first",
    "home.hero.endpoint": "Endpoint",
    "home.hero.endpointEmpty": "Issued by the server once deployed",

    "home.stat.models": "Models",
    "home.stat.vendors": "Upstream vendors",
    "home.stat.minTopup": "Starts at",
    "home.stat.availability": "Availability",
    "home.stat.concurrency": "Peak concurrency",
    "home.stat.unitVendor": "",
    "home.stat.unitModel": "",
    "home.stat.unitConcurrency": "in parallel",

    "home.orbit.core": "One gateway",
    "home.orbit.cli": "Claude Code · Codex",
    "home.orbit.cliNote": "command-line tools",
    "home.orbit.app": "Your app",
    "home.orbit.appNote": "official SDKs · cURL",

    "home.steps.eyebrow": "Getting started",
    "home.steps.title": "Three steps, five minutes",
    "home.steps.lead": "No SDK to swap, no code to rewrite. Call it exactly the way you already do.",
    "home.steps.1.title": "Buy a key in the console",
    "home.steps.1.body": "Pick a quota pack; the key is issued on payment. The secret is shown once — save it then.",
    "home.steps.2.title": "Put the endpoint and key in your env",
    "home.steps.2.body": "Claude Code, Codex CLI and the official SDKs all read the same variables. Copy from the right.",
    "home.steps.3.title": "Get back to work",
    "home.steps.3.body":
      "Model listing, streaming and tool calls all come back in the official shape. Your client never notices the layer in between.",

    "home.why.eyebrow": "Why here",
    "home.why.title": "The bill, opened up",
    "home.why.lead":
      "Compute resale is an easy place to fudge the numbers. Every design decision below exists so the numbers add up.",

    "home.why.1.title": "Official SDKs point straight at it",
    "home.why.1.body":
      "Both the Anthropic and OpenAI base_url shapes work, and /v1/models is there — model discovery completes, so nobody types model names by hand.",
    "home.why.2.title": "Quota rides with the key",
    "home.why.2.body":
      "One key, one balance. Input, output and cache reads are metered and charged separately, in tokens — no opaque \"credits\", so there is no exchange rate to bend.",
    "home.why.3.title": "Every call is traceable",
    "home.why.3.body":
      "Responses carry X-Galaxy-Request-Id. The console shows what that one call cost, line by line — and that id is what you file a dispute with.",
    "home.why.4.title": "The secret is shown once",
    "home.why.4.body":
      "Only a sha256 is stored. Lost it? Reissue: the new key inherits the balance and scope, the old one dies immediately.",
    "home.why.5.title": "Expiry does not zero you out",
    "home.why.5.body":
      "An expired key freezes for {freeze} days first. During that window you can still reissue and move the balance across.",
    "home.why.6.title": "Payloads are not kept",
    "home.why.6.body":
      "Only structured metering and execution events are recorded. Request and response bodies never hit the database or the logs.",

    "home.models.eyebrow": "Models",
    "home.models.title": "The ones people actually use",
    "home.models.lead": "The full list and per-model rates are on the models page.",

    "home.faq.eyebrow": "FAQ",
    "home.faq.title": "You are probably wondering",

    "home.faq.1.q": "How is this different from buying an official plan?",
    "home.faq.1.a":
      "An official plan is a monthly subscription whose quota resets every month: leftovers are wasted, overruns wait for next month. This is pay-per-token — buy what you need, unused quota stays on the key, and an expired key freezes before anything is lost. One endpoint also covers both the Anthropic and OpenAI families, so there is one account and one config instead of two.",
    "home.faq.2.q": "Do you store my prompts?",
    "home.faq.2.a":
      "No. Only structured metering and execution events are recorded — which model, how many tokens, success or failure. Request and response bodies never reach the database or the logs. That is also why a dispute does not need (and should not include) the payload.",
    "home.faq.3.q": "Which clients work?",
    "home.faq.3.a":
      "Anything that lets you set a base_url: Claude Code, Codex CLI, the official Anthropic and OpenAI SDKs, and third-party clients. The model listing endpoint is served too, so \"test connection / discover models\" completes normally.",
    "home.faq.4.q": "How is quota counted?",
    "home.faq.4.a":
      "Per metering unit. Input tokens, output tokens and cache-read tokens each have their own rate and their own balance. The console shows which units a single call consumed and what each one cost.",
    "home.faq.5.q": "What if I lose the key?",
    "home.faq.5.a":
      "Reissue it from the console. The new key inherits the balance, expiry and scope; the old one is void immediately. The new secret is, again, shown only once.",
    "home.faq.6.q": "Enterprise purchasing, bulk quota, invoices?",
    "home.faq.6.a":
      "Send a note through Contact with your expected volume and the models you need. We reply to whatever contact you leave.",

    "home.cta.title": "Start with the smallest pack",
    "home.cta.body": "Quota does not expire into thin air. Try it for a day; whatever is left stays on the key.",
    "home.cta.primary": "Open the console",
    "home.cta.secondary": "Talk to us",

    "models.title": "Models",
    "models.lead":
      "Every model the platform currently offers. Once your base_url points here, these names go straight into your client.",
    "models.search": "Search models",
    "models.count": "{count} models",
    "models.none": "No matching model",
    "models.noneHint": "Try another keyword, or hit \"All\" for the full list.",
    "models.context": "Context",
    "models.input": "Input",
    "models.output": "Output",
    "models.listPrice": "list",
    "models.discount": "{rate} off",
    "models.cache": "Cache read",
    "models.priceNoteBase":
      "Rates are per million tokens, the same unit the bill uses. A card marked \"Flat rate\" is showing the rate for that capability, not a rate set for that model.",
    "models.priceNoteFlat":
      "Rates are per million tokens, the same unit the bill uses. Billing is currently a flat per-token rate that does not vary by model — that is what the \"Flat rate\" mark means.",
    "models.endpointTitle": "This is the line your client needs",

    "pricing.title": "Pricing",
    "pricing.lead":
      "You buy quota, not months. Input, output and cache reads each have their own rate and their own balance.",
    "pricing.packages": "Quota packs",
    "pricing.packagesLead":
      "Order from the console. Quota lands on a freshly issued key, or tops up a key you already have.",
    "pricing.unitPrices": "Unit rates",
    "pricing.unitPricesLead": "This table is the bill's arithmetic: units used × rate ÷ one million.",
    "pricing.table.kind": "Capability",
    "pricing.table.unit": "Metering unit",
    "pricing.table.price": "Per million",
    "pricing.buy": "Buy in the console",
    "pricing.ttl": "Valid {days} days",
    "pricing.limits": "{concurrency} concurrent · {rpm} rpm",
    "pricing.includes": "Includes",
    "pricing.featured": "Most bought",
    "pricing.emptyPackages": "No packs listed yet",
    "pricing.emptyPackagesHint": "They show up here as soon as they are listed in the back office.",
    "pricing.emptyPrices": "The rate table is empty",
    "pricing.emptyPricesHint":
      "With no rates configured, calls are metered but not charged. The operator has to write rates in first.",
    "pricing.howTitle": "How the bill is computed",
    "pricing.how.1.title": "Per token, not per call",
    "pricing.how.1.body":
      "What a request costs depends on the tokens it actually consumed and produced — not on whether it counts as one call or two.",
    "pricing.how.2.title": "Three balances, kept apart",
    "pricing.how.2.body":
      "Input, output and cache reads each have their own rate. Cache hits are far cheaper, which is exactly why they are worth engineering for.",
    "pricing.how.3.title": "Failures are free",
    "pricing.how.3.body":
      "A request that fails before the first byte is retried automatically and not charged. One that already produced output is charged for what it produced.",
    "pricing.faqTitle": "Questions about money",

    "contact.title": "Contact",
    "contact.lead":
      "Enterprise purchasing, bulk quota, integration help — or just whether this can carry your workload. Leave a note and we answer directly.",
    "contact.form.title": "Leave a note",
    "contact.form.name": "Your name",
    "contact.form.namePlaceholder": "Jane",
    "contact.form.contact": "How to reach you",
    "contact.form.contactPlaceholder": "Email, phone or WeChat — whichever you actually read",
    "contact.form.contactRequired": "We need a way to reach you",
    "contact.form.company": "Company / team",
    "contact.form.companyPlaceholder": "Optional",
    "contact.form.topic": "What is this about",
    "contact.form.scale": "Expected volume",
    "contact.form.scalePlaceholder": "Optional — e.g. \"20-30M tokens a day\"",
    "contact.form.message": "Anything else",
    "contact.form.messagePlaceholder":
      "What you are building, which models, where you are stuck. The more specific this is, the more specific our answer.",
    "contact.form.optional": "optional",
    "contact.form.submit": "Send it",
    "contact.form.submitting": "Sending",
    "contact.form.success": "Got it. We will reply to the contact you left.",
    "contact.form.failed": "Could not send",
    "contact.form.privacy": "Used only to answer this note, never passed on. Your IP is recorded alongside it, for abuse prevention.",

    "contact.topic.enterprise": "Enterprise purchasing",
    "contact.topic.support": "Integration & support",
    "contact.topic.business": "Partnerships",
    "contact.topic.other": "Something else",

    "contact.side.title": "Or reach us directly",
    "contact.side.email": "Email",
    "contact.side.wechat": "WeChat",
    "contact.side.console": "Already a customer?",
    "contact.side.consoleBody":
      "For a bill that looks wrong or one call you want explained, the console shows the line-by-line detail and files the dispute for you — that route is faster than this form.",
    "contact.side.consoleLink": "Open the console",
    "contact.side.hoursTitle": "When we reply",
    "contact.side.hoursBody": "Usually the same working day. Enterprise enquiries get a named owner.",

    "footer.product": "Product",
    "footer.resources": "Resources",
    "footer.company": "About",
    "footer.docs": "Integration docs",
    "footer.console": "Console",
    "footer.terms": "Terms",
    "footer.privacy": "Privacy",
    "footer.tagline": "One endpoint for Claude and GPT, billed by the token, every call traceable.",
    "footer.rights": "All rights reserved.",
  },
} as const;

export type AppLocale = (typeof SUPPORTED_LOCALES)[number];
export type TranslationKey = keyof (typeof messages)["zh-CN"];

interface LocaleContextValue {
  locale: AppLocale;
  setLocale: (next: AppLocale) => void;
  t: (key: TranslationKey, vars?: Record<string, string | number>) => string;
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
      <ConfigProvider theme={portalTheme} locale={locale === "en-US" ? enUS : zhCN}>
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

/** 计量单位的人话名。字典里没有的原样显示 unit id —— 新接一个上游只是还没有译名。 */
export function unitLabel(unit: string, t: LocaleContextValue["t"]): string {
  const key = `unit.${unit}` as TranslationKey;
  const label = t(key);
  return label === key ? unit : label;
}

/** 能力（kind）的人话名。字典里没有的原样显示 kind —— 新接一类能力只是还没有译名。 */
export function kindLabel(kind: string, t: LocaleContextValue["t"]): string {
  const key = `kind.${kind}` as TranslationKey;
  const label = t(key);
  return label === key ? kind : label;
}

/** 模型族的人话名。认不出来的一律归「其他」，不猜。 */
export function familyLabel(family: string, t: LocaleContextValue["t"]): string {
  const key = `family.${family}` as TranslationKey;
  const label = t(key);
  return label === key ? family : label;
}

export const SUPPORTED_LOCALE_LIST = SUPPORTED_LOCALES;
