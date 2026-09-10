/** Renderer-safe API contracts. No Electron or Node runtime imports in this module. */
const invokeMethods = new WeakMap<object, Set<string>>();

export function Invoke(target: object, method: string, _descriptor: PropertyDescriptor): void {
  const methods = invokeMethods.get(target) ?? new Set<string>();
  methods.add(method);
  invokeMethods.set(target, methods);
}

export type ApiClass = new () => ElectronApi;
export type ExposedMethods = Record<string, (...args: unknown[]) => Promise<unknown>>;

export function getInvokeMethods(Api: ApiClass): string[] {
  const methods = new Set<string>();
  let prototype: object | null = Api.prototype;
  while (prototype && prototype !== ElectronApi.prototype) {
    invokeMethods.get(prototype)?.forEach(method => methods.add(method));
    prototype = Object.getPrototypeOf(prototype) as object | null;
  }
  return Array.from(methods);
}

export abstract class ElectronApi {
  abstract getApiName(): string;
  getNamespace(): string { return 'galaxy'; }
  getRendererName(): string { return `${this.getNamespace()}_${this.getApiName()}`; }

  isAvailable(): boolean {
    return typeof window !== 'undefined' && typeof (window as unknown as Record<string, unknown>)[this.getRendererName()] === 'object';
  }

  protected async invokeApi<T>(method: string, ...args: unknown[]): Promise<T> {
    if (!this.isAvailable()) throw new Error(`Electron API '${this.getRendererName()}' is unavailable`);
    const exposed = (window as unknown as Record<string, ExposedMethods>)[this.getRendererName()];
    if (typeof exposed?.[method] !== 'function') throw new Error(`Electron method '${method}' is unavailable`);
    return await exposed[method](...args) as T;
  }
}
