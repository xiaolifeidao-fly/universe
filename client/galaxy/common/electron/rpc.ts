import { type ApiClass, type ElectronApi, type ExposedMethods, getInvokeMethods } from '../eleapi/base';

export interface IpcRegistrar<Event> {
  handle(channel: string, listener: (event: Event, ...args: unknown[]) => unknown): void;
  removeHandler(channel: string): void;
}

/** Build from contracts, never enumerate implementation helpers for exposure. */
export function registerRpc<Event>(ipc: IpcRegistrar<Event>, contracts: readonly ApiClass[], implementations: readonly ElectronApi[], isTrusted: (event: Event) => boolean): () => void {
  const pending = new Map<string, (...args: unknown[]) => unknown>();
  const names = new Set<string>();
  for (const Contract of contracts) {
    const name = new Contract().getRendererName();
    if (names.has(name)) throw new Error(`Duplicate Electron API: ${name}`);
    names.add(name);
    const matches = implementations.filter(instance => instance.getRendererName() === name);
    const implementation = matches[0];
    if (matches.length !== 1 || !(implementation instanceof Contract)) throw new Error(`Missing or duplicate implementation: ${name}`);
    for (const method of getInvokeMethods(Contract)) {
      const fn: unknown = Reflect.get(implementation, method);
      if (typeof fn !== 'function' || fn === Reflect.get(Contract.prototype, method)) throw new Error(`Missing implementation: ${name}.${method}`);
      pending.set(`${name}.${method}`, (...args: unknown[]) => Reflect.apply(fn, implementation, args));
    }
  }
  if (implementations.some(instance => !names.has(instance.getRendererName()))) throw new Error('Implementation has no registered contract');
  const registered: string[] = [];
  const dispose = () => { for (const channel of registered.splice(0)) ipc.removeHandler(channel); };
  try {
    for (const [channel, invoke] of pending) {
      ipc.handle(channel, (event, ...args) => {
        if (!isTrusted(event)) throw new Error('Electron API access denied');
        return invoke(...args);
      });
      registered.push(channel);
    }
  } catch (error) { dispose(); throw error; }
  return dispose;
}

export function exposeApis(contracts: readonly ApiClass[], expose: (name: string, api: ExposedMethods) => void, invoke: (channel: string, ...args: unknown[]) => Promise<unknown>): void {
  const names = new Set<string>();
  const entries = contracts.map(Contract => {
    const name = new Contract().getRendererName();
    if (names.has(name)) throw new Error(`Duplicate Electron API: ${name}`);
    names.add(name);
    const api: ExposedMethods = {};
    for (const method of getInvokeMethods(Contract)) api[method] = (...args) => invoke(`${name}.${method}`, ...args);
    return { name, api };
  });
  for (const { name, api } of entries) expose(name, api);
}
