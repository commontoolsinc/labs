import {
  ActionClaimKey,
  actionClaimMapKey,
  ExecutionClaim,
  parseSessionExecutionContextKey,
  principalOfUserContextKey,
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
  ExecutorExecutionMetricsSnapshot,
  SpaceExecutor,
  SpaceExecutorFactory,
  SpaceExecutorLaneDemand,
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
  /** Carries the candidate's context rank: `space`, or a canonical
   * `user:<did>` lane identity since C1.5a. Executor-IPC identity invariant
   * as amended by C1.5b (amendments 22/23): lane identity — a contextKey
   * INCLUDING the lane principal's DID — crosses the executor channels;
   * raw sponsor credentials and session tokens still do not. */
  readonly claimKey: ActionClaimKey;
  readonly builtinId?: ServerExecutableBuiltinId;
  /** Worker-derived from a host-only accepted-commit boolean. Beyond lane
   * identity (the contextKey, principal DID included — amendment 23), no
   * credential, session token, or other actor identity crosses either
   * executor IPC channel. */
  readonly causalActorMatchesSponsor?: boolean;
  /** Worker-side demand epoch of the CANDIDATE'S LANE (A24): the global
   * epoch for space candidates, the per-lane epoch once user lanes are
   * wired. Stale closure candidates are ignored after a demanded-root
   * shrink or a lane reset rebuilds their portion of the runtime graph. */
  readonly demandGeneration?: number;
}

/** Executor-channel shape of one lane's demand slice (A24): the pool's
 * SpaceExecutorLaneDemand plus the host-minted per-lane wire generation. */
type WireLaneDemand = {
  contextKey: string;
  pieces: string[];
  demandGeneration: number;
  resetClaims?: boolean;
};

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
    | "execution-metrics"
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
  metrics?: ExecutorExecutionMetricsSnapshot;
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
    message.type === "execution-metrics" ||
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
    (message.type !== "execution-metrics" ||
      isExecutorExecutionMetricsSnapshot(message.metrics)) &&
    (message.type !== "writer-discovery" ||
      isExecutorWriterDiscovery(message.discovery)) &&
    ((message.type !== "unserved-claim" &&
      message.type !== "invalidated-claim") ||
      (isExecutionClaim(message.claim) &&
        typeof message.diagnosticCode === "string" &&
        message.diagnosticCode.length > 0));
};

