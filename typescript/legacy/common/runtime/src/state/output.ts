import { Value } from '@commontools/data/interfaces/common-data-types.js';
import { HostToModuleRPC } from '../rpc/index.js';
import { Storage } from './storage/index.js';

export class Output implements Storage {
  #rpc;
  #keys;

  constructor(rpc: HostToModuleRPC, keys: string[]) {
    this.#rpc = rpc;
    this.#keys = keys;
  }

  async read(key: string): Promise<void | Value> {
    if (this.#keys.includes(key)) {
      return await this.#rpc.send('module:output:read', { key });
    }
  }

  async write(_key: string, _value: Value): Promise<void> {
    throw new Error('Writing to outputs is not allowed.');
  }
}
