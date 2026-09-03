"use client";

import { Fragment, useState, type ReactNode } from "react";
import { Code2, Eye } from "lucide-react";
import { HtmlPreview } from "@/components/workbench/html-preview";

/**
 * 会话正文与文档正文的 Markdown 呈现。
 *
 * 移动端不引入 Markdown 依赖：模型回复和交付文档里真正出现的就是标题、列表、
 * 任务清单、表格、引用、分割线和代码块这几样，按块解析后各自渲染，行内只认
 * 代码、强调、删除线、链接和图片。正文永远走 React 节点，绝不注入 HTML。
 *
 * 例外是代码块里那段 HTML：原型和 HTML 报告本来就是要看效果的，这类块给一个
 * 「效果 / 源码」开关，效果走沙箱 iframe（见 html-preview.tsx），和文档预览同一套口径。
 */
export function RichText({ text }: { text: string }) {
  return <BlockList blocks={parseBlocks(splitLines(text))} className="rich-text" />;
}

function BlockList({ blocks, className }: { blocks: Block[]; className?: string }) {
  return (
    <div className={className ?? "rich-text__blocks"}>
      {blocks.map((block, index) => <BlockView block={block} key={index} />)}
    </div>
  );
}

function BlockView({ block }: { block: Block }) {
  if (block.kind === "code") return <CodeBlock block={block} />;
  if (block.kind === "heading") {
    return <p className={`rich-text__heading level-${block.level}`}>{inline(block.content)}</p>;
  }
  if (block.kind === "divider") return <hr className="rich-text__divider" />;
  if (block.kind === "quote") {
    return <blockquote className="rich-text__quote"><BlockList blocks={block.blocks} /></blockquote>;
  }
  if (block.kind === "table") return <TableBlock block={block} />;
  if (block.kind === "list") return <ListBlock block={block} />;
  return <p className="rich-text__paragraph">{inline(block.content)}</p>;
}

function ListBlock({ block }: { block: ListBlock }) {
  const hasTask = block.items.some((item) => typeof item.checked === "boolean");
  const className = `rich-text__list${hasTask ? " is-task" : ""}`;
  const items = block.items.map((item, index) => (
    <li key={index} className={typeof item.checked === "boolean" ? "is-task" : undefined}>
      {typeof item.checked === "boolean" ? (
        <input type="checkbox" checked={item.checked} readOnly tabIndex={-1} aria-hidden="true" />
      ) : null}
      {/* 条目正文单独包一层：勾选框那一行是横排的，子列表要落在正文这一列里往下排。 */}
      <span className="rich-text__item"><ItemBody blocks={item.blocks} /></span>
    </li>
  ));
  return block.ordered
    ? <ol className={className} start={block.start}>{items}</ol>
    : <ul className={className}>{items}</ul>;
}

/** 单段的条目直接铺开，免得每一条都套一层块容器把行距撑开。 */
function ItemBody({ blocks }: { blocks: Block[] }) {
  if (!blocks.length) return null;
  if (blocks.length === 1 && blocks[0].kind === "paragraph") return <>{inline(blocks[0].content)}</>;
  const [first, ...rest] = blocks;
  return (
    <>
      {first.kind === "paragraph" ? inline(first.content) : <BlockView block={first} />}
      {rest.length ? <BlockList blocks={rest} /> : null}
    </>
  );
}

