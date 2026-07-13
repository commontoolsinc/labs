import {
  ActionClaimKey,
  actionClaimMapKey,
  ExecutionClaim,
  type WireMemoryProtocolFlags,
  wireMemoryProtocolFlags,
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
import type { ExecutorWriterDiscovery } from "./writer-discovery.ts";
import {
  isServerExecutableBuiltinId,
  type ServerExecutableBuiltinId,
} from "../builtins/server-execution.ts";
import {
  type AuthorizedServerBuiltinRequest,
  createServerBuiltinBrokerHost,
  type ServerBuiltinBrokerContext,
  type ServerBuiltinBrokerHost,
} from "./server-builtin-channel.ts";
import type { ServerBuiltinFetchBroker } from "./server-builtin-egress.ts";
import {
  authorizeDefaultServerBuiltinRequest,
  createDefaultServerBuiltinBroker,
} from "./server-builtin-transport.ts";

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
  onWriterDiscovery?: (discovery: ExecutorWriterDiscovery) => void;
  createWorker?: () => ExecutorWorkerLike;
  createProvider?: (
    options: HostProviderChannelOptions,
  ) => HostProviderChannel;
  createBuiltinBroker?: (
    context: ServerBuiltinBrokerContext,
  ) => ServerBuiltinFetchBroker;
  authorizeBuiltinRequest?: (
    request: AuthorizedServerBuiltinRequest,
    context: ServerBuiltinBrokerContext,
  ) => void | Promise<void>;
  /** Claim-deadline seams keep renewal tests deterministic. */
  now?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => number;
  clearTimer?: (timer: number) => void;
  /** Maximum time for Worker boot plus initialize acknowledgement. */
  startupTimeoutMs?: number;
}

export interface CandidateClaim {
  readonly claimKey: ActionClaimKey;
  readonly builtinId?: ServerExecutableBuiltinId;
  /** Worker-side demand epoch; stale closure candidates are ignored after a
   * demanded-root shrink rebuilds the runtime graph. */
  readonly demandGeneration?: number;
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
    | "settled"
    | "fatal"
    | "candidate-claim"
    | "candidate-diagnostic"
    | "invalidated-claim"
    | "writer-discovery"
    | "unserved-claim";
  requestId?: number;
  message?: string;
  candidate?: CandidateClaim;
  diagnostic?: CandidateClaimDiagnostic;
  discovery?: ExecutorWriterDiscovery;
  claim?: ExecutionClaim;
  diagnosticCode?: string;
  dataSeq?: number;
};

const isWorkerResponse = (value: unknown): value is WorkerResponse => {
  if (typeof value !== "object" || value === null) return false;
  const message = value as Record<string, unknown>;
  return (message.type === "booted" || message.type === "ready" ||
    message.type === "complete" || message.type === "settled" ||
    message.type === "fatal" ||
    message.type === "candidate-claim" ||
    message.type === "candidate-diagnostic" ||
    message.type === "invalidated-claim" ||
    message.type === "writer-discovery" ||
    message.type === "unserved-claim") &&
    (message.requestId === undefined ||
      Number.isSafeInteger(message.requestId)) &&
    (message.message === undefined || typeof message.message === "string") &&
    (message.type !== "settled" ||
      (Number.isSafeInteger(message.dataSeq) &&
        Number(message.dataSeq) >= 0)) &&
    (message.type !== "candidate-claim" ||
      isCandidateClaim(message.candidate)) &&
    (message.type !== "candidate-diagnostic" ||
      isCandidateClaimDiagnostic(message.diagnostic)) &&
    (message.type !== "writer-discovery" ||
      isExecutorWriterDiscovery(message.discovery)) &&
    ((message.type !== "unserved-claim" &&
      message.type !== "invalidated-claim") ||
      (isExecutionClaim(message.claim) &&
        typeof message.diagnosticCode === "string" &&
        message.diagnosticCode.length > 0));
};

