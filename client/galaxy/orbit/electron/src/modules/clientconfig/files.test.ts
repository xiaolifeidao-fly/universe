import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyClaudeSettings,
  applyCodexConfig,
  claudeBaseUrl,
  codexBaseUrl,
  normalizeBaseUrl,
  normalizeSecret,
  readClaudeSettings,
  readCodexConfig,
} from './files';

const SECRET = 'sk-galaxy-ABCDEFGHJKMNPQRSTVWXYZ0123456';
const BASE = 'https://hub.example.com/v1';

test('两个客户端各自要的 base_url', () => {
  assert.equal(claudeBaseUrl('https://hub.example.com/v1/'), 'https://hub.example.com');
  assert.equal(claudeBaseUrl('http://47.110.3.214:10004/v1'), 'http://47.110.3.214:10004');
  assert.equal(claudeBaseUrl('https://example.com/galaxy/v1'), 'https://example.com/galaxy');
  assert.equal(codexBaseUrl('https://hub.example.com'), 'https://hub.example.com/v1');
  assert.equal(codexBaseUrl('https://hub.example.com/v1/'), 'https://hub.example.com/v1');
});

test('地址和密钥只认干净的形状', () => {
  assert.throws(() => normalizeBaseUrl('javascript:alert(1)'), /http\/https/);
  assert.throws(() => normalizeBaseUrl('file:///etc/passwd'), /http\/https/);
  assert.throws(() => normalizeBaseUrl('https://user:pass@hub.example.com/v1'), /账号/);
  assert.throws(() => normalizeBaseUrl('https://hub.example.com/v1?x=1'), /查询参数/);
  assert.throws(() => normalizeBaseUrl('not a url'), /URL/);
  assert.throws(() => normalizeSecret('sk-ant-123'), /Galaxy/);
  assert.throws(() => normalizeSecret('sk-galaxy-abc"\ninjected = true'), /Galaxy/);
  assert.equal(normalizeSecret(`  ${SECRET} `), SECRET);
});

test('Claude Code：没有配置文件时从零写一份', () => {
  const written = JSON.parse(applyClaudeSettings(null, BASE, SECRET));
  assert.deepEqual(written, { env: { ANTHROPIC_BASE_URL: 'https://hub.example.com', ANTHROPIC_AUTH_TOKEN: SECRET } });
});

test('Claude Code：只动 env 里那三个键，其余原样留着', () => {
  const raw = JSON.stringify({
    model: 'opus',
    permissions: { allow: ['Bash(ls)'] },
    env: { ANTHROPIC_API_KEY: 'sk-ant-real', DISABLE_TELEMETRY: '1', ANTHROPIC_BASE_URL: 'https://old.example.com' },
  });
  const written = JSON.parse(applyClaudeSettings(raw, BASE, SECRET));
  assert.equal(written.model, 'opus');
  assert.deepEqual(written.permissions, { allow: ['Bash(ls)'] });
  assert.deepEqual(written.env, {
    DISABLE_TELEMETRY: '1',
    ANTHROPIC_BASE_URL: 'https://hub.example.com',
    ANTHROPIC_AUTH_TOKEN: SECRET,
  });
  assert.deepEqual(readClaudeSettings(JSON.stringify(written)), { baseUrl: 'https://hub.example.com', secret: SECRET });
});

test('Claude Code：认不清的文件不写', () => {
  assert.throws(() => applyClaudeSettings('{ "model": ', BASE, SECRET), /不是合法的 JSON/);
  assert.throws(() => applyClaudeSettings('[]', BASE, SECRET), /不是一个对象/);
  assert.throws(() => applyClaudeSettings('{"env": "x"}', BASE, SECRET), /env 不是一个对象/);
  assert.deepEqual(readClaudeSettings('{ broken'), { baseUrl: '', secret: '' });
});

test('Codex：没有配置文件时从零写一份', () => {
  const written = applyCodexConfig(null, BASE, SECRET);
  assert.equal(written, [
    'model_provider = "galaxy"',
    '',
    '[model_providers.galaxy]',
    'name = "Galaxy"',
    'base_url = "https://hub.example.com/v1"',
    'wire_api = "responses"',
    `experimental_bearer_token = "${SECRET}"`,
    '',
  ].join('\n'));
  assert.deepEqual(readCodexConfig(written), { provider: 'galaxy', baseUrl: 'https://hub.example.com/v1', secret: SECRET });
});

