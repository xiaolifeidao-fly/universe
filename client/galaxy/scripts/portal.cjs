#!/usr/bin/env node
// 门户站的 dev / start / build。
//
// 它不走 desktop.cjs：那个脚本的每一步都在伺候桌面壳（编译 Electron、写
// desktop.json、拉 electron-builder），而门户没有壳 —— 它就是一个网站，
// 部署到服务器上给陌生人打开的。硬塞进那个脚本只会让两边都变难读。
//
// build 的产物和两个控制台放在一起（.desktop/portal），目录名是历史遗留：
// 那里面装的一直是「要部署到远端服务器的 Next standalone 包」，
// 不改是因为可能已经有部署脚本指着它。
const { spawn } = require("node:child_process");
const path = require("node:path");

const [action] = process.argv.slice(2);
if (!["dev", "start", "build"].includes(action)) {
  throw new Error("Usage: portal.cjs dev|start|build");
}

const root = path.resolve(__dirname, "..");
const app = path.join(root, "portal");
const PORT = "17900";

function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [require.resolve("next/dist/bin/next"), ...args], {
      cwd: app,
      env: process.env,
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`Process exited: ${code}`))));
  });
}

async function main() {
  if (action === "dev" || action === "start") {
    await run([action, "-H", "127.0.0.1", "-p", PORT]);
    return;
  }

  // 构建与打包的那几步（拷 standalone、压平目录、补 static/public、删 .env、
  // 写 runtime.json）和两个端完全一样，走同一个 build-webview.cjs ——
  // 门户不走 desktop.cjs 是因为它没有壳，不是因为它的界面要另起一套。
  require("./build-webview.cjs").buildWebview("portal");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
