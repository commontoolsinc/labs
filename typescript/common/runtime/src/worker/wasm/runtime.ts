import { wit as commonDataWit } from '@commontools/data';
import { wit as commonIoWit } from '@commontools/io';
import { wit as commonModuleWit } from '@commontools/module';
import { Runtime as UsubaRuntime } from '@commontools/usuba-rt';

import { Dictionary, Reference, Value } from '../../index.js';
import { LocalRuntime, ThreadLocalModule } from '../index.js';
import { DuplexState } from '../../state/io/duplex.js';

export class RuntimeWasmWorker implements LocalRuntime {
  #inner = new UsubaRuntime([commonDataWit, commonIoWit]);

  async eval(
    contentType: 'text/javascript',
    sourceCode: string,
    io: DuplexState
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
