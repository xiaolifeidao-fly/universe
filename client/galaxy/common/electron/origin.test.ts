import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveOrigin } from './origin';

const base = { product: 'nova' as const, packaged: true, resourcesPath: '/app/resources', env: {} };
const frozen = (origin: string) => (file: string) =>
  file.endsWith('desktop.json') ? JSON.stringify({ APP_ORIGIN: origin }) : null;

test('打包后读安装包里冻结的地址', () => {
  assert.equal(
    resolveOrigin({ ...base, readFile: frozen('https://nova.example.com/') }),
    'https://nova.example.com',
  );
});

test('启动环境变量覆盖冻结值，单端覆盖优先于共用覆盖', () => {
  assert.equal(
    resolveOrigin({
      ...base,
      env: { GALAXY_APP_ORIGIN: 'https://shared.example.com' },
      readFile: frozen('https://frozen.example.com'),
    }),
    'https://shared.example.com',
  );
  assert.equal(
    resolveOrigin({
      ...base,
      env: { GALAXY_APP_ORIGIN: 'https://shared.example.com', GALAXY_NOVA_APP_ORIGIN: 'https://nova.example.com' },
      readFile: frozen('https://frozen.example.com'),
    }),
    'https://nova.example.com',
  );
});

// 这四条是安全边界，不是格式偏好：页面能调用本机 bridge，
// 放行明文 http 等于把这个能力交给任何一个能改包的人。
test('非本机地址必须是 https', () => {
  assert.throws(
    () => resolveOrigin({ ...base, env: { GALAXY_APP_ORIGIN: 'http://nova.example.com' } }),
    /必须是 https/,
  );
});

test('本机地址允许 http，方便对着本地 next dev 调壳', () => {
  for (const host of ['127.0.0.1:17898', 'localhost:17898']) {
    assert.equal(resolveOrigin({ ...base, env: { GALAXY_APP_ORIGIN: `http://${host}` } }), `http://${host}`);
  }
});

test('非 http/https 一律拒绝', () => {
  assert.throws(
    () => resolveOrigin({ ...base, env: { GALAXY_APP_ORIGIN: 'file:///tmp/evil.html' } }),
    /只支持 http\/https/,
  );
});

test('打包后没配地址直接报错，不回落到本机端口', () => {
  assert.throws(() => resolveOrigin({ ...base, readFile: () => null }), /没有配置控制台地址/);
});

test('未打包回落到本机 next dev 的端口', () => {
  assert.equal(resolveOrigin({ ...base, packaged: false, readFile: () => null }), 'http://127.0.0.1:17898');
  assert.equal(
    resolveOrigin({ ...base, product: 'orbit', packaged: false, readFile: () => null }),
    'http://127.0.0.1:17899',
  );
});

test('desktop.json 坏了当作没配', () => {
  assert.throws(() => resolveOrigin({ ...base, readFile: () => '{ not json' }), /没有配置控制台地址/);
});