const isExecutorExecutionMetricsSnapshot = (
  value: unknown,
): value is ExecutorExecutionMetricsSnapshot => {
  if (typeof value !== "object" || value === null) return false;
  const snapshot = value as Record<string, unknown>;
  const transactions = snapshot.actionTransactions;
  return Number.isSafeInteger(snapshot.schedulerRuns) &&
    Number(snapshot.schedulerRuns) >= 0 &&
    Number.isSafeInteger(snapshot.asyncRequests) &&
    Number(snapshot.asyncRequests) >= 0 &&
    typeof transactions === "object" && transactions !== null &&
    Number.isSafeInteger(
      (transactions as Record<string, unknown>).shadow,
    ) &&
    Number((transactions as Record<string, unknown>).shadow) >= 0 &&
    Number.isSafeInteger(
      (transactions as Record<string, unknown>).authoritative,
    ) &&
    Number((transactions as Record<string, unknown>).authoritative) >= 0;
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
    causalActorMatchesSponsor?: unknown;
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
  if (
    candidate.causalActorMatchesSponsor !== undefined &&
    typeof candidate.causalActorMatchesSponsor !== "boolean"
  ) {
    return false;
  }
  const claim = candidate.claimKey;
  if (typeof claim !== "object" || claim === null) return false;
  const key = claim as Record<string, unknown>;
  return typeof key.branch === "string" && typeof key.space === "string" &&
    // C1.5a widened the intra-Worker lane identity to space plus canonical
    // user-rank keys; C2.5 adds canonical `session:<did>:<sid>` keys — the
    // exact-shape parse is the wire-boundary half of CA9/CA12 (a fabricated
    // or raw-concatenated session key never reaches claim issuance). C2.8
    // (2026-07-18) lifted amendment 8's computation-only conjunct: scoped
    // lanes carry effect candidates too (scoped-lane builtin egress under
    // the lane grant, context-lattice OQ6).
    typeof key.contextKey === "string" &&
    (key.contextKey === "space" ||
      ((key.actionKind === "computation" || key.actionKind === "effect") &&
        (principalOfUserContextKey(key.contextKey) !== undefined ||
          parseSessionExecutionContextKey(key.contextKey) !== undefined))) &&
    typeof key.pieceId === "string" &&
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
  #candidateAdmissionControl = Promise.resolve();
  #claimControl = Promise.resolve();
  #requestId = 0;
  #demandGeneration = 0;
  /** Per-lane wire demand generations (A24). Monotonic for the Worker's
   * lifetime — a lane closed and later reopened resumes ABOVE its old
   * generation so stale in-flight candidates can never revalidate. */
  readonly #laneDemandGenerations = new Map<string, number>();
  /** Lanes currently wired to the Worker. Distinct from the generation map,
   * which deliberately retains closed lanes' high-water marks. */
  #liveLaneContexts = new Set<string>();
  /** Whether this Worker generation ever received a lane wire; candidates
   * of unknown user lanes are pre-lane (C1.5a) until then. */
  #lanesWired = false;
  #executionMetrics: ExecutorExecutionMetricsSnapshot = Object.freeze({
    schedulerRuns: 0,
    asyncRequests: 0,
    actionTransactions: Object.freeze({ shadow: 0, authoritative: 0 }),
  });
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
      const wired = this.#wireLanes(this.#startOptions.lanes);
      await this.#serializeCandidateAdmission(async () => {
        await this.#request("initialize", {
          space: this.#startOptions.space,
          branch: this.#startOptions.branch,
          principal: this.#startOptions.lease.onBehalfOf,
          leaseGeneration: this.#startOptions.lease.leaseGeneration,
          pieces: [...this.#startOptions.pieces],
          ...(wired !== undefined ? { lanes: wired.wire } : {}),
          port: this.#provider.port,
          builtinBrokerPort: this.#builtinBrokerPort,
          apiUrl: options.apiUrl.href,
          patternApiUrl: (options.patternApiUrl ?? options.apiUrl).href,
          experimental: options.experimental ?? {},
          ...(options.protocolFlags !== undefined
            ? { protocolFlags: options.protocolFlags }
            : {}),
        }, [this.#provider.port, this.#builtinBrokerPort]);
        if (wired !== undefined) this.#commitWiredLanes(wired);
      });
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

  /** Assign wire generations to a lane partition (A24): a lane new to the
   * Worker, reopened after removal, or explicitly reset gets a bumped
   * generation; an unchanged live lane keeps its current one. Call sites
   * commit the returned state only after the Worker acknowledged the wire. */
  #wireLanes(
    lanes: readonly SpaceExecutorLaneDemand[] | undefined,
  ):
    | { wire: WireLaneDemand[]; live: Set<string> }
    | undefined {
    if (lanes === undefined) return undefined;
    const live = new Set<string>();
    const wire = lanes.map((lane) => {
      const previous = this.#laneDemandGenerations.get(lane.contextKey);
      const bump = lane.resetClaims === true || previous === undefined ||
        !this.#liveLaneContexts.has(lane.contextKey);
      const generation = bump ? (previous ?? 0) + 1 : previous;
      live.add(lane.contextKey);
      return {
        contextKey: lane.contextKey,
        pieces: [...lane.pieces],
        demandGeneration: generation,
        ...(lane.resetClaims === true ? { resetClaims: true } : {}),
      };
    });
    return { wire, live };
  }

  #commitWiredLanes(
    wired: { wire: WireLaneDemand[]; live: Set<string> },
  ): void {
    for (const lane of wired.wire) {
      this.#laneDemandGenerations.set(lane.contextKey, lane.demandGeneration);
    }
    this.#liveLaneContexts = wired.live;
    this.#lanesWired = true;
  }

  async setDemand(
    pieces: readonly string[],
    lanes?: readonly SpaceExecutorLaneDemand[],
  ): Promise<void> {
    const next = new Set(pieces);
    await this.#serializeCandidateAdmission(async () => {
      // A shrink is surgical: the Worker stops only the removed roots, and
      // the scheduler-unregister hook releases exactly the claims of actions
      // those roots retired. Claims for surviving pieces (including children
      // shared with other roots) keep their incarnation, so ordinary
      // navigation no longer resets the lane's authority. A claim landing on
      // an action a concurrent shrink already stopped settles as one
      // claim-scoped release rather than a lane failure.
      const wired = this.#wireLanes(lanes);
      await this.#request("set-demand", {
        pieces: [...next],
        demandGeneration: this.#demandGeneration,
        ...(wired !== undefined ? { lanes: wired.wire } : {}),
      });
      if (wired !== undefined) this.#commitWiredLanes(wired);
      this.#demandedPieces.clear();
      for (const piece of next) this.#demandedPieces.add(piece);
    });
  }

  executionMetrics(): ExecutorExecutionMetricsSnapshot {
    return this.#executionMetrics;
  }

  async wake(): Promise<void> {
    await this.#serializeCandidateAdmission(() => this.#request("wake"));
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
      if (options.abrupt === true) {
        const error = new Error("executor Worker stopped abruptly");
        this.#booted.reject(error);
        this.#rejectPending(error);
      } else {
        await this.#candidateAdmissionControl;
        await this.#claimControl;
        if (!this.#failed) await this.#request("stop");
      }
    } finally {
      this.#revokeClaims();
      this.#detach();
      this.#worker.terminate();
      // A graceful stop deliberately proceeds while a claimed action is still
      // in flight (its `run-claimed-action` request stays in `#pending`), and
      // a revoked lane's activation may never receive its Worker response.
      // The Worker is now terminated, so no pending request can ever settle;
      // reject them all — as the abrupt path already does up front — or their
      // `withResolvers` promises (each still carrying a live activation-race
      // reaction) leak a "pending promise, resolved event loop" at teardown.
      // `#monitorClaimActivation` observes this rejection under `#stopped` and
      // returns without crashing the lane.
      this.#rejectPending(new Error("executor Worker stopped"));
      this.#builtinBrokerHost.dispose();
      await this.#provider.dispose();
    }
  }

  #request(
    type:
      | "initialize"
      | "set-demand"
      | "wake"
      | "settle"
      | "stop"
      | "run-claimed-action",
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

  #serializeCandidateAdmission<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#candidateAdmissionControl.then(operation);
    // Keep the serialization lane usable after a failed operation. The caller
    // still observes the original rejection and applies the relevant failure
    // policy.
    this.#candidateAdmissionControl = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
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
      void this.#serializeCandidateAdmission(() =>
        this.#handleCandidate(candidate)
      ).catch((error) => this.#fail(error));
      return;
    }
    if (message.type === "candidate-diagnostic") {
      this.#onCandidateDiagnostic?.(message.diagnostic!);
      return;
    }
    if (message.type === "execution-metrics") {
      const next = message.metrics!;
      const current = this.#executionMetrics;
      if (
        next.schedulerRuns < current.schedulerRuns ||
        next.asyncRequests < current.asyncRequests ||
        next.actionTransactions.shadow < current.actionTransactions.shadow ||
        next.actionTransactions.authoritative <
          current.actionTransactions.authoritative
      ) {
        this.#fail(
          new Error("executor Worker execution metrics moved backwards"),
        );
        return;
      }
      this.#executionMetrics = Object.freeze({
        schedulerRuns: next.schedulerRuns,
        asyncRequests: next.asyncRequests,
        actionTransactions: Object.freeze({
          shadow: next.actionTransactions.shadow,
          authoritative: next.actionTransactions.authoritative,
        }),
      });
      try {
        this.#startOptions.onExecutionMetrics?.(this.#executionMetrics);
      } catch (error) {
        console.warn("executor Worker metrics sink failed", error);
      }
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

  /** Expected demand generation for a candidate's lane (A24): the space
   * lane keeps the global generation; once lanes are wired, a user
   * candidate must match ITS live lane's generation — candidates of closed
   * or re-anchored lane incarnations never revalidate (-1 matches nothing).
   * Before any lane is wired, user candidates are C1.5a pre-lane and keep
   * the space check byte-identical. */
  #expectedCandidateGeneration(contextKey: string): number {
    if (contextKey === "space" || !this.#lanesWired) {
      return this.#demandGeneration;
    }
    return this.#liveLaneContexts.has(contextKey)
      ? this.#laneDemandGenerations.get(contextKey) ?? -1
      : -1;
  }

  async #handleCandidate(candidate: CandidateClaim): Promise<void> {
    this.#onCandidateClaim?.(candidate);
    if (
      (candidate.demandGeneration ?? 0) !==
        this.#expectedCandidateGeneration(candidate.claimKey.contextKey)
    ) return;
    const key = candidate.claimKey;
    if (
      key.space !== this.#startOptions.space ||
      key.branch !== this.#startOptions.branch
    ) {
      throw new Error("executor CandidateClaim escaped its bound lane");
    }
    // §B.5's causal-actor/sponsor-match rule is confined to the SPACE lane,
    // whose executing identity is an unrelated volunteer sponsor. A scoped
    // lane's builtin is the LANE principal's own standing side effect
    // reacting to anyone's data (context-lattice §3/OQ6, C2.8): its
    // authority is the lane grant, so a foreign-caused recompute is never
    // dropped here — the sponsor-consent gate applies only when the claim
    // names the space lane.
    if (
      key.contextKey === "space" &&
      isServerExecutableBuiltinId(candidate.builtinId) &&
      candidate.causalActorMatchesSponsor !== true
    ) {
      this.#onCandidateDiagnostic?.({
        claimKey: key,
        diagnosticCode: "builtin-causal-actor-mismatch",
      });
      return;
    }
    const routingEnabled =
      this.#protocolFlags.serverPrimaryExecutionV1 === true &&
      this.#protocolFlags.serverPrimaryExecutionClaimRoutingV1 === true &&
      (key.actionKind !== "effect" ||
        (this.#protocolFlags.serverPrimaryExecutionBuiltinPassivityV1 ===
            true && isServerExecutableBuiltinId(candidate.builtinId)));
    const mapKey = candidateKey(candidate);
    if (
      !routingEnabled || this.#claims.has(mapKey) || this.#stopped ||
      this.#failed
    ) return;

    const claim = await this.#server.trySetExecutionClaim(
      this.#startOptions.lease,
      key,
    );
    if (claim === null) {
      this.#onCandidateDiagnostic?.({
        claimKey: key,
        diagnosticCode: "claim-authority-lost",
      });
      return;
    }
    if (this.#stopped || this.#failed) {
      this.#revokeClaim(claim);
      return;
    }
    this.#claims.set(mapKey, claim);
    this.#scheduleClaimRenewal(claim);
    const activated = this.#request("run-claimed-action", {
      claim,
      assertion: {
        contextKey: claim.contextKey,
        leaseGeneration: claim.leaseGeneration,
        claimGeneration: claim.claimGeneration,
      },
    });
    // Claim installation remains serialized, but route readiness/final work
    // must not occupy the control lane: renewal, demand shrink, and graceful
    // stop all need to proceed while an action is slow or retrying.
    void this.#monitorClaimActivation(activated, claim).catch((error) =>
      this.#fail(error)
    );
  }

  async #monitorClaimActivation(
    activation: Promise<WorkerResponse>,
    claim: ExecutionClaim,
  ): Promise<void> {
    try {
      const response = await this.#awaitClaimActivation(activation, claim);
      if (!this.#claimIsCurrent(claim) || this.#stopped || this.#failed) return;
      if (response.type !== "complete") {
        throw new Error("executor Worker returned an invalid claim activation");
      }
    } catch (error) {
      // A revoke/replacement intentionally cancels Worker route readiness. A
      // delayed timeout/rejection from that old request must never crash or
      // revoke the replacement incarnation.
      if (!this.#claimIsCurrent(claim) || this.#stopped || this.#failed) return;
      throw error;
    }
  }

  #claimIsCurrent(claim: ExecutionClaim): boolean {
    const current = this.#claims.get(candidateKey({ claimKey: claim }));
    return current !== undefined &&
      current.leaseGeneration === claim.leaseGeneration &&
      current.claimGeneration === claim.claimGeneration;
  }

  async #awaitClaimActivation(
    activation: Promise<WorkerResponse>,
    claim: ExecutionClaim,
  ): Promise<WorkerResponse> {
    const timeout = Promise.withResolvers<WorkerResponse>();
    const remaining = Math.max(1, claim.expiresAt - this.#now());
    const timer = this.#setTimer(
      () =>
        timeout.reject(
          new Error("executor Worker did not activate its claim in time"),
        ),
      Math.min(this.#startupTimeoutMs, remaining),
    );
    try {
      return await Promise.race([activation, timeout.promise]);
    } finally {
      this.#clearTimer(timer);
    }
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
      // Worker releases race host-side revokes (demand change, renewal
      // failure, stop) by construction: the Worker posts asynchronously
      // against the claim state it last saw. A release naming a claim the
      // host no longer holds — or an older incarnation — is already handled;
      // acting on it would revoke a newer incarnation or crash the lane.
      return;
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
      // Renewal is a lease-safety path, not an action-completion path. A
      // claimed computation may legitimately remain in flight beyond one TTL;
      // serializing this behind activation/final settlement would guarantee
      // expiry for slow or conflict-retrying work.
      void this.#renewClaim(claim).catch((error) => this.#fail(error));
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
      // The Worker can classify the action as unserved or invalidate it while
      // renewal awaits engine setup. In that case the server must return null
      // to avoid resurrecting the released incarnation, and the matching
      // local release has already ended our authority obligation.
      if (
        !this.#claimIsCurrent(expected) || this.#stopped || this.#failed
      ) return;
      this.#revokeClaim(live);
      this.#claims.delete(key);
      this.#cancelClaimRenewal(key);
      this.#onCandidateDiagnostic?.({
        claim: live,
        diagnosticCode: "claim-authority-lost",
      });
      return;
    }
    const current = this.#claims.get(key);
    if (
      this.#stopped || this.#failed || current === undefined ||
      current.leaseGeneration !== expected.leaseGeneration ||
      current.claimGeneration !== expected.claimGeneration
    ) {
      // Release/revoke may race the async renewal. Never reinsert a locally
      // ended incarnation after its server round trip returns.
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
      // Bounds both initial Worker boot and a claimed-action activation. A
      // silent Worker cannot retain an authority lane indefinitely; timeout
      // tears it down and lets the pool's fenced replacement path recover.
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
