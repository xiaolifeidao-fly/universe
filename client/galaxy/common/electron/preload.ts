import { contextBridge, ipcRenderer } from 'electron';
import type { Product } from '../index';
import { registerApi } from '../eleapi/register';
import { exposeApis } from './rpc';

export function registerPreload(product: Product): void {
  exposeApis(registerApi(product),
    (name, api) => contextBridge.exposeInMainWorld(name, api),
    (channel, ...args) => ipcRenderer.invoke(channel, ...args),
  );
  contextBridge.exposeInMainWorld('galaxyDesktop', { product });
}
