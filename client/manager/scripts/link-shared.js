#!/usr/bin/env node
// npm install 后自动补一个 client/shared/node_modules -> client/manager/node_modules 的符号链接。
// 原因见 client/shared/README.md：client/shared/** 里的文件要 import "antd"/"react" 这类
// 依赖，靠这个软链才能找到（Node/webpack/TypeScript 都是从被导入文件所在目录往上找
// node_modules，client/shared 自己没有）。失败了不影响其它安装步骤（比如没有符号链接权限
// 的环境），只打一行提示，构建/开发时如果报 "Cannot find module 'antd'" 之类的错，
// 回来看这一步是不是没成功。
const fs = require("fs");
const path = require("path");

const target = path.resolve(__dirname, "..", "node_modules");
const linkPath = path.resolve(__dirname, "..", "..", "shared", "node_modules");

try {
  if (fs.existsSync(linkPath)) {
    const stats = fs.lstatSync(linkPath);
    if (stats.isSymbolicLink()) {
      process.exit(0);
    }
    console.warn(`[link-shared] ${linkPath} 已存在且不是符号链接，跳过（请手动检查）。`);
    process.exit(0);
  }
  const relativeTarget = path.relative(path.dirname(linkPath), target);
  fs.symlinkSync(relativeTarget, linkPath, "dir");
  console.log(`[link-shared] 已创建 ${linkPath} -> ${relativeTarget}`);
} catch (error) {
  console.warn(`[link-shared] 创建符号链接失败（${error.message}），client/shared/** 里 import 第三方包可能会解析失败。`);
  console.warn("[link-shared] 手动修复：cd client && ln -s ../manager/node_modules shared/node_modules");
}
