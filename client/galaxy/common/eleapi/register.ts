import type { Product } from '../index';
import type { ApiClass } from './base';
import { BridgeApi } from './bridge.api';

/** One contract registry for both main and preload. New API modules are listed here once. */
export function registerApi(product: Product): readonly ApiClass[] {
  return product === 'nova' ? [BridgeApi] : [];
}
