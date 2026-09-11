"use client";

/**
 * 接入示例。
 *
 * 地址和模型名都来自服务端 —— 门户上抄下来的那几行必须能直接跑通，
 * 写死一个示例地址的结果是所有人复制走一个连不上的东西。
 *
 * 高亮是手写的三种 span（注释 / 关键字 / 字符串），不引 highlight.js：
 * 这里只有四段固定的代码，为它拉一个 200KB 的库不划算。
 */

import { useState } from "react";
import { useLocale } from "@/i18n/LocaleProvider";
import { Btn, useCopy } from "@/components/site/kit";
import { IconCheck, IconCopy } from "@/components/site/icons";

const TABS = ["Claude Code", "Codex CLI", "Python", "cURL"] as const;
type Tab = (typeof TABS)[number];

const SECRET = "sk-galaxy-…";

function samples(endpoint: string, model: string): Record<Tab, string> {
  return {
    "Claude Code": `# ~/.zshrc
export ANTHROPIC_BASE_URL=${endpoint}
export ANTHROPIC_AUTH_TOKEN=${SECRET}

# 然后照常用
claude`,
    "Codex CLI": `# ~/.zshrc
export OPENAI_BASE_URL=${endpoint}
export OPENAI_API_KEY=${SECRET}

# 然后照常用
codex`,
    Python: `from anthropic import Anthropic

client = Anthropic(
    base_url="${endpoint}",
    auth_token="${SECRET}",
)

message = client.messages.create(
    model="${model}",
    max_tokens=1024,
    messages=[{"role": "user", "content": "写一个快排"}],
)
print(message.content[0].text)`,
    cURL: `curl ${endpoint}/messages \\
  -H "x-api-key: ${SECRET}" \\
  -H "anthropic-version: 2023-06-01" \\
  -H "content-type: application/json" \\
  -d '{
    "model": "${model}",
    "max_tokens": 256,
    "messages": [{"role": "user", "content": "你好"}]
  }'`,
  };
}

/** 极简着色：# 开头整行是注释，引号里是字符串，行首的 export/from/import/curl 是关键字。 */
function highlight(line: string, key: string) {
  const trimmed = line.trimStart();
  if (trimmed.startsWith("#")) {
    return (
      <span className="c" key={key}>
        {line}
      </span>
    );
  }
  const parts = line.split(/("[^"]*")/g);
  return (
    <span key={key}>
      {parts.map((part, index) => {
        if (part.startsWith('"') && part.endsWith('"') && part.length > 1) {
          return (
            <span className="s" key={index}>
              {part}
            </span>
          );
        }
        return part.split(/\b(export|from|import|curl|print)\b/g).map((word, wordIndex) =>
          ["export", "from", "import", "curl", "print"].includes(word) ? (
            <span className="k" key={`${index}-${wordIndex}`}>
              {word}
            </span>
          ) : (
            <span key={`${index}-${wordIndex}`}>{word}</span>
          ),
        );
      })}
    </span>
  );
}

export function CodeTabs({ endpoint, model }: { endpoint: string; model: string }) {
  const { t } = useLocale();
  const [tab, setTab] = useState<Tab>("Claude Code");
  const copier = useCopy();

  // 两个占位都写成尖括号形态。之前模型名兜底成 "claude-sonnet-5" —— 那看起来
  // 像个真模型名，后端连不上时会被人原样抄走，而那个名字这套部署里未必有。
  const code = samples(endpoint || "https://<你的服务地址>/v1", model || "<模型名>")[tab];

  return (
    <div className="gp-code">
      <div className="gp-code__bar">
        {TABS.map((item) => (
          <button
            key={item}
            type="button"
            className="gp-code__tab"
            data-active={tab === item}
            onClick={() => setTab(item)}
          >
            {item}
          </button>
        ))}
        <span style={{ flex: 1 }} />
        <Btn tone="quiet" size="sm" onClick={() => copier.copy(code)}>
          {copier.state === "ok" ? <IconCheck /> : <IconCopy />}
          {copier.state === "ok"
            ? t("common.copied")
            : copier.state === "fail"
              ? t("common.copyFailed")
              : t("common.copy")}
        </Btn>
      </div>
      <pre>
        <code>
          {code.split("\n").map((line, index) => (
            <span key={index}>
              {highlight(line, `line-${index}`)}
              {"\n"}
            </span>
          ))}
        </code>
      </pre>
    </div>
  );
}
