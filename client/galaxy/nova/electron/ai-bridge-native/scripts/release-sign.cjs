#!/usr/bin/env node
// ai-bridge 发布包的签名工具（跨端契约第 2 节）。只用 Node 自带的 crypto，不装任何依赖。
//
//   node scripts/release-sign.cjs keygen [--out <pem>]             生成发布签名私钥（一次就够）
//   node scripts/release-sign.cjs sign --key <pem> <压缩包...>      给压缩包签名，写出 <压缩包>.sig
//   node scripts/release-sign.cjs verify [--pub <base64>] <压缩包...>
//                                                                 用公钥验 <压缩包>.sig（默认读 release-keys.txt）
//
// 节点只装用 release-keys.txt 里某一把公钥验得过的包，管理后台也只收验得过的包 ——
// 下载地址、sha256 这些 Hub 下发的东西都不单独可信，真正的信任根是这把离线私钥。
//
// 被签名的字节和节点（src/pool/upgrade.rs 的 signed_message）、管理后台（Go）逐字节一致：
//   "ai-bridge-release:v1\n" + version + "\n" + platform + "\n" + sha256 + "\n"
// 三边任何一边多一个换行，发版那天所有机器都会拒装。
'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

/** 与 build-cli.cjs 的 TARGETS、节点的 PLATFORMS 同一张表。 */
const PLATFORMS = ['linux-x64', 'linux-arm64', 'darwin-arm64', 'darwin-x64', 'windows-x64', 'windows-arm64'];
const VERSION = String.raw`\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?`;
const ARCHIVE = new RegExp(String.raw`^ai-bridge-(${VERSION})-(${PLATFORMS.join('|')})\.(tar\.gz|zip)$`);

/** Ed25519 公钥 SPKI DER 的固定前缀，后面接 32 字节原始公钥。 */
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

const DEFAULT_KEY = path.join(os.homedir(), '.config', 'ai-bridge-release', 'release-signing-key.pem');

function signedMessage(version, platform, sha256) {
  return Buffer.from(`ai-bridge-release:v1\n${version}\n${platform}\n${sha256}\n`, 'utf8');
}

/**
 * 版本和平台只从文件名里来（契约第 1 节的包名）。
 *
 * 不接受命令行另给：签名覆盖的是「这是哪个版本、给哪个平台」，文件名和签名内容
 * 对不上的包，管理后台按文件名登记之后节点一定验不过 —— 在签的时候就拦住。
 */
function parseArchiveName(file) {
  const name = path.basename(file);
  const match = ARCHIVE.exec(name);
  if (!match) {
    throw new Error(`${name} 不是发布包的文件名（应当是 ai-bridge-<版本>-<平台>.tar.gz，Windows 是 .zip）`);
  }
  const [, version, platform, extension] = match;
  const expected = platform.startsWith('windows-') ? 'zip' : 'tar.gz';
  if (extension !== expected) throw new Error(`${name}：${platform} 的包应当是 .${expected}`);
  return { version, platform };
}

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function rawPublicKey(publicKey) {
  return publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);
}

/** Buffer.from(…, 'base64') 会悄悄跳过非法字符，所以解完再编回去比一次，只认规范写法。 */
function publicKeyFromBase64(encoded) {
  const raw = Buffer.from(encoded, 'base64');
  if (raw.length !== 32 || raw.toString('base64') !== encoded) {
    throw new Error(`不是 32 字节 Ed25519 公钥的标准 base64：${encoded}`);
  }
  return crypto.createPublicKey({ key: Buffer.concat([SPKI_PREFIX, raw]), format: 'der', type: 'spki' });
}

/** 与节点的 parse_release_keys 同一套规则：`#` 之后是注释，空行忽略，坏一行整份报错。 */
function readReleaseKeys(file = path.join(root, 'release-keys.txt')) {
  const keys = [];
  fs.readFileSync(file, 'utf8').split('\n').forEach((line, index) => {
    const content = line.split('#')[0].trim();
    if (!content) return;
    try {
      keys.push(publicKeyFromBase64(content));
    } catch {
      throw new Error(`${path.basename(file)} 第 ${index + 1} 行不是 32 字节 Ed25519 公钥的标准 base64`);
    }
  });
  return keys;
}

function loadPrivateKey(file) {
  const key = crypto.createPrivateKey(fs.readFileSync(file));
  if (key.asymmetricKeyType !== 'ed25519') throw new Error(`${file} 不是 Ed25519 私钥`);
  return key;
}

/** 签一个包，写出 `<包>.sig`（一行 base64 签名）。build-cli.cjs 也调它。 */
function signArchive(archive, keyFile) {
  const { version, platform } = parseArchiveName(archive);
  const privateKey = loadPrivateKey(keyFile);
  const publicKey = crypto.createPublicKey(privateKey);
  const sha256 = sha256File(archive);
  const message = signedMessage(version, platform, sha256);
  const signature = crypto.sign(null, message, privateKey);
  // 交出去之前先自己验一遍：一个验不过的 .sig 传上管理后台，只会换来一句「签名不对」。
  if (!crypto.verify(null, message, publicKey, signature)) throw new Error(`${path.basename(archive)} 签完自验失败`);
  const sigFile = `${archive}.sig`;
  fs.writeFileSync(sigFile, `${signature.toString('base64')}\n`);
  return {
    archive, sigFile, version, platform, sha256,
    signature: signature.toString('base64'),
    publicKey: rawPublicKey(publicKey).toString('base64'),
  };
}

