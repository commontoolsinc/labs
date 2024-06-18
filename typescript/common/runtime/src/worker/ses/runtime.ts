import {
  StaticModuleRecord,
  lockdown,
  Compartment,
} from '@commontools/usuba-ses';
import { LocalRuntime, ThreadLocalModule } from '../index.js';
import type { Value } from '../../index.js';
import { Reference } from '../../common/data/reference.js';
import { logger as console } from '../../helpers.js';
import * as api from '@commontools/usuba-api';
import { DuplexState } from '../../state/io/duplex.js';

export class RuntimeSESWorker implements LocalRuntime {
  constructor() {
    console.log('SES locking down...');
    lockdown();
    console.log('SES locked down!');
  }

  async eval(
    _contentType: 'text/javascript',
    sourceCode: string,
    io: DuplexState
  ): Promise<ThreadLocalModule> {
    const commonIO = harden({
      read(name: string) {
        return new Reference(io, name);
      },
      write(name: string, value: Value) {
        io.write(name, value);
      },
    });

    const bundledSourceCode = await api.bundleJavascript({
      formData: {
        source: [
          new File(
            [new Blob([sourceCode], { type: 'text/javascript' })],
            'interior.js'
          ),
        ],
      },
    });

    const commonIOCompartment = new Compartment(
      {
        io: commonIO,
      },
      {},
      {
        importHook: async (specifier: string) => {
          console.log('Importing:', specifier);
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
          console.log('Resolving:', specifier);
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
          console.log('Importing:', specifier);
          if (specifier == 'interior') {
            return new StaticModuleRecord(bundledSourceCode, specifier);
          }

          if (specifier.startsWith('https://')) {
            // yolo dont do this
            return new StaticModuleRecord(
              await (await fetch(specifier)).text(),
              specifier
            );
          }

          throw new Error(
            `Attempt to import unrecognized module '${specifier}'`
          );
        },
        resolveHook: (specifier: string) => {
          console.warn('Resolving:', specifier);
          if (
            specifier == 'interior' ||
            specifier == 'common:io/state@0.0.1' ||
            specifier.startsWith('https://')
          ) {
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