test('Codex：改顶层 model_provider、换掉旧的 galaxy 段，别的表和注释都留着', () => {
  const raw = [
    '# 我自己的注释',
    'model = "gpt-5.6-terra"',
    'model_provider = "openai"',
    'notify = [',
    '  "say",',
    '  "done",',
    ']',
    '',
    '[model_providers.galaxy]',
    'name = "Galaxy"',
    'base_url = "https://old.example.com/v1"',
    'experimental_bearer_token = "sk-galaxy-OLDOLDOLDOLDOLDOLD"',
    '',
    '[model_providers.galaxy.http_headers]',
    'X-Old = "1"',
    '',
    '[model_providers.other]',
    'name = "Other"',
    '',
    '[profiles.work]',
    'model_provider = "other"',
  ].join('\n');
  const written = applyCodexConfig(raw, BASE, SECRET);
  const lines = written.split('\n');
  assert.equal(lines[0], '# 我自己的注释');
  assert.equal(lines.filter((line) => line.startsWith('model_provider =')).length, 2, '顶层一行，profiles.work 里那行不动');
  assert.ok(lines.includes('model_provider = "galaxy"'));
  assert.ok(lines.includes('model_provider = "other"'), 'profile 里的 model_provider 不该被改');
  assert.ok(lines.includes('[model_providers.other]'));
  assert.ok(lines.includes('[profiles.work]'));
  assert.ok(!written.includes('old.example.com'));
  assert.ok(!written.includes('X-Old'));
  assert.equal(written.split('[model_providers.galaxy]').length - 1, 1);
  assert.equal(applyCodexConfig(written, BASE, SECRET), written, '再写一次结果不变');
  assert.deepEqual(readCodexConfig(written), { provider: 'galaxy', baseUrl: 'https://hub.example.com/v1', secret: SECRET });
});

test('Codex：没有 model_provider 时插在第一个表头之前', () => {
  const written = applyCodexConfig('model = "o3"\n\n[tui]\nnotifications = true\n', BASE, SECRET);
  assert.ok(written.startsWith('model = "o3"\nmodel_provider = "galaxy"\n\n[tui]\nnotifications = true\n\n[model_providers.galaxy]\n'));
});

test('Codex：多行字符串里长得像表头的行不算表头', () => {
  const raw = [
    'developer_instructions = """',
    '[model_providers.galaxy]',
    'keep me',
    '"""',
    '',
    '[tui]',
    'notifications = true',
  ].join('\n');
  const written = applyCodexConfig(raw, BASE, SECRET);
  assert.ok(written.includes('[model_providers.galaxy]\nkeep me\n"""'), '字符串内容原样保留');
  assert.ok(written.indexOf('model_provider = "galaxy"') < written.indexOf('[tui]'));
});

test('Codex：注释和单行字符串里的三引号不算多行字符串的开头', () => {
  const raw = [
    '# wrap long prompts in """ blocks',
    'model = "o3"',
    "notify = [\"say\", \"'''\"]",
    'model_provider = "openai"',
    '',
    '[model_providers.galaxy]',
    'base_url = "https://old.example.com/v1"',
    '',
    '[tui]',
    'notifications = true',
  ].join('\n');
  const once = applyCodexConfig(raw, BASE, SECRET);
  const twice = applyCodexConfig(once, BASE, SECRET);
  assert.equal(twice, once, '再点一次「使用」不该多出第二段 galaxy');
  assert.equal(once.split('[model_providers.galaxy]').length - 1, 1);
  assert.ok(!once.includes('old.example.com'));
  assert.ok(once.indexOf('model_provider = "galaxy"') < once.indexOf('[tui]'), 'model_provider 要留在顶层');
  assert.deepEqual(readCodexConfig(once), { provider: 'galaxy', baseUrl: 'https://hub.example.com/v1', secret: SECRET });
});

