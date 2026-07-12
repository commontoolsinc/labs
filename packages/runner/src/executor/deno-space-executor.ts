import type { WireMemoryProtocolFlags } from "@commonfabric/memory/v2";
import type { MemorySpace } from "@commonfabric/memory/interface";
import type { Server } from "@commonfabric/memory/v2/server";
import {
  createHostProviderChannel,
  type HostProviderChannel,
  type HostProviderChannelOptions,
} from "../storage/v2-host-provider.ts";
import type { ExperimentalOptions } from "../runtime.ts";
import type {
  SpaceExecutor,
  SpaceExecutorFactory,
  SpaceExecutorStartOptions,
} from "./shared-execution-pool.ts";

export interface ExecutorWorkerLike extends EventTarget {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  terminate(): void;
}

export interface DenoSpaceExecutorFactoryOptions {
  server: Server;
  apiUrl: URL;
  patternApiUrl?: URL;
  experimental?: ExperimentalOptions;
  protocolFlags?: Partial<WireMemoryProtocolFlags>;
  createWorker?: () => ExecutorWorkerLike;
  createProvider?: (
    options: HostProviderChannelOptions,
  ) => HostProviderChannel;
}

type WorkerResponse = {
  type: "booted" | "ready" | "complete" | "fatal";
  requestId?: number;
  message?: string;
};

const isWorkerResponse = (value: unknown): value is WorkerResponse => {
  if (typeof value !== "object" || value === null) return false;
  const message = value as Record<string, unknown>;
  return (message.type === "booted" || message.type === "ready" ||
    message.type === "complete" || message.type === "fatal") &&
    (message.requestId === undefined ||
      Number.isSafeInteger(message.requestId)) &&
    (message.message === undefined || typeof message.message === "string");
};

class DenoSpaceExecutor implements SpaceExecutor {
  readonly #worker: ExecutorWorkerLike;
  readonly #provider: HostProviderChannel;
  readonly #startOptions: SpaceExecutorStartOptions;
  readonly #pending = new Map<
    number,
    PromiseWithResolvers<void>
  >();
  readonly #booted = Promise.withResolvers<void>();
  #requestId = 0;
  #stopped = false;
  #failed = false;

  constructor(
    worker: ExecutorWorkerLike,
    provider: HostProviderChannel,
    startOptions: SpaceExecutorStartOptions,
  ) {
    this.#worker = worker;
    this.#provider = provider;
    this.#startOptions = startOptions;
    this.#worker.addEventListener("message", this.#onMessage);
    this.#worker.addEventListener("error", this.#onError);
    this.#worker.addEventListener("messageerror", this.#onMessageError);
  }

