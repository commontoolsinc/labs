import { Value } from '@commontools/data/interfaces/common-data-types.js';
import { FiniteIO } from './index.js';
import { Storage } from '../storage/index.js';

export class StateSlice implements FiniteIO {
  #table;

  constructor(table: Map<string, Value>) {
    this.#table = table;
  }

  get keys(): string[] {
    return Array.from(this.#table.keys());
  }

  serialize(): { [index: string]: Value } {
    let serialized: { [index: string]: Value } = {};

    for (const [key, value] of this.#table.entries()) {
      serialized[key] = value;
    }

    return serialized;
  }

  table(): Map<string, Value> {
    return this.#table;
  }

  clone(): StateSlice {
    const table = new Map();
    for (const [key, value] of this.#table.entries()) {
      table.set(key, value);
    }
    return new StateSlice(table);
  }

  freeze() {
    Object.freeze(this.#table);
  }

  read(key: string): Value | undefined {
    return this.#table.get(key);
  }

  write(key: string, value: Value): void {
    this.#table.set(key, value);
  }

  async populateFrom(storage: Storage, keys: string[]) {
    const values: Promise<[string, Value | void]>[] = [];

    for (const key of keys) {
      values.push(
        storage.read(key).then((value: Value | void) => [key, value])
      );
    }

    (await Promise.all(values)).reduce((map, [key, value]) => {
      if (typeof value !== 'undefined') {
        map.set(key, value);
      }
      return map;
    }, this.#table);
  }

  static async fromStorage(storage: Storage, keys: string[]) {
    let state = new StateSlice(new Map());
    await state.populateFrom(storage, keys);
    return state;
  }
}
