import { shell } from 'electron';
import { ShellApi } from '@galaxy/common/eleapi/shell.api';

/**
 * 只放行 http / https。
 *
 * 页面来自远端部署（见 common/electron/origin.ts），shell.openExternal 又是「交给系统去开」——
 * 不卡协议的话，能改那台服务器的人就能让这台电脑打开 file://、smb:// 或者随便哪个
 * 注册了协议的本机程序。控制台要开的只有安装包下载地址，一律是 http(s)。
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
