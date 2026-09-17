/**
 * 从 assets/icons/<端>.svg 生出各平台要的图标文件。
 *
 * 母版只有一份 SVG，别的全是它的产物 —— 改图标只改那一份，然后跑
 * `npm run icons`，不要手工去动 .icns / .ico。
 *
 * 光栅化用的是工作区里已经有的 Electron（同一个 Chromium），不引第三方
 * 图形库，也不依赖本机装没装 ImageMagick / librsvg：装了 Electron 就能出图。
 * 本文件既是 node 侧的调度，也是 electron 侧的渲染入口 —— 靠
 * process.versions.electron 分流，省掉一个只有十几行的伴生文件。
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const products = Object.keys(require('../common').products);
// 画布按 1024 出，小尺寸一律从它降采样：浏览器在 16px 上直接画矢量会把
// 星芒和轨道抗锯齿成一团灰，降采样反而更干净。
const CANVAS = 1024;
const WIN_SIZES = [16, 24, 32, 48, 64, 128, 256];
const LINUX_SIZES = [32, 64, 128, 256, 512];
// icns 的每一条都是「四字类型 + PNG」。10.7 以后的 macOS 直接读 PNG，
// 所以不需要 iconutil，自己拼一个容器就行，Windows/Linux 上也能跑。
const ICNS_TYPES = [['icp4', 16], ['icp5', 32], ['ic11', 32], ['ic12', 64], ['ic07', 128], ['ic13', 256], ['ic08', 256], ['ic14', 512], ['ic09', 512], ['ic10', 1024]];

/**
 * macOS 的图标不是满幅方块：系统图标都缩在 1024 画布里的 824 见方，
 * 底下垫一层落影。满幅的那份放进 Dock 会比邻居大一圈，一眼就出戏。
 */
