import { wit as commonDataWit } from '@commontools/data';
import { wit as commonIoWit } from '@commontools/io';
import { wit as commonModuleWit } from '@commontools/module';
import { Runtime as UsubaRuntime } from '@commontools/usuba-rt';

import { Dictionary, Reference, Value } from '../../index.js';
import { GuestRuntime, ThreadLocalModule } from '../index.js';
import { IO } from '../../state/io/index.js';

export class RuntimeWasmWorker implements GuestRuntime {
  #inner = new UsubaRuntime([commonDataWit, commonIoWit]);

  async eval(
    contentType: 'text/javascript',
    sourceCode: string,
    io: IO
  ): Promise<ThreadLocalModule> {
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

    const innerModule = module.create();
    return {
      id: blueprint.id(),
      run() {
        return innerModule.run();
      },
    };
  }
}
