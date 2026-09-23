#!/usr/bin/env node
// 出一版 ai-bridge：抬版本号 → 编 .node → 编各平台发布包（顺带签名、写 SHA256SUMS）。
//
//   node scripts/release.cjs --bump patch                        本机一版
//   node scripts/release.cjs --bump minor --note "……" \
//        --target x86_64-unknown-linux-gnu --zig                 抬小版本，出 Linux 包
//   node scripts/release.cjs --version 1.0.0 --no-node           版本号直接给，不重编 .node
//   node scripts/release.cjs --target a --target b --zig         一次出多个平台
//
// 自己不编译：把 scripts/build.cjs 与 scripts/build-cli.cjs 按顺序跑一遍。那两个仍然
// 能单独用 —— 这里只是把「改版本号 + 两个产物 + 签名 + 校验和」这几件手工活串起来，
// 省掉「改完 Cargo.toml 只重编了其中一个」这类各处版本对不上的事故。
//
// 版本号只有一处权威：Cargo.toml 的 [package].version。发布包的文件名、二进制里的版本串、
// 签名覆盖的那段消息全从它来。.node **不带版本号**（napi 那片的 bridgeVersion 由 JS 侧传），
// 所以重编 .node 只是让 Nova 与这一版跑同一份代码，不改变它的文件名。
//
// 任何一步编译失败都会把 Cargo.toml 原样改回去：否则失败一次、修完再跑，版本号白跳一格，
// 而跳过去的那个号可能已经有人下过了。
'use strict';
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const cargoToml = path.join(root, 'Cargo.toml');

const USAGE = `用法：
  node scripts/release.cjs [--bump patch|minor|major | --version x.y.z] [--note "……"]
                           [--target <triple>]... [--zig] [--glibc 2.17]
                           [--no-node] [--out <dir>] [--key <私钥 pem>]

  --bump / --version  抬版本号（两者取一；都不给就按当前版本重打一遍）
  --note "……"         在版本号上方加一行「# x.y.z 起 ……」，与 Cargo.toml 里已有的几行同体例
  --target            rust triple，可重复；不给就编本机
  --zig --glibc       在 macOS 上交叉编 Linux 包（见 build-cli.cjs 开头）
  --no-node           不重编 Nova 用的 .node
  --out               发布包目录，默认 client/galaxy/release/ai-bridge
  --key               发布签名私钥；不给就用 AI_BRIDGE_RELEASE_KEY 或默认位置那把`;

/** 出错时要把 Cargo.toml 放回去，所以这几样得让 fail() 够得着。 */
let bumped = false;
let originalToml = null;
let versionBefore = null;

function parseCli(argv) {
  const options = { targets: [], node: true, zig: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const [flag, inline] = arg.startsWith('--') && arg.includes('=') ? arg.split(/=(.*)/s) : [arg, undefined];
    const value = () => {
      if (inline !== undefined) return inline;
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) throw new Error(`${flag} 后面要跟一个值`);
      i += 1;
      return next;
    };
    if (flag === '--bump') options.bump = value();
    else if (flag === '--version') options.version = value();
    else if (flag === '--note') options.note = value();
    else if (flag === '--target') options.targets.push(value());
    else if (flag === '--out') options.out = value();
    else if (flag === '--glibc') options.glibc = value();
    else if (flag === '--key') options.key = value();
    else if (flag === '--zig') options.zig = true;
    else if (flag === '--node') options.node = true;
    else if (flag === '--no-node') options.node = false;
    else if (flag === '--help' || flag === '-h') options.help = true;
    else throw new Error(`不认识的参数：${flag}\n${USAGE}`);
  }
  if (options.bump && options.version) throw new Error('--bump 和 --version 只能给一个');
  return options;
}

/** 与 build-cli.cjs 同一个规则：跑到当前目录外面就给绝对路径，别印一串 ../../..。 */
function display(target) {
  const relative = path.relative(process.cwd(), target);
  return relative.startsWith('..') ? target : relative;
}

/** [package] 段的范围。不能无脑找第一个 `version =`：依赖项里也有一堆。 */
function packageSection(text) {
  const header = /^\[package\]\s*$/m.exec(text);
  if (!header) throw new Error('Cargo.toml 里找不到 [package] 段');
  const start = header.index + header[0].length;
  const next = /^\[/m.exec(text.slice(start));
  return { start, end: next ? start + next.index : text.length };
}

function readPackageVersion(text) {
  const section = packageSection(text);
  const match = /^version\s*=\s*"([^"]+)"/m.exec(text.slice(section.start, section.end));
  if (!match) throw new Error('Cargo.toml 的 [package] 里找不到 version');
  return { value: match[1], index: section.start + match.index, length: match[0].length };
}

