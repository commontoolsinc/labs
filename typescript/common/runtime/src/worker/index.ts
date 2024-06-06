import { ContentType } from '../index.js';
import { GuestEvents, GuestResponses } from '../ipc/guest.js';
import { HANDSHAKE_EVENT, IPCEventHandler, IPCGuest } from '../ipc/index.js';
import { DuplexState } from '../state/io/duplex.js';
import { IO } from '../state/io/index.js';
import { StateSlice } from '../state/io/slice.js';

export interface GuestRuntime {
  eval(
    contentType: ContentType,
    sourceCode: string,
    io: IO
  ): Promise<ThreadLocalModule>;
}

export interface ThreadLocalModule {
  id: string;
  run: () => void;
}

export interface Invocation {
  module: ThreadLocalModule;
  output: IO;
}

export class RuntimeWorkerContext {
  // @ts-ignore
  #ipc: IPCGuest | null = null;
  #invocations: Map<string, Invocation> = new Map();
  #runtime;

  constructor(runtime: GuestRuntime) {
    this.#runtime = runtime;
    self.addEventListener('message', this.#onGlobalMessage);
  }

  #onGlobalMessage = (event: MessageEvent) => {
    if (event.data != HANDSHAKE_EVENT) {
      console.warn('Ignoring unexpected message:', event.data);
      return;
    }

    const [port] = event.ports;
    this.#ipc = new IPCGuest(
      port,
      this.#onIPCMessage as IPCEventHandler<GuestEvents, GuestResponses>
    );
  };

  // TODO: Fix the types on this
  #onIPCMessage = async (name: keyof GuestEvents, detail: unknown) => {
    switch (name) {
      case 'module:eval': {
        const { contentType, sourceCode, state } =
          detail as GuestEvents['module:eval'];

        const input = new StateSlice(state);
        const output = new StateSlice(new Map());
        const io = new DuplexState(input, output);
        const module = await this.#runtime.eval(contentType, sourceCode, io);

        // TODO: This accounts well for the case where we have only unique modules, but it does not account for same modules w/ different state
        this.#invocations.set(module.id, {
          module,
          output,
        });

        return {};
      }
      case 'module:run': {
        const { id } = detail as GuestEvents['module:run'];
        const module = this.#invocations.get(id)?.module;

        if (!module) {
          return {
            error: `Module '${id}' does not exist`,
          };
        }
        try {
          module.run();
        } catch (error) {
          return {
            error: error?.toString() || 'Unknown error',
          };
        }
        return {};
      }
      case 'output:read': {
        const { id, key } = detail as GuestEvents['output:read'];
        const invocation = this.#invocations.get(id);

        if (!invocation) {
          return {
            error: `Module '${id}' does not exist`,
          };
        }

        const { output } = invocation;
        const value = output.read(key);

        return {
          value,
        };
      }
    }
    throw new Error('Unexpected IPC message:', name);
  };
}
