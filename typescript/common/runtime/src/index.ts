import { Runtime as UsubaRuntime } from '@commontools/usuba-rt';
import { wit as commonDataWit } from '@commontools/data';
import { wit as commonIoWit } from '@commontools/io';
import { wit as commonModuleWit } from '@commontools/module';
import type { Value } from '@commontools/data/interfaces/common-data-types.js';
import type { IO } from './state/io/index.js';
import { Reference } from './reference.js';
import { Dictionary } from './dictionary.js';

export type { Value } from '@commontools/data/interfaces/common-data-types.js';

export * from './state/io/index.js';
export * from './dictionary.js';
export * from './reference.js';
export * from './infer.js';

export type ContentType = 'text/javascript';

export type Sandbox = 'ses' | 'wasm' | 'confidential-compute';

export interface Module {
  run: () => Promise<void>;
}

export class Runtime {
  #wasm = new UsubaRuntime([commonDataWit, commonIoWit]);

  async eval(
    sandbox: Sandbox,
    contentType: ContentType,
    sourceCode: string,
    io: IO
  ): Promise<Module> {
    switch (sandbox) {
      case 'ses':
        break;
      case 'wasm':
        return this.#evalWasm(contentType, sourceCode, io);
      case 'confidential-compute':
        break;
    }

    throw new Error(`Medium '${sandbox}' not (yet) supported!`);
  }

  #evalSes = async (contentType: ContentType, sourceCode: string, io: IO): Promise<Module> {

  }

  #evalWasm = async (
    contentType: ContentType,
    sourceCode: string,
    io: IO
  ): Promise<Module> => {
    const blueprint = await this.#wasm.defineModule<{
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
        Any: class {},
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
  };
}
