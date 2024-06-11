import {
  StaticModuleRecord,
  lockdown,
  Compartment,
} from '@commontools/usuba-ses';
import { LocalRuntime, ThreadLocalModule } from '../index.js';
import { IO } from '../../state/io/index.js';
import type { Value } from '../../index.js';
import { Reference } from '../../common/data/reference.js';

export class RuntimeSESWorker implements LocalRuntime {
  constructor() {
    console.log('LOCKING DOWN');
    lockdown();
    console.log('LOCKED DOWN OKAY');
  }

  async eval(
    _contentType: 'text/javascript',
    sourceCode: string,
    io: IO
  ): Promise<ThreadLocalModule> {
    const commonIO = harden({
      read(name: string) {
        return new Reference(io, name);
      },
      write(name: string, value: Value) {
        io.write(name, value);
      },
    });

    const commonIOCompartment = new Compartment(
      {
        io: commonIO,
      },
      {},
      {
        importHook: async (specifier: string) => {
          console.warn('IMPORT HOOK:', specifier);
          if (specifier == 'common:io/state@0.0.1') {
            return new StaticModuleRecord(
              'export const read = io.read; export const write = io.write;',
              'common:io/state@0.0.1'
            );
          }
          throw new Error(
            `Attempt to import unrecognized module '${specifier}'`
          );
        },
        resolveHook: (specifier: string) => {
          console.warn('RESOLVE HOOK:', specifier);
          if (specifier == 'common:io/state@0.0.1') {
            return 'common:io/state@0.0.1';
          }
          throw new Error(
            `Attempt to resolve unrecognized module '${specifier}'`
          );
        },
      }
    );

    const interiorModule = new Compartment(
      {
        console: harden(console),
      },
      {
        'common:io/state@0.0.1': commonIOCompartment.module(
          'common:io/state@0.0.1'
        ),
      },
      {
        importHook: async (specifier: string) => {
          console.warn('IMPORT HOOK:', specifier);
          if (specifier == 'interior') {
            return new StaticModuleRecord(sourceCode, 'interior');
          }
          throw new Error(
            `Attempt to import unrecognized module '${specifier}'`
          );
        },
        resolveHook: (specifier: string) => {
          console.warn('RESOLVE HOOK:', specifier);
          if (specifier == 'interior' || specifier == 'common:io/state@0.0.1') {
            return specifier;
          }
          throw new Error(
            `Attempt to resolve unrecognized module '${specifier}'`
          );
        },
      }
    );

    const moduleImport = await interiorModule.import('interior');
    const innerModule = moduleImport?.namespace?.module?.create();

    if (!innerModule) {
      throw new Error('Illegible module exports');
    }

    return {
      id: 'hand-wave',
      run() {
        return innerModule.run();
      },
    };
  }
}
