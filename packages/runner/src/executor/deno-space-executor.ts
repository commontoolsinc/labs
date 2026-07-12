import type {
  ActionClaimKey,
  ExecutionClaim,
  WireMemoryProtocolFlags,
} from "@commonfabric/memory/v2";
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
  /** Host-local shadow diagnostic. Receiving one never transfers authority;
   * the explicit claim-routing sub-capability controls that separately. */
  onCandidateClaim?: (candidate: CandidateClaim) => void;
  onCandidateDiagnostic?: (diagnostic: CandidateClaimDiagnostic) => void;
  createWorker?: () => ExecutorWorkerLike;
  createProvider?: (
    options: HostProviderChannelOptions,
  ) => HostProviderChannel;
}

export interface CandidateClaim {
  readonly claimKey: ActionClaimKey;
}

export interface CandidateClaimDiagnostic {
  readonly diagnosticCode: string;
  readonly claimKey?: ActionClaimKey;
  readonly claim?: ExecutionClaim;
}

type WorkerResponse = {
  type:
    | "booted"
    | "ready"
    | "complete"
    | "fatal"
    | "candidate-claim"
    | "candidate-diagnostic"
    | "unserved-claim";
  requestId?: number;
  message?: string;
  candidate?: CandidateClaim;
  diagnostic?: CandidateClaimDiagnostic;
  claim?: ExecutionClaim;
  diagnosticCode?: string;
};

const isWorkerResponse = (value: unknown): value is WorkerResponse => {
  if (typeof value !== "object" || value === null) return false;
  const message = value as Record<string, unknown>;
  return (message.type === "booted" || message.type === "ready" ||
    message.type === "complete" || message.type === "fatal" ||
    message.type === "candidate-claim" ||
    message.type === "candidate-diagnostic" ||
    message.type === "unserved-claim") &&
    (message.requestId === undefined ||
      Number.isSafeInteger(message.requestId)) &&
    (message.message === undefined || typeof message.message === "string") &&
    (message.type !== "candidate-claim" ||
      isCandidateClaim(message.candidate)) &&
    (message.type !== "candidate-diagnostic" ||
      isCandidateClaimDiagnostic(message.diagnostic)) &&
    (message.type !== "unserved-claim" ||
      (isExecutionClaim(message.claim) &&
        typeof message.diagnosticCode === "string" &&
        message.diagnosticCode.length > 0));
};

const isCandidateClaimDiagnostic = (
  value: unknown,
): value is CandidateClaimDiagnostic => {
  if (typeof value !== "object" || value === null) return false;
  const diagnostic = value as Record<string, unknown>;
  return typeof diagnostic.diagnosticCode === "string" &&
    diagnostic.diagnosticCode.length > 0 &&
    (diagnostic.claimKey === undefined ||
      isCandidateClaim({ claimKey: diagnostic.claimKey })) &&
    (diagnostic.claim === undefined || isExecutionClaim(diagnostic.claim));
};

const isCandidateClaim = (value: unknown): value is CandidateClaim => {
  if (typeof value !== "object" || value === null) return false;
  const claim = (value as { claimKey?: unknown }).claimKey;
  if (typeof claim !== "object" || claim === null) return false;
  const key = claim as Record<string, unknown>;
  return typeof key.branch === "string" && typeof key.space === "string" &&
    key.contextKey === "space" && typeof key.pieceId === "string" &&
    typeof key.actionId === "string" &&
    (key.actionKind === "computation" || key.actionKind === "effect") &&
    typeof key.implementationFingerprint === "string" &&
    typeof key.runtimeFingerprint === "string";
};

const isExecutionClaim = (value: unknown): value is ExecutionClaim => {
  if (typeof value !== "object" || value === null) return false;
  const claim = value as ExecutionClaim;
  return isCandidateClaim({ claimKey: claim }) &&
    Number.isSafeInteger(claim.leaseGeneration) &&
    claim.leaseGeneration > 0 && Number.isSafeInteger(claim.claimGeneration) &&
    claim.claimGeneration > 0 && Number.isFinite(claim.expiresAt);
};

const candidateKey = (candidate: CandidateClaim): string =>
  JSON.stringify({
    branch: candidate.claimKey.branch,
    space: candidate.claimKey.space,
    contextKey: candidate.claimKey.contextKey,
    pieceId: candidate.claimKey.pieceId,
    actionId: candidate.claimKey.actionId,
    actionKind: candidate.claimKey.actionKind,
    implementationFingerprint: candidate.claimKey.implementationFingerprint,
    runtimeFingerprint: candidate.claimKey.runtimeFingerprint,
  });

