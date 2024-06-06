import { Runtime as UsubaRuntime } from '@commontools/usuba-rt';
import { wit as commonDataWit } from '@commontools/data';
import { wit as commonIoWit } from '@commontools/io';
import { wit as commonModuleWit } from '@commontools/module';
import type { Value } from '@commontools/data/interfaces/common-data-types.js';
import type { IO } from './io.js';
import { Reference } from './reference.js';
import { Dictionary } from './dictionary.js';

export type { Value } from '@commontools/data/interfaces/common-data-types.js';

export * from './io.js';
export * from './dictionary.js';
export * from './reference.js';
export * from './infer.js';

export type ContentType = 'text/javascript';

export interface Module {
  run: () => void;
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
        Dictionary,
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
