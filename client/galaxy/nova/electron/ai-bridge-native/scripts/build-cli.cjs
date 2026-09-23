#!/usr/bin/env node
// 出 ai-bridge 命令行的发布包：一个平台一个压缩包，里面是可执行文件、部署说明和服务模板。
//
// 和 build.cjs 是两件事：那边出 Nova 用的 .node（动态库，要 Node 宿主），这边出服务器上
// 独立运行的可执行文件。实现是同一份 Rust，只是入口不同（src/bin/ai-bridge.rs）。
//
//   node scripts/build-cli.cjs                      编本机
//   node scripts/build-cli.cjs --target <triple>    交叉编译（要有对应工具链）
//   node scripts/build-cli.cjs --out <dir>          产物目录，默认 client/galaxy/release/ai-bridge
//   node scripts/build-cli.cjs --target x86_64-unknown-linux-gnu --zig [--glibc 2.17]
//                                                   在 macOS 上用 zig 交叉编译 Linux 包
//
// 找得到发布签名私钥时顺手签名，产出 <包>.sig：先看环境变量 AI_BRIDGE_RELEASE_KEY，
// 再看默认位置 ~/.config/ai-bridge-release/release-signing-key.pem（与 release-sign.cjs 一致）。
// 管理后台只收验得过签名的包，节点也只装验得过签名的包；私钥怎么来见 scripts/release-sign.cjs。
//
// 不加 --zig 时本机只能出本机那几片（macOS 上 arm64 与 x64 两片开箱即用），
// Windows / Linux 靠 CI 对应的 runner 出：.github/workflows/ai-bridge-native.yml 的 cli 任务。
'use strict';
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);

/** rust triple → 发布包里的平台名。 */
const TARGETS = {
  'aarch64-apple-darwin': 'darwin-arm64',
  'x86_64-apple-darwin': 'darwin-x64',
  'x86_64-pc-windows-msvc': 'windows-x64',
  'aarch64-pc-windows-msvc': 'windows-arm64',
  'x86_64-unknown-linux-gnu': 'linux-x64',
  'aarch64-unknown-linux-gnu': 'linux-arm64',
};

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