  async initialize(options: {
    apiUrl: URL;
    patternApiUrl?: URL;
    experimental?: ExperimentalOptions;
    protocolFlags?: Partial<WireMemoryProtocolFlags>;
  }): Promise<void> {
    await this.#booted.promise;
    await this.#request("initialize", {
      space: this.#startOptions.space,
      branch: this.#startOptions.branch,
      principal: this.#startOptions.lease.onBehalfOf,
      leaseGeneration: this.#startOptions.lease.leaseGeneration,
      pieces: [...this.#startOptions.pieces],
      port: this.#provider.port,
      apiUrl: options.apiUrl.href,
      patternApiUrl: (options.patternApiUrl ?? options.apiUrl).href,
      experimental: options.experimental ?? {},
      ...(options.protocolFlags !== undefined
        ? { protocolFlags: options.protocolFlags }
        : {}),
    }, [this.#provider.port]);
  }

  setDemand(pieces: readonly string[]): Promise<void> {
    return this.#request("set-demand", { pieces: [...pieces] });
  }

  wake(): Promise<void> {
    return this.#request("wake");
  }

  async stop(): Promise<void> {
    if (this.#stopped) return;
    this.#stopped = true;
    try {
      if (!this.#failed) await this.#request("stop");
    } finally {
      this.#detach();
      this.#worker.terminate();
      await this.#provider.dispose();
    }
  }

  #request(
    type: "initialize" | "set-demand" | "wake" | "stop",
    fields: Record<string, unknown> = {},
    transfer: Transferable[] = [],
  ): Promise<void> {
    if (this.#failed) {
      return Promise.reject(new Error("executor Worker failed"));
    }
    const requestId = ++this.#requestId;
    const pending = Promise.withResolvers<void>();
    this.#pending.set(requestId, pending);
    try {
      this.#worker.postMessage({ type, requestId, ...fields }, transfer);
    } catch (error) {
      this.#pending.delete(requestId);
      pending.reject(error);
    }
    return pending.promise;
  }

  #onMessage = (event: Event): void => {
    const message = (event as MessageEvent<unknown>).data;
    if (!isWorkerResponse(message)) {
      this.#fail(new Error("invalid executor Worker response"));
      return;
    }
    if (message.type === "booted") {
      this.#booted.resolve();
      return;
    }
    if (message.type === "fatal") {
      this.#fail(new Error(message.message ?? "executor Worker failed"));
      return;
    }
    if (message.requestId === undefined) {
      this.#fail(new Error("executor Worker response has no request id"));
      return;
    }
    const pending = this.#pending.get(message.requestId);
    if (pending === undefined) {
      this.#fail(new Error("executor Worker response is not pending"));
      return;
    }
    this.#pending.delete(message.requestId);
    pending.resolve();
  };

  #onError = (event: Event): void => {
    const error = event as ErrorEvent;
    error.preventDefault();
    this.#fail(error.error ?? new Error(error.message));
  };

  #onMessageError = (): void => {
    this.#fail(new Error("executor Worker message decoding failed"));
  };

  #fail(error: unknown): void {
    if (this.#failed || this.#stopped) return;
    this.#failed = true;
    const failure = error instanceof Error ? error : new Error(String(error));
    this.#booted.reject(failure);
    for (const pending of this.#pending.values()) pending.reject(failure);
    this.#pending.clear();
    this.#detach();
    this.#worker.terminate();
    void this.#provider.dispose();
    this.#startOptions.onCrash(failure);
  }

  #detach(): void {
    this.#worker.removeEventListener("message", this.#onMessage);
    this.#worker.removeEventListener("error", this.#onError);
    this.#worker.removeEventListener("messageerror", this.#onMessageError);
  }
}

/** Creates the host provider before the realm so accepted commits buffer. */
export class DenoSpaceExecutorFactory implements SpaceExecutorFactory {
  readonly #createWorker: () => ExecutorWorkerLike;
  readonly #createProvider: (
    options: HostProviderChannelOptions,
  ) => HostProviderChannel;

  constructor(readonly options: DenoSpaceExecutorFactoryOptions) {
    this.#createWorker = options.createWorker ??
      (() =>
        new Worker(new URL("./executor-worker.ts", import.meta.url).href, {
          type: "module",
          name: "common-fabric-space-executor",
        }));
    this.#createProvider = options.createProvider ?? createHostProviderChannel;
  }

  async start(options: SpaceExecutorStartOptions): Promise<SpaceExecutor> {
    const provider = this.#createProvider({
      server: this.options.server,
      space: options.space as MemorySpace,
      branch: options.branch,
      executionLease: options.lease,
    });
    let worker: ExecutorWorkerLike;
    try {
      worker = this.#createWorker();
    } catch (error) {
      await provider.dispose();
      throw error;
    }
    const executor = new DenoSpaceExecutor(worker, provider, options);
    try {
      await executor.initialize({
        apiUrl: this.options.apiUrl,
        patternApiUrl: this.options.patternApiUrl,
        experimental: this.options.experimental,
        protocolFlags: this.options.protocolFlags,
      });
      return executor;
    } catch (error) {
      await executor.stop();
      throw error;
    }
  }
}