/** 用给定的公钥（KeyObject 数组）验 `<包>.sig`，任何一把验得过就算数。 */
function verifyArchive(archive, publicKeys) {
  const { version, platform } = parseArchiveName(archive);
  const sigFile = `${archive}.sig`;
  if (!fs.existsSync(sigFile)) throw new Error(`找不到签名文件 ${sigFile}`);
  const signature = fs.readFileSync(sigFile, 'utf8').trim();
  const bytes = Buffer.from(signature, 'base64');
  if (bytes.length !== 64 || bytes.toString('base64') !== signature) {
    throw new Error(`${path.basename(sigFile)} 不是 64 字节 Ed25519 签名的标准 base64`);
  }
  const sha256 = sha256File(archive);
  const message = signedMessage(version, platform, sha256);
  const ok = publicKeys.some((key) => crypto.verify(null, message, key, bytes));
  return { archive, version, platform, sha256, signature, ok };
}

function keygen(out) {
  // 不覆盖：私钥被覆盖等于换了钥匙，已经装出去的机器从此验不过任何新包，只能挨台重装。
  if (fs.existsSync(out)) throw new Error(`${out} 已经存在，不覆盖（换钥匙的步骤见 release-keys.txt 开头）`);
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  fs.mkdirSync(path.dirname(out), { recursive: true, mode: 0o700 });
  fs.writeFileSync(out, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600, flag: 'wx' });
  const encoded = rawPublicKey(publicKey).toString('base64');
  console.log(`已生成发布签名私钥：${out}（权限 0600；离线保管、备份好，绝不进仓库）`);
  console.log('');
  console.log(`公钥：${encoded}`);
  console.log('');
  console.log('把公钥加到两处，缺一处都不行：');
  console.log('  1. ai-bridge-native/release-keys.txt 里加一行，然后重新编译发布包 —— 节点靠它验包；');
  console.log('  2. manager-api 配置 galaxy.bridge_release.public_keys（多把用逗号分隔）—— 管理后台上传时靠它验包。');
  console.log('');
  console.log('之后每出一个包：node scripts/release-sign.cjs sign --key <私钥> <包>，把包和 .sig 一起在管理后台上传。');
}

function parseCli(argv) {
  const options = { files: [], pub: [] };
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
    if (flag === '--out') options.out = value();
    else if (flag === '--key') options.key = value();
    else if (flag === '--pub') options.pub.push(value());
    else if (flag.startsWith('-')) throw new Error(`不认识的参数：${flag}`);
    else options.files.push(arg);
  }
  return options;
}

const USAGE = `用法：
  node scripts/release-sign.cjs keygen [--out <pem>]            默认 ${DEFAULT_KEY}
  node scripts/release-sign.cjs sign --key <pem> <压缩包...>     私钥也可以用环境变量 AI_BRIDGE_RELEASE_KEY 给
  node scripts/release-sign.cjs verify [--pub <base64>] <压缩包...>  默认用 release-keys.txt 里的公钥`;

function main(argv) {
  const [command, ...rest] = argv;
  const options = parseCli(rest);
  switch (command) {
    case 'keygen': {
      keygen(path.resolve(options.out ?? DEFAULT_KEY));
      return 0;
    }
    case 'sign': {
      const key = options.key ?? process.env.AI_BRIDGE_RELEASE_KEY ?? (fs.existsSync(DEFAULT_KEY) ? DEFAULT_KEY : undefined);
      if (!key) throw new Error('要指定私钥：--key <pem>，或者环境变量 AI_BRIDGE_RELEASE_KEY');
      if (options.files.length === 0) throw new Error('要给出至少一个压缩包');
      for (const file of options.files) {
        const signed = signArchive(path.resolve(file), path.resolve(key));
        console.log(`已签名 ${path.basename(file)} → ${path.basename(signed.sigFile)}`);
        console.log(`  版本 ${signed.version} · 平台 ${signed.platform} · sha256 ${signed.sha256}`);
        console.log(`  公钥 ${signed.publicKey}`);
      }
      return 0;
    }
    case 'verify': {
      const keys = options.pub.length > 0 ? options.pub.map(publicKeyFromBase64) : readReleaseKeys();
      if (keys.length === 0) throw new Error('release-keys.txt 里还没有公钥：用 --pub <base64> 指定要验的公钥');
      if (options.files.length === 0) throw new Error('要给出至少一个压缩包');
      let failed = 0;
      for (const file of options.files) {
        const result = verifyArchive(path.resolve(file), keys);
        if (result.ok) {
          console.log(`通过  ${path.basename(file)}（版本 ${result.version} · 平台 ${result.platform}）`);
        } else {
          failed += 1;
          console.log(`不通过  ${path.basename(file)}：签名和这个包、这几把公钥都对不上`);
        }
      }
      return failed === 0 ? 0 : 1;
    }
    case undefined:
    case 'help':
    case '--help':
      console.log(USAGE);
      return 0;
    default:
      throw new Error(`不认识的命令：${command}\n${USAGE}`);
  }
}

if (require.main === module) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(`release-sign: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = {
  DEFAULT_KEY,
  PLATFORMS, parseArchiveName, publicKeyFromBase64, readReleaseKeys, signArchive, signedMessage, verifyArchive,
};
