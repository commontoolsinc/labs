import { Value } from '@commontools/data/interfaces/common-data-types.js';

export interface Storage {
  read(key: string): Promise<Value | void>;
  write(key: string, value: Value): Promise<void>;
}
