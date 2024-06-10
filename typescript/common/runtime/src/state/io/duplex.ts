import { Value } from '@commontools/data/interfaces/common-data-types.js';
import { IO } from './index.js';

export class DuplexState implements IO {
  #i;
  #o;

  get input() {
    return this.#i;
  }

  get output() {
    return this.#o;
  }

  constructor(i: IO, o: IO) {
    this.#i = i;
    this.#o = o;
  }

  read(key: string): Value | undefined {
    return this.#i.read(key);
  }

  write(key: string, value: Value): void {
    return this.#o.write(key, value);
  }
}