function nextVersion(current, bump) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(current);
  if (!match) throw new Error(`当前版本 ${current} 不是 x.y.z，抬不动 —— 用 --version 直接给一个`);
  const [major, minor, patch] = match.slice(1).map(Number);
  if (bump === 'major') return `${major + 1}.0.0`;
  if (bump === 'minor') return `${major}.${minor + 1}.0`;
  if (bump === 'patch') return `${major}.${minor}.${patch + 1}`;
  throw new Error(`--bump 只认 major / minor / patch，收到 ${bump}`);
}

/** 写回版本号；给了 --note 就在它上面补一行说明，与已有的那几行同体例。 */
function withVersion(text, version, note) {
  const found = readPackageVersion(text);
  const comment = note ? `# ${version} 起 ${note}\n` : '';
  return `${text.slice(0, found.index)}${comment}version = "${version}"${text.slice(found.index + found.length)}`;
}

/** 目录里属于某个版本的发布包。签名与校验和都跟着包名走，所以认名字就够。 */
function archives(out, version) {
  if (!fs.existsSync(out)) return [];
  const pattern = new RegExp(`^ai-bridge-${version.replace(/\./g, '\\.')}-.+\\.(tar\\.gz|zip)$`);
  return fs.readdirSync(out).filter((name) => pattern.test(name)).sort();
}

/** 编译失败就把 Cargo.toml 放回去 —— 版本号不该为一次失败的构建白跳一格。 */
function fail(message) {
  if (bumped) {
    fs.writeFileSync(cargoToml, originalToml);
    bumped = false;
    console.error(`release: 版本号已改回 ${versionBefore}（Cargo.lock 下次 cargo 跑起来会自己跟上）`);
  }
  throw new Error(message);
}

function runScript(script, args, what, env) {
  const result = spawnSync(process.execPath, [path.join(__dirname, script), ...args], { cwd: root, stdio: 'inherit', env });
  if (result.error) fail(`${what} 跑不起来：${result.error.message}`);
  if (result.status !== 0) fail(`${what} 失败（退出码 ${result.status}）`);
}

function main(argv) {
  const options = parseCli(argv);
  if (options.help) {
    console.log(USAGE);
    return 0;
  }

  const out = path.resolve(root, options.out ?? path.join('..', '..', '..', 'release', 'ai-bridge'));
  originalToml = fs.readFileSync(cargoToml, 'utf8');
  versionBefore = readPackageVersion(originalToml).value;
  let version = versionBefore;

  if (options.bump || options.version) {
    if (options.version && !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(options.version)) {
      throw new Error(`--version 要写成 1.0.0 这样（可带 -beta.1 后缀），收到 ${options.version}`);
    }
    version = options.version ?? nextVersion(versionBefore, options.bump);
    if (version === versionBefore) throw new Error(`版本号没变（仍是 ${versionBefore}）`);
    fs.writeFileSync(cargoToml, withVersion(originalToml, version, options.note));
    bumped = true;
    console.log(`release: 版本 ${versionBefore} → ${version}${options.note ? '（已加说明行）' : ''}`);
  } else {
    console.log(`release: 没给 --bump / --version，按当前版本 ${version} 重打`);
    // 同号重打是**能**做的，但节点与管理后台都按版本号比新旧：号没变，那边认不出这是新包。
    const existing = archives(out, version);
    if (existing.length > 0) console.log(`release: 注意 —— ${display(out)} 里已有 ${existing.join('、')}，会被覆盖`);
  }

  const env = { ...process.env, ...(options.key ? { AI_BRIDGE_RELEASE_KEY: path.resolve(options.key) } : {}) };
  // .node 先编：它只编本机，失败得快，不用等交叉编译那几分钟才发现代码根本编不过。
  if (options.node) runScript('build.cjs', [], 'build.cjs（Nova 用的 .node）', env);

  const passthrough = [...(options.zig ? ['--zig'] : []), ...(options.glibc ? ['--glibc', options.glibc] : [])];
  if (options.targets.length === 0) {
    runScript('build-cli.cjs', ['--out', out, ...passthrough], '本机发布包', env);
  } else {
    for (const target of options.targets) {
      runScript('build-cli.cjs', ['--target', target, '--out', out, ...passthrough], `${target} 发布包`, env);
    }
  }

  console.log('');
  console.log(`release: ai-bridge ${version}`);
  for (const name of archives(out, version)) {
    const size = (fs.statSync(path.join(out, name)).size / 1048576).toFixed(1);
    const signed = fs.existsSync(path.join(out, `${name}.sig`)) ? '已签名' : '未签名';
    console.log(`  ${name}  ${size} MB  ${signed}`);
  }
  if (options.node) console.log('  ai-bridge-native.<平台>.node（Nova 用，不带版本号）已重编');
  console.log(`  目录：${display(out)}（校验和见其中的 SHA256SUMS）`);
  if (bumped) console.log('  Cargo.toml / Cargo.lock 已改，记得提交');
  return 0;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (error) {
  console.error(`release: ${error.message}`);
  process.exitCode = 1;
}
