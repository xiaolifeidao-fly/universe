import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ElectronApi, Invoke, type ExposedMethods } from '../eleapi/base';
import { registerApi } from '../eleapi/register';
import { exposeApis, registerRpc } from './rpc';

class DemoApi extends ElectronApi {
  override getApiName(): string { return 'DemoApi'; }
  @Invoke
  echo(value: string): Promise<string> { return this.invokeApi('echo', value); }
}
class DemoImpl extends DemoApi {
  private prefix = 'bound:';
  override async echo(value: string): Promise<string> { return this.prefix + value; }
  internalHelper(): string { return 'must not be exposed'; }
}

test('same contracts automatically register, expose and invoke only marked API methods', async () => {
  const handlers = new Map<string, (event: { trusted: boolean }, ...args: unknown[]) => unknown>();
  const ipc = {
    handle: (channel: string, handler: (event: { trusted: boolean }, ...args: unknown[]) => unknown) => { handlers.set(channel, handler); },
    removeHandler: (channel: string) => { handlers.delete(channel); },
  };
  const dispose = registerRpc(ipc, [DemoApi], [new DemoImpl()], event => event.trusted);
  const exposed: Record<string, ExposedMethods> = {};
  exposeApis([DemoApi], (name, api) => { exposed[name] = api; }, async (channel, ...args) => handlers.get(channel)!({ trusted: true }, ...args));
  assert.deepEqual([...handlers.keys()], ['galaxy_DemoApi.echo']);
  assert.deepEqual(Object.keys(exposed.galaxy_DemoApi), ['echo']);
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: exposed });
  try { assert.equal(await new DemoApi().echo('hello'), 'bound:hello'); }
  finally {
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  }
  assert.throws(() => handlers.get('galaxy_DemoApi.echo')!({ trusted: false }, 'secret'), /access denied/);
  dispose();
  assert.equal(handlers.size, 0);
});

test('registration fails before exposure when implementation or registry is invalid', () => {
  const ipc = { handle: () => { throw new Error('must validate before registering'); }, removeHandler: () => {} };
  assert.throws(() => registerRpc(ipc, [DemoApi], [], () => true), /Missing or duplicate/);
  assert.throws(() => registerRpc(ipc, [DemoApi], [new DemoApi()], () => true), /Missing implementation/);
  assert.throws(() => registerRpc(ipc, [DemoApi, DemoApi], [new DemoImpl()], () => true), /Duplicate Electron API/);
  assert.throws(() => registerRpc(ipc, [], [new DemoImpl()], () => true), /no registered contract/);
  assert.deepEqual(registerApi('orbit').map(Api => new Api().getRendererName()), ['galaxy_ClientConfigApi', 'galaxy_KeyVaultApi']);
  assert.deepEqual(registerApi('nova').map(Api => new Api().getRendererName()), ['galaxy_BridgeApi', 'galaxy_ShellApi']);
});

test('a failed IPC registration rolls back already installed handlers', () => {
  class MultiApi extends DemoApi { @Invoke async second(): Promise<void> {} }
  class MultiImpl extends MultiApi { override async echo(value: string): Promise<string> { return value; } override async second(): Promise<void> {} }
  const removed: string[] = [];
  let count = 0;
  assert.throws(() => registerRpc({
    handle: () => { if (++count === 2) throw new Error('channel conflict'); },
    removeHandler: channel => { removed.push(channel); },
  }, [MultiApi], [new MultiImpl()], () => true), /channel conflict/);
  assert.deepEqual(removed, ['galaxy_DemoApi.second']);
});
