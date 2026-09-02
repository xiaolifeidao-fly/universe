"use client";

import { Fragment, type ReactNode } from "react";

/**
 * 会话正文的轻量 Markdown 呈现。
 *
 * 移动端不引入 Markdown 依赖：模型回复里真正影响可读性的只有代码块、标题、
 * 列表和行内代码，这里按块解析，其余按段落原样显示，绝不注入 HTML。
 */
export function RichText({ text }: { text: string }) {
  const blocks = parseBlocks(text);
  return (
    <div className="rich-text">
      {blocks.map((block, index) => {
        if (block.kind === "code") {
          return (
            <pre className="rich-text__code" key={index}>
              {block.language ? <span className="rich-text__code-lang">{block.language}</span> : null}
              <code>{block.content}</code>
            </pre>
          );
        }
        if (block.kind === "heading") {
          return <p className={`rich-text__heading level-${block.level}`} key={index}>{inline(block.content)}</p>;
        }
        if (block.kind === "list") {
          return (
            <ul className="rich-text__list" key={index}>
              {block.items.map((item, itemIndex) => <li key={itemIndex}>{inline(item)}</li>)}
            </ul>
          );
        }
        if (block.kind === "ordered") {
          return (
            <ol className="rich-text__list" key={index}>
              {block.items.map((item, itemIndex) => <li key={itemIndex}>{inline(item)}</li>)}
            </ol>
          );
        }
        if (block.kind === "quote") {
          return <blockquote className="rich-text__quote" key={index}>{inline(block.content)}</blockquote>;
        }
        return <p className="rich-text__paragraph" key={index}>{inline(block.content)}</p>;
      })}
    </div>
  );
}

type Block =
  | { kind: "code"; language: string; content: string }
  | { kind: "heading"; level: number; content: string }
  | { kind: "list"; items: string[] }
  | { kind: "ordered"; items: string[] }
  | { kind: "quote"; content: string }
  | { kind: "paragraph"; content: string };

function parseBlocks(value: string): Block[] {
  const lines = String(value ?? "").replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  let list: string[] = [];
  let ordered: string[] = [];

  const flushParagraph = () => {
    if (paragraph.length) blocks.push({ kind: "paragraph", content: paragraph.join("\n") });
    paragraph = [];
  };
  const flushLists = () => {
    if (list.length) blocks.push({ kind: "list", items: list });
    if (ordered.length) blocks.push({ kind: "ordered", items: ordered });
    list = [];
    ordered = [];
  };
  const flushAll = () => {
    flushParagraph();
    flushLists();
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const fence = /^```(.*)$/.exec(line.trim());
    if (fence) {
      flushAll();
      const language = fence[1].trim();
      const content: string[] = [];
      index += 1;
      while (index < lines.length && !/^```/.test(lines[index].trim())) {
        content.push(lines[index]);
        index += 1;
      }
      blocks.push({ kind: "code", language, content: content.join("\n") });
      continue;
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      flushAll();
      blocks.push({ kind: "heading", level: heading[1].length, content: heading[2] });
      continue;
    }
    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    if (bullet) {
      flushParagraph();
      if (ordered.length) flushLists();
      list.push(bullet[1]);
      continue;
    }
    const numbered = /^\s*(\d+)[.)]\s+(.*)$/.exec(line);
    if (numbered) {
      flushParagraph();
      if (list.length) flushLists();
      ordered.push(numbered[2]);
      continue;
    }
    const quote = /^>\s?(.*)$/.exec(line);
    if (quote) {
      flushAll();
      blocks.push({ kind: "quote", content: quote[1] });
      continue;
    }
    if (!line.trim()) {
      flushAll();
      continue;
    }
    flushLists();
    paragraph.push(line);
  }
  flushAll();
  return blocks;
}

/** 行内只处理代码、粗体和链接文字，链接一律降级成纯文本，不做跳转。 */
function inline(value: string): ReactNode {
  const nodes: ReactNode[] = [];
  const pattern = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\[[^\]]+\]\([^)]+\))/g;
  let cursor = 0;
  let match = pattern.exec(value);
  let key = 0;
  while (match) {
    if (match.index > cursor) nodes.push(<Fragment key={key++}>{value.slice(cursor, match.index)}</Fragment>);
    const token = match[0];
    if (token.startsWith("`")) {
      nodes.push(<code className="rich-text__inline-code" key={key++}>{token.slice(1, -1)}</code>);
    } else if (token.startsWith("**")) {
      nodes.push(<strong key={key++}>{token.slice(2, -2)}</strong>);
    } else {
      const label = /^\[([^\]]+)\]/.exec(token);
      nodes.push(<span className="rich-text__link" key={key++}>{label ? label[1] : token}</span>);
    }
    cursor = match.index + token.length;
    match = pattern.exec(value);
  }
  if (cursor < value.length) nodes.push(<Fragment key={key++}>{value.slice(cursor)}</Fragment>);
  return nodes;
}