class DenoSpaceExecutor implements SpaceExecutor {
  readonly #worker: ExecutorWorkerLike;
  readonly #provider: HostProviderChannel;
  readonly #startOptions: SpaceExecutorStartOptions;
  readonly #server: Server;
  readonly #protocolFlags: Partial<WireMemoryProtocolFlags>;
  readonly #onCandidateClaim?: (candidate: CandidateClaim) => void;
  readonly #onCandidateDiagnostic?: (
    diagnostic: CandidateClaimDiagnostic,
  ) => void;
  readonly #claims = new Map<string, ExecutionClaim>();
  readonly #pending = new Map<
    number,
    PromiseWithResolvers<void>
  >();
  readonly #booted = Promise.withResolvers<void>();
  #claimControl = Promise.resolve();
  #requestId = 0;
  #stopped = false;
  #failed = false;

  constructor(
    worker: ExecutorWorkerLike,
    provider: HostProviderChannel,
    startOptions: SpaceExecutorStartOptions,
    control: {
      server: Server;
      protocolFlags?: Partial<WireMemoryProtocolFlags>;
      onCandidateClaim?: (candidate: CandidateClaim) => void;
      onCandidateDiagnostic?: (diagnostic: CandidateClaimDiagnostic) => void;
    },
  ) {
    this.#worker = worker;
    this.#provider = provider;
    this.#startOptions = startOptions;
    this.#server = control.server;
    this.#protocolFlags = control.protocolFlags ?? {};
    this.#onCandidateClaim = control.onCandidateClaim;
    this.#onCandidateDiagnostic = control.onCandidateDiagnostic;
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
      await this.#claimControl;
      if (!this.#failed) await this.#request("stop");
    } finally {
      this.#revokeClaims();
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
    if (message.type === "candidate-claim") {
      const candidate = message.candidate!;
      this.#claimControl = this.#claimControl.then(
        () => this.#handleCandidate(candidate),
        () => this.#handleCandidate(candidate),
      ).catch((error) => this.#fail(error));
      return;
    }
    if (message.type === "candidate-diagnostic") {
      this.#onCandidateDiagnostic?.(message.diagnostic!);
      return;
    }
    if (message.type === "unserved-claim") {
      const claim = message.claim!;
      const diagnosticCode = message.diagnosticCode!;
      this.#claimControl = this.#claimControl.then(
        () => this.#handleUnserved(claim, diagnosticCode),
        () => this.#handleUnserved(claim, diagnosticCode),
      ).catch((error) => this.#fail(error));
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

  async #handleCandidate(candidate: CandidateClaim): Promise<void> {
    this.#onCandidateClaim?.(candidate);
    const key = candidate.claimKey;
    if (
      key.space !== this.#startOptions.space ||
      key.branch !== this.#startOptions.branch
    ) {
      throw new Error("executor CandidateClaim escaped its bound lane");
    }
    const routingEnabled =
      this.#protocolFlags.serverPrimaryExecutionV1 === true &&
      this.#protocolFlags.serverPrimaryExecutionClaimRoutingV1 === true &&
      (key.actionKind !== "effect" ||
        this.#protocolFlags.serverPrimaryExecutionBuiltinPassivityV1 === true);
    const mapKey = candidateKey(candidate);
    if (!routingEnabled || this.#claims.has(mapKey) || this.#stopped) return;

    const claim = await this.#server.setExecutionClaim(
      this.#startOptions.lease,
      key,
    );
    if (this.#stopped || this.#failed) {
      this.#revokeClaim(claim);
      return;
    }
    this.#claims.set(mapKey, claim);
    this.#worker.postMessage({
      type: "run-claimed-action",
      claim,
      assertion: {
        contextKey: claim.contextKey,
        leaseGeneration: claim.leaseGeneration,
        claimGeneration: claim.claimGeneration,
      },
    });
  }

  #handleUnserved(
    claim: ExecutionClaim,
    diagnosticCode: string,
  ): void {
    const mapKey = candidateKey({ claimKey: claim });
    const live = this.#claims.get(mapKey);
    if (
      live === undefined || live.leaseGeneration !== claim.leaseGeneration ||
      live.claimGeneration !== claim.claimGeneration
    ) {
      throw new Error("unserved executor attempt does not match a live claim");
    }
    this.#revokeClaim(live);
    this.#claims.delete(mapKey);
    this.#onCandidateDiagnostic?.({ claim: live, diagnosticCode });
  }

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
    this.#revokeClaims();
    this.#detach();
    this.#worker.terminate();
    void this.#provider.dispose();
    this.#startOptions.onCrash(failure);
  }

  #revokeClaims(): void {
    for (const claim of this.#claims.values()) {
      this.#revokeClaim(claim);
    }
    this.#claims.clear();
  }

  #revokeClaim(claim: ExecutionClaim): void {
    const revoke = (this.#server as Partial<Server>).revokeExecutionClaim;
    if (typeof revoke === "function") revoke.call(this.#server, claim);
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
      shadowWrites: true,
    });
    let worker: ExecutorWorkerLike;
    try {
      worker = this.#createWorker();
    } catch (error) {
      await provider.dispose();
      throw error;
    }
    const executor = new DenoSpaceExecutor(worker, provider, options, {
      server: this.options.server,
      protocolFlags: this.options.protocolFlags,
      onCandidateClaim: this.options.onCandidateClaim,
      onCandidateDiagnostic: this.options.onCandidateDiagnostic,
    });
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
