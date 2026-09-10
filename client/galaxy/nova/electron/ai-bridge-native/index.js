// 按 平台-架构 加载原生模块。构建脚本把产物放在包根目录，命名沿用 napi-rs 惯例。
const { existsSync } = require('node:fs');
const { join } = require('node:path');

const file = join(__dirname, `ai-bridge-native.${process.platform}-${process.arch}.node`);
if (!existsSync(file)) {
  throw new Error(
    `找不到 ${process.platform}-${process.arch} 的 ai-bridge-native 原生模块。` +
    '在 client/galaxy/nova/electron/ai-bridge-native 下运行 `npm run build` 生成。',
  );
}
module.exports = require(file);
