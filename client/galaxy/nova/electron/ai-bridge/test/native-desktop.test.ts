import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { DesktopBridgeService } from '../src/desktop/service.js';

// 桌面 IPC 的形状由 @galaxy/common 的 BridgeApi 定义，实现在 Rust 里。
// 这组用例守的是那条边界：少一个必填字段、把 undefined 发成 null，
// 渲染层都会安静地显示错，而不会有任何一侧报错。

async function service(t: TestContext, config: string) {
  const dir = await mkdtemp(join(tmpdir(), 'nova-shape-'));
  const configPath = join(dir, 'config.yaml');
  await writeFile(configPath, config.replaceAll('<dir>', dir));
  const instance = new DesktopBridgeService(configPath);
  await instance.initialize();
  // 先停服务再删目录：钩子按注册顺序跑，反了就会在配置已经没了之后才去停。
  t.after(() => instance.stop());
  t.after(() => rm(dir, { recursive: true, force: true }));
  return instance;
}

const RELAY_ONLY = `
mode: relay
server: { host: 127.0.0.1, port: 0 }
providers:
  gw: { type: relay, authMode: api_key, apiKey: k, baseURL: "https://gw.example.com/v1" }
relay: { enabled: true, openai: gw }
auth: { tokenFile: <dir>/tokens.json }
`;

test('getState 满足 BridgeState 契约：capabilities 的 detail 一定有', async (t) => {
  const state = await (await service(t, RELAY_ONLY)).getState();
  for (const key of ['configPath', 'hubURL', 'displayName', 'resources', 'capabilities', 'paired']) {
    assert.ok(key in state, `BridgeState 少了 ${key}`);
  }
  assert.equal(typeof state.displayName, 'string');
  assert.ok(state.displayName.length > 0);
  assert.equal(state.paired, false);
  // 没配对时 nodeId 是 undefined 而不是 null —— TS 侧一直是省略这个键。
  assert.equal('nodeId' in state, false);
  for (const key of ['platform', 'cpus', 'totalMemMB', 'freeMemMB']) {
    assert.ok(state.resources[key] !== undefined, `resources 少了 ${key}`);
  }
  assert.ok(Array.isArray(state.capabilities));
  for (const capability of state.capabilities) {
    assert.equal(typeof capability.kind, 'string');
    assert.equal(typeof capability.provider, 'string');
    assert.equal(typeof capability.available, 'boolean');
    // detail 在契约里是必填：控制台直接把它显示给主人看。
    assert.equal(typeof capability.detail, 'string');
    assert.ok(capability.detail.length > 0);
  }
});

test('getStatus 满足 BridgeRuntimeStatus 契约，且状态随启停迁移', async (t) => {
  const instance = await service(t, RELAY_ONLY);
  const stopped = await instance.getStatus();
  assert.equal(stopped.state, 'stopped');
  assert.equal(stopped.mode, 'relay');
  assert.equal(typeof stopped.hubURL, 'string');
  assert.equal(typeof stopped.configPath, 'string');
  assert.equal('error' in stopped, false, '没出错时不该有 error 字段');
  assert.equal('nodeId' in stopped, false);

  assert.equal((await instance.start()).state, 'running');
  const running = await instance.getStatus();
  assert.equal(running.state, 'running');
  // relay 在跑时才带队列计数，给控制台显示闸门水位。
  assert.ok(running.queue?.providers?.gw, '跑起来之后要能看到 provider 队列');
  assert.equal((await instance.stop()).state, 'stopped');
});

test('ping 只在问了平台地址时才回 hubMatches', async (t) => {
  const instance = await service(t, RELAY_ONLY);
  const bare = await instance.ping({});
  assert.equal(bare.running, true);
  assert.equal(bare.resident, true);
  assert.equal(bare.paired, false);
  assert.equal('hubMatches' in bare, false, '没配平台地址时无从比对');
  await assert.rejects(instance.ping({ port: 39217 }), /unrecognized_keys/);
});

test('getTools 三项齐全，拿不到版本时绝不催人升级', async (t) => {
  const tools = await (await service(t, RELAY_ONLY)).getTools();
  assert.deepEqual(tools.map((t: { name: string }) => t.name), ['ai-bridge', 'claude', 'codex']);
  for (const tool of tools) {
    assert.equal(typeof tool.current, 'string');
    assert.equal(typeof tool.latest, 'string');
    assert.equal(typeof tool.installed, 'boolean');
    assert.equal(tool.installed, tool.current !== '');
    if (!tool.current || !tool.latest) {
      assert.equal(tool.upgradable, false, `${tool.name}: 版本拿不全时不该显示可升级`);
    }
  }
  // ai-bridge 随 Nova 更新，没有独立升级通道。
  assert.equal(tools[0].upgradable, false);
});

test('mode=pool 但没配对时，启动要报清楚而不是静默停住', async (t) => {
  const instance = await service(t, `
mode: pool
relay: { enabled: false }
providers: {}
auth: { tokenFile: <dir>/tokens.json }
pool: { hubURL: "https://hub.example.com", tokenFile: <dir>/node.json }
`);
  await assert.rejects(instance.start(), /配对/);
  const status = await instance.getStatus();
  assert.equal(status.state, 'error');
  assert.match(status.error, /配对/);
});

test('配置文件被删掉之后仍然停得下来', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'nova-shape-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const configPath = join(dir, 'config.yaml');
  await writeFile(configPath, RELAY_ONLY.replaceAll('<dir>', dir));
  const instance = new DesktopBridgeService(configPath);
  await instance.initialize();
  assert.equal((await instance.start()).state, 'running');

  // 主人手抖删了配置、或者编辑到一半存成了坏 YAML —— 正是最需要它停下来的时候。
  await rm(configPath);
  const stopped = await instance.stop();
  assert.equal(stopped.state, 'stopped');
  // 查询仍然照实报错：停机要宽容，但不该把「配置没了」也一起吞掉。
  await assert.rejects(instance.getStatus(), /Config file not found/);
});
