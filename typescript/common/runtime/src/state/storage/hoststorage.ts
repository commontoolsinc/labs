import { throwIfError } from '../../helpers.js';
import { Value } from '../../index.js';
import { ModuleToHostRPC } from '../../rpc/index.js';
import { DuplexState } from '../io/duplex.js';
import { StateSlice } from '../io/slice.js';
import { Storage } from './index.js';

export class HostStorage implements Storage {
  #rpc;
  #inputKeys;

  constructor(rpc: ModuleToHostRPC, inputKeys: string[]) {
    this.#rpc = rpc;
    this.#inputKeys = inputKeys;
  }

  async read(key: string): Promise<Value | void> {
    if (this.#inputKeys.includes(key)) {
      const result = await this.#rpc.send('host:storage:read', {
        key,
      });

      if (!throwIfError(result)) {
        return result.value;
      }
    }
    throw new Error(`Read of key '${key}' not allowed`);
  }

  write(_key: string, _value: Value): Promise<void> {
    throw new Error('Method not implemented.');
  }

  async toDuplexState(): Promise<DuplexState> {
    const input = await StateSlice.fromStorage(this, this.#inputKeys);
    const output = new StateSlice(new Map());

    return new DuplexState(input, output);
  }
}