const isExecutorWriterDiscovery = (
  value: unknown,
): value is ExecutorWriterDiscovery => {
  if (typeof value !== "object" || value === null) return false;
  const discovery = value as Record<string, unknown>;
  return typeof discovery.pieceId === "string" &&
    typeof discovery.indexMiss === "boolean" &&
    Array.isArray(discovery.writers) && discovery.writers.every((value) => {
      if (typeof value !== "object" || value === null) return false;
      const writer = value as Record<string, unknown>;
      return typeof writer.branch === "string" &&
        (writer.ownerSpace === undefined ||
          typeof writer.ownerSpace === "string") &&
        typeof writer.pieceId === "string" &&
        Number.isSafeInteger(writer.processGeneration) &&
        typeof writer.actionId === "string" &&
        (writer.actionKind === "computation" ||
          writer.actionKind === "effect" ||
          writer.actionKind === "event-handler") &&
        typeof writer.implementationFingerprint === "string" &&
        typeof writer.runtimeFingerprint === "string" &&
        (writer.source === "live" || writer.source === "durable" ||
          writer.source === "live+durable");
    });
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
  const candidate = value as {
    claimKey?: unknown;
    builtinId?: unknown;
    demandGeneration?: unknown;
  };
  if (
    candidate.builtinId !== undefined &&
    !isServerExecutableBuiltinId(candidate.builtinId)
  ) {
    return false;
  }
  if (
    candidate.demandGeneration !== undefined &&
    (!Number.isSafeInteger(candidate.demandGeneration) ||
      Number(candidate.demandGeneration) < 0)
  ) {
    return false;
  }
  const claim = candidate.claimKey;
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
  actionClaimMapKey(candidate.claimKey);

class DenoSpaceExecutor implements SpaceExecutor {
  readonly #worker: ExecutorWorkerLike;
  readonly #provider: HostProviderChannel;
  readonly #builtinBrokerHost: ServerBuiltinBrokerHost;
  readonly #builtinBrokerPort: MessagePort;
  readonly #startOptions: SpaceExecutorStartOptions;
  readonly #server: Server;
  readonly #protocolFlags: Partial<WireMemoryProtocolFlags>;
  readonly #onCandidateClaim?: (candidate: CandidateClaim) => void;
  readonly #onCandidateDiagnostic?: (
    diagnostic: CandidateClaimDiagnostic,
  ) => void;
  readonly #onWriterDiscovery?: (discovery: ExecutorWriterDiscovery) => void;
  readonly #claims = new Map<string, ExecutionClaim>();
  readonly #claimRenewalTimers = new Map<string, number>();
  readonly #demandedPieces: Set<string>;
  readonly #now: () => number;
  readonly #setTimer: (callback: () => void, delayMs: number) => number;
  readonly #clearTimer: (timer: number) => void;
  readonly #startupTimeoutMs: number;
  readonly #pending = new Map<
    number,
    PromiseWithResolvers<WorkerResponse>
  >();
  readonly #booted = Promise.withResolvers<void>();
  #claimControl = Promise.resolve();
  #requestId = 0;
  #demandGeneration = 0;
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
      onWriterDiscovery?: (discovery: ExecutorWriterDiscovery) => void;
      createBuiltinBroker: (
        context: ServerBuiltinBrokerContext,
      ) => ServerBuiltinFetchBroker;
      authorizeBuiltinRequest: (
        request: AuthorizedServerBuiltinRequest,
        context: ServerBuiltinBrokerContext,
      ) => void | Promise<void>;
      servingOrigin: URL;
      now: () => number;
      setTimer: (callback: () => void, delayMs: number) => number;
      clearTimer: (timer: number) => void;
      startupTimeoutMs: number;
    },
  ) {
    this.#worker = worker;
    this.#provider = provider;
    this.#startOptions = startOptions;
    this.#demandedPieces = new Set(startOptions.pieces);
    this.#now = control.now;
    this.#setTimer = control.setTimer;
    this.#clearTimer = control.clearTimer;
    this.#startupTimeoutMs = control.startupTimeoutMs;
    this.#server = control.server;
    this.#protocolFlags = control.protocolFlags ?? {};
    this.#onCandidateClaim = control.onCandidateClaim;
    this.#onCandidateDiagnostic = control.onCandidateDiagnostic;
    this.#onWriterDiscovery = control.onWriterDiscovery;
    const builtinChannel = new MessageChannel();
    const brokerContext: ServerBuiltinBrokerContext = {
      space: startOptions.space as MemorySpace,
      branch: startOptions.branch,
      leaseGeneration: startOptions.lease.leaseGeneration,
      onBehalfOf: startOptions.lease.onBehalfOf,
      servingOrigin: new URL(control.servingOrigin),
    };
    this.#builtinBrokerHost = createServerBuiltinBrokerHost({
      port: builtinChannel.port1,
      context: brokerContext,
      broker: control.createBuiltinBroker(brokerContext),
      isClaimLive: (claim) => this.#isClaimLive(claim),
      authorize: control.authorizeBuiltinRequest,
    });
    this.#builtinBrokerPort = builtinChannel.port2;
    this.#worker.addEventListener("message", this.#onMessage);
    this.#worker.addEventListener("error", this.#onError);
    this.#worker.addEventListener("messageerror", this.#onMessageError);
  }

  async initialize(options: {
    apiUrl: URL;
    patternApiUrl?: URL;
    experimental?: ExperimentalOptions;
    protocolFlags?: Partial<WireMemoryProtocolFlags>;
    signal?: AbortSignal;
  }): Promise<void> {
    const startup = (async () => {
      await this.#booted.promise;
      options.signal?.throwIfAborted();
      await this.#request("initialize", {
        space: this.#startOptions.space,
        branch: this.#startOptions.branch,
        principal: this.#startOptions.lease.onBehalfOf,
        leaseGeneration: this.#startOptions.lease.leaseGeneration,
        pieces: [...this.#startOptions.pieces],
        port: this.#provider.port,
        builtinBrokerPort: this.#builtinBrokerPort,
        apiUrl: options.apiUrl.href,
        patternApiUrl: (options.patternApiUrl ?? options.apiUrl).href,
        experimental: options.experimental ?? {},
        ...(options.protocolFlags !== undefined
          ? { protocolFlags: options.protocolFlags }
          : {}),
      }, [this.#provider.port, this.#builtinBrokerPort]);
    })();
    await this.#awaitStartup(startup, options.signal);
  }

  async #awaitStartup(
    startup: Promise<void>,
    signal?: AbortSignal,
  ): Promise<void> {
    const timeout = Promise.withResolvers<void>();
    const timer = this.#setTimer(
      () =>
        timeout.reject(
          new Error(
            `executor Worker did not initialize within ${this.#startupTimeoutMs}ms`,
          ),
        ),
      this.#startupTimeoutMs,
    );
    const aborted = Promise.withResolvers<void>();
    const onAbort = () =>
      aborted.reject(
        signal?.reason instanceof Error
          ? signal.reason
          : new Error("executor Worker startup was cancelled"),
      );
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
    try {
      await Promise.race([startup, timeout.promise, aborted.promise]);
    } finally {
      this.#clearTimer(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  async setDemand(pieces: readonly string[]): Promise<void> {
    const next = new Set(pieces);
    const shrunk = [...this.#demandedPieces].some((piece) => !next.has(piece));
    if (shrunk) {
      this.#demandGeneration++;
      await this.#claimControl;
      this.#revokeClaims();
    }
    await this.#request("set-demand", {
      pieces: [...next],
      demandGeneration: this.#demandGeneration,
      resetClaims: shrunk,
    });
    this.#demandedPieces.clear();
    for (const piece of next) this.#demandedPieces.add(piece);
  }

  async wake(): Promise<void> {
    await this.#request("wake");
  }

  async settle(): Promise<number> {
    const response = await this.#request("settle");
    if (response.type !== "settled" || response.dataSeq === undefined) {
      throw new Error("executor Worker returned an invalid settle barrier");
    }
    return response.dataSeq;
  }

  async stop(options: { abrupt?: boolean } = {}): Promise<void> {
    if (this.#stopped) return;
    this.#stopped = true;
    try {
      await this.#claimControl;
      if (options.abrupt === true) {
        const error = new Error("executor Worker stopped abruptly");
        this.#booted.reject(error);
        this.#rejectPending(error);
      } else if (!this.#failed) {
        await this.#request("stop");
      }
    } finally {
      this.#revokeClaims();
      this.#detach();
      this.#worker.terminate();
      this.#builtinBrokerHost.dispose();
      await this.#provider.dispose();
    }
  }

  #request(
    type: "initialize" | "set-demand" | "wake" | "settle" | "stop",
    fields: Record<string, unknown> = {},
    transfer: Transferable[] = [],
  ): Promise<WorkerResponse> {
    if (this.#failed) {
      return Promise.reject(new Error("executor Worker failed"));
    }
    const requestId = ++this.#requestId;
    const pending = Promise.withResolvers<WorkerResponse>();
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
    if (message.type === "writer-discovery") {
      this.#onWriterDiscovery?.(message.discovery!);
      return;
    }
    if (
      message.type === "unserved-claim" ||
      message.type === "invalidated-claim"
    ) {
      const claim = message.claim!;
      const diagnosticCode = message.diagnosticCode!;
      this.#claimControl = this.#claimControl.then(
        () => this.#handleClaimRelease(claim, diagnosticCode),
        () => this.#handleClaimRelease(claim, diagnosticCode),
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
    pending.resolve(message);
  };

  async #handleCandidate(candidate: CandidateClaim): Promise<void> {
    this.#onCandidateClaim?.(candidate);
    if ((candidate.demandGeneration ?? 0) !== this.#demandGeneration) return;
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
        (this.#protocolFlags.serverPrimaryExecutionBuiltinPassivityV1 ===
            true && isServerExecutableBuiltinId(candidate.builtinId)));
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
    this.#scheduleClaimRenewal(claim);
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

  #handleClaimRelease(
    claim: ExecutionClaim,
    diagnosticCode: string,
  ): void {
    const mapKey = candidateKey({ claimKey: claim });
    const live = this.#claims.get(mapKey);
    if (
      live === undefined || live.leaseGeneration !== claim.leaseGeneration ||
      live.claimGeneration !== claim.claimGeneration
    ) {
      throw new Error("executor claim release does not match a live claim");
    }
    this.#revokeClaim(live);
    this.#claims.delete(mapKey);
    this.#cancelClaimRenewal(mapKey);
    this.#onCandidateDiagnostic?.({ claim: live, diagnosticCode });
  }

  #scheduleClaimRenewal(claim: ExecutionClaim): void {
    const key = candidateKey({ claimKey: claim });
    this.#cancelClaimRenewal(key);
    const remaining = Math.max(1, claim.expiresAt - this.#now());
    const timer = this.#setTimer(() => {
      this.#claimRenewalTimers.delete(key);
      if (this.#stopped || this.#failed) return;
      const renew = () => this.#renewClaim(claim);
      this.#claimControl = this.#claimControl.then(renew, renew).catch((
        error,
      ) => this.#fail(error));
    }, Math.max(1, Math.floor(remaining / 2)));
    this.#claimRenewalTimers.set(key, timer);
  }

  async #renewClaim(expected: ExecutionClaim): Promise<void> {
    const key = candidateKey({ claimKey: expected });
    const live = this.#claims.get(key);
    if (
      live === undefined || live.leaseGeneration !== expected.leaseGeneration ||
      live.claimGeneration !== expected.claimGeneration || this.#stopped ||
      this.#failed
    ) return;
    const renewed = await this.#server.renewExecutionClaim(
      this.#startOptions.lease,
      live,
    );
    if (renewed === null) {
      throw new Error("executor claim renewal lost authority");
    }
    if (this.#stopped || this.#failed) {
      this.#revokeClaim(renewed);
      return;
    }
    this.#claims.set(key, renewed);
    this.#scheduleClaimRenewal(renewed);
  }

  #cancelClaimRenewal(key: string): void {
    const timer = this.#claimRenewalTimers.get(key);
    if (timer === undefined) return;
    this.#clearTimer(timer);
    this.#claimRenewalTimers.delete(key);
  }

  #isClaimLive(claim: ExecutionClaim): boolean {
    const live = this.#claims.get(candidateKey({ claimKey: claim }));
    if (
      live === undefined || live.leaseGeneration !== claim.leaseGeneration ||
      live.claimGeneration !== claim.claimGeneration
    ) {
      return false;
    }
    const serverGate = (this.#server as Partial<Server> & {
      hasLiveExecutionClaim?: (candidate: ExecutionClaim) => boolean;
    }).hasLiveExecutionClaim;
    return typeof serverGate === "function"
      ? serverGate.call(this.#server, claim)
      : claim.expiresAt > Date.now();
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
    this.#builtinBrokerHost.dispose();
    void this.#provider.dispose();
    this.#startOptions.onCrash(failure);
  }

  #revokeClaims(): void {
    for (const timer of this.#claimRenewalTimers.values()) {
      this.#clearTimer(timer);
    }
    this.#claimRenewalTimers.clear();
    for (const claim of this.#claims.values()) {
      this.#revokeClaim(claim);
    }
    this.#claims.clear();
  }

  #rejectPending(error: Error): void {
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
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
  readonly options: DenoSpaceExecutorFactoryOptions;
  readonly #createWorker: () => ExecutorWorkerLike;
  readonly #createProvider: (
    options: HostProviderChannelOptions,
  ) => HostProviderChannel;
  readonly #createBuiltinBroker: (
    context: ServerBuiltinBrokerContext,
  ) => ServerBuiltinFetchBroker;

  constructor(options: DenoSpaceExecutorFactoryOptions) {
    this.options = {
      ...options,
      protocolFlags: options.protocolFlags ??
        wireMemoryProtocolFlags(options.server.memoryProtocolFlags()),
    };
    if (
      this.options.startupTimeoutMs !== undefined &&
      (!Number.isSafeInteger(this.options.startupTimeoutMs) ||
        this.options.startupTimeoutMs <= 0)
    ) {
      throw new TypeError(
        "executor startup timeout must be a positive integer",
      );
    }
    this.#createWorker = this.options.createWorker ??
      (() =>
        new Worker(new URL("./executor-worker.ts", import.meta.url).href, {
          type: "module",
          name: "common-fabric-space-executor",
        }));
    this.#createProvider = this.options.createProvider ??
      createHostProviderChannel;
    this.#createBuiltinBroker = this.options.createBuiltinBroker ??
      ((context) =>
        this.options.protocolFlags
            ?.serverPrimaryExecutionBuiltinPassivityV1 === true
          ? createDefaultServerBuiltinBroker({
            servingOrigin: context.servingOrigin,
          })
          : {
            fetch: () =>
              Promise.reject(
                new Error("server builtin passivity is not negotiated"),
              ),
          });
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
      onWriterDiscovery: this.options.onWriterDiscovery,
      createBuiltinBroker: this.#createBuiltinBroker,
      authorizeBuiltinRequest: this.options.authorizeBuiltinRequest ??
        authorizeDefaultServerBuiltinRequest,
      servingOrigin: this.options.patternApiUrl ?? this.options.apiUrl,
      now: this.options.now ?? Date.now,
      setTimer: this.options.setTimer ??
        ((callback, delayMs) =>
          setTimeout(callback, delayMs) as unknown as number),
      clearTimer: this.options.clearTimer ??
        ((timer) =>
          clearTimeout(timer as unknown as ReturnType<typeof setTimeout>)),
      startupTimeoutMs: this.options.startupTimeoutMs ?? 30_000,
    });
    try {
      await executor.initialize({
        apiUrl: this.options.apiUrl,
        patternApiUrl: this.options.patternApiUrl,
        experimental: this.options.experimental,
        protocolFlags: this.options.protocolFlags,
        signal: options.signal,
      });
      return executor;
    } catch (error) {
      await executor.stop({ abrupt: true });
      throw error;
    }
  }
}