/** 产物目录由 .cargo/config.toml 挪到了包外，别假设是 ./target —— 问 cargo。 */
function metadata() {
  const meta = spawnSync('cargo', ['metadata', '--format-version', '1', '--no-deps'],
    { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (meta.status !== 0) throw new Error(`cargo metadata 失败：${(meta.stderr || '').trim()}`);
  return JSON.parse(meta.stdout);
}

function hostTriple() {
  const host = spawnSync('rustc', ['-vV'], { encoding: 'utf8' });
  const triple = /^host:\s*(\S+)$/m.exec(host.stdout ?? '')?.[1];
  if (!triple) throw new Error('问不出 rustc 的 host triple，装好 Rust 再来');
  return triple;
}

/** 产物路径怎么显示：在当前目录之下就给相对路径，跑到外面（--out 指到别处）就给绝对路径 ——
 *  一串 ../../../.. 谁也读不出来指的是哪。 */
function display(target) {
  const relative = path.relative(process.cwd(), target);
  return relative.startsWith('..') ? target : relative;
}

function option(name) {
  const index = argv.indexOf(name);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} 后面要跟一个值`);
  return value;
}

const target = option('--target') ?? hostTriple();
const platform = TARGETS[target];
if (!platform) {
  throw new Error(`ai-bridge 命令行还没有 ${target} 的发布配置（认识的：${Object.keys(TARGETS).join(', ')}）`);
}
const out = path.resolve(root, option('--out') ?? path.join('..', '..', '..', 'release', 'ai-bridge'));

// --zig：在 macOS 上交叉编译 Linux 包，不用 Docker、不用 Linux 机器。
//
// zig 同时充当 C 编译器（ring 里有 C 与汇编）和链接器，自带各个版本 glibc 的符号桩，
// 所以能指定「最低要求哪一版 glibc」。默认 2.17：CI 在 Ubuntu 22.04 上编的包要
// glibc ≥ 2.35，CentOS 7、Ubuntu 18.04 这类老系统直接跑不起来，而 2.17 几乎哪都能跑。
// 要先装好：brew install zig && cargo install cargo-zigbuild
const zig = argv.includes('--zig');
const glibc = option('--glibc') ?? '2.17';
if (!/^\d+\.\d+$/.test(glibc)) throw new Error(`--glibc 要写成 2.17 这样的版本号，收到 ${glibc}`);
const linuxGnu = target.endsWith('-linux-gnu');

// 不带 node 特性：napi 的符号要 Node 宿主提供，独立的可执行文件里没有这个宿主。
run('cargo', zig
  // cargo-zigbuild 认 <triple>.<glibc> 这种写法；产物目录仍然是不带版本后缀的 triple。
  ? ['zigbuild', '--release', '--bin', 'ai-bridge', '--target', linuxGnu ? `${target}.${glibc}` : target]
  : ['build', '--release', '--bin', 'ai-bridge', '--target', target]);
if (zig && linuxGnu) console.log(`ai-bridge: 按 glibc ${glibc} 链接`);

const meta = metadata();
const version = meta.packages.find((item) => item.name === 'ai-bridge-native')?.version ?? '0.0.0';
const windows = target.includes('windows');
const exe = windows ? 'ai-bridge.exe' : 'ai-bridge';
const built = path.join(path.resolve(meta.target_directory), target, 'release', exe);

const name = `ai-bridge-${version}-${platform}`;
const stage = path.join(out, name);
fs.rmSync(stage, { recursive: true, force: true });
fs.mkdirSync(stage, { recursive: true });
fs.copyFileSync(built, path.join(stage, exe));
if (!windows) fs.chmodSync(path.join(stage, exe), 0o755);
// 部署说明和服务模板跟着包走：拿到压缩包的人手边往往没有这个仓库。
// 过滤掉 Finder 的垃圾：deploy/ 被访达逛过就会留下 .DS_Store，整个目录是 cpSync 进来的，
// 它会一路跟进发布包 —— 对面解包看到的是我们的交付物，不该混着本机的桌面元数据。
const JUNK = /^(\.DS_Store|Thumbs\.db|\._.*)$/;
fs.cpSync(path.join(root, 'deploy'), path.join(stage, 'deploy'), {
  recursive: true,
  filter: (src) => !JUNK.test(path.basename(src)),
});
fs.copyFileSync(path.join(root, 'deploy', 'README.md'), path.join(stage, 'README.md'));

// Windows 用 zip，其余 tar.gz —— 各自平台上不装任何东西就能解开。
// tar 三个平台都有：Windows 10 起系统自带 bsdtar，它也能写 zip（-a 按扩展名选格式）。
const archive = path.join(out, windows ? `${name}.zip` : `${name}.tar.gz`);
fs.rmSync(archive, { force: true });
// 上一次留下的签名一并删掉：包重新打过，旧的 .sig 一定对不上，留着只会被误传上去。
fs.rmSync(`${archive}.sig`, { force: true });
// COPYFILE_DISABLE：macOS 的 bsdtar 默认把扩展属性写成 ._<原名> 的伴生条目，
// 在 Linux 上解开就是满目录的垃圾文件。
run('tar', windows ? ['-a', '-c', '-f', archive, name] : ['-czf', archive, name],
  { cwd: out, env: { ...process.env, COPYFILE_DISABLE: '1' } });
fs.rmSync(stage, { recursive: true, force: true });

// 校验和：服务器上的可执行文件通常是从某个链接下载下来的，得有办法确认它没被换过。
const digest = crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex');
const sums = path.join(out, 'SHA256SUMS');
const file = path.basename(archive);
// 只留目录里还在的包。清单是给别人核对用的，列着一个已经删掉的旧版本，
// 核对的人只会怀疑自己下漏了文件；`shasum -c SHA256SUMS` 也会直接报 No such file。
const lines = (fs.existsSync(sums) ? fs.readFileSync(sums, 'utf8').split('\n') : [])
  .map((line) => /^([0-9a-f]{64})\s\s(.+)$/.exec(line.trim()))
  .filter((match) => match && match[2] !== file && fs.existsSync(path.join(out, match[2])))
  .map((match) => `${match[1]}  ${match[2]}`);
lines.push(`${digest}  ${file}`);
fs.writeFileSync(sums, `${lines.sort((a, b) => a.slice(66).localeCompare(b.slice(66))).join('\n')}\n`);
console.log(`ai-bridge: ${display(archive)} (${(fs.statSync(archive).size / 1048576).toFixed(1)} MB)`);

// 私钥的找法与 `release-sign.cjs sign` 保持一致：环境变量优先，其次是默认位置那把。
// 两边不一致的表现很隐蔽 —— 手工签得动的包，走这个脚本打出来却是没签名的。
const { DEFAULT_KEY, signArchive } = require('./release-sign.cjs');
const releaseKey = process.env.AI_BRIDGE_RELEASE_KEY ?? (fs.existsSync(DEFAULT_KEY) ? DEFAULT_KEY : undefined);
if (releaseKey) {
  const signed = signArchive(archive, path.resolve(releaseKey));
  console.log(`ai-bridge: 已签名 → ${display(signed.sigFile)}`);
  console.log(`ai-bridge: 私钥 ${releaseKey}${process.env.AI_BRIDGE_RELEASE_KEY ? '（AI_BRIDGE_RELEASE_KEY）' : '（默认位置）'} · 公钥 ${signed.publicKey}`);
  console.log('ai-bridge: 在管理后台上传时把包和 .sig 一起传；公钥要在 release-keys.txt 和 galaxy.bridge_release.public_keys 里');
} else {
  console.log(`ai-bridge: 找不到发布签名私钥（AI_BRIDGE_RELEASE_KEY 没设，${DEFAULT_KEY} 也不在），`
    + '这个包没有签名 —— 管理后台不收、节点也不装。');
  console.log(`ai-bridge: 上传前签一次：node scripts/release-sign.cjs sign --key <私钥> ${display(archive)}`);
}
