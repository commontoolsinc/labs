import type { Value } from '@commontools/data/interfaces/common-data-types.js';
import { Dictionary } from './dictionary.js';

/**
 * Attempts to infer a `Value` from any given JS value. See data.wit for a
 * reference of all possible variants of `Value`. Inference has marginal cost;
 * it is more efficient to avoid it if you can.
 *
 * NOTE: Currently "array" `Value` types aren't really going to work.
 * Stick to "string", "number", "boolean", "buffer" and "dictionary".
 */
export const infer = (value: any): Value | undefined => {
  const val = value;
  let tag: string = typeof value;

  switch (tag) {
    case 'string':
    case 'boolean':
    case 'number':
      return {
        tag,
        val,
      };
    case 'object': {
      if (Array.isArray(val)) {
        return {
          tag: 'array',
          val,
        };
      }

      if (val instanceof Uint8Array) {
        return {
          tag: 'buffer',
          val,
        };
      }

      // NOTE: `typeof null == 'object'`
      if (val) {
        return {
          tag: 'dictionary',
          val: new Dictionary(val),
        };
      }
    }
  }

  return undefined;
};
