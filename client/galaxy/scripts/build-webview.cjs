/**
 * 把一个成员的界面构建成「要部署到远端服务器」的 Next standalone 包。
 *
 * 三个成员（nova / orbit 的 webview，以及门户）都走这里：桌面壳的打包流程
 * （desktop.cjs build）、门户的 portal.cjs、还有各自的 build.sh。否则
 * 「拷 standalone、压平目录、补 static/public、删 .env、写 runtime.json」
 * 这几步要在三个地方各写一份，漂了也不会有人发现。
 *
 * 产物目录名 .desktop/<成员> 是历史遗留：里面装的一直是要部署上服务器的那份包，
 * 不改是因为可能已经有部署脚本指着它。
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');

// dir 是源码目录（也是 standalone 里那份应用的相对位置）；target 是这个成员
// 打哪台 Go 服务的兜底值 —— 三个成员不共用一个：Nova 只调 /api/galaxy/provider/*
// （galaxy-api :10004），Orbit 的 /api/galaxy/consumer/* 和门户的
// /api/galaxy/portal/* 都在 galaxy-consumer-api :10005 上。指错了不会 502、
// 也不报错，是后端回一句 Go 默认的「404 page not found」，看上去像页面丢了。
const members = {
  nova: { dir: 'nova/webview', target: 'http://127.0.0.1:10004' },
  orbit: { dir: 'orbit/webview', target: 'http://127.0.0.1:10005' },
  // 门户的「控制台」按钮指向哪儿、页脚上的联系方式，都是运维配的，跟着 runtime.json
  // 一起发。名字不带 NEXT_PUBLIC_ 前缀是**故意的**：这几个值现在由服务端在每次渲染时
  // 现读（portal/src/utils/site.server.ts），不再打进浏览器包 —— 带那个前缀的写法会被
  // Next 在构建时替换成字面量，值就定格在打包机上，改服务器配置不生效。
  portal: {
    dir: 'portal',
    target: 'http://127.0.0.1:10005',
    runtime: {
      GALAXY_CONSOLE_URL: '',
      GALAXY_DOCS_URL: '',
      GALAXY_CONTACT_EMAIL: '',
      GALAXY_CONTACT_WECHAT: '',
      GALAXY_ICP: '',
    },
  },
};

function buildWebview(member) {
  const config = members[member];
  if (!config) throw new Error(`Usage: build-webview.cjs ${Object.keys(members).join('|')}`);
  const app = path.join(root, config.dir);
  const result = spawnSync(process.execPath, [require.resolve('next/dist/bin/next'), 'build'], { cwd: app, stdio: 'inherit' });
  if (result.error || result.status !== 0) throw result.error || new Error(`${member} 界面构建失败`);

  const dist = path.join(app, '.next');
  const output = path.join(root, '.desktop', member);
  fs.rmSync(output, { recursive: true, force: true });
  fs.cpSync(path.join(dist, 'standalone'), output, { recursive: true });

  // standalone 把应用摆在它在仓库里的相对路径下：client/galaxy/<成员的目录>。
  // 那几层对部署机没有任何意义（包名已经写明是谁了），只会让 cd 和看日志时多绕路，
  // 这里压平成 <包>/webview（门户是 <包>/portal）+ <包>/node_modules。
  //
  // 压平是安全的：server.js 用 __dirname 定位自己，node 找依赖是从应用目录
  // 逐级往上走 —— 压平前是 <端>/webview → client/galaxy/node_modules，
  // 压平后是 webview → node_modules，层级关系没变。
  const nested = path.join(output, 'client', 'galaxy');
  for (const name of fs.readdirSync(nested)) fs.renameSync(path.join(nested, name), path.join(output, name));
  fs.rmSync(path.join(output, 'client'), { recursive: true, force: true });
  const appRoot = path.join(output, path.basename(config.dir));
  if (path.join(output, config.dir) !== appRoot) {
    fs.renameSync(path.join(output, config.dir), appRoot);
    fs.rmSync(path.join(output, config.dir.split('/')[0]), { recursive: true, force: true });
  }

  // 工作区那份 package.json / package-lock.json 是 Next 顺带追进来的，运行时一点用
  // 都没有 —— node 给 webview/server.js 认的是 webview/package.json。留着只会招来
  // 一次 `npm install`：那份清单带着 postinstall（部署机上根本没有 scripts/）和
  // workspaces（指向不存在的 nova/ orbit/），装一半就崩，还会把包里已经备好的
  // node_modules 搅乱。依赖随包发好，部署机不需要装任何东西。
  for (const name of ['package.json', 'package-lock.json']) fs.rmSync(path.join(output, name), { force: true });

  // static 与 public 不在追踪范围里，要自己补进去。
  fs.cpSync(path.join(dist, 'static'), path.join(appRoot, '.next', 'static'), { recursive: true });
  fs.cpSync(path.join(app, 'public'), path.join(appRoot, 'public'), { recursive: true });
  // Local environment files can contain secrets. Deployed apps use runtime environment settings.
  for (const name of fs.readdirSync(appRoot)) if (name.startsWith('.env')) fs.rmSync(path.join(appRoot, name));
  // Next 把应用的 package.json 原样搬了进来，里面还挂着 dependencies（含只在
  // 工作区里存在的 @galaxy/common）、devDependencies 和 next dev 那些 scripts。
  // 部署机上一样都用不着，但看见就会有人 npm install，然后卡在 registry 上
  // 找不到 @galaxy/common。这里只留最小清单 —— 是删字段不是删文件：node 判断
  // 一个 .js 是 CJS 还是 ESM，看的就是最近的这份 package.json。
  const manifest = path.join(appRoot, 'package.json');
  const { name, version } = JSON.parse(fs.readFileSync(manifest, 'utf8'));
  fs.writeFileSync(manifest, JSON.stringify({ name, version, private: true }, null, 2));

  require('@next/env').loadEnvConfig(app, false);
  const runtime = {
    SERVER_TARGET: process.env.SERVER_TARGET || config.target,
    APP_URL_PREFIX: process.env.APP_URL_PREFIX || '/api',
  };
  for (const [key, fallback] of Object.entries(config.runtime ?? {})) runtime[key] = process.env[key] || fallback;
  fs.writeFileSync(path.join(output, 'runtime.json'), JSON.stringify(runtime, null, 2));
  console.log(`[${member}] 界面构建完成：${output}`);
  return output;
}

module.exports = { buildWebview, members };
if (require.main === module) buildWebview(process.argv[2]);
