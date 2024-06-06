import { Value } from '@commontools/data/interfaces/common-data-types.js';
import { IO } from './index.js';
import { Storage } from '../storage/index.js';

export class StateSlice implements IO {
  #table;

  constructor(table: Map<string, Value>) {
    this.#table = table;
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

  static async fromStorage(storage: Storage, keys: string[]) {
    const values = [];

    for (const key of keys) {
      values.push(storage.read(key).then((value) => [key, value]));
    }

    return new StateSlice(
      (await Promise.all(values)).reduce((map, [key, value]) => {
        map.set(key, value);
        return map;
      }, new Map())
    );
  }
}
