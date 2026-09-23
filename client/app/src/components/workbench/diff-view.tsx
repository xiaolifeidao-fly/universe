"use client";

import { useMemo } from "react";

/** 超过这个行数就不再逐行比对：手机上读不完，也没必要为它跑一次 O(n²) 的对齐。 */
const MAX_DIFF_LINES = 1_200;

type DiffLine = { kind: "same" | "add" | "remove"; text: string; oldNumber?: number; newNumber?: number };

/**
 * 文件差异的单栏呈现。
 *
 * 手机屏幕放不下左右分栏，这里把两份正文对齐成一列，增删各自着色，
 * 行号保留在左侧，让人能对着 PC 上的同一份改动看。
 */
export function DiffView({
  oldText,
  newText,
  binary,
  truncated,
}: {
  oldText: string;
  newText: string;
  binary: boolean;
  truncated: boolean;
}) {
  const lines = useMemo(() => diffLines(oldText ?? "", newText ?? ""), [newText, oldText]);

  if (binary) return <p className="field-help">这是二进制文件，不显示正文差异。</p>;
  if (truncated) return <p className="field-help">文件过大，未加载正文差异。</p>;
  if (!lines.length) return <p className="field-help">没有可对比的内容。</p>;

  return (
    <div className="diff-view" role="group" aria-label="文件差异">
      {lines.map((line, index) => (
        <div className={`diff-line is-${line.kind}`} key={index}>
          <span className="diff-line__no">{line.kind === "add" ? line.newNumber : line.oldNumber}</span>
          <span className="diff-line__sign" aria-hidden="true">{line.kind === "add" ? "+" : line.kind === "remove" ? "-" : " "}</span>
          <span className="diff-line__text">{line.text || " "}</span>
        </div>
      ))}
    </div>
  );
}

function diffLines(oldText: string, newText: string): DiffLine[] {
  const oldLines = oldText ? oldText.replace(/\r\n/g, "\n").split("\n") : [];
  const newLines = newText ? newText.replace(/\r\n/g, "\n").split("\n") : [];
  if (oldLines.length > MAX_DIFF_LINES || newLines.length > MAX_DIFF_LINES) {
    return newLines.slice(0, MAX_DIFF_LINES).map((text, index) => ({ kind: "same", text, oldNumber: index + 1, newNumber: index + 1 }));
  }

  // 经典 LCS 对齐：两侧都在千行以内，代价可接受，结果和命令行 diff 的分组一致。
  const table: number[][] = Array.from({ length: oldLines.length + 1 }, () => new Array<number>(newLines.length + 1).fill(0));
  for (let i = oldLines.length - 1; i >= 0; i -= 1) {
    for (let j = newLines.length - 1; j >= 0; j -= 1) {
      table[i][j] = oldLines[i] === newLines[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }

  const lines: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < oldLines.length && j < newLines.length) {
    if (oldLines[i] === newLines[j]) {
      lines.push({ kind: "same", text: oldLines[i], oldNumber: i + 1, newNumber: j + 1 });
      i += 1;
      j += 1;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      lines.push({ kind: "remove", text: oldLines[i], oldNumber: i + 1 });
      i += 1;
    } else {
      lines.push({ kind: "add", text: newLines[j], newNumber: j + 1 });
      j += 1;
    }
  }
  while (i < oldLines.length) {
    lines.push({ kind: "remove", text: oldLines[i], oldNumber: i + 1 });
    i += 1;
  }
  while (j < newLines.length) {
    lines.push({ kind: "add", text: newLines[j], newNumber: j + 1 });
    j += 1;
  }
  return lines;
}
