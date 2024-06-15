import type {
  Dictionary as CommonDictionary,
  Value,
} from '@commontools/data/interfaces/common-data-types.js';
import { IO as CommonIO } from '../../state/io/index.js';
import { infer } from './infer.js';
import { Reference } from './reference.js';
import { logger as console } from '../../helpers.js';

export class Dictionary implements CommonDictionary, CommonIO {
  #inner: any;

  constructor(inner: any) {
    this.#inner = inner;
  }

  read(key: string): Value | undefined {
    console.log(`Reading '${key}' from`, this.#inner);
    return infer(this.#inner[key]);
  }

  write(_key: string, _value: Value): void {
    throw new Error('Write into dictionary is not supported');
  }

  get(key: string): Reference | undefined {
    return new Reference(this, key);
  }
}
