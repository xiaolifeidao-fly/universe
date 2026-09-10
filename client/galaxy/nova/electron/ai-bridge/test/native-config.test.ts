import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { parseConfig } from '../src/config/index.js';
import { AppConfigSchema } from '../src/config/schema.js';

// 配置的权威解析在 Rust 里，TS 只把结果重新断言成类型。这组用例把两边钉在一起：
// 任何一边的默认值、校验或字段名漂移，都会在这里立刻暴露，而不是等到运行时行为分叉。
const requireNative = createRequire(import.meta.url);
const native = requireNative('@galaxy/ai-bridge-native') as { parseConfigJson(text: string): string };

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function bothParse(text: string) {
  const fromRust = JSON.parse(native.parseConfigJson(text));
  const fromTs = parseConfig(yaml.load(text));
  return { fromRust, fromTs };
}

test('原生解析与 zod 对 config.example.yaml 得到同一份配置', async () => {
  const text = await readFile(join(root, 'config.example.yaml'), 'utf8');
  const { fromRust, fromTs } = bothParse(text);
  assert.deepEqual(fromRust, fromTs);
  // 补齐默认值后的 JSON 必须能原样回到 zod：可选字段不能变成 null。
  assert.deepEqual(AppConfigSchema.parse(fromRust), fromTs);
});

test('原生解析与 zod 对完整的 pool 配置得到同一份配置', () => {
  const text = `
mode: pool
log: { level: warn }
concurrency: { global: 8 }
providers:
  anthropic:
    type: relay
    authMode: claude_oauth
    models: [claude-sonnet-4-5]
  local:
    type: codex_local
    codex: { sandboxMode: workspace-write, approvalPolicy: never, extraConfig: { anything: 1 } }
relay: { enabled: false }
auth:
  tokens:
    - { alias: mate, token: "plain-token-12345", scopes: [relay:anthropic], concurrency: 3 }
pool:
  hubURL: https://hub.example.com
  contract: 2
  contributions:
    - id: claude-main
      upstream: anthropic
      models: { allow: ["claude-sonnet-*"] }
      quota:
        - { unit: llm.output_tokens, limit: 2000000, window: day, resetAt: "00:00+08:00" }
      schedule: [{ window: "22:00-08:00", tz: Asia/Shanghai }]
    - id: planner
      kind: delivery.task
      provider: delivery-task-planner
      exec: { command: /usr/local/bin/worker, args: ["--stdio"], timeoutMs: 3600000 }
      quota: [{ unit: time.seconds, limit: 21600 }]
`;
  const { fromRust, fromTs } = bothParse(text);
  assert.deepEqual(fromRust, fromTs);
  assert.deepEqual(AppConfigSchema.parse(fromRust), fromTs);
});

test('${ENV} 展开两边一致，缺失的变量都替换成空串', () => {
  const text = `
providers:
  gw: { type: relay, authMode: api_key, apiKey: "\${AI_BRIDGE_TEST_KEY}", baseURL: "https://gw.example.com/v1" }
relay: { openai: gw }
`;
  process.env.AI_BRIDGE_TEST_KEY = 'from-env';
  try {
    const { fromRust, fromTs } = bothParse(text);
    assert.equal(fromRust.providers.gw.apiKey, 'from-env');
    assert.deepEqual(fromRust, fromTs);
  } finally { delete process.env.AI_BRIDGE_TEST_KEY; }
  const { fromRust: missing } = bothParse(text);
  assert.equal(missing.providers.gw.apiKey, '');
});

test('两边拒绝同一批坏配置', () => {
  const cases: Array<[string, RegExp]> = [
    ['providers: {}\nrelay: { enabled: true }\n', /都没配/],
    ['providers:\n  a: { type: claude_code_local }\nrelay: { anthropic: a }\n', /必须是 relay/],
    ['relay: { anthropic: nope }\n', /不存在的 provider/],
    ['providers:\n  gw: { type: relay, authMode: api_key }\nrelay: { openai: gw }\n', /必须配置 baseURL/],
    ['relay: { enabled: false }\nauth:\n  tokens:\n    - { alias: a }\n', /Invalid config/],
    ['relay: { enabled: false }\nauth:\n  tokens:\n    - { alias: a, token: "12345678" }\n    - { alias: a, token: "87654321" }\n', /重复/],
    ['mode: pool\nrelay: { enabled: false }\n', /缺少 pool 配置段/],
  ];
  for (const [text, expected] of cases) {
    assert.throws(() => native.parseConfigJson(text), expected, `原生侧应当拒绝：${text}`);
    assert.throws(() => parseConfig(yaml.load(text)), expected, `zod 侧应当拒绝：${text}`);
  }
});