function macVariant(svg) {
  const inner = svg.replace('width="1024" height="1024"', 'x="100" y="100" width="824" height="824"');
  if (inner === svg) throw new Error('母版的根节点得是 width="1024" height="1024"，mac 变体靠替换它来内缩');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024">
  <defs>
    <filter id="mac-shadow" x="-25%" y="-25%" width="150%" height="150%" color-interpolation-filters="sRGB">
      <feDropShadow dx="0" dy="16" stdDeviation="18" flood-color="#000000" flood-opacity="0.3"/>
    </filter>
  </defs>
  <g filter="url(#mac-shadow)">${inner}</g>
</svg>`;
}

/**
 * 加到手机主屏时用的那张：iOS 会自己把图标切成圆角并垫上背景，
 * 所以这一份要满幅直角 —— 带透明圆角交上去，圆角处会被压成黑的。
 */
function squareVariant(svg) {
  // 只摘 <rect> 上的圆角：<ellipse> 的 rx 是轨道的长半轴，一起摘掉图案就没了。
  const square = svg.replace(/(<rect\b[^>]*?) rx="[\d.]+"/g, '$1');
  if (square === svg) throw new Error('母版的底板得是带 rx 的圆角矩形，方形变体靠去掉它来生成');
  return square;
}

function ico(pngs) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(pngs.length, 4);
  let offset = 6 + pngs.length * 16;
  const entries = pngs.map(({ size, data }) => {
    const entry = Buffer.alloc(16);
    entry[0] = size >= 256 ? 0 : size;   // 256 在这个字节里写 0，格式就是这么定的
    entry[1] = size >= 256 ? 0 : size;
    entry.writeUInt16LE(1, 4); entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(data.length, 8); entry.writeUInt32LE(offset, 12);
    offset += data.length;
    return entry;
  });
  return Buffer.concat([header, ...entries, ...pngs.map(p => p.data)]);
}

function icns(entries) {
  const chunks = entries.map(({ type, data }) => {
    const head = Buffer.alloc(8);
    head.write(type, 0, 4, 'ascii');
    head.writeUInt32BE(data.length + 8, 4);
    return Buffer.concat([head, data]);
  });
  const body = Buffer.concat(chunks);
  const head = Buffer.alloc(8);
  head.write('icns', 0, 4, 'ascii');
  head.writeUInt32BE(body.length + 8, 4);
  return Buffer.concat([head, body]);
}

function render(jobs) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'galaxy-icons-')), 'jobs.json');
  fs.writeFileSync(file, JSON.stringify(jobs));
  const result = spawnSync(require('electron'), [__filename, file], { stdio: ['ignore', 'inherit', 'inherit'] });
  if (result.error || result.status !== 0) throw result.error || new Error('Electron 渲染图标失败');
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
}

async function renderInElectron() {
  const { app, BrowserWindow } = require('electron');
  const jobs = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('force-color-profile', 'srgb');
  await app.whenReady();
  // 离屏窗口不上屏，跑 CI 或者 ssh 进来手动补图标时也不会弹一个窗。
  const win = new BrowserWindow({ width: CANVAS, height: CANVAS, show: false, frame: false, transparent: true, webPreferences: { offscreen: true } });
  for (const job of jobs) {
    const html = `<html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0;background:transparent;overflow:hidden}svg{display:block;width:${CANVAS}px;height:${CANVAS}px}</style></head><body>${fs.readFileSync(job.svg, 'utf8')}</body></html>`;
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    await new Promise(resolve => setTimeout(resolve, 150));
    const shot = await win.webContents.capturePage();
    for (const [size, out] of Object.entries(job.out)) {
      // Retina 上抓下来的是 2048，非 Retina 是 1024，统一按目标尺寸缩一次。
      const n = Number(size);
      const image = shot.getSize().width === n ? shot : shot.resize({ width: n, height: n, quality: 'best' });
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, image.toPNG());
    }
  }
  win.destroy();
  app.quit();
}

function buildIcons() {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'galaxy-icons-'));
  const jobs = [];
  for (const product of products) {
    const master = path.join(root, 'assets', 'icons', `${product}.svg`);
    if (!fs.existsSync(master)) throw new Error(`缺母版：${master}`);
    const mac = path.join(work, `${product}-mac.svg`);
    fs.writeFileSync(mac, macVariant(fs.readFileSync(master, 'utf8')));
    const square = path.join(work, `${product}-square.svg`);
    fs.writeFileSync(square, squareVariant(fs.readFileSync(master, 'utf8')));
    const flat = {}, shadowed = {};
    for (const size of new Set([...WIN_SIZES, ...LINUX_SIZES])) flat[size] = path.join(work, `${product}-flat-${size}.png`);
    for (const [, size] of ICNS_TYPES) shadowed[size] = path.join(work, `${product}-mac-${size}.png`);
    jobs.push({ svg: master, out: flat }, { svg: mac, out: shadowed }, { svg: square, out: { 180: path.join(work, `${product}-square-180.png`) } });
  }
  render(jobs);

  for (const product of products) {
    const build = path.join(root, product, 'electron', 'build');
    const flat = size => fs.readFileSync(path.join(work, `${product}-flat-${size}.png`));
    fs.mkdirSync(path.join(build, 'icons'), { recursive: true });
    fs.writeFileSync(path.join(build, 'icon.icns'), icns(ICNS_TYPES.map(([type, size]) => ({ type, data: fs.readFileSync(path.join(work, `${product}-mac-${size}.png`)) }))));
    fs.writeFileSync(path.join(build, 'icon.ico'), ico(WIN_SIZES.map(size => ({ size, data: flat(size) }))));
    // Linux 要的是一组按边长命名的 PNG，electron-builder 照文件名认尺寸。
    for (const size of LINUX_SIZES) fs.writeFileSync(path.join(build, 'icons', `${size}x${size}.png`), flat(size));

    // 窗口与任务栏图标（Windows/Linux 用；macOS 用安装包里的 .icns）。
    const assets = path.join(root, product, 'electron', 'assets');
    fs.mkdirSync(assets, { recursive: true });
    fs.writeFileSync(path.join(assets, 'icon.png'), flat(512));

    // 浏览器里的页签图标：App Router 认 src/app 下的 icon / apple-icon。
    const web = path.join(root, product, 'webview', 'src', 'app');
    fs.copyFileSync(path.join(root, 'assets', 'icons', `${product}.svg`), path.join(web, 'icon.svg'));
    fs.copyFileSync(path.join(work, `${product}-square-180.png`), path.join(web, 'apple-icon.png'));
    console.log(`${product}: icon.icns / icon.ico / icons/*.png / assets/icon.png / webview icon`);
  }
  fs.rmSync(work, { recursive: true, force: true });
}

if (process.versions.electron) renderInElectron().catch(error => { console.error(error); process.exit(1); });
else if (require.main === module) { buildIcons(); }
module.exports = { buildIcons };
