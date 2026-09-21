import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveUpdateFeed } from './feed';
import { defaultUpdateFeed } from '../../index';

const base = { product: 'nova' as const, env: {} };
const fallback = defaultUpdateFeed.trim().replace(/\/+$/, '');

test('一级都没配就是不检查更新，而不是报错', () => {
  const feed = resolveUpdateFeed(base);
  // 兜底默认是空的。哪天有人填了，这条断言要跟着走 —— 它钉的是「没有地址时不报错」，
  // 不是「一定没有地址」。
  assert.equal(feed.url, fallback ? `${fallback}/nova` : '');
  if (!fallback) assert.match(feed.reason, /没有配置更新地址/);
});

test('编译进壳的兜底排在最后：部署那一侧给了就用部署给的', () => {
  assert.equal(
    resolveUpdateFeed({ ...base, remote: 'https://remote.example.com/nova' }).url,
    'https://remote.example.com/nova',
  );
  assert.equal(
    resolveUpdateFeed({ ...base, env: { GALAXY_UPDATE_FEED: 'https://shared.example.com/nova' } }).url,
    'https://shared.example.com/nova',
  );
});

test('兜底是两端共用的前缀，端那一段由壳自己补', () => {
  if (!fallback) return; // 默认空 = 没有兜底，这条无从验起
  assert.equal(resolveUpdateFeed(base).url, `${fallback}/nova`);
  assert.equal(resolveUpdateFeed({ ...base, product: 'orbit' }).url, `${fallback}/orbit`);
  // 兜底同样要过那几条校验：填了个明文 http 或带查询串的值，只会静默关掉更新。
  assert.equal(resolveUpdateFeed(base).reason, '');
});

test('控制台带回来的地址是常规来源，末尾的斜杠去掉', () => {
  assert.equal(
    resolveUpdateFeed({ ...base, remote: 'https://bucket.oss-cn-hangzhou.aliyuncs.com/galaxy/desktop/nova/' }).url,
    'https://bucket.oss-cn-hangzhou.aliyuncs.com/galaxy/desktop/nova',
  );
});

test('环境变量覆盖控制台给的地址，单端覆盖优先于共用覆盖', () => {
  assert.equal(
    resolveUpdateFeed({
      ...base,
      env: { GALAXY_UPDATE_FEED: 'https://shared.example.com/desktop/nova' },
      remote: 'https://remote.example.com/desktop/nova',
    }).url,
    'https://shared.example.com/desktop/nova',
  );
  assert.equal(
    resolveUpdateFeed({
      ...base,
      env: {
        GALAXY_UPDATE_FEED: 'https://shared.example.com/desktop/nova',
        GALAXY_NOVA_UPDATE_FEED: 'https://nova.example.com/desktop/nova',
      },
      remote: 'https://remote.example.com/desktop/nova',
    }).url,
    'https://nova.example.com/desktop/nova',
  );
});

test('两个端各认各的单端覆盖', () => {
  const env = { GALAXY_ORBIT_UPDATE_FEED: 'https://orbit.example.com/desktop/orbit' };
  // 另一个端不受影响：它要么落到兜底，要么（兜底为空时）就是不检查更新。
  assert.equal(resolveUpdateFeed({ product: 'nova', env }).url, fallback ? `${fallback}/nova` : '');
  assert.equal(resolveUpdateFeed({ product: 'orbit', env }).url, 'https://orbit.example.com/desktop/orbit');
});

test('导出成空串等于没配，往下一级落', () => {
  assert.equal(
    resolveUpdateFeed({
      ...base,
      env: { GALAXY_NOVA_UPDATE_FEED: '   ', GALAXY_UPDATE_FEED: '' },
      remote: 'https://remote.example.com/desktop/nova',
    }).url,
    'https://remote.example.com/desktop/nova',
  );
});

// 下面三条钉的是「清单指向的是一个会被装到用户机器上的文件」这件事。
test('非本机的明文 http 不收', () => {
  const feed = resolveUpdateFeed({ ...base, remote: 'http://bucket.example.com/desktop/nova' });
  assert.equal(feed.url, '');
  assert.match(feed.reason, /必须是 https/);
});

test('本机的 http 放行：对着本地目录调更新流程是常规操作', () => {
  assert.equal(resolveUpdateFeed({ ...base, remote: 'http://127.0.0.1:8080/nova' }).url, 'http://127.0.0.1:8080/nova');
});

test('带查询串的地址不收：electron-updater 要在它后面拼文件名', () => {
  const feed = resolveUpdateFeed({ ...base, remote: 'https://bucket.example.com/desktop/nova?Signature=abc' });
  assert.equal(feed.url, '');
  assert.match(feed.reason, /查询参数/);
});

test('不是 URL 的值只关掉更新，不抛异常', () => {
  const feed = resolveUpdateFeed({ ...base, remote: 'oss://bucket/desktop/nova' });
  assert.equal(feed.url, '');
  assert.match(feed.reason, /只支持 http\/https|不是合法 URL/);
});