test('Codex：多行字符串结尾多带引号、带转义也能正确收尾', () => {
  const raw = [
    'developer_instructions = """',
    'say \\"""hi\\"""',
    'end with quotes""""',
    '[tui]',
    'notifications = true',
  ].join('\n');
  const written = applyCodexConfig(raw, BASE, SECRET);
  assert.ok(written.indexOf('model_provider = "galaxy"') < written.indexOf('[tui]'));
  assert.equal(applyCodexConfig(written, BASE, SECRET), written);
});

test('Codex：顶层用内联表写 model_providers 时拒绝', () => {
  assert.throws(() => applyCodexConfig('model_providers = { galaxy = { name = "x" } }\n', BASE, SECRET), /内联表/);
  assert.throws(() => applyCodexConfig('model_providers.galaxy.name = "x"\n', BASE, SECRET), /内联表/);
});

/**
 * 密钥锁了模型，配置里就要写死那个模型。
 *
 * 额度按模型卖之后，一份 Opus 的额度签出来的密钥只允许调 Opus。不写这一项，
 * 客户端按它自己的默认模型发请求 —— 接上去之后每一句都被拒，而人刚买的就是这个模型。
 */
test('锁了模型就连模型一起写进 Claude 的 settings.json', () => {
  const written = JSON.parse(applyClaudeSettings(null, BASE, SECRET, 'claude-opus-5')) as {
    env: Record<string, string>;
  };
  assert.equal(written.env.ANTHROPIC_MODEL, 'claude-opus-5');
  assert.equal(written.env.ANTHROPIC_BASE_URL, 'https://hub.example.com');
});

// 反过来同样要紧：没锁模型的密钥不能被悄悄钉在某一个模型上 ——
// 那会把一把什么都能调的密钥限制住，而用户从界面上看不出是谁干的。
test('没锁模型就一个字都不写', () => {
  for (const model of [undefined, '', '   ']) {
    const written = JSON.parse(applyClaudeSettings(null, BASE, SECRET, model)) as { env: Record<string, string> };
    assert.equal('ANTHROPIC_MODEL' in written.env, false, `model=${JSON.stringify(model)} 时不该写这一项`);
  }
});

// 用户自己写过 ANTHROPIC_MODEL 的，接进来要换成这把密钥能调的那个，而不是留着原来那个。
test('原来写过别的模型就改掉它', () => {
  const before = JSON.stringify({ env: { ANTHROPIC_MODEL: 'claude-sonnet-5', FOO: 'bar' } });
  const written = JSON.parse(applyClaudeSettings(before, BASE, SECRET, 'claude-opus-5')) as {
    env: Record<string, string>;
  };
  assert.equal(written.env.ANTHROPIC_MODEL, 'claude-opus-5');
  assert.equal(written.env.FOO, 'bar', '别人的设置不该被动');
});

test('Codex 的顶层 model 同理', () => {
  const written = applyCodexConfig(null, BASE, SECRET, 'gpt-5.6-terra');
  assert.match(written, /^model = "gpt-5\.6-terra"$/m);
  assert.match(written, /^model_provider = "galaxy"$/m);
  // 两个顶层 key 都要落在第一个表头**之前**：插到表里面去，TOML 里那是另一件事。
  const lines = written.split('\n');
  const firstHeader = lines.findIndex((line) => line.startsWith('['));
  assert.ok(lines.findIndex((line) => line.startsWith('model =')) < firstHeader);
  assert.ok(lines.findIndex((line) => line.startsWith('model_provider =')) < firstHeader);
});

test('Codex 原来写过 model 就改那一行，不新增一行', () => {
  const before = 'model = "gpt-4"\napproval_policy = "never"\n';
  const written = applyCodexConfig(before, BASE, SECRET, 'gpt-5.6-terra');
  assert.equal(written.split('\n').filter((line) => /^model\s*=/.test(line)).length, 1);
  assert.match(written, /^model = "gpt-5\.6-terra"$/m);
  assert.match(written, /^approval_policy = "never"$/m);
});

test('Codex 没锁模型时不写 model', () => {
  const written = applyCodexConfig(null, BASE, SECRET);
  assert.equal(/^model\s*=/m.test(written), false);
  assert.match(written, /^model_provider = "galaxy"$/m);
});
