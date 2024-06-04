import type {
  Value,
  Reference as CommonReference,
} from '@commontools/data/interfaces/common-data-types.js';
import { IO } from './io.js';

export class Reference implements CommonReference {
  #io;
  #key;

  constructor(io: IO, key: string) {
    // TODO: Validate attempt to read (aka attempt to create a Reference) here
    this.#io = io;
    this.#key = key;
  }

  deref(): Value | undefined {
    return this.#io.read(this.#key);
  }
}
