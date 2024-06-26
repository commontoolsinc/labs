import type { Value } from '@commontools/data/interfaces/common-data-types.js';

export interface IO {
  read(key: string): Value | undefined;
  write(key: string, value: Value): void;
}

export interface FiniteIO extends IO {
  get keys(): string[];
  serialize(): { [index: string]: Value };
}
