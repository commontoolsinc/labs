import { assertNever } from '../helpers.js';
import { Sandbox, WASM_SANDBOX } from '../index.js';
import { HostWorkerEventHandler } from '../rpc/host.js';
import { HostToRuntimeRPC, HANDSHAKE_EVENT } from '../rpc/index.js';

export type WorkerContext = {
  worker: Worker;
  rpc: HostToRuntimeRPC;
};

export class WorkerPool {
  // TODO: Support multiple workers per sandbox type and some kind
  // of policy-based compartmentalization for them
  #categories = new Map<Sandbox, Promise<WorkerContext>>();

  async get(sandbox: Sandbox): Promise<WorkerContext> {
    // TODO: Handle worker failure cases
    if (!this.#categories.has(sandbox)) {
      console.log(`Creating new worker for '${sandbox}' modules`);
      this.#categories.set(
        sandbox,
        new Promise<WorkerContext>((resolve) => {
          const worker = this.#makeWorkerForSandbox(sandbox);
          const { port1: port, port2: workerPort } = new MessageChannel();

          const rpc: HostToRuntimeRPC = new HostToRuntimeRPC(
            port,
            this.#makeRpcEventHandler(() =>
              resolve({
                worker,
                rpc,
              })
            )
          );

          setTimeout(() => {
            console.log('Sending handshake');
            worker.postMessage(HANDSHAKE_EVENT, [workerPort]);
          }, 1000);
        })
      );
    }

    return this.#categories.get(sandbox)!;
  }

  #makeWorkerForSandbox = (sandbox: Sandbox) => {
    // NOTE: We use string literals for worker scripts so that bundlers (e.g.,
    // Vite) will correctly identify the file paths and bundle them.
    //
    // https://vitejs.dev/guide/features.html#web-workers:~:text=The%20worker%20detection%20will%20only%20work%20if%20the%20new%20URL()%20constructor%20is%20used%20directly%20inside%20the%20new%20Worker()%20declaration.%20Additionally%2C%20all%20options%20parameters%20must%20be%20static%20values%20(i.e.%20string%20literals).

    switch (sandbox) {
      case WASM_SANDBOX:
        return new Worker(new URL('./wasm/index.js', import.meta.url), {
          type: 'module',
        });
      default:
        throw new Error(`Sandbox type '${sandbox}' not yet supported`);
    }
  };

  #makeRpcEventHandler = (resolve: () => void) =>
    (async (event, _detail) => {
      switch (event) {
        case 'rpc:handshake:confirmed': {
          return resolve();
        }
      }
      return assertNever(event as never);
    }) as HostWorkerEventHandler;
}
