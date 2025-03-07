import { Value } from '../index.js';
import { StateSlice } from './io/slice.js';
import { Storage } from './storage/index.js';

export class Input implements Storage {
  #storage;
  #keys;

  constructor(storage: Storage, keys: string[]) {
    this.#storage = storage;
    this.#keys = keys;
  }

  read(key: string): Promise<Value | void> {
    if (this.#keys.includes(key)) {
      return this.#storage.read(key);
    } else {
      throw new Error(`Read of key '${key}' not allowed`);
    }
  }

  write(_key: string, _value: Value): Promise<void> {
    throw new Error('Method not implemented.');
  }

  get keys() {
    return this.#keys;
  }

  async toStateSlice(): Promise<StateSlice> {
    return StateSlice.fromStorage(this.#storage, this.#keys);
  }
}
