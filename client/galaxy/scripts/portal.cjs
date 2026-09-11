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
const fs = require("node:fs");
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

  await run(["build"]);

  const dist = path.join(app, ".next");
  const output = path.join(root, ".desktop", "portal");
  fs.rmSync(output, { recursive: true, force: true });
  fs.cpSync(path.join(dist, "standalone"), output, { recursive: true });
  // standalone 把应用放在它在仓库里的相对路径下，static 与 public 要自己补进去。
  const appRoot = path.join(output, "client", "galaxy", "portal");
  fs.cpSync(path.join(dist, "static"), path.join(appRoot, ".next", "static"), { recursive: true });
  fs.cpSync(path.join(app, "public"), path.join(appRoot, "public"), { recursive: true });
  // 本地 .env 可能带密钥，部署那份只认运行环境变量。
  for (const name of fs.readdirSync(appRoot)) {
    if (name.startsWith(".env")) fs.rmSync(path.join(appRoot, name));
  }
  require("@next/env").loadEnvConfig(app, false);
  fs.writeFileSync(
    path.join(output, "runtime.json"),
    JSON.stringify(
      {
        SERVER_TARGET: process.env.SERVER_TARGET || "http://127.0.0.1:10004",
        APP_URL_PREFIX: process.env.APP_URL_PREFIX || "/api",
        NEXT_PUBLIC_CONSOLE_URL: process.env.NEXT_PUBLIC_CONSOLE_URL || "",
      },
      null,
      2,
    ),
  );
  console.log(`[portal] 构建完成：${output}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
