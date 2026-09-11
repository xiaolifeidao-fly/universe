// Run after build:nova and build:orbit. Uses a local mock upstream; no real account changes.
//
// 验的是 .desktop/<端>/ 里那份 Next standalone —— 界面从远端加载之后，它就是
// **要部署到服务器上**的东西，不再进安装包。桌面壳只负责加载它的地址，
// 所以这条测试仍然是发布前唯一一次「路由、静态资源、业务代理」的整体验证。
const { spawn } = require('node:child_process');
const http = require('node:http');
const path = require('node:path');
const assert = require('node:assert/strict');
async function main() {
  const upstream = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ path: req.url, token: req.headers.token }));
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  try {
    for (const [product, port, home, other] of [['nova', 17998, '/provider/today', '/consumer/keys'], ['orbit', 17999, '/consumer/keys', '/provider/today']]) {
      const cwd = path.resolve(__dirname, '..', '.desktop', product, 'client/galaxy', product, 'webview');
      const child = spawn(process.execPath, ['server.js'], { cwd, env: { ...process.env, HOSTNAME: '127.0.0.1', PORT: String(port), SERVER_TARGET: `http://127.0.0.1:${upstream.address().port}` }, stdio: 'pipe' });
      let output = '';
      child.stderr.on('data', (data) => output += data);
      const base = `http://127.0.0.1:${port}`;
      try {
        let ready = false;
        for (let attempt = 0; attempt < 100; attempt++) {
          try { const res = await fetch(base + '/api/desktop-health'); assert.equal((await res.json()).product, product); ready = true; break; }
          catch { await new Promise((resolve) => setTimeout(resolve, 100)); }
        }
        assert.ok(ready, output);
        assert.equal((await fetch(base + other)).status, 404, 'Opposite product routes must not be shipped');
        assert.equal((await fetch(base + home)).status, 200);
        const login = await (await fetch(base + '/login')).text();
        assert.ok(login.includes(product === 'nova' ? 'Nova' : 'Orbit'));
        const proxied = await fetch(base + '/api/galaxy/consumer/keys', { headers: { token: 'test-only' } });
        assert.deepEqual(await proxied.json(), { path: '/api/galaxy/consumer/keys', token: 'test-only' });
        const script = login.match(/src="([^\"]+\.js)"/);
        assert.ok(script);
        assert.equal((await fetch(base + script[1])).status, 200);
        console.log(`${product}: standalone, assets, product routing, and Next.js business proxy passed`);
      } finally { child.kill(); await new Promise((resolve) => child.once('exit', resolve)); }
    }
  } finally { await new Promise((resolve) => upstream.close(resolve)); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
