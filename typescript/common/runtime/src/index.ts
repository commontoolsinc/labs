import { WorkerPool } from './worker/pool.js';
import { Input } from './state/input.js';
import { HostToModuleRPC } from './rpc/index.js';
import { Output } from './state/output.js';
import { assertNever, throwIfError } from './helpers.js';
import { HostModuleEventHandler } from './rpc/host.js';

export type { Value } from '@commontools/data/interfaces/common-data-types.js';

export * from './state/io/index.js';
export * from './state/input.js';
export * from './state/output.js';
export * from './state/storage/index.js';
export * from './state/storage/localstorage.js';
export * from './common/data/dictionary.js';
export * from './common/data/reference.js';
export * from './common/data/infer.js';

export type ContentType = 'text/javascript';

export const SES_SANDBOX = 'ses';
export const WASM_SANDBOX = 'wasm';
export const CONFIDENTIAL_COMPUTE_SANDBOX = 'confidential-compute';

export type Sandbox =
  | typeof SES_SANDBOX
  | typeof WASM_SANDBOX
  | typeof CONFIDENTIAL_COMPUTE_SANDBOX;

export class Module {
  #rpc;
  #input;

  constructor(port: MessagePort, input: Input) {
    this.#rpc = new HostToModuleRPC(port, this.#handleModuleRPCEvent);
    this.#input = input;
  }

  async run(): Promise<void> {
    throwIfError(await this.#rpc.send('module:run', undefined));
  }

  output(keys: string[]) {
    return new Output(this.#rpc, keys);
  }

  #handleModuleRPCEvent = (async (event, detail) => {
    switch (event) {
      case 'host:storage:read':
        try {
          return {
            value: await this.#input.read(detail.key),
          };
        } catch (error) {
          return {
            error: `${error}`,
          };
        }
    }

    return assertNever(event as never);
  }) as HostModuleEventHandler;
}

export class Runtime {
  #workerPool = new WorkerPool();

  async eval(
    id: string,
    sandbox: Sandbox,
    contentType: 'text/javascript',
    sourceCode: string,
    input: Input
  ): Promise<Module> {
    const { rpc: runtimeRpc } = await this.#workerPool.get(sandbox);
    const { port1: moduleTx, port2: moduleRx } = new MessageChannel();
    const module = new Module(moduleTx, input);

    throwIfError(
      await runtimeRpc.send(
        'runtime:eval',
        {
          id,
          contentType,
          sourceCode,
          inputKeys: input.keys,
          port: moduleRx,
        },
        [moduleRx]
      )
    );

    return module;
  }
}
