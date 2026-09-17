import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveOrigin } from './origin';
import { defaultOrigin, products } from '../index';

const base = { product: 'nova' as const, packaged: true, resourcesPath: '/app/resources', env: {} };
const frozen = (origin: string) => (file: string) =>
  file.endsWith('desktop.json') ? JSON.stringify({ APP_ORIGIN: origin }) : null;

// 这一条钉的是「两个端各自加载哪个地址」这个需求本身：壳打开的是
// defaultOrigin + basePath（main.ts 里那个 base）。域名或 basePath 被人单方面
// 改一半，这里就会红 —— 而线上的症状是控制台一片 404，从那儿回溯要绕很远。
test('两个端默认加载的完整地址', () => {
  assert.equal(defaultOrigin + products.nova.basePath, 'https://www.galaxy.rodeo/nova');
  assert.equal(defaultOrigin + products.orbit.basePath, 'https://www.galaxy.rodeo/orbit');
});

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

test('没配地址就用编译进壳的正式部署地址，打包与否都一样', () => {
  assert.equal(resolveOrigin({ ...base, readFile: () => null }), defaultOrigin);
  assert.equal(resolveOrigin({ ...base, packaged: false, readFile: () => null }), defaultOrigin);
  assert.equal(resolveOrigin({ ...base, product: 'orbit', readFile: () => null }), defaultOrigin);
});

// 未打包时不碰 desktop.json：那是安装包里的文件，开发树里同名的那份是
// 上一次 build 的残留，拿它当配置会让「改了环境变量却没生效」变成常态。
test('未打包不读开发树里的 desktop.json', () => {
  assert.equal(
    resolveOrigin({ ...base, packaged: false, readFile: frozen('https://stale.example.com') }),
    defaultOrigin,
  );
});

// 开发态连本机 next dev 靠 scripts/desktop.cjs 注入这个变量，不是靠
// app.isPackaged —— 那条暗门会让 `start`（壳在本机、界面在远端）也悄悄
// 指到一个没人监听的端口上。
test('开发态的本机地址来自环境变量', () => {
  assert.equal(
    resolveOrigin({ ...base, packaged: false, env: { GALAXY_NOVA_APP_ORIGIN: 'http://127.0.0.1:17898' } }),
    'http://127.0.0.1:17898',
  );
});

// 运维把变量导成空值（`export GALAXY_APP_ORIGIN=`）比不导出常见得多。
test('空串与空白当作没配，往下一级落', () => {
  assert.equal(
    resolveOrigin({ ...base, env: { GALAXY_NOVA_APP_ORIGIN: '  ', GALAXY_APP_ORIGIN: '' }, readFile: frozen('https://frozen.example.com') }),
    'https://frozen.example.com',
  );
  assert.equal(resolveOrigin({ ...base, env: { GALAXY_APP_ORIGIN: '' }, readFile: frozen('   ') }), defaultOrigin);
});

test('desktop.json 坏了当作没配', () => {
  assert.equal(resolveOrigin({ ...base, readFile: () => '{ not json' }), defaultOrigin);
});
