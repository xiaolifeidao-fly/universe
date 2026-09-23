import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import yaml from 'js-yaml';
import { DesktopBridgeService } from '../src/desktop/service.js';

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'nova-bridge-'));
  const configPath = join(dir, 'config.yaml');
  await writeFile(configPath, yaml.dump({ mode: 'relay', providers: {}, relay: { enabled: false }, server: { port: 0 },
    auth: { tokenFile: join(dir, 'tokens.json') }, pool: { hubURL: 'http://127.0.0.1:59998', tokenFile: join(dir, 'node.json') } }));
  const service = new DesktopBridgeService(configPath);
  await service.initialize();
  return { service, dir, configPath };
}

test('desktop relay lifecycle is serialized and token management never lists secrets', async () => {
  const { service, dir } = await fixture();
  try {
    assert.equal((await service.getStatus()).state, 'stopped');
    const [a, b] = await Promise.all([service.start(), service.start()]);
    assert.equal(a.state, 'running'); assert.equal(b.state, 'running');
    const issued = await service.createToken({ alias: 'test', scopes: ['admin'] });
    assert.ok(issued.token);
    const list = await service.listTokens();
    assert.equal(list[0].alias, 'test');
    assert.equal(JSON.stringify(list).includes(issued.token), false);
    await service.revokeToken('test'); assert.deepEqual(await service.listTokens(), []);
    assert.equal((await service.restart()).state, 'running');
    assert.equal((await service.stop()).state, 'stopped');
    await assert.rejects(service.ping({ port: 39217 }), /unrecognized_keys/);
    await assert.rejects(service.upgradeTool('arbitrary-command'), /不认识/);
  } finally { await service.stop(); await rm(dir, { recursive: true, force: true }); }
});

test('desktop pair keeps node token private and stop aborts an outstanding hello', async () => {
  const { service, dir, configPath } = await fixture();
  let pairBody: Record<string, unknown> | undefined;
  let hello = 0;
  const hub = http.createServer((req, res) => {
    if (req.url === '/agent/v1/pair') {
      let body = ''; req.on('data', data => body += data);
      req.on('end', () => { pairBody = JSON.parse(body); res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ nodeId: 'owned-node', token: 'node-secret' })); });
    } else if (req.url === '/agent/v1/hello') { hello++; /* intentionally pending until stop aborts */ }
    else { res.writeHead(204); res.end(); }
  });
  await new Promise<void>(resolve => hub.listen(0, '127.0.0.1', resolve));
  const address = hub.address(); assert.ok(address && typeof address !== 'string');
  const hubURL = `http://127.0.0.1:${address.port}`;
  const config = yaml.load(await readFile(configPath, 'utf8')) as { pool: { hubURL: string } };
  config.pool.hubURL = hubURL; await writeFile(configPath, yaml.dump(config));
  try {
    const paired = await service.pair({ code: 'one-use-code', hubURL });
    assert.equal(pairBody?.code, 'one-use-code');
    assert.equal(paired.nodeId, 'owned-node');
    assert.equal(JSON.stringify(paired).includes('node-secret'), false);
    assert.ok((await readFile(join(dir, 'node.json'), 'utf8')).includes('node-secret'));
    for (let i = 0; hello === 0 && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(hello, 1);
    assert.equal((await service.getStatus()).state, 'starting');
    assert.equal((await service.ping({ hubUrl: hubURL })).hubMatches, true);
    assert.equal((await service.stop()).state, 'stopped');
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(hello, 1, 'stopped runner must not reconnect');
  } finally { await service.stop(); hub.closeAllConnections(); await new Promise<void>(resolve => hub.close(() => resolve())); await rm(dir, { recursive: true, force: true }); }
});
