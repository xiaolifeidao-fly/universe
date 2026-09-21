"use client";

import { Select } from "antd";
import type { DefaultOptionType } from "antd/es/select";
import { useMemo, useState } from "react";

/**
 * 计量单位（unit）与能力（kind）在界面上的人话名。
 *
 * 这两类 id 是**注册制**的：额度引擎只认「单位 → 上限」这张表，接一种新 kind
 * 就会自带一批新单位。所以这里不做白名单，只做翻译 —— 查不到译名的原样显示 id，
 * 新接一个上游只是还没来得及补文案，不该在下拉里变成空白。
 *
 * key 的形状（unit.<id> / kind.<id>）和文案都与 orbit / portal 的 unitLabel()
 * 对齐：同一个单位在运营后台叫一个名、在使用者账单上叫另一个名，对账时没人对得上。
 */

type Translate = (key: string) => string;

export function unitLabel(unit: string, t: Translate): string {
  const key = `unit.${unit}`;
  const label = t(key);
  return label === key ? unit : label;
}

export function kindLabel(kind: string, t: Translate): string {
  const key = `kind.${kind}`;
  const label = t(key);
  return label === key ? kind : label;
}

/**
 * 推理强度的中文名。
 *
 * 认不出来的原样显示 —— 库里可能躺着历史上填错的档，或者上游加了新档而我们还没跟上。
 * 显示成空白或「未知」都会让运营以为这行坏了，而它其实照常在计价。
 */
export function effortLabel(effort: string, t: Translate): string {
  const key = `galaxy.price.effort.${effort}`;
  const label = t(key);
  return label === key ? effort : label;
}

/**
 * 下拉候选：中文名在前，原始 id 灰着跟在后面。
 *
 * id 必须一直露着 —— 选中之后回填到输入框、以及最终存进库里的都是它。只剩中文名
 * 的话，运营就没法把这一页选的东西和价目表、账单、节点上报里的 unit 对上号。
 * 没有译名的 id 只显示一次，不要「llm.foo  llm.foo」。
 */
export function labeledOptions(values: string[], label: (value: string) => string): DefaultOptionType[] {
  return values.map((value) => {
    const text = label(value);
    const translated = text !== value;
    return {
      value,
      // title 有两个用处：鼠标停上去的原生提示，以及 optionMatches() 的匹配面。
      title: translated ? `${text} ${value}` : value,
      label: translated ? (
        <span style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12 }}>
          <span>{text}</span>
          <span className="manager-mono" style={{ fontSize: 12, color: "var(--manager-text-faint)" }}>
            {value}
          </span>
        </span>
      ) : (
        <span className="manager-mono">{value}</span>
      ),
    };
  });
}

/**
 * 中文名和 id 都能搜：运营记得住「输出」，也记得住 output_tokens。
 * 只按 value 过滤的话，打中文会把整张候选列表筛空。
 */
export function optionMatches(input: string, option?: DefaultOptionType): boolean {
  const needle = input.trim().toLowerCase();
  if (!needle) return true;
  return `${option?.value ?? ""} ${option?.title ?? ""}`.toLowerCase().includes(needle);
}

/**
 * 表格里的一格：中文名在上，原始 id 用等宽小字跟在下面。
 *
 * 只显示 id 的话，这张表只有背得出 `llm.cache_write_5m_tokens` 的人看得懂；
 * 只显示中文名的话，运营就没法把这一行和账单、节点上报里的 unit 对上号 ——
 * 而这两件事（看懂、对账）在定价这一页是同一个人同一次操作要做的。
 * 没有译名的 id 就只出现一次，不要「llm.foo / llm.foo」。
 */
export function CodeText({ value, label }: { value: string; label: string }) {
  if (label === value) {
    return <span className="manager-mono">{value}</span>;
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", lineHeight: 1.35 }}>
      <span>{label}</span>
      <span className="manager-mono" style={{ fontSize: 12, color: "var(--manager-text-faint)" }}>
        {value}
      </span>
    </div>
  );
}

/**
 * 手填的 id 长什么样：字母数字加点、下划线、连字符，`llm.cache_write_5m_tokens`、`video.edit.render`。
 *
 * 拿它把「在搜中文」和「在敲一个新 id」分开。不分的话，搜索框里打「对话」会顺手
 * 多出一条叫「对话」的候选 —— 点中它，库里就多了一个中文的 kind，
 * 而扣费按 id 精确匹配，这一行价从此对不上任何一笔用量。
 */
const ID_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * 选中文名、存 id 的下拉。
 *
 * 收起来之后框里只剩中文名 —— 它是给人读的；id 在下拉候选里、在表格里都还露着，
 * 而**提交出去的始终是 id**：库里的 kind / unit 一个字都不会变。
 *
 * 用 Select 而不是 AutoComplete，是因为 AutoComplete 的输入框里装的就是最终值，
 * 显示中文就等于存中文。但**手填不能丢** —— 单位和能力都是注册制的，新接一种业务
 * 自带自己的一批 id，候选表来自「已有的价 + 真跑过的用量」，天然追不上还没跑过的新 id。
 * 所以打进去的 id 只要不在候选里，就自己成为一条候选，回车即选中。
 */
export function CodeSelect({
  value,
  onChange,
  candidates,
  label,
  placeholder,
}: {
  /** 由 Form.Item 注入。 */
  value?: string;
  onChange?: (value: string) => void;
  candidates: string[];
  label: (value: string) => string;
  placeholder?: string;
}) {
  const [typed, setTyped] = useState("");

  const options = useMemo(() => {
    const ids = [...candidates];
    const seen = new Set(ids);
    // 当前选中的 id 不在候选里（改一行老价目、或者上次手填的）也要补一条：
    // 没有对应 option，下拉里就找不到自己选的那一项。
    if (value && !seen.has(value)) {
      ids.push(value);
      seen.add(value);
    }
    const known = labeledOptions(ids, label);
    const custom = typed.trim();
    // 只在「这串东西像个 id、而且现有候选一个都搜不到」时才给手填那一条。
    // 已经搜得到就别再造 —— 多出来的那条长得和搜索词一样，点错了存下去的是半截 id。
    if (!custom || seen.has(custom) || !ID_SHAPE.test(custom)) return known;
    if (known.some((option) => optionMatches(custom, option))) return known;
    return [...known, ...labeledOptions([custom], label)];
  }, [candidates, label, typed, value]);

  return (
    <Select
      showSearch
      // 空串是「没填」，不是一个叫空串的 id —— 传空串进去 placeholder 就不显示了。
      value={value || undefined}
      onChange={(next: string | undefined) => {
        setTyped("");
        onChange?.(next ?? "");
      }}
      onSearch={setTyped}
      labelRender={({ value: picked }) => {
        const id = String(picked ?? "");
        const text = label(id);
        return text === id ? <span className="manager-mono">{id}</span> : text;
      }}
      filterOption={optionMatches}
      options={options}
      placeholder={placeholder}
    />
  );
}