function TableBlock({ block }: { block: TableBlock }) {
  // 表格在手机上一定放不下，让它自己横向滚，不要把整条消息撑出横向滚动条。
  return (
    <div className="rich-text__table">
      <table>
        {block.head.length ? (
          <thead>
            <tr>{block.head.map((cell, index) => <th key={index} style={alignOf(block.align[index])}>{inline(cell)}</th>)}</tr>
          </thead>
        ) : null}
        <tbody>
          {block.rows.map((row, rowIndex) => (
            <tr key={rowIndex}>
              {row.map((cell, index) => <td key={index} style={alignOf(block.align[index])}>{inline(cell)}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function alignOf(align?: Align) {
  return align && align !== "left" ? { textAlign: align } : undefined;
}

/**
 * 代码块。是一段 HTML 时默认先给效果——会话里贴出来的原型，用户要看的是页面本身，
 * 不是那几百行标签；随时能切回源码。
 */
function CodeBlock({ block }: { block: CodeBlock }) {
  const previewable = isHtmlSource(block.language, block.content);
  const [preview, setPreview] = useState(previewable);
  return (
    <div className="rich-text__code-block">
      {previewable ? (
        <div className="preview-switch" role="group" aria-label="查看方式">
          <button type="button" className={preview ? "is-active" : ""} onClick={() => setPreview(true)}>
            <Eye size={16} aria-hidden="true" />效果
          </button>
          <button type="button" className={preview ? "" : "is-active"} onClick={() => setPreview(false)}>
            <Code2 size={16} aria-hidden="true" />源码
          </button>
        </div>
      ) : null}
      {previewable && preview ? (
        <HtmlPreview html={block.content} title="页面预览" />
      ) : (
        <pre className="rich-text__code">
          {block.language ? <span className="rich-text__code-lang">{block.language}</span> : null}
          <code>{block.content}</code>
        </pre>
      )}
    </div>
  );
}

/** 语言标了 html，或者正文本身就是一份完整页面，都按能看效果处理。 */
export function isHtmlSource(language: string, content: string) {
  if (/^(html|htm|xhtml|svg)$/i.test(language.trim())) return true;
  if (language.trim()) return false;
  return /^\s*(<!doctype\s+html|<html[\s>])/i.test(content);
}

/* ---------- 块解析 ---------- */

type Align = "left" | "center" | "right";

interface ListItem {
  checked?: boolean;
  blocks: Block[];
}

type CodeBlock = { kind: "code"; language: string; content: string };
type ListBlock = { kind: "list"; ordered: boolean; start: number; items: ListItem[] };
type TableBlock = { kind: "table"; head: string[]; align: Align[]; rows: string[][] };

type Block =
  | CodeBlock
  | ListBlock
  | TableBlock
  | { kind: "heading"; level: number; content: string }
  | { kind: "quote"; blocks: Block[] }
  | { kind: "divider" }
  | { kind: "paragraph"; content: string };

function splitLines(value: string) {
  return String(value ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
}

const FENCE = /^\s{0,3}(```+|~~~+)(.*)$/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const DIVIDER = /^\s{0,3}([-*_])\s*(?:\1\s*){2,}$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;
const LIST_ITEM = /^(\s*)([-*+]|\d{1,9}[.)])(\s+|$)(.*)$/;
const TABLE_DIVIDER = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;

function parseBlocks(lines: string[]): Block[] {
  const blocks: Block[] = [];
  let paragraph: string[] = [];

  const flush = () => {
    if (paragraph.length) blocks.push({ kind: "paragraph", content: paragraph.join("\n") });
    paragraph = [];
  };

  let index = 0;
  while (index < lines.length) {
    const line = lines[index];

    if (!line.trim()) {
      flush();
      index += 1;
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence) {
      flush();
      const marker = fence[1][0];
      const content: string[] = [];
      index += 1;
      while (index < lines.length && !new RegExp(`^\\s{0,3}${marker === "`" ? "```" : "~~~"}+\\s*$`).test(lines[index])) {
        content.push(lines[index]);
        index += 1;
      }
      index += 1; // 收尾的围栏；正文到结尾都没闭合时这一步只是越过末尾。
      blocks.push({ kind: "code", language: fence[2].trim().split(/\s+/)[0] ?? "", content: content.join("\n") });
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      flush();
      blocks.push({ kind: "heading", level: heading[1].length, content: heading[2] });
      index += 1;
      continue;
    }

    if (DIVIDER.test(line)) {
      flush();
      blocks.push({ kind: "divider" });
      index += 1;
      continue;
    }

    if (QUOTE.test(line)) {
      flush();
      const inner: string[] = [];
      while (index < lines.length) {
        const quote = QUOTE.exec(lines[index]);
        if (quote) {
          inner.push(quote[1]);
          index += 1;
          continue;
        }
        // 引用块里的续行可以不带 `>`，但空行就到此为止。
        if (!lines[index].trim()) break;
        if (LIST_ITEM.test(lines[index]) || HEADING.test(lines[index]) || FENCE.test(lines[index])) break;
        inner.push(lines[index]);
        index += 1;
      }
      blocks.push({ kind: "quote", blocks: parseBlocks(inner) });
      continue;
    }

    if (line.includes("|") && index + 1 < lines.length && TABLE_DIVIDER.test(lines[index + 1]) && lines[index + 1].includes("-")) {
      flush();
      const [table, next] = parseTable(lines, index);
      blocks.push(table);
      index = next;
      continue;
    }

    if (LIST_ITEM.test(line)) {
      flush();
      const [list, next] = parseList(lines, index);
      blocks.push(list);
      index = next;
      continue;
    }

    paragraph.push(line);
    index += 1;
  }

  flush();
  return blocks;
}

function splitRow(line: string) {
  let body = line.trim();
  if (body.startsWith("|")) body = body.slice(1);
  if (body.endsWith("|") && !body.endsWith("\\|")) body = body.slice(0, -1);
  const cells: string[] = [];
  let current = "";
  for (let index = 0; index < body.length; index += 1) {
    const character = body[index];
    if (character === "\\" && body[index + 1] === "|") {
      current += "|";
      index += 1;
      continue;
    }
    if (character === "|") {
      cells.push(current.trim());
      current = "";
      continue;
    }
    current += character;
  }
  cells.push(current.trim());
  return cells;
}

function parseTable(lines: string[], start: number): [TableBlock, number] {
  const head = splitRow(lines[start]);
  const align: Align[] = splitRow(lines[start + 1]).map((cell) => {
    const left = cell.startsWith(":");
    const right = cell.endsWith(":");
    if (left && right) return "center";
    if (right) return "right";
    return "left";
  });
  const rows: string[][] = [];
  let index = start + 2;
  while (index < lines.length && lines[index].includes("|") && lines[index].trim()) {
    const cells = splitRow(lines[index]);
    // 少的补空、多的截掉：模型手写的表格经常有一两行列数对不上，不能整张表塌掉。
    rows.push(Array.from({ length: head.length }, (_, cell) => cells[cell] ?? ""));
    index += 1;
  }
  return [{ kind: "table", head, align, rows }, index];
}

/**
 * 一段列表。
 *
 * 缩进决定层级：比首项缩进多的行算这一条的续行（含子列表），和首项齐平的是下一条。
 * 条目内容再递归走一遍块解析，所以子列表、条目里的代码块和表格都能正常展开。
 */
function parseList(lines: string[], start: number): [ListBlock, number] {
  const first = LIST_ITEM.exec(lines[start]) as RegExpExecArray;
  const baseIndent = first[1].length;
  const ordered = /\d/.test(first[2]);
  const startNumber = ordered ? Number.parseInt(first[2], 10) || 1 : 1;
  const items: ListItem[] = [];
  let buffer: string[] = [];
  let index = start;

  const flushItem = () => {
    if (!buffer.length) return;
    let lines_ = buffer;
    let checked: boolean | undefined;
    const task = /^\[([ xX])\]\s+(.*)$/.exec(lines_[0] ?? "");
    if (task) {
      checked = task[1].toLowerCase() === "x";
      lines_ = [task[2], ...lines_.slice(1)];
    }
    items.push({ checked, blocks: parseBlocks(lines_) });
    buffer = [];
  };

  while (index < lines.length) {
    const line = lines[index];

    if (!line.trim()) {
      // 空行后面还接着这段列表就继续，否则列表到此结束。
      let lookahead = index + 1;
      while (lookahead < lines.length && !lines[lookahead].trim()) lookahead += 1;
      if (lookahead >= lines.length) break;
      const next = LIST_ITEM.exec(lines[lookahead]);
      const indented = lines[lookahead].search(/\S/) > baseIndent;
      if (!indented && !(next && next[1].length <= baseIndent + 1 && /\d/.test(next[2]) === ordered)) break;
      buffer.push("");
      index = lookahead;
      continue;
    }

    const item = LIST_ITEM.exec(line);
    const indent = line.search(/\S/);
    if (item && indent <= baseIndent + 1) {
      if (/\d/.test(item[2]) !== ordered) break; // 有序换无序（或反过来）算另一段列表。
      flushItem();
      buffer.push(item[4]);
      index += 1;
      continue;
    }

    if (indent > baseIndent) {
      // 子列表和续行统一按「去掉一层缩进」交给下一轮解析。
      buffer.push(line.slice(Math.min(indent, baseIndent + markerWidth(first))));
      index += 1;
      continue;
    }

    if (!items.length && !buffer.length) break;
    // 顶格的续行（懒续行）并到当前条目，遇到别的块级结构就收尾。
    if (HEADING.test(line) || DIVIDER.test(line) || FENCE.test(line) || QUOTE.test(line)) break;
    buffer.push(line);
    index += 1;
  }

  flushItem();
  return [{ kind: "list", ordered, start: startNumber, items }, index];
}

function markerWidth(match: RegExpExecArray) {
  return match[2].length + Math.max(1, match[3].length);
}

/* ---------- 行内解析 ---------- */

const ESCAPABLE = /[\\`*_~\[\]()#+\-.!>|]/;
const AUTOLINK = /^<((?:https?:\/\/|mailto:)[^>\s]+)>/;
const BARE_LINK = /^(https?:\/\/[^\s<>()[\]{}"'，。；：、！？]+)/;
const IMAGE = /^!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+["'（(][^)]*)?\s*\)/;
const LINK = /^\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+["'（(][^)]*)?\s*\)/;

/** 能直接点开的链接：站外地址交给浏览器，工作区里的相对路径只显示不跳转。 */
function isFollowable(href: string) {
  return /^(https?:\/\/|mailto:|tel:)/i.test(href);
}

function isRenderableImage(src: string) {
  return /^(https?:\/\/|data:image\/)/i.test(src);
}

function inline(value: string): ReactNode {
  const nodes: ReactNode[] = [];
  let text = "";
  let key = 0;
  const flush = () => {
    if (!text) return;
    nodes.push(<Fragment key={key++}>{text}</Fragment>);
    text = "";
  };
  const push = (node: ReactNode) => {
    flush();
    nodes.push(node);
  };

  let index = 0;
  while (index < value.length) {
    const rest = value.slice(index);
    const character = rest[0];

    if (character === "\\" && ESCAPABLE.test(rest[1] ?? "")) {
      text += rest[1];
      index += 2;
      continue;
    }

    if (character === "`") {
      const code = /^(`+)([\s\S]*?[^`])\1(?!`)/.exec(rest);
      if (code) {
        push(<code className="rich-text__inline-code" key={key++}>{code[2].trim()}</code>);
        index += code[0].length;
        continue;
      }
    }

    if (character === "!") {
      const image = IMAGE.exec(rest);
      if (image) {
        push(isRenderableImage(image[2])
          ? <img className="rich-text__image" src={image[2]} alt={image[1]} key={key++} loading="lazy" />
          // 工作区里的相对路径在手机上取不到，只留一行说明，别摆一个碎图标。
          : <span className="rich-text__image-note" key={key++}>[图片] {image[1] || image[2]}</span>);
        index += image[0].length;
        continue;
      }
    }

    if (character === "[") {
      const link = LINK.exec(rest);
      if (link) {
        const label = link[1] || link[2];
        push(isFollowable(link[2])
          ? <a className="rich-text__link" href={link[2]} target="_blank" rel="noreferrer noopener" key={key++}>{inline(label)}</a>
          : <span className="rich-text__link" key={key++}>{inline(label)}</span>);
        index += link[0].length;
        continue;
      }
    }

    if (character === "<") {
      const auto = AUTOLINK.exec(rest);
      if (auto) {
        push(<a className="rich-text__link" href={auto[1]} target="_blank" rel="noreferrer noopener" key={key++}>{auto[1].replace(/^mailto:/, "")}</a>);
        index += auto[0].length;
        continue;
      }
    }

    if (character === "h" && (index === 0 || !/[\w/]/.test(value[index - 1]))) {
      const bare = BARE_LINK.exec(rest);
      if (bare) {
        push(<a className="rich-text__link" href={bare[1]} target="_blank" rel="noreferrer noopener" key={key++}>{bare[1]}</a>);
        index += bare[0].length;
        continue;
      }
    }

    if (character === "~") {
      const strike = /^~~([\s\S]+?)~~/.exec(rest);
      if (strike) {
        push(<del key={key++}>{inline(strike[1])}</del>);
        index += strike[0].length;
        continue;
      }
    }

    if (character === "*" || character === "_") {
      // `_` 只在词边界上算强调，snake_case 的变量名不该被拆成斜体。
      const wordInside = character === "_" && index > 0 && /[\w一-龥]/.test(value[index - 1]);
      if (!wordInside) {
        const strong = new RegExp(`^\\${character}{2}([\\s\\S]+?)\\${character}{2}`).exec(rest);
        if (strong) {
          push(<strong key={key++}>{inline(strong[1])}</strong>);
          index += strong[0].length;
          continue;
        }
        const emphasis = new RegExp(`^\\${character}([^\\s${character}][\\s\\S]*?)\\${character}(?!\\${character})`).exec(rest);
        if (emphasis) {
          push(<em key={key++}>{inline(emphasis[1])}</em>);
          index += emphasis[0].length;
          continue;
        }
      }
    }

    text += character;
    index += 1;
  }

  flush();
  return nodes;
}
