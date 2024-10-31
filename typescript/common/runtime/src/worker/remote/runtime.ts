import { Value } from '../../index.js';
import { DuplexState } from '../../state/io/duplex.js';
import { LocalRuntime, ThreadLocalModule } from '../index.js';
import * as api from '@commontools/usuba-api';

export class RuntimeRemoteWorker implements LocalRuntime {
  async eval(
    contentType: 'text/javascript',
    sourceCode: string,
    io: DuplexState
  ): Promise<ThreadLocalModule> {
    return {
      id: 'mega-hand-wave',
      async run() {
        // S-tier hand-wave: instantiation is happening on every call to run
        const { outputs } = await api.evalRecipe({
          requestBody: {
            content_type: contentType,
            inputs: io.input.serialize(),
            source_code: sourceCode,
          },
        });

        for (const [key, value] of Object.entries(outputs)) {
          io.write(key, value as Value);
        }
      },
    };
  }
}
