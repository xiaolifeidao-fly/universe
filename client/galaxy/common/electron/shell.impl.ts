import { shell } from 'electron';
import { ShellApi } from '../eleapi/shell.api';

/**
 * 把一个地址交给系统去开。和自动更新一样归**壳**管、不归端：
 * 两个端都有「页面里放了一条站外链接」的需求（Nova 的 ai-bridge 安装包、
 * Orbit 的 cc-switch 下载页），而窗口一律拒绝 window.open 与跨源跳转
 * （见 main.ts），所以这是页面唯一的出口。实现由 main.ts 统一补上。
 *
 * 只放行 http / https。
 *
 * 页面来自远端部署（见 common/electron/origin.ts），shell.openExternal 又是「交给系统去开」——
 * 不卡协议的话，能改那台服务器的人就能让这台电脑打开 file://、smb:// 或者随便哪个
 * 注册了协议的本机程序。控制台要开的只有下载地址，一律是 http(s)。
 */
export class ShellImpl extends ShellApi {
  override async openExternal(url: string): Promise<void> {
    let parsed: URL;
    try {
      parsed = new URL(String(url));
    } catch {
      throw new Error('只能打开 http/https 地址');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('只能打开 http/https 地址');
    await shell.openExternal(parsed.toString());
  }
}
