import { ContentType } from '../index.js';
import { RuntimeEventHandler, RuntimeRequests } from '../rpc/runtime.js';
import {
  HANDSHAKE_EVENT,
  ModuleToHostRPC,
  RuntimeToHostRPC,
} from '../rpc/index.js';
import { DuplexState } from '../state/io/duplex.js';
import { StateSlice } from '../state/io/slice.js';
import {
  ModuleEventHandler,
  ModuleRequests,
  ModuleResponses,
} from '../rpc/module.js';
import { assertNever, logger as console } from '../helpers.js';
import { HostStorage } from '../state/storage/hoststorage.js';

export interface ThreadLocalModule {
  id: string;
  run: () => void;
}

export class ModuleInstance {
  // @ts-ignore
  #rpc;
  #storage;
  #input = new StateSlice(new Map());
  #output = new StateSlice(new Map());
  #inputKeys;

  #moduleInitializes;

  constructor(
    port: MessagePort,
    runtime: LocalRuntime,
    contentType: ContentType,
    sourceCode: string,
    inputKeys: string[]
  ) {
    const rpc = new ModuleToHostRPC(port, this.#handleRPCEvent);
    const storage = new HostStorage(rpc, inputKeys);

    this.#moduleInitializes = (async () => {
      await this.#input.populateFrom(storage, inputKeys);
      const io = new DuplexState(this.#input, this.#output);
      const module = await runtime.eval(contentType, sourceCode, io);

      return module;
    })();

    this.#inputKeys = inputKeys;
    this.#rpc = rpc;
    this.#storage = storage;
  }

  #handleRPCEvent = (async (event, detail) => {
    switch (event) {
      case 'module:run': {
        try {
          const module = await this.#moduleInitializes;
          await this.#input.populateFrom(this.#storage, this.#inputKeys);
          await module.run();
        } catch (error) {
          return {
            error: `${error}`,
          };
        }
        return {} as ModuleResponses['module:run'];
      }
      case 'module:output:read': {
        const { key } = detail as ModuleRequests['module:output:read'];

        return {
          value: this.#output.read(key),
        } as ModuleResponses['module:output:read'];
      }
    }

    return assertNever(event);
  }) as ModuleEventHandler;
}

export interface LocalRuntime {
  eval(
    contentType: ContentType,
    sourceCode: string,
    io: DuplexState
  ): Promise<ThreadLocalModule>;
}

export class RuntimeContext {
  // @ts-ignore
  #rpc: RuntimeToHostRPC | null = null;
  #instances = new Map<string, ModuleInstance>();
  #runtime;

  constructor(runtime: LocalRuntime) {
    this.#runtime = runtime;
    self.addEventListener('message', this.#handleGlobalMessage);
    console.log('Worker runtime context initialized');
  }

  #handleGlobalMessage = (event: MessageEvent) => {
    if (event.data != HANDSHAKE_EVENT) {
      console.warn('Ignoring unexpected message:', event.data);
      return;
    }

    console.log('Got handshake event', event);

    const [port] = event.ports;

    this.#rpc = new RuntimeToHostRPC(port, this.#handleRPCEvent);
    this.#rpc.send('rpc:handshake:confirmed', undefined);
  };

  #handleRPCEvent = (async (event, detail) => {
    switch (event) {
      case 'runtime:eval': {
        const { id, contentType, sourceCode, inputKeys, port } =
          detail as RuntimeRequests['runtime:eval'];

        try {
          const moduleInstance = await new ModuleInstance(
            port,
            this.#runtime,
            contentType,
            sourceCode,
            inputKeys
          );

          this.#instances.set(id, moduleInstance);
        } catch (error) {
          return {
            error: `${error}`,
          };
        }

        return {};
      }
    }

    return assertNever(event as never);
  }) as RuntimeEventHandler;
}
