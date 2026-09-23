// 把自带的 npm 拷进包。
//
// 为什么不用 extraResources：electron-builder 的文件过滤器里有一行硬编码 ——
// 相对路径正好是 `node_modules` 的目录一律 return false（app-builder-lib 的
// util/filter.js），filter 写什么都救不回来。而 npm 自己那 12MB 依赖就躺在
// `npm/node_modules` 下，少了它包里就是个一跑就 MODULE_NOT_FOUND 的空壳。
// 这个坑不报错也不警告，只能靠 `npm run verify:toolchain --bundle` 验出来。
//
// afterPack 跑在**签名之前**：拷完再签，.app 的封印才是完整的；签完再往里塞文件
// 会让签名失效，用户那边直接打不开。
//
// npm 干什么用的见 src/modules/toolchain。
const fs = require('node:fs');
const path = require('node:path');

/** 各平台的 resources 目录。toolchain 那边按 process.resourcesPath 找，两边要对上。 */
function resourcesDir(context) {
  if (context.electronPlatformName === 'darwin') {
    return path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources');
  }
  return path.join(context.appOutDir, 'resources');
}

exports.default = async function afterPack(context) {
  const from = path.join(__dirname, '..', '..', '..', 'node_modules', 'npm');
  if (!fs.existsSync(path.join(from, 'bin', 'npm-cli.js'))) {
    throw new Error(`自带的 npm 不在 ${from} —— 先 npm install 再打包`);
  }
  const to = path.join(resourcesDir(context), 'npm');
  fs.rmSync(to, { recursive: true, force: true });
  fs.cpSync(from, to, {
    recursive: true,
    dereference: true,
    // 文档和 man 页用不上，但 node_modules 一个都不能少。
    filter: (source) => {
      const relative = path.relative(from, source);
      return !(relative === 'docs' || relative === 'man' || relative.endsWith('.md'));
    },
  });
  const deps = fs.readdirSync(path.join(to, 'node_modules')).length;
  console.log(`  • bundled npm  path=${path.relative(context.appOutDir, to)} deps=${deps}`);
};
