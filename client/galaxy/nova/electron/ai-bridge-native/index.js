// 按 平台-架构 加载原生模块。构建脚本把产物放在包根目录，命名沿用 napi-rs 惯例。
const { existsSync, readdirSync } = require('node:fs');
const { join } = require('node:path');

const wanted = `ai-bridge-native.${process.platform}-${process.arch}.node`;
const file = join(__dirname, wanted);
if (!existsSync(file)) {
  // 把「有什么」一并说出来：缺产物几乎总是「只编了本机那一片」或者「CI 产物没放进来」，
  // 光报缺哪个不够定位。
  const present = readdirSync(__dirname)
    .filter((name) => name.endsWith('.node'))
    .map((name) => name.replace(/^ai-bridge-native\.|\.node$/g, ''));
  throw new Error(
    `找不到 ${process.platform}-${process.arch} 的 ai-bridge-native 原生模块。` +
    `包里现有：${present.length ? present.join('、') : '（一个都没有）'}。` +
    '本机编译：在 client/galaxy/nova/electron/ai-bridge-native 下 `npm run build`；' +
    '其它平台从 CI 的 ai-bridge-native 工件里取，放到这个目录即可。',
  );
}
module.exports = require(file);
