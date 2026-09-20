import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveUpdateFeed } from './feed';

const base = { product: 'nova' as const, env: {} };

test('没配就是不检查更新，而不是报错', () => {
  const feed = resolveUpdateFeed(base);
  assert.equal(feed.url, '');
  assert.match(feed.reason, /没有配置更新地址/);
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
  assert.equal(resolveUpdateFeed({ product: 'nova', env }).url, '');
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
