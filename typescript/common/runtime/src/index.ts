import { Runtime as UsubaRuntime } from '@commontools/usuba-rt';
import { wit as commonDataWit } from '@commontools/data';
import { wit as commonIoWit } from '@commontools/io';
import { wit as commonModuleWit } from '@commontools/module';
import type {
  Value,
  Reference as CommonReference,
} from '@commontools/data/interfaces/common-data-types.js';

export type * from '@commontools/data/interfaces/common-data-types.js';

export type ContentType = 'text/javascript';

export interface IO {
  read: (key: string) => Value | undefined;
  write: (key: string, value: Value) => void;
}

export interface Module {
  run: () => void;
}

/**
 * Attempts to infer a `Value` from any given JS value. See data.wit for a
 * reference of all possible variants of `Value`. Inference has marginal cost;
 * it is more efficient to avoid it if you can.
 *
 * NOTE: Currently "array" and "map" `Value` types aren't really going to work.
 * Stick to "string", "number", "boolean" and "buffer".
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
    default: {
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
    }
  }

  return undefined;
};

class Reference implements CommonReference {
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

export class Runtime {
  #inner = new UsubaRuntime([commonDataWit, commonIoWit]);

  async eval(
    contentType: ContentType,
    sourceCode: string,
    io: IO
  ): Promise<Module> {
    const blueprint = await this.#inner.defineModule<{
      module: { create(): { run: () => void } };
    }>({
      contentType,
      sourceCode,
      wit: commonModuleWit,
    });

    const { module } = await blueprint.instantiate({
      'common:data/types': {
        Reference,
        Map,
      },
      'common:io/state': {
        read(name: string) {
          return new Reference(io, name);
        },
        write(name: string, value: Value) {
          io.write(name, value);
        },
      },
    });

    return module.create();
  }
}
