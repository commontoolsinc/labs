import { Value } from '@commontools/data/interfaces/common-data-types.js';
import { Storage } from './index.js';

export class HostLocalStorage implements Storage {
  async read(key: string): Promise<void | Value> {
    const serialized = localStorage.getItem(key);
    return serialized ? JSON.parse(serialized) : undefined;
  }

  async write(key: string, value: Value): Promise<void> {
    const serialized = JSON.stringify(value);
    localStorage.setItem(key, serialized);
  }
}
