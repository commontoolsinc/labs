import { assertEquals, assertExists } from "@std/assert";
import { Identity } from "@commonfabric/identity";
import type { MemorySpace, Signer } from "@commonfabric/memory/interface";
import type {
  ActionClaimKey,
  ActionSettlement,
  BranchName,
  ExecutionClaim,
  MemoryProtocolFlags,
} from "@commonfabric/memory/v2";
import {
  resetPersistentSchedulerStateConfig,
  resetServerPrimaryExecutionClaimRankConfig,
  sessionExecutionContextKey,
  setPersistentSchedulerStateConfig,
  setServerPrimaryExecutionClaimRankConfig,
} from "@commonfabric/memory/v2";
import * as MemoryClient from "@commonfabric/memory/v2/client";
import {
  type ExecutionLeaseHandle,
  Server,
} from "@commonfabric/memory/v2/server";
import { Runtime } from "../src/runtime.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";
import {
  type Options as StorageOptions,
  type SessionFactory,
  StorageManager,
} from "../src/storage/v2.ts";
import { HostStorageManager } from "../src/storage/v2-host-provider.ts";
import { createExecutorActionTransactionRouter } from "../src/executor/action-transaction-router.ts";
import {
  DenoSpaceExecutorFactory,
  type DenoSpaceExecutorFactoryOptions,
  type ExecutorWorkerLike,
} from "../src/executor/deno-space-executor.ts";
import { SharedExecutionPool } from "../src/executor/shared-execution-pool.ts";

const SPACE = "did:key:z6Mk-executor-candidate";
const BRANCH = "feature" as BranchName;
const LEASE = {
  version: 1,
  space: SPACE,
  branch: BRANCH,
  leaseGeneration: 7,
  hostId: "host:candidate-test",
  onBehalfOf: "did:key:z6Mk-candidate-sponsor",
  state: "active",
  expiresAt: 90_000,
} as ExecutionLeaseHandle;
const CLAIM_KEY: ActionClaimKey = {
  branch: BRANCH,
  space: SPACE,
  contextKey: "space",
  pieceId: "of:piece-root",
  actionId: "cf:module/abc:compute:instance-1",
  actionKind: "computation",
  implementationFingerprint: "impl:abc:compute",
  runtimeFingerprint: "runtime:test",
};
const CLAIM: ExecutionClaim = {
  ...CLAIM_KEY,
  leaseGeneration: LEASE.leaseGeneration,
  claimGeneration: 3,
  expiresAt: 80_000,
};
const BUILTIN_CLAIM_KEY: ActionClaimKey = {
  ...CLAIM_KEY,
  actionId: "cf:builtin/fetchText:instance-1",
  actionKind: "effect",
  implementationFingerprint: "impl:cf:builtin/fetchText:server-v1",
};

interface CandidateClaim {
  claimKey: ActionClaimKey;
  builtinId?: string;
  causalActorMatchesSponsor?: boolean;
}

interface CandidateDiagnostic {
  claim?: ExecutionClaim;
  claimKey?: ActionClaimKey;
  diagnosticCode: string;
}

interface WriterDiscovery {
  pieceId: string;
  indexMiss: boolean;
  writers: readonly {
    branch: string;
    ownerSpace?: string;
    actionId: string;
    pieceId: string;
    processGeneration: number;
    actionKind: "computation" | "effect" | "event-handler";
    implementationFingerprint: string;
    runtimeFingerprint: string;
    source: "live" | "durable" | "live+durable";
  }[];
}

interface ExecutionMetrics {
  schedulerRuns: number;
  asyncRequests: number;
  actionTransactions: {
    shadow: number;
    authoritative: number;
  };
}

type CandidateAwareFactoryOptions = DenoSpaceExecutorFactoryOptions & {
  /** Host-local diagnostic only. This callback never publishes authority. */
  onCandidateClaim?: (candidate: CandidateClaim) => void;
  onCandidateDiagnostic?: (diagnostic: CandidateDiagnostic) => void;
  onWriterDiscovery?: (discovery: WriterDiscovery) => void;
};

class FakeWorker extends EventTarget implements ExecutorWorkerLike {
  readonly messages: unknown[] = [];
  readonly pendingClaimedRunIds: number[] = [];
  readonly pendingSetDemandIds: number[] = [];
  terminated = false;
  settledSeq = 41;
  acknowledgeClaimedRuns = true;
  acknowledgeSetDemand = true;

  boot(): void {
    this.dispatchEvent(
      new MessageEvent("message", {
        data: { type: "booted" },
      }),
    );
  }

  candidate(
    claimKey: ActionClaimKey,
    options: {
      demandGeneration?: number;
      builtinId?: "fetchText";
      causalActorMatchesSponsor?: boolean;
    } = {},
  ): void {
    this.dispatchEvent(
      new MessageEvent("message", {
        data: {
          type: "candidate-claim",
          candidate: {
            claimKey,
            ...options,
          },
        },
      }),
    );
  }

  unserved(claim: ExecutionClaim, diagnosticCode: string): void {
    this.dispatchEvent(
      new MessageEvent("message", {
        data: { type: "unserved-claim", claim, diagnosticCode },
      }),
    );
  }

  diagnostic(diagnostic: CandidateDiagnostic): void {
    this.dispatchEvent(
      new MessageEvent("message", {
        data: { type: "candidate-diagnostic", diagnostic },
      }),
    );
  }

  invalidated(claim: ExecutionClaim, diagnosticCode: string): void {
    this.dispatchEvent(
      new MessageEvent("message", {
        data: { type: "invalidated-claim", claim, diagnosticCode },
      }),
    );
  }

  acknowledgeLatestClaimedRun(): void {
    const requestId = this.pendingClaimedRunIds.pop();
    if (requestId === undefined) throw new Error("claimed run request missing");
    this.dispatchEvent(
      new MessageEvent("message", {
        data: { type: "complete", requestId },
      }),
    );
  }

  acknowledgePendingClaimedRuns(): void {
    while (this.pendingClaimedRunIds.length > 0) {
      this.acknowledgeLatestClaimedRun();
    }
  }

  acknowledgeLatestSetDemand(): void {
    const requestId = this.pendingSetDemandIds.pop();
    if (requestId === undefined) throw new Error("set-demand request missing");
    this.dispatchEvent(
      new MessageEvent("message", {
        data: { type: "complete", requestId },
      }),
    );
  }

  writerDiscovery(discovery: WriterDiscovery): void {
    this.dispatchEvent(
      new MessageEvent("message", {
        data: { type: "writer-discovery", discovery },
      }),
    );
  }

  executionMetrics(metrics: ExecutionMetrics): void {
    this.response({ type: "execution-metrics", metrics });
  }

  response(data: unknown): void {
    this.dispatchEvent(
      new MessageEvent("message", {
        data,
      }),
    );
  }

  postMessage(message: unknown, _transfer?: Transferable[]): void {
    this.messages.push(message);
    const request = message as {
      type?: string;
      requestId?: number;
      resetClaims?: boolean;
    };
    if (request.type === "initialize") {
      this.dispatchEvent(
        new MessageEvent("message", {
          data: { type: "ready", requestId: request.requestId },
        }),
      );
    } else if (request.type === "settle") {
      this.dispatchEvent(
        new MessageEvent("message", {
          data: {
            type: "settled",
            requestId: request.requestId,
            dataSeq: this.settledSeq,
          },
        }),
      );
    } else if (
      request.type === "run-claimed-action" &&
      !this.acknowledgeClaimedRuns
    ) {
      if (request.requestId === undefined) {
        throw new Error("claimed run request missing");
      }
      this.pendingClaimedRunIds.push(request.requestId);
    } else if (
      request.type === "set-demand" && !this.acknowledgeSetDemand
    ) {
      if (request.requestId === undefined) {
        throw new Error("set-demand request missing");
      }
      this.pendingSetDemandIds.push(request.requestId);
    } else if (
      request.type === "set-demand" || request.type === "wake" ||
      request.type === "stop" ||
      (request.type === "run-claimed-action" && this.acknowledgeClaimedRuns)
    ) {
      if (
        request.type === "stop" ||
        (request.type === "set-demand" && request.resetClaims === true)
      ) {
        // The real Worker cancels exact activation waiters before acknowledging
        // stop or a claim-resetting demand change.
        this.acknowledgePendingClaimedRuns();
      }
      this.dispatchEvent(
        new MessageEvent("message", {
          data: { type: "complete", requestId: request.requestId },
        }),
      );
    }
  }

  terminate(): void {
    this.terminated = true;
  }
}

class ClaimRecordingServer {
  readonly claimRequests: {
    lease: ExecutionLeaseHandle;
    claimKey: ActionClaimKey;
  }[] = [];
  readonly revoked: ExecutionClaim[] = [];
  readonly renewRequests: ExecutionClaim[] = [];
  claimResult: ExecutionClaim | null = CLAIM;
  setExecutionClaim(
    lease: ExecutionLeaseHandle,
    claimKey: ActionClaimKey,
  ): Promise<ExecutionClaim> {
    this.claimRequests.push({ lease, claimKey });
    return this.claimResult === null
      ? Promise.reject(
        new Error("execution lease is not active and authorized"),
      )
      : Promise.resolve(this.claimResult);
  }

  trySetExecutionClaim(
    lease: ExecutionLeaseHandle,
    claimKey: ActionClaimKey,
  ): Promise<ExecutionClaim | null> {
    this.claimRequests.push({ lease, claimKey });
    return Promise.resolve(this.claimResult);
  }

  revokeExecutionClaim(claim: ExecutionClaim): boolean {
    this.revoked.push(claim);
    return true;
  }

  renewExecutionClaim(
    _lease: ExecutionLeaseHandle,
    claim: ExecutionClaim,
  ): Promise<ExecutionClaim | null> {
    this.renewRequests.push(claim);
    return Promise.resolve({ ...claim, expiresAt: claim.expiresAt + 80_000 });
  }
}

const flushClaimControl = async (): Promise<void> => {
  for (let pending = 0; pending < 8; pending++) await Promise.resolve();
};

const startExecutor = async (options: {
  routing: boolean;
  onCandidateClaim?: (candidate: CandidateClaim) => void;
  onCandidateDiagnostic?: (diagnostic: CandidateDiagnostic) => void;
  onWriterDiscovery?: (discovery: WriterDiscovery) => void;
  claimTimers?: {
    now: () => number;
    setTimer: (callback: () => void, delayMs: number) => number;
    clearTimer: (timer: number) => void;
  };
  acknowledgeClaimedRuns?: boolean;
  startupTimeoutMs?: number;
  onExecutionMetrics?: (snapshot: ExecutionMetrics) => void;
}) => {
  const worker = new FakeWorker();
  worker.acknowledgeClaimedRuns = options.acknowledgeClaimedRuns ?? true;
  const server = new ClaimRecordingServer();
  const channel = new MessageChannel();
  const crashes: unknown[] = [];
  const factoryOptions: CandidateAwareFactoryOptions = {
    server: server as unknown as Server,
    apiUrl: new URL("https://toolshed.example/"),
    protocolFlags: {
      serverPrimaryExecutionV1: true,
      serverPrimaryExecutionClaimRoutingV1: options.routing,
      serverPrimaryExecutionBuiltinPassivityV1: true,
    },
    onCandidateClaim: options.onCandidateClaim,
    onCandidateDiagnostic: options.onCandidateDiagnostic,
    onWriterDiscovery: options.onWriterDiscovery,
    now: options.claimTimers?.now ?? (() => 0),
    startupTimeoutMs: options.startupTimeoutMs,
    ...options.claimTimers,
    createWorker: () => {
      queueMicrotask(() => worker.boot());
      return worker;
    },
    createProvider: () => ({
      port: channel.port1,
      dispose: () => {
        channel.port2.close();
        return Promise.resolve();
      },
    }),
  };
  const factory = new DenoSpaceExecutorFactory(factoryOptions);
  const executor = await factory.start({
    space: SPACE,
    branch: BRANCH,
    lease: LEASE,
    pieces: [CLAIM_KEY.pieceId],
    onCrash: (error) => crashes.push(error),
    onExecutionMetrics: options.onExecutionMetrics,
  });
  return { worker, server, crashes, executor };
};

Deno.test("shadow executors report CandidateClaim diagnostics without publishing authority", async () => {
  const candidates: CandidateClaim[] = [];
  const { worker, server, crashes, executor } = await startExecutor({
    routing: false,
    onCandidateClaim: (candidate) => candidates.push(candidate),
  });
  try {
    worker.candidate(CLAIM_KEY);
    await flushClaimControl();

    assertEquals(candidates, [{ claimKey: CLAIM_KEY }]);
    assertEquals(server.claimRequests, []);
    assertEquals(
      worker.messages.some((message) =>
        (message as { type?: string }).type === "run-claimed-action"
      ),
      false,
    );
    assertEquals(crashes, []);
  } finally {
    await executor.stop();
  }
});

Deno.test("executor host retains the latest cumulative execution placement snapshot", async () => {
  const published: ExecutionMetrics[] = [];
  const { worker, crashes, executor } = await startExecutor({
    routing: false,
    onExecutionMetrics: (snapshot) => published.push(snapshot),
  });
  try {
    assertEquals(executor.executionMetrics?.(), {
      schedulerRuns: 0,
      asyncRequests: 0,
      actionTransactions: { shadow: 0, authoritative: 0 },
    });

    worker.executionMetrics({
      schedulerRuns: 3,
      asyncRequests: 1,
      actionTransactions: { shadow: 2, authoritative: 1 },
    });
    assertEquals(executor.executionMetrics?.(), {
      schedulerRuns: 3,
      asyncRequests: 1,
      actionTransactions: { shadow: 2, authoritative: 1 },
    });

    worker.executionMetrics({
      schedulerRuns: 5,
      asyncRequests: 2,
      actionTransactions: { shadow: 3, authoritative: 2 },
    });
    assertEquals(executor.executionMetrics?.(), {
      schedulerRuns: 5,
      asyncRequests: 2,
      actionTransactions: { shadow: 3, authoritative: 2 },
    });
    assertEquals(published, [{
      schedulerRuns: 3,
      asyncRequests: 1,
      actionTransactions: { shadow: 2, authoritative: 1 },
    }, {
      schedulerRuns: 5,
      asyncRequests: 2,
      actionTransactions: { shadow: 3, authoritative: 2 },
    }]);
    assertEquals(crashes, []);
  } finally {
    await executor.stop();
  }
});

Deno.test("executor host rejects malformed execution placement snapshots", async () => {
  const { worker, crashes, executor } = await startExecutor({ routing: false });
  try {
    worker.response({
      type: "execution-metrics",
      metrics: {
        schedulerRuns: 1,
        asyncRequests: -1,
        actionTransactions: { shadow: 0, authoritative: 0 },
      },
    });

    assertEquals(
      crashes.map((error) => error instanceof Error ? error.message : error),
      ["invalid executor Worker response"],
    );
    assertEquals(worker.terminated, true);
  } finally {
    await executor.stop();
  }
});

Deno.test("executor host rejects execution placement counters that move backwards", async () => {
  const { worker, crashes, executor } = await startExecutor({ routing: false });
  try {
    worker.executionMetrics({
      schedulerRuns: 3,
      asyncRequests: 1,
      actionTransactions: { shadow: 2, authoritative: 1 },
    });
    worker.executionMetrics({
      schedulerRuns: 2,
      asyncRequests: 1,
      actionTransactions: { shadow: 2, authoritative: 1 },
    });

    assertEquals(
      crashes.map((error) => error instanceof Error ? error.message : error),
      ["executor Worker execution metrics moved backwards"],
    );
    assertEquals(worker.terminated, true);
  } finally {
    await executor.stop();
  }
});

Deno.test("supported builtin candidates require a host-derived causal actor match", async () => {
  const diagnostics: CandidateDiagnostic[] = [];
  const { worker, server, crashes, executor } = await startExecutor({
    routing: true,
    onCandidateDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
  });
  try {
    worker.candidate(BUILTIN_CLAIM_KEY, { builtinId: "fetchText" });
    worker.candidate(BUILTIN_CLAIM_KEY, {
      builtinId: "fetchText",
      causalActorMatchesSponsor: false,
    });
    await flushClaimControl();

    assertEquals(server.claimRequests, []);
    assertEquals(diagnostics, [{
      claimKey: BUILTIN_CLAIM_KEY,
      diagnosticCode: "builtin-causal-actor-mismatch",
    }, {
      claimKey: BUILTIN_CLAIM_KEY,
      diagnosticCode: "builtin-causal-actor-mismatch",
    }]);

    worker.candidate(BUILTIN_CLAIM_KEY, {
      builtinId: "fetchText",
      causalActorMatchesSponsor: true,
    });
    await flushClaimControl();
    assertEquals(server.claimRequests, [{
      lease: LEASE,
      claimKey: BUILTIN_CLAIM_KEY,
    }]);
    assertEquals(crashes, []);
  } finally {
    await executor.stop();
  }
});

Deno.test("executor settlement returns the Worker barrier and abrupt stop skips a second round trip", async () => {
  const { worker, executor } = await startExecutor({ routing: false });

  assertEquals(await executor.settle(), worker.settledSeq);
  await executor.stop({ abrupt: true });

  assertEquals(
    worker.messages.filter((message) =>
      (message as { type?: string }).type === "settle"
    ).length,
    1,
  );
  assertEquals(
    worker.messages.some((message) =>
      (message as { type?: string }).type === "stop"
    ),
    false,
  );
  assertEquals(worker.terminated, true);
});

Deno.test("canonical unserved attempts revoke the exact test-only claim", async () => {
  const diagnostics: CandidateDiagnostic[] = [];
  const { worker, server, crashes, executor } = await startExecutor({
    routing: true,
    onCandidateDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
  });
  try {
    worker.candidate(CLAIM_KEY);
    await flushClaimControl();
    worker.unserved(CLAIM, "dynamic-non-space-read-scope");
    await flushClaimControl();

    assertEquals(crashes, []);
    assertEquals(diagnostics, [{
      claim: CLAIM,
      diagnosticCode: "dynamic-non-space-read-scope",
    }]);
    assertEquals(server.revoked, [CLAIM]);
  } finally {
    await executor.stop();
  }
});

Deno.test("demand shrink releases stale claims so re-added roots can reclaim", async () => {
  const { worker, server, crashes, executor } = await startExecutor({
    routing: true,
  });
  try {
    worker.candidate(CLAIM_KEY);
    await flushClaimControl();
    assertEquals(server.claimRequests.length, 1);

    // Shrinking away the claim's root stops its action in the Worker; the
    // scheduler-unregister hook posts the exact release, which the host turns
    // into the server revoke.
    await executor.setDemand(["space:of:other-piece"]);
    assertEquals(server.revoked, []);
    worker.invalidated(CLAIM, "action-unregistered");
    await flushClaimControl();
    assertEquals(server.revoked, [CLAIM]);

    // Re-adding the root re-instantiates its actions; the fresh candidate
    // reclaims without any lane-wide reset.
    await executor.setDemand([CLAIM_KEY.pieceId, "space:of:other-piece"]);
    worker.candidate(CLAIM_KEY);
    await flushClaimControl();
    assertEquals(server.claimRequests.length, 2);
    assertEquals(crashes, []);
  } finally {
    await executor.stop();
  }
});

Deno.test("live executor claims renew before their server-authored deadline", async () => {
  let nextTimer = 0;
  const timers = new Map<
    number,
    { callback: () => void; delayMs: number }
  >();
  const { worker, server, crashes, executor } = await startExecutor({
    routing: true,
    claimTimers: {
      now: () => 0,
      setTimer(callback, delayMs) {
        const timer = ++nextTimer;
        timers.set(timer, { callback, delayMs });
        return timer;
      },
      clearTimer: (timer) => {
        timers.delete(timer);
      },
    },
  });
  try {
    worker.candidate(CLAIM_KEY);
    await flushClaimControl();
    assertEquals([...timers.values()].map((timer) => timer.delayMs), [40_000]);

    const renewal = [...timers.values()][0]!;
    timers.clear();
    renewal.callback();
    await flushClaimControl();

    assertEquals(server.renewRequests, [CLAIM]);
    assertEquals(server.revoked, []);
    assertEquals(crashes, []);
    assertEquals(timers.size, 1);
  } finally {
    await executor.stop();
  }
});

Deno.test("claim renewal is not blocked by a still-running activation", async () => {
  let nextTimer = 0;
  const timers = new Map<
    number,
    { callback: () => void; delayMs: number }
  >();
  const { worker, server, crashes, executor } = await startExecutor({
    routing: true,
    acknowledgeClaimedRuns: false,
    startupTimeoutMs: 90_000,
    claimTimers: {
      now: () => 0,
      setTimer(callback, delayMs) {
        const timer = ++nextTimer;
        timers.set(timer, { callback, delayMs });
        return timer;
      },
      clearTimer: (timer) => {
        timers.delete(timer);
      },
    },
  });
  try {
    worker.candidate(CLAIM_KEY);
    await flushClaimControl();

    const renewal = [...timers.values()].find((timer) =>
      timer.delayMs === 40_000
    );
    if (renewal === undefined) throw new Error("renewal timer missing");
    renewal.callback();
    await flushClaimControl();

    assertEquals(server.renewRequests, [CLAIM]);
    assertEquals(server.revoked, []);
    assertEquals(crashes, []);
  } finally {
    worker.acknowledgeLatestClaimedRun();
    await flushClaimControl();
    await executor.stop({ abrupt: true });
  }
});

Deno.test("claim renewal tolerates an exact release while storage is open", async () => {
  let nextTimer = 0;
  const timers = new Map<
    number,
    { callback: () => void; delayMs: number }
  >();
  const { worker, server, crashes, executor } = await startExecutor({
    routing: true,
    claimTimers: {
      now: () => 0,
      setTimer(callback, delayMs) {
        const timer = ++nextTimer;
        timers.set(timer, { callback, delayMs });
        return timer;
      },
      clearTimer: (timer) => {
        timers.delete(timer);
      },
    },
  });
  const renewalStarted = Promise.withResolvers<void>();
  const finishRenewal = Promise.withResolvers<ExecutionClaim | null>();
  server.renewExecutionClaim = (
    _lease: ExecutionLeaseHandle,
    claim: ExecutionClaim,
  ) => {
    server.renewRequests.push(claim);
    renewalStarted.resolve();
    return finishRenewal.promise;
  };
  try {
    worker.candidate(CLAIM_KEY);
    await flushClaimControl();

    const renewal = [...timers.values()].find((timer) =>
      timer.delayMs === 40_000
    );
    if (renewal === undefined) throw new Error("renewal timer missing");
    renewal.callback();
    await renewalStarted.promise;

    // Opening a first-use engine can yield. If the Worker rejects the exact
    // action in that interval, the server correctly returns null rather than
    // resurrecting the released incarnation.
    worker.unserved(CLAIM, "dynamic-non-space-read-scope");
    await flushClaimControl();
    finishRenewal.resolve(null);
    await flushClaimControl();

    assertEquals(server.renewRequests, [CLAIM]);
    assertEquals(server.revoked, [CLAIM]);
    assertEquals(crashes, []);
    assertEquals(worker.terminated, false);
  } finally {
    finishRenewal.resolve(null);
    await executor.stop();
  }
});

Deno.test("claim renewal authority loss releases the route without crashing the Worker", async () => {
  let nextTimer = 0;
  const timers = new Map<
    number,
    { callback: () => void; delayMs: number }
  >();
  const diagnostics: CandidateDiagnostic[] = [];
  const { worker, server, crashes, executor } = await startExecutor({
    routing: true,
    onCandidateDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    claimTimers: {
      now: () => 0,
      setTimer(callback, delayMs) {
        const timer = ++nextTimer;
        timers.set(timer, { callback, delayMs });
        return timer;
      },
      clearTimer: (timer) => {
        timers.delete(timer);
      },
    },
  });
  server.renewExecutionClaim = (
    _lease: ExecutionLeaseHandle,
    claim: ExecutionClaim,
  ) => {
    server.renewRequests.push(claim);
    return Promise.resolve(null);
  };
  try {
    worker.candidate(CLAIM_KEY);
    await flushClaimControl();

    const renewal = [...timers.entries()].find(([, timer]) =>
      timer.delayMs === 40_000
    );
    if (renewal === undefined) throw new Error("renewal timer missing");
    timers.delete(renewal[0]);
    renewal[1].callback();
    await flushClaimControl();

    assertEquals(server.renewRequests, [CLAIM]);
    assertEquals(server.revoked, [CLAIM]);
    assertEquals(diagnostics, [{
      claim: CLAIM,
      diagnosticCode: "claim-authority-lost",
    }]);
    assertEquals(crashes, []);
    assertEquals(worker.terminated, false);
    assertEquals(timers.size, 0);
  } finally {
    await executor.stop();
  }
});

Deno.test("candidate claim authority loss is ignored during a demand transition", async () => {
  const diagnostics: CandidateDiagnostic[] = [];
  const { worker, server, crashes, executor } = await startExecutor({
    routing: true,
    onCandidateDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
  });
  server.claimResult = null;
  try {
    worker.candidate(CLAIM_KEY);
    await flushClaimControl();

    assertEquals(server.claimRequests, [{
      lease: LEASE,
      claimKey: CLAIM_KEY,
    }]);
    assertEquals(diagnostics, [{
      claimKey: CLAIM_KEY,
      diagnosticCode: "claim-authority-lost",
    }]);
    assertEquals(crashes, []);
    assertEquals(worker.terminated, false);
  } finally {
    await executor.stop();
  }
});

Deno.test("unacknowledged claim activation is revoked and crashes the Worker", async () => {
  let nextTimer = 0;
  const timers = new Map<
    number,
    { callback: () => void; delayMs: number }
  >();
  const { worker, server, crashes, executor } = await startExecutor({
    routing: true,
    acknowledgeClaimedRuns: false,
    startupTimeoutMs: 100,
    claimTimers: {
      now: () => 0,
      setTimer(callback, delayMs) {
        const timer = ++nextTimer;
        timers.set(timer, { callback, delayMs });
        return timer;
      },
      clearTimer: (timer) => {
        timers.delete(timer);
      },
    },
  });
  try {
    worker.candidate(CLAIM_KEY);
    await flushClaimControl();

    assertEquals(server.claimRequests.length, 1);
    assertEquals(server.revoked, []);
    const activation = [...timers.values()].find((timer) =>
      timer.delayMs === 100
    );
    if (activation === undefined) throw new Error("activation timer missing");
    activation.callback();
    await flushClaimControl();

    assertEquals(server.revoked, [CLAIM]);
    assertEquals(crashes.length, 1);
    assertEquals(worker.terminated, true);
  } finally {
    await executor.stop();
  }
});

Deno.test("abrupt stop cancels an unacknowledged claim activation", async () => {
  const { worker, server, executor } = await startExecutor({
    routing: true,
    acknowledgeClaimedRuns: false,
  });
  worker.candidate(CLAIM_KEY);
  await flushClaimControl();
  let stopped = false;
  const stopping = (async () => {
    await executor.stop({ abrupt: true });
    stopped = true;
  })();
  try {
    await flushClaimControl();
    assertEquals(stopped, true);
    assertEquals(server.revoked, [CLAIM]);
    assertEquals(worker.terminated, true);
  } finally {
    if (!stopped) {
      worker.acknowledgeLatestClaimedRun();
    }
    await stopping;
  }
});

Deno.test("graceful stop does not wait for claimed action settlement", async () => {
  const { worker, server, executor } = await startExecutor({
    routing: true,
    acknowledgeClaimedRuns: false,
  });
  worker.candidate(CLAIM_KEY);
  await flushClaimControl();
  let stopped = false;
  const stopping = (async () => {
    await executor.stop();
    stopped = true;
  })();
  try {
    await flushClaimControl();
    assertEquals(stopped, true);
    assertEquals(server.revoked, [CLAIM]);
    assertEquals(worker.terminated, true);
  } finally {
    if (!stopped) worker.acknowledgeLatestClaimedRun();
    await stopping;
  }
});

Deno.test("demand shrink does not wait for claimed action settlement", async () => {
  const { worker, server, executor } = await startExecutor({
    routing: true,
    acknowledgeClaimedRuns: false,
  });
  worker.candidate(CLAIM_KEY);
  await flushClaimControl();
  let changed = false;
  const changing = (async () => {
    await executor.setDemand(["space:of:other-piece"]);
    changed = true;
  })();
  try {
    await flushClaimControl();
    assertEquals(changed, true);
    // The host no longer resets lane authority on shrink; the Worker releases
    // exactly the claims of actions the stopped roots retired.
    assertEquals(server.revoked, []);
    assertEquals(
      worker.messages.filter((message) =>
        (message as { type?: string }).type === "set-demand"
      ).map((message) => (message as { resetClaims?: boolean }).resetClaims),
      [undefined],
    );
    worker.invalidated(CLAIM, "action-unregistered");
    await flushClaimControl();
    assertEquals(server.revoked, [CLAIM]);
  } finally {
    if (!changed) worker.acknowledgeLatestClaimedRun();
    await changing;
    await flushClaimControl();
    await executor.stop({ abrupt: true });
  }
});

Deno.test("an ordinary demand shrink leaves sibling claims live", async () => {
  const { worker, server, crashes, executor } = await startExecutor({
    routing: true,
  });
  try {
    worker.candidate(CLAIM_KEY);
    await flushClaimControl();

    // Grow, then shrink away the sibling; the claim's own piece stays
    // demanded, so its incarnation must survive the shrink untouched.
    await executor.setDemand([CLAIM_KEY.pieceId, "space:of:sibling"]);
    await executor.setDemand([CLAIM_KEY.pieceId]);
    await flushClaimControl();
    assertEquals(server.revoked, []);
    assertEquals(crashes, []);

    // The claim is still live host-side: its exact release revokes it once.
    worker.invalidated(CLAIM, "action-unregistered");
    await flushClaimControl();
    assertEquals(server.revoked, [CLAIM]);
  } finally {
    await executor.stop();
  }
});

// C1.10: the W2.6 shrink-race, HOST side only. This fixture scripts the
// Worker's gone-signal by hand, so it pins how the host reacts to an
// `invalidated-claim` release arriving for a held activation — exactly one
// revoke, no lane reset — but it does NOT execute the Worker's decision
// logic (startClaimedAction catching ClaimedActionGoneError). That real seam
// is bound by "the real Worker settles a claimed activation raced by a
// concurrent shrink as one claim-scoped release" below (FW7/FB4), which
// drives the production executor-worker and observes the wire diagnostic
// `action-unregistered` — the code production actually emits (the previously
// pinned `demand-removed` appears nowhere in production).
Deno.test("a claimed activation raced by a concurrent shrink settles as one claim revoke without a fatal", async () => {
  const diagnostics: CandidateDiagnostic[] = [];
  const { worker, server, crashes, executor } = await startExecutor({
    routing: true,
    acknowledgeClaimedRuns: false,
    onCandidateDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
  });
  try {
    // The claim lands and its activation is posted to the Worker, then held
    // in-flight (unacknowledged) — the race window.
    worker.candidate(CLAIM_KEY);
    await flushClaimControl();
    assertEquals(server.claimRequests.length, 1);
    assertEquals(worker.pendingClaimedRunIds.length, 1);

    // A concurrent shrink retires the claim's root while its activation is
    // still in flight. Ordinary shrink neither resets claims nor waits for
    // settlement (W2.6), so the activation stays held and no claim is revoked
    // yet.
    let changed = false;
    const changing = (async () => {
      await executor.setDemand(["space:of:other-piece"]);
      changed = true;
    })();
    await flushClaimControl();
    assertEquals(changed, true);
    assertEquals(server.revoked, []);
    assertEquals(worker.terminated, false);

    // The raced activation settles as a claim-scoped release (the action died
    // in the shrink window — ClaimedActionGoneError → exact release, tolerated
    // by W2.5), NOT a lane-fatal error. `action-unregistered` is the release
    // code the production Worker emits (executor-worker.ts, both release
    // paths); the real-seam fixture below pins it end-to-end.
    worker.invalidated(CLAIM, "action-unregistered");
    await flushClaimControl();
    await changing;

    // Exactly one revoke; the lane stays live and no fatal was posted.
    assertEquals(server.revoked, [CLAIM]);
    assertEquals(diagnostics, [{
      claim: CLAIM,
      diagnosticCode: "action-unregistered",
    }]);
    assertEquals(crashes, []);
    assertEquals(worker.terminated, false);
  } finally {
    await executor.stop({ abrupt: true });
  }
});

Deno.test("ordinary shadow rejection reports a host-local candidate diagnostic", async () => {
  const diagnostics: CandidateDiagnostic[] = [];
  const { worker, server, crashes, executor } = await startExecutor({
    routing: false,
    onCandidateDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
  });
  try {
    worker.diagnostic({
      claimKey: CLAIM_KEY,
      diagnosticCode: "non-space-write-scope",
    });
    await flushClaimControl();

    assertEquals(diagnostics, [{
      claimKey: CLAIM_KEY,
      diagnosticCode: "non-space-write-scope",
    }]);
    assertEquals(server.claimRequests, []);
    assertEquals(crashes, []);
  } finally {
    await executor.stop();
  }
});

Deno.test("changed action identity revokes its old host claim", async () => {
  const diagnostics: CandidateDiagnostic[] = [];
  const { worker, server, crashes, executor } = await startExecutor({
    routing: true,
    onCandidateDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
  });
  try {
    worker.candidate(CLAIM_KEY);
    await flushClaimControl();
    worker.invalidated(CLAIM, "claim-key-mismatch");
    await flushClaimControl();

    assertEquals(crashes, []);
    assertEquals(server.revoked, [CLAIM]);
    assertEquals(diagnostics, [{
      claim: CLAIM,
      diagnosticCode: "claim-key-mismatch",
    }]);
  } finally {
    await executor.stop();
  }
});

Deno.test("host records indexed executor writer discovery", async () => {
  const discoveries: WriterDiscovery[] = [];
  const { worker, crashes, executor } = await startExecutor({
    routing: false,
    onWriterDiscovery: (discovery) => discoveries.push(discovery),
  });
  try {
    const discovery: WriterDiscovery = {
      pieceId: CLAIM_KEY.pieceId,
      indexMiss: false,
      writers: [{
        branch: CLAIM_KEY.branch,
        ownerSpace: CLAIM_KEY.space,
        actionId: CLAIM_KEY.actionId,
        pieceId: CLAIM_KEY.pieceId,
        processGeneration: 0,
        actionKind: CLAIM_KEY.actionKind,
        implementationFingerprint: CLAIM_KEY.implementationFingerprint,
        runtimeFingerprint: CLAIM_KEY.runtimeFingerprint,
        source: "live+durable",
      }],
    };
    worker.writerDiscovery(discovery);
    await flushClaimControl();

    assertEquals(discoveries, [discovery]);
    assertEquals(crashes, []);
  } finally {
    await executor.stop();
  }
});

Deno.test("the explicit routing capability turns an exact CandidateClaim into an asserted executor rerun", async () => {
  const candidates: CandidateClaim[] = [];
  const { worker, server, crashes, executor } = await startExecutor({
    routing: true,
    onCandidateClaim: (candidate) => candidates.push(candidate),
  });
  try {
    worker.candidate(CLAIM_KEY);
    await flushClaimControl();

    assertEquals(candidates, [{ claimKey: CLAIM_KEY }]);
    assertEquals(server.claimRequests, [{
      lease: LEASE,
      claimKey: CLAIM_KEY,
    }]);
    assertEquals(worker.messages.at(-1), {
      type: "run-claimed-action",
      requestId: 2,
      claim: CLAIM,
      assertion: {
        contextKey: "space",
        leaseGeneration: LEASE.leaseGeneration,
        claimGeneration: CLAIM.claimGeneration,
      },
    });
    assertEquals(crashes, []);
  } finally {
    await executor.stop();
  }
});

Deno.test("candidate authority waits until the Worker finishes activating demand", async () => {
  const { worker, server, crashes, executor } = await startExecutor({
    routing: true,
  });
  try {
    worker.acknowledgeSetDemand = false;
    const changing = executor.setDemand([
      CLAIM_KEY.pieceId,
      "space:of:another-piece",
    ]);
    await flushClaimControl();
    assertEquals(worker.pendingSetDemandIds.length, 1);

    // The real Worker emits candidates while set-demand is still traversing
    // the newly demanded roots. It cannot process run-claimed-action until
    // that same serialized traversal returns.
    worker.candidate(CLAIM_KEY);
    await flushClaimControl();
    assertEquals(server.claimRequests, []);
    assertEquals(
      worker.messages.some((message) =>
        (message as { type?: string }).type === "run-claimed-action"
      ),
      false,
    );

    worker.acknowledgeLatestSetDemand();
    await changing;
    await flushClaimControl();

    assertEquals(server.claimRequests, [{
      lease: LEASE,
      claimKey: CLAIM_KEY,
    }]);
    assertEquals(
      worker.messages.map((message) => (message as { type?: string }).type),
      ["initialize", "set-demand", "run-claimed-action"],
    );
    assertEquals(crashes, []);
  } finally {
    worker.acknowledgeSetDemand = true;
    await executor.stop();
  }
});

Deno.test("a release for a claim the host no longer holds is ignored", async () => {
  const diagnostics: CandidateDiagnostic[] = [];
  const { worker, server, crashes, executor } = await startExecutor({
    routing: true,
    onCandidateDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
  });
  try {
    // No claim was ever installed for this incarnation; the Worker's release
    // raced a host-side revoke. It must not crash the lane or revoke anything.
    worker.unserved(CLAIM, "dynamic-read-outside-static-surface");
    await flushClaimControl();

    assertEquals(crashes, []);
    assertEquals(worker.terminated, false);
    assertEquals(server.revoked, []);
    assertEquals(diagnostics, []);
  } finally {
    await executor.stop();
  }
});

Deno.test("a stale-generation release does not revoke a newer incarnation", async () => {
  const diagnostics: CandidateDiagnostic[] = [];
  const { worker, server, crashes, executor } = await startExecutor({
    routing: true,
    onCandidateDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
  });
  try {
    worker.candidate(CLAIM_KEY);
    await flushClaimControl();

    // A delayed release naming a previous claimGeneration must leave the live
    // incarnation untouched.
    worker.invalidated(
      { ...CLAIM, claimGeneration: CLAIM.claimGeneration - 1 },
      "dynamic-read-outside-static-surface",
    );
    await flushClaimControl();
    assertEquals(crashes, []);
    assertEquals(server.revoked, []);
    assertEquals(diagnostics, []);

    // The exact live incarnation still releases normally, exactly once.
    worker.invalidated(CLAIM, "dynamic-read-outside-static-surface");
    await flushClaimControl();
    assertEquals(crashes, []);
    assertEquals(server.revoked, [CLAIM]);
    assertEquals(diagnostics, [{
      claim: CLAIM,
      diagnosticCode: "dynamic-read-outside-static-surface",
    }]);
  } finally {
    await executor.stop();
  }
});

// --- C1.8 (A24): lane-partitioned demand wire and per-lane generations ---

const USER_LANE = "user:did%3Akey%3Az6Mk-candidate-alice";
const USER_CLAIM_KEY: ActionClaimKey = {
  ...CLAIM_KEY,
  contextKey: USER_LANE as ActionClaimKey["contextKey"],
};

type WireSetDemand = {
  type?: string;
  pieces?: string[];
  lanes?: {
    contextKey: string;
    pieces: string[];
    demandGeneration: number;
    resetClaims?: boolean;
  }[];
};

const setDemandMessages = (worker: FakeWorker): WireSetDemand[] =>
  worker.messages.filter((message) =>
    (message as WireSetDemand).type === "set-demand"
  ) as WireSetDemand[];

Deno.test("lane demand wire mints monotonic per-lane generations and keeps the pre-lane shape", async () => {
  const { worker, crashes, executor } = await startExecutor({ routing: true });
  try {
    // Lane-less demand: the wire is byte-identical to the pre-lane shape.
    await executor.setDemand([CLAIM_KEY.pieceId]);
    assertEquals("lanes" in setDemandMessages(worker)[0], false);

    // First lane appearance mints generation 1.
    await executor.setDemand([CLAIM_KEY.pieceId], [{
      contextKey: USER_LANE,
      pieces: [CLAIM_KEY.pieceId],
    }]);
    assertEquals(setDemandMessages(worker)[1].lanes, [{
      contextKey: USER_LANE,
      pieces: [CLAIM_KEY.pieceId],
      demandGeneration: 1,
    }]);

    // An unchanged live lane keeps its generation.
    await executor.setDemand([CLAIM_KEY.pieceId], [{
      contextKey: USER_LANE,
      pieces: [CLAIM_KEY.pieceId],
    }]);
    assertEquals(setDemandMessages(worker)[2].lanes?.[0].demandGeneration, 1);

    // A pool-signalled reset (re-anchor) bumps and forwards resetClaims.
    await executor.setDemand([CLAIM_KEY.pieceId], [{
      contextKey: USER_LANE,
      pieces: [CLAIM_KEY.pieceId],
      resetClaims: true,
    }]);
    assertEquals(setDemandMessages(worker)[3].lanes, [{
      contextKey: USER_LANE,
      pieces: [CLAIM_KEY.pieceId],
      demandGeneration: 2,
      resetClaims: true,
    }]);

    // Close, then reopen: the generation resumes ABOVE its old high-water
    // mark so stale in-flight candidates can never revalidate.
    await executor.setDemand([CLAIM_KEY.pieceId], []);
    assertEquals(setDemandMessages(worker)[4].lanes, []);
    await executor.setDemand([CLAIM_KEY.pieceId], [{
      contextKey: USER_LANE,
      pieces: [CLAIM_KEY.pieceId],
    }]);
    assertEquals(setDemandMessages(worker)[5].lanes?.[0].demandGeneration, 3);
    assertEquals(crashes, []);
  } finally {
    await executor.stop();
  }
});

Deno.test("startup lanes ride the initialize wire with minted generations", async () => {
  const worker = new FakeWorker();
  const server = new ClaimRecordingServer();
  const channel = new MessageChannel();
  const factory = new DenoSpaceExecutorFactory({
    server: server as unknown as Server,
    apiUrl: new URL("https://toolshed.example/"),
    protocolFlags: {
      serverPrimaryExecutionV1: true,
      serverPrimaryExecutionClaimRoutingV1: true,
      serverPrimaryExecutionBuiltinPassivityV1: true,
    },
    now: () => 0,
    createWorker: () => {
      queueMicrotask(() => worker.boot());
      return worker;
    },
    createProvider: () => ({
      port: channel.port1,
      dispose: () => {
        channel.port2.close();
        return Promise.resolve();
      },
    }),
  });
  const executor = await factory.start({
    space: SPACE,
    branch: BRANCH,
    lease: LEASE,
    pieces: [CLAIM_KEY.pieceId],
    lanes: [{
      contextKey: USER_LANE,
      pieces: [CLAIM_KEY.pieceId],
      resetClaims: true,
    }],
    onCrash: () => {},
  });
  try {
    const initialize = worker.messages.find((message) =>
      (message as { type?: string }).type === "initialize"
    ) as WireSetDemand;
    assertEquals(initialize.lanes, [{
      contextKey: USER_LANE,
      pieces: [CLAIM_KEY.pieceId],
      demandGeneration: 1,
      resetClaims: true,
    }]);
  } finally {
    await executor.stop();
  }
});

Deno.test("user candidates validate against their own lane's generation", async () => {
  const { worker, server, crashes, executor } = await startExecutor({
    routing: true,
  });
  try {
    // Pre-lane (C1.5a) compatibility: before any lane is wired, a user
    // candidate rides the space generation check byte-identically. A
    // distinct action keeps its live claim from occluding later candidates.
    worker.candidate({
      ...USER_CLAIM_KEY,
      actionId: "cf:module/abc:compute:pre-lane",
    });
    await flushClaimControl();
    assertEquals(server.claimRequests.length, 1);

    await executor.setDemand([CLAIM_KEY.pieceId], [{
      contextKey: USER_LANE,
      pieces: [CLAIM_KEY.pieceId],
      resetClaims: true,
    }]);

    // resetClaims wired generation 1; a candidate minted before the reset
    // (no generation) is stale and never claims.
    worker.candidate(USER_CLAIM_KEY);
    await flushClaimControl();
    assertEquals(server.claimRequests.length, 1);

    // The lane's current generation claims.
    worker.candidate(USER_CLAIM_KEY, { demandGeneration: 1 });
    await flushClaimControl();
    assertEquals(server.claimRequests.length, 2);
    assertEquals(server.claimRequests[1].claimKey, USER_CLAIM_KEY);

    // A candidate of a lane that is NOT wired is dropped once lanes are
    // engaged — its server-side grant is gone (routing disjointness).
    worker.candidate(
      {
        ...CLAIM_KEY,
        contextKey: "user:did%3Akey%3Az6Mk-candidate-bob",
      } as ActionClaimKey,
      { demandGeneration: 1 },
    );
    await flushClaimControl();
    assertEquals(server.claimRequests.length, 2);

    // Space candidates stay on the global generation, untouched by lanes.
    worker.candidate(CLAIM_KEY);
    await flushClaimControl();
    assertEquals(server.claimRequests.length, 3);
    assertEquals(crashes, []);
  } finally {
    await executor.stop();
  }
});

// ---------------------------------------------------------------------------
// FW7/FB4 — the W2.6 shrink-race through the REAL Worker seam. The fixtures
// above script the Worker by hand, so none of them execute the production
// decision logic this race guards: `startClaimedAction` discovering the
// action died in the shrink window (`ClaimedActionGoneError`) and the
// request handler converting it into a claim-scoped `invalidated-claim`
// release (diagnostic `action-unregistered`) instead of a lane fatal
// (executor-worker.ts). This fixture self-hosts the real production loop —
// real memory Server, real executor Worker — and makes the race
// deterministic by holding the claimed activation message at the host/Worker
// boundary while an ordinary shrink retires the claimed action, then
// releasing it: the activation is guaranteed to find the action unregistered.
// ---------------------------------------------------------------------------

const REAL_SEAM_FLAGS = {
  persistentSchedulerState: true,
  schedulerWriterLookup: true,
  serverPrimaryExecutionV1: true,
  serverPrimaryExecutionClaimRoutingV1: true,
  serverPrimaryExecutionBuiltinPassivityV1: true,
} as const satisfies Partial<MemoryProtocolFlags>;

const DOUBLER_PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      "/// <cts-enable />",
      "import { pattern, computed } from 'commonfabric';",
      "export default pattern<{ value: number }>(({ value }) =>",
      "  computed(() => (value as any) * 2));",
    ].join("\n"),
  }],
};

class LoopbackSessionFactory implements SessionFactory {
  constructor(
    private readonly server: Server,
    private readonly flags: Partial<MemoryProtocolFlags>,
  ) {}

  async create(
    space: MemorySpace,
    signer?: Signer,
    mountOptions: MemoryClient.MountOptions = {},
  ) {
    const client = await MemoryClient.connect({
      transport: MemoryClient.loopback(this.server),
      protocolFlags: this.flags,
    });
    const session = await client.mount(
      space,
      mountOptions,
      (_space, _session, context) => ({
        invocation: {
          aud: context.audience,
          challenge: context.challenge.value,
        },
        authorization: { principal: signer?.did() },
      }),
    );
    return { client, session };
  }
}

class LoopbackStorageManager extends StorageManager {
  static connectTo(
    server: Server,
    flags: Partial<MemoryProtocolFlags>,
    options: Omit<StorageOptions, "memoryHost" | "spaceHostMap">,
  ): LoopbackStorageManager {
    return new LoopbackStorageManager(
      { ...options, memoryHost: new URL("memory://executor-shrink-race") },
      new LoopbackSessionFactory(server, flags),
    );
  }
}

const awaitControlBarrier = async <T>(
  barrier: Promise<T>,
  name: string,
  events: readonly string[],
): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      barrier,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${name} timed out: ${events.join(" | ")}`)),
          15_000,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

/** The REAL executor Worker behind a message tap: outgoing
 * `run-claimed-action` requests for one piece are HELD until the test
 * releases them, which is exactly the shrink-race window (claim issued,
 * activation in flight, demand shrink lands first). Everything else passes
 * through byte-identical, and every Worker->host event is re-dispatched
 * unchanged. */
class HoldingRealWorker extends EventTarget implements ExecutorWorkerLike {
  readonly #inner: Worker;
  readonly held: Array<{ message: unknown; transfer: Transferable[] }> = [];
  readonly fatals: string[] = [];
  #holdClaimedRunsFor: string | null = null;

  constructor() {
    super();
    this.#inner = new Worker(
      new URL("../src/executor/executor-worker.ts", import.meta.url).href,
      { type: "module" },
    );
    for (const type of ["message", "error", "messageerror"] as const) {
      this.#inner.addEventListener(type, (event: Event) => {
        if (type === "message") {
          const data = (event as MessageEvent<unknown>).data;
          const shape = data as { type?: string; message?: string };
          if (shape.type === "fatal") {
            this.fatals.push(shape.message ?? "unknown fatal");
          }
          this.dispatchEvent(new MessageEvent("message", { data }));
          return;
        }
        this.dispatchEvent(new Event(type));
      });
    }
  }

  holdClaimedRunsFor(pieceId: string): void {
    this.#holdClaimedRunsFor = pieceId;
  }

  releaseHeld(): void {
    for (const { message, transfer } of this.held.splice(0)) {
      this.#inner.postMessage(message, transfer);
    }
  }

  postMessage(message: unknown, transfer: Transferable[] = []): void {
    const request = message as {
      type?: string;
      claim?: { pieceId?: string };
    };
    if (
      request.type === "run-claimed-action" &&
      this.#holdClaimedRunsFor !== null &&
      request.claim?.pieceId === this.#holdClaimedRunsFor
    ) {
      this.held.push({ message, transfer });
      return;
    }
    this.#inner.postMessage(message, transfer);
  }

  terminate(): void {
    this.#inner.terminate();
  }
}

Deno.test("the real Worker settles a claimed activation raced by a concurrent shrink as one claim-scoped release", async () => {
  // Deterministic teardown barrier: terminating a real Worker can race the
  // Deno event loop's resolution check and kill the run at the test's final
  // awaits ("Promise resolution is still pending but the event loop has
  // already resolved"); a pending no-op timer held across the test keeps the
  // loop refed through that window (same mitigation as the patterns
  // user-lane gate suite).
  const keepAlive = setInterval(() => {}, 60_000);
  try {
    const principal = await Identity.fromPassphrase(
      `executor shrink race real seam ${crypto.randomUUID()}`,
    );
    const space = principal.did();
    const server = new Server({
      authorizeSessionOpen(message) {
        const value = (message.authorization as { principal?: unknown })
          ?.principal;
        return typeof value === "string" ? value : undefined;
      },
      sessionOpenAuth: { audience: "did:key:z6Mk-shrink-race-real-seam" },
      protocolFlags: REAL_SEAM_FLAGS,
      acl: { mode: "off", serviceDids: [space] },
    });
    const seedStorage = LoopbackStorageManager.connectTo(
      server,
      REAL_SEAM_FLAGS,
      { as: principal },
    );
    const seedRuntime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: seedStorage,
      experimental: {
        persistentSchedulerState: true,
        serverPrimaryExecution: true,
      },
    });
    let executor:
      | Awaited<ReturnType<DenoSpaceExecutorFactory["start"]>>
      | null = null;
    let observerClient: MemoryClient.Client | null = null;
    let unsubscribeControl = () => {};
    const events: string[] = [];
    try {
      const compiled = await seedRuntime.patternManager.compilePattern(
        DOUBLER_PROGRAM,
        { space },
      );
      const seed = async (name: string, value: number) => {
        const tx = seedRuntime.edit();
        const input = seedRuntime.getCell<number>(
          space,
          `shrink-race-input-${name}`,
          undefined,
          tx,
        );
        input.set(value);
        const result = seedRuntime.getCell<number>(
          space,
          `shrink-race-result-${name}`,
          undefined,
          tx,
        );
        const handle = seedRuntime.run(tx, compiled, { value: input }, result);
        assertEquals((await tx.commit()).error, undefined);
        assertEquals(await handle.pull(), value * 2);
        return { input, result };
      };
      const pieceA = await seed("a", 5);
      const pieceB = await seed("b", 6);
      await seedRuntime.settled();
      await seedRuntime.storageManager.synced();
      await seedRuntime.dispose();

      observerClient = await MemoryClient.connect({
        transport: MemoryClient.loopback(server),
        protocolFlags: REAL_SEAM_FLAGS,
      });
      const observer = await observerClient.mount(
        space,
        {},
        (_space, _session, context) => ({
          invocation: {
            aud: context.audience,
            challenge: context.challenge.value,
          },
          authorization: { principal: space },
        }),
      );
      await observer.setExecutionDemand("", [
        pieceA.result.sourceURI,
        pieceB.result.sourceURI,
      ]);
      // Settlements are ordered against the session's data feed; watch both
      // roots so the control events can deliver.
      await observer.watchSet([{
        id: "shrink-race-a",
        kind: "graph",
        query: {
          roots: [{
            id: pieceA.result.sourceURI,
            selector: { path: [], schema: true },
          }],
        },
      }, {
        id: "shrink-race-b",
        kind: "graph",
        query: {
          roots: [{
            id: pieceB.result.sourceURI,
            selector: { path: [], schema: true },
          }],
        },
      }]);
      const lease = await server.acquireExecutionLease(space, "");
      assertExists(lease);

      const pieceIdA = `space:${pieceA.result.sourceURI}`;
      const pieceIdB = `space:${pieceB.result.sourceURI}`;
      const claims = new Map<string, ExecutionClaim>();
      const revokes: Array<{ pieceId: string; claimGeneration: number }> = [];
      const settlements: ActionSettlement[] = [];
      const bothClaimed = Promise.withResolvers<void>();
      const revokedB = Promise.withResolvers<void>();
      unsubscribeControl = observer.subscribeExecutionControl((event) => {
        events.push(event.type);
        if (event.type === "session.execution.claim.set") {
          claims.set(event.claim.pieceId, event.claim);
          if (claims.has(pieceIdA) && claims.has(pieceIdB)) {
            bothClaimed.resolve();
          }
        }
        if (event.type === "session.execution.claim.revoke") {
          revokes.push({
            pieceId: event.claim.pieceId,
            claimGeneration: event.claimGeneration,
          });
          if (event.claim.pieceId === pieceIdB) revokedB.resolve();
        }
        if (event.type === "session.execution.settlement") {
          settlements.push(event.settlement);
        }
      });

      const releaseDiagnostics: Array<{
        pieceId: string | undefined;
        diagnosticCode: string;
      }> = [];
      const holdingWorker = new HoldingRealWorker();
      holdingWorker.holdClaimedRunsFor(pieceIdB);
      const factory = new DenoSpaceExecutorFactory({
        server,
        apiUrl: new URL("https://toolshed.example/"),
        patternApiUrl: new URL("https://toolshed.example/"),
        experimental: {
          persistentSchedulerState: true,
          serverPrimaryExecution: true,
        },
        createWorker: () => holdingWorker,
        onCandidateDiagnostic: (diagnostic) =>
          releaseDiagnostics.push({
            pieceId: diagnostic.claim?.pieceId ?? diagnostic.claimKey?.pieceId,
            diagnosticCode: diagnostic.diagnosticCode,
          }),
      } as CandidateAwareFactoryOptions);
      executor = await factory.start({
        space,
        branch: "",
        lease,
        pieces: [pieceA.result.sourceURI, pieceB.result.sourceURI],
        onCrash(error) {
          events.push(`crash:${error}`);
        },
      });
      // One source invalidation per piece drives discovery to exact claims.
      await observer.transact({
        localSeq: 2,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: pieceA.input.sourceURI,
          value: { value: 7 },
        }],
      });
      await observer.transact({
        localSeq: 3,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: pieceB.input.sourceURI,
          value: { value: 8 },
        }],
      });
      await awaitControlBarrier(
        bothClaimed.promise,
        "both pieces claimed",
        events,
      );
      const claimA = claims.get(pieceIdA)!;
      const claimB = claims.get(pieceIdB)!;
      // B's claim is issued and its activation request is HELD in flight at
      // the host/Worker boundary: the race window is open.
      assertEquals(holdingWorker.held.length, 1);

      // An ordinary demand shrink retires B while its activation is in
      // flight. The Worker unregisters B's action; B was never live in the
      // Worker, so the shrink itself releases nothing — the held activation
      // is now doomed to find the action gone.
      await executor.setDemand([pieceA.result.sourceURI]);
      await executor.settle();
      assertEquals(revokes, []);
      assertEquals(server.listExecutionClaims(space).length, 2);
      assertEquals(holdingWorker.fatals, []);

      // Release the held activation: the REAL startClaimedAction hits
      // ClaimedActionGoneError and the Worker posts a claim-scoped release
      // with the production diagnostic — not a lane fatal.
      holdingWorker.releaseHeld();
      await awaitControlBarrier(
        revokedB.promise,
        "claim-scoped release of B",
        events,
      );

      // Exactly one revoke, for B's exact incarnation; A is untouched.
      assertEquals(revokes, [{
        pieceId: pieceIdB,
        claimGeneration: claimB.claimGeneration,
      }]);
      // The REAL wire diagnostic code, observed at the host release seam.
      assertEquals(
        releaseDiagnostics.filter((entry) => entry.pieceId === pieceIdB),
        [{ pieceId: pieceIdB, diagnosticCode: "action-unregistered" }],
      );
      // No lane fatal: the Worker posted no fatal message and the host saw
      // no crash; A's claim survives server-side.
      assertEquals(holdingWorker.fatals, []);
      assertEquals(events.filter((event) => event.startsWith("crash:")), []);
      assertEquals(server.listExecutionClaims(space), [claimA]);

      // The lane stays LIVE: the next source invalidation of A settles under
      // A's original claim incarnation, no reclaim.
      const settledA = Promise.withResolvers<ActionSettlement>();
      let sourceSeqA = Number.POSITIVE_INFINITY;
      const unsubscribeSettled = observer.subscribeExecutionControl(
        (event) => {
          if (
            event.type === "session.execution.settlement" &&
            event.settlement.claim.pieceId === pieceIdA &&
            event.settlement.inputBasisSeq >= sourceSeqA
          ) {
            settledA.resolve(event.settlement);
          }
        },
      );
      try {
        const source = await observer.transact({
          localSeq: 4,
          reads: { confirmed: [], pending: [] },
          operations: [{
            op: "set",
            id: pieceA.input.sourceURI,
            value: { value: 9 },
          }],
        });
        sourceSeqA = source.seq;
        const settlement = await awaitControlBarrier(
          settledA.promise,
          "post-race settlement for A",
          events,
        );
        assertEquals(
          settlement.outcome === "committed" || settlement.outcome === "no-op",
          true,
        );
        assertEquals(settlement.claim.claimGeneration, claimA.claimGeneration);
      } finally {
        unsubscribeSettled();
      }
      assertEquals(events.filter((event) => event.startsWith("crash:")), []);
    } finally {
      unsubscribeControl();
      await executor?.stop();
      await seedStorage.close();
      await observerClient?.close();
      await server.close();
    }
  } finally {
    clearInterval(keepAlive);
  }
});

// ---------------------------------------------------------------------------
// C2.5 — session-rank candidate identity end-to-end against the REAL server
// (the C2 wave-A grant machinery). The FakeWorker plays the Worker's wire
// half; the test process plays its replica half through the REAL host
// provider channel (HostStorageManager + the real executor action router),
// so the full CA9 identity chain is exercised: host session-lane grant ->
// claim issuance binding -> claim contextKey -> Worker acting lane ->
// claimed commit -> engine session commit fence -> settlement.
// ---------------------------------------------------------------------------

Deno.test("a session-rank candidate claims end-to-end under a live session lane grant, commits under the lane, and settles", async () => {
  const principal = await Identity.fromPassphrase(
    `executor session lane e2e ${crypto.randomUUID()}`,
  );
  const space = principal.did();
  const SESSION_PIECE = "space:of:session-e2e-piece";
  const SESSION_ACTION_ID = "action:session-e2e-derive";
  const server = new Server({
    authorizeSessionOpen(message) {
      const value = (message.authorization as { principal?: unknown })
        ?.principal;
      return typeof value === "string" ? value : undefined;
    },
    sessionOpenAuth: { audience: "did:key:z6Mk-session-lane-e2e" },
    protocolFlags: {
      ...REAL_SEAM_FLAGS,
      serverPrimaryExecutionContextLatticeClaimsV1: true,
    },
    acl: { mode: "off", serviceDids: [space] },
  });
  setServerPrimaryExecutionClaimRankConfig("session");
  setPersistentSchedulerStateConfig(true);
  const events: string[] = [];
  let client: MemoryClient.Client | null = null;
  let workerStorage: HostStorageManager | null = null;
  let executor: Awaited<ReturnType<DenoSpaceExecutorFactory["start"]>> | null =
    null;
  let unsubscribeControl = () => {};
  try {
    // The lane session: a REAL connected client session of the lane
    // principal that negotiated context-lattice-claims-v1 — the one
    // identity source the session lane may have (CA9).
    client = await MemoryClient.connect({
      transport: MemoryClient.loopback(server),
      protocolFlags: {
        ...REAL_SEAM_FLAGS,
        serverPrimaryExecutionContextLatticeClaimsV1: true,
      },
    });
    const session = await client.mount(
      space,
      {},
      (_space, _session, context) => ({
        invocation: {
          aud: context.audience,
          challenge: context.challenge.value,
        },
        authorization: { principal: space },
      }),
    ) as MemoryClient.SpaceSession & {
      sessionId: string;
      transact(commit: unknown): Promise<{ seq: number }>;
      setExecutionDemand(
        branch: string,
        pieces: readonly string[],
      ): Promise<boolean>;
      watchSet(watches: unknown[]): Promise<unknown>;
      subscribeExecutionControl(
        listener: (event: {
          type: string;
          claim?: { contextKey?: string };
          settlement?: { outcome?: string; claim?: { contextKey?: string } };
        }) => void,
      ): () => void;
    };
    // First commit flips the pre-launch compatibility capability to WRITE,
    // which grant creation and the lease demand.
    await session.transact({
      localSeq: 1,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: "of:session-e2e-seed",
        value: { value: "seed" },
      }],
    });
    await session.setExecutionDemand("", [SESSION_PIECE]);
    // Watch the session-scoped output: committed-settlement delivery gates
    // on the session's data sync reaching the settlement's accepted commit,
    // and the F6 cohort filter delivers the server-lane-authored session
    // row to exactly this owning session.
    await session.watchSet([{
      id: "session-e2e-watch",
      kind: "graph",
      query: {
        roots: [{
          id: "of:session-e2e-output",
          scope: "session",
          selector: { path: [], schema: false },
        }],
      },
    }]);
    const lease = await (server as unknown as {
      acquireExecutionLease(
        space: string,
        branch: string,
      ): Promise<ExecutionLeaseHandle | null>;
    }).acquireExecutionLease(space, "");
    assertExists(lease);
    // The wave-A grant machinery: the session is its own anchor.
    const grant = await (server as unknown as {
      openSessionLaneGrant(
        space: string,
        branch: string,
        principal: string,
        sessionId: string,
      ): Promise<{ contextKey: `session:${string}:${string}` }>;
    }).openSessionLaneGrant(space, "", space, session.sessionId);
    const sessionLane = grant.contextKey;
    assertEquals(
      sessionLane,
      sessionExecutionContextKey(space, session.sessionId),
    );

    const claimed = Promise.withResolvers<void>();
    const settled = Promise.withResolvers<string>();
    unsubscribeControl = session.subscribeExecutionControl((event) => {
      events.push(event.type);
      if (
        event.type === "session.execution.claim.set" &&
        event.claim?.contextKey === sessionLane
      ) {
        claimed.resolve();
      }
      if (
        event.type === "session.execution.settlement" &&
        event.settlement?.claim?.contextKey === sessionLane
      ) {
        settled.resolve(event.settlement?.outcome ?? "unknown");
      }
    });

    // The REAL host half: DenoSpaceExecutor with the real provider channel
    // (no createProvider override), scripted Worker wire.
    const worker = new FakeWorker();
    const diagnostics: CandidateDiagnostic[] = [];
    const factory = new DenoSpaceExecutorFactory({
      server,
      apiUrl: new URL("https://toolshed.example/"),
      protocolFlags: {
        serverPrimaryExecutionV1: true,
        serverPrimaryExecutionClaimRoutingV1: true,
        serverPrimaryExecutionBuiltinPassivityV1: true,
      },
      onCandidateDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      createWorker: () => {
        queueMicrotask(() => worker.boot());
        return worker;
      },
    });
    executor = await factory.start({
      space,
      branch: "",
      lease: lease as ExecutionLeaseHandle,
      pieces: [SESSION_PIECE],
      onCrash: (error) => events.push(`crash:${error}`),
    });
    // C2.7 owns pool-side session-lane demand aggregation; the wire itself
    // is already lane-generic — a session lane rides it like a user lane.
    await executor.setDemand([SESSION_PIECE], [{
      contextKey: sessionLane,
      pieces: [SESSION_PIECE],
    }]);

    const sessionClaimKey: ActionClaimKey = {
      branch: "",
      space,
      contextKey: sessionLane as ActionClaimKey["contextKey"],
      pieceId: SESSION_PIECE,
      actionId: SESSION_ACTION_ID,
      actionKind: "computation",
      implementationFingerprint: "impl:session-e2e",
      runtimeFingerprint: "runtime:session-e2e",
    };
    worker.candidate(sessionClaimKey, { demandGeneration: 1 });
    await awaitControlBarrier(claimed.promise, "session claim", events);
    assertEquals(diagnostics, []);

    // The claim's ACTIVATION carries the session identity to the Worker:
    // the acting context is the claim's validated contextKey — parsed from
    // the grant's canonical key, never assembled from a DID.
    const activation = worker.messages.find((message) =>
      (message as { type?: string }).type === "run-claimed-action"
    ) as { claim: ExecutionClaim } | undefined;
    assertExists(activation);
    assertEquals(activation.claim.contextKey, sessionLane);

    // The Worker's replica half: the REAL host provider channel port from
    // the initialize wire, the REAL executor router serving the session
    // lane. Commit a claimed session-context action run under the lane.
    const initialize = worker.messages.find((message) =>
      (message as { type?: string }).type === "initialize"
    ) as {
      port: MessagePort;
      protocolFlags?: Partial<MemoryProtocolFlags>;
    } | undefined;
    assertExists(initialize);
    const sourceAction = {};
    const router = createExecutorActionTransactionRouter({
      servedSpace: space as MemorySpace,
      branch: "",
      userRankCandidates: true,
      sessionRankCandidates: true,
      lanePrincipal: space,
      openUserLaneKeys: () => [sessionLane],
      claimForAction: (_action, lane) =>
        lane === sessionLane ? activation.claim : undefined,
      onCandidate: () => {},
    });
    workerStorage = HostStorageManager.connect({
      port: initialize.port,
      principal: space as MemorySpace,
      space: space as MemorySpace,
      branch: "",
      protocolFlags: initialize.protocolFlags as never,
      shadowWrites: true,
      actionTransactionRouter: router,
      executionLaneForAction: (action) =>
        action === sourceAction ? sessionLane as never : undefined,
    });
    const sessionOut = {
      space,
      scope: "session" as const,
      id: "of:session-e2e-output",
      path: ["value"],
    };
    const observation = {
      version: 2 as const,
      ownerSpace: space,
      branch: "",
      pieceId: SESSION_PIECE,
      processGeneration: 1,
      actionId: SESSION_ACTION_ID,
      actionKind: "computation" as const,
      implementationFingerprint: "impl:session-e2e",
      runtimeFingerprint: "runtime:session-e2e",
      observedAtSeq: 0,
      transactionKind: "action-run" as const,
      reads: [],
      shallowReads: [],
      actualChangedWrites: [sessionOut],
      currentKnownWrites: [sessionOut],
      materializerWriteEnvelopes: [],
      completeActionScopeSummary: {
        version: 1 as const,
        complete: true as const,
        implementationFingerprint: "impl:session-e2e",
        runtimeFingerprint: "runtime:session-e2e",
        piece: {
          space,
          scope: "space" as const,
          id: SESSION_PIECE.slice("space:".length),
          path: ["value"],
        },
        reads: [],
        writes: [sessionOut],
        materializerWriteEnvelopes: [],
        directOutputs: [sessionOut],
      },
      status: "success" as const,
    };
    const provider = workerStorage.open(space as MemorySpace);
    const committed = await workerStorage.runWithExecutionLane(
      space as MemorySpace,
      sessionLane as never,
      () =>
        provider.replica.commitNative!(
          {
            operations: [{
              op: "set",
              id: "of:session-e2e-output" as never,
              type: "application/json",
              scope: "session",
              value: { value: 42 },
            }],
            preconditions: [],
            schedulerObservation: observation,
          } as never,
          // Minimal IStorageTransaction shape: the router resolves the
          // commit's lane through sourceAction; the read builder needs the
          // (empty) read-activity log.
          { sourceAction, getReadActivities: () => [] } as never,
        ),
    );
    assertEquals(committed.error, undefined);
    const outcome = await awaitControlBarrier(
      settled.promise,
      "session settlement",
      events,
    );
    assertEquals(outcome, "committed");
  } finally {
    unsubscribeControl();
    if (executor !== null) await executor.stop();
    if (workerStorage !== null) await workerStorage.close();
    if (client !== null) await client.close();
    resetServerPrimaryExecutionClaimRankConfig();
    resetPersistentSchedulerStateConfig();
  }
});

// ---------------------------------------------------------------------------
// C2.7 — DEMAND-driven session-lane end-to-end against the REAL server and
// the REAL pool. Extends the C2.5 e2e above: nothing opens the grant or
// wires the lane by hand — the SharedExecutionPool derives the session lane
// from the session's PUBLISHED demand (design §2: "a session's demand
// implies demand for its own session-context lane; no new demand message is
// required — the host derives lane demand from the session that published
// it"), opens the grant on the real server, and delivers the lane on the
// contextKey-generic wire. Then the design's Bob-votes-Alice's-tally case:
// a FOREIGN principal's space commit invalidating the session-scoped
// derivation produces the A4 wake pair for the session lane — [space] +
// open user lanes + open SESSION lanes, the session lane paired with its
// OWNING session's demanded pieces — which reaches the Worker's replica
// half as an accepted-commit notice naming the session-context stale
// reader; the recompute commits under the lane and settles again to the
// owning session.
// ---------------------------------------------------------------------------

Deno.test("published session demand drives the pool to open the session lane; a foreign invalidating commit wakes it and the recompute settles", async () => {
  const principal = await Identity.fromPassphrase(
    `executor session demand e2e ${crypto.randomUUID()}`,
  );
  const space = principal.did();
  const FOREIGN_BOB = "did:key:z6Mk-session-demand-bob";
  const SESSION_PIECE = "space:of:session-demand-piece";
  const SESSION_ACTION_ID = "action:session-demand-derive";
  const SOURCE = {
    space,
    scope: "space" as const,
    id: "of:session-demand-source",
    path: ["value"],
  };
  const server = new Server({
    authorizeSessionOpen(message) {
      const value = (message.authorization as { principal?: unknown })
        ?.principal;
      return typeof value === "string" ? value : undefined;
    },
    sessionOpenAuth: { audience: "did:key:z6Mk-session-demand-e2e" },
    protocolFlags: {
      ...REAL_SEAM_FLAGS,
      serverPrimaryExecutionContextLatticeClaimsV1: true,
    },
    acl: { mode: "off", serviceDids: [space] },
  });
  setServerPrimaryExecutionClaimRankConfig("session");
  setPersistentSchedulerStateConfig(true);
  const events: string[] = [];
  let client: MemoryClient.Client | null = null;
  let bobClient: MemoryClient.Client | null = null;
  let workerStorage: HostStorageManager | null = null;
  let pool: SharedExecutionPool | null = null;
  let unsubscribeControl = () => {};
  try {
    client = await MemoryClient.connect({
      transport: MemoryClient.loopback(server),
      protocolFlags: {
        ...REAL_SEAM_FLAGS,
        serverPrimaryExecutionContextLatticeClaimsV1: true,
      },
    });
    const session = await client.mount(
      space,
      {},
      (_space, _session, context) => ({
        invocation: {
          aud: context.audience,
          challenge: context.challenge.value,
        },
        authorization: { principal: space },
      }),
    ) as MemoryClient.SpaceSession & {
      sessionId: string;
      transact(commit: unknown): Promise<{ seq: number }>;
      setExecutionDemand(
        branch: string,
        pieces: readonly string[],
      ): Promise<boolean>;
      watchSet(watches: unknown[]): Promise<unknown>;
      subscribeExecutionControl(
        listener: (event: {
          type: string;
          claim?: { contextKey?: string };
          settlement?: { outcome?: string; claim?: { contextKey?: string } };
        }) => void,
      ): () => void;
    };
    // First commit flips the pre-launch compatibility capability to WRITE,
    // which grant creation and the lease demand.
    await session.transact({
      localSeq: 1,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: SOURCE.id,
        value: { value: "seed" },
      }],
    });
    await session.watchSet([{
      id: "session-demand-watch",
      kind: "graph",
      query: {
        roots: [{
          id: "of:session-demand-output",
          scope: "session",
          selector: { path: [], schema: false },
        }],
      },
    }]);
    const sessionLane = sessionExecutionContextKey(space, session.sessionId);

    const claimed = Promise.withResolvers<void>();
    const settlements: string[] = [];
    let settlementBarrier = Promise.withResolvers<string>();
    unsubscribeControl = session.subscribeExecutionControl((event) => {
      events.push(event.type);
      if (
        event.type === "session.execution.claim.set" &&
        event.claim?.contextKey === sessionLane
      ) {
        claimed.resolve();
      }
      if (
        event.type === "session.execution.settlement" &&
        event.settlement?.claim?.contextKey === sessionLane
      ) {
        settlements.push(event.settlement?.outcome ?? "unknown");
        settlementBarrier.resolve(event.settlement?.outcome ?? "unknown");
      }
    });

    // The REAL pool over the REAL control surface: session-lane lifecycle
    // engages through the published-demand snapshot alone.
    const worker = new FakeWorker();
    const diagnostics: CandidateDiagnostic[] = [];
    const factory = new DenoSpaceExecutorFactory({
      server,
      apiUrl: new URL("https://toolshed.example/"),
      protocolFlags: {
        serverPrimaryExecutionV1: true,
        serverPrimaryExecutionClaimRoutingV1: true,
        serverPrimaryExecutionBuiltinPassivityV1: true,
      },
      onCandidateDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      createWorker: () => {
        queueMicrotask(() => worker.boot());
        return worker;
      },
    });
    pool = new SharedExecutionPool({
      control: server,
      factory,
      userLaneCandidates: true,
      sessionLaneCandidates: true,
    });
    pool.start();

    // Publishing demand is the ONLY driver: the pool acquires the lease,
    // opens the session (and user) lane grants, and starts the Worker with
    // the lane partition.
    await session.setExecutionDemand("", [SESSION_PIECE]);
    await pool.idle();
    const grant = (server as unknown as {
      sessionLaneGrant(
        space: string,
        branch: string,
        principal: string,
        sessionId: string,
      ): { contextKey: string } | null;
    }).sessionLaneGrant(space, "", space, session.sessionId);
    assertExists(grant, "the pool opened the session lane grant from demand");
    assertEquals(grant.contextKey, sessionLane);
    const initialize = worker.messages.find((message) =>
      (message as { type?: string }).type === "initialize"
    ) as {
      port: MessagePort;
      protocolFlags?: Partial<MemoryProtocolFlags>;
      lanes?: {
        contextKey: string;
        pieces: string[];
        demandGeneration: number;
      }[];
    } | undefined;
    assertExists(initialize);
    const wiredSessionLane = initialize.lanes?.find((lane) =>
      lane.contextKey === sessionLane
    );
    assertExists(wiredSessionLane, "the session lane rode the startup wire");
    assertEquals(wiredSessionLane.pieces, [SESSION_PIECE]);

    // Worker half: emit the session candidate; the host claims it against
    // the REAL issuance seam (live session lane grant required).
    const sessionClaimKey: ActionClaimKey = {
      branch: "",
      space,
      contextKey: sessionLane as ActionClaimKey["contextKey"],
      pieceId: SESSION_PIECE,
      actionId: SESSION_ACTION_ID,
      actionKind: "computation",
      implementationFingerprint: "impl:session-demand",
      runtimeFingerprint: "runtime:session-demand",
    };
    worker.candidate(sessionClaimKey, {
      demandGeneration: wiredSessionLane.demandGeneration,
    });
    await awaitControlBarrier(claimed.promise, "session claim", events);
    assertEquals(diagnostics, []);
    const activation = worker.messages.find((message) =>
      (message as { type?: string }).type === "run-claimed-action"
    ) as { claim: ExecutionClaim } | undefined;
    assertExists(activation);
    assertEquals(activation.claim.contextKey, sessionLane);

    // The Worker's replica half over the REAL provider channel, watching
    // for the accepted-commit notice that names the session-context stale
    // reader (the A4 wake pair reaching the Worker).
    const woke = Promise.withResolvers<void>();
    const sourceAction = {};
    const router = createExecutorActionTransactionRouter({
      servedSpace: space as MemorySpace,
      branch: "",
      userRankCandidates: true,
      sessionRankCandidates: true,
      lanePrincipal: space,
      openUserLaneKeys: () => [sessionLane],
      claimForAction: (_action, lane) =>
        lane === sessionLane ? activation.claim : undefined,
      onCandidate: () => {},
    });
    workerStorage = HostStorageManager.connect({
      port: initialize.port,
      principal: space as MemorySpace,
      space: space as MemorySpace,
      branch: "",
      protocolFlags: initialize.protocolFlags as never,
      shadowWrites: true,
      actionTransactionRouter: router,
      executionLaneForAction: (action) =>
        action === sourceAction ? sessionLane as never : undefined,
      onAcceptedCommitIntegrated(notice) {
        if (
          notice.staleDemandedReaders.some((reader) =>
            reader.executionContextKey === sessionLane &&
            reader.actionId === SESSION_ACTION_ID
          )
        ) {
          woke.resolve();
        }
      },
    });
    const sessionOut = {
      space,
      scope: "session" as const,
      id: "of:session-demand-output",
      path: ["value"],
    };
    const observationFor = () => ({
      version: 2 as const,
      ownerSpace: space,
      branch: "",
      pieceId: SESSION_PIECE,
      processGeneration: 1,
      actionId: SESSION_ACTION_ID,
      actionKind: "computation" as const,
      implementationFingerprint: "impl:session-demand",
      runtimeFingerprint: "runtime:session-demand",
      observedAtSeq: 0,
      transactionKind: "action-run" as const,
      reads: [SOURCE],
      shallowReads: [],
      actualChangedWrites: [sessionOut],
      currentKnownWrites: [sessionOut],
      materializerWriteEnvelopes: [],
      completeActionScopeSummary: {
        version: 1 as const,
        complete: true as const,
        implementationFingerprint: "impl:session-demand",
        runtimeFingerprint: "runtime:session-demand",
        piece: {
          space,
          scope: "space" as const,
          id: SESSION_PIECE.slice("space:".length),
          path: ["value"],
        },
        reads: [SOURCE],
        writes: [sessionOut],
        materializerWriteEnvelopes: [],
        directOutputs: [sessionOut],
      },
      status: "success" as const,
    });
    const provider = workerStorage.open(space as MemorySpace);
    const commitUnderLane = async (value: number) => {
      const committed = await workerStorage!.runWithExecutionLane(
        space as MemorySpace,
        sessionLane as never,
        () =>
          provider.replica.commitNative!(
            {
              operations: [{
                op: "set",
                id: "of:session-demand-output" as never,
                type: "application/json",
                scope: "session",
                value: { value },
              }],
              preconditions: [],
              schedulerObservation: observationFor(),
            } as never,
            { sourceAction, getReadActivities: () => [] } as never,
          ),
      );
      assertEquals(committed.error, undefined);
    };
    // First claimed run: session-context observation on the demanded piece
    // reading the shared source — claim, commit, settlement, delivered to
    // the owning session.
    await commitUnderLane(42);
    assertEquals(
      await awaitControlBarrier(
        settlementBarrier.promise,
        "first session settlement",
        events,
      ),
      "committed",
    );

    // Bob votes in Alice's tally: a FOREIGN principal's space commit to the
    // read source invalidates the session-scoped derivation. The A4 wake
    // pair for the session lane forms server-side and reaches the Worker's
    // replica half as the session-context stale reader.
    settlementBarrier = Promise.withResolvers<string>();
    bobClient = await MemoryClient.connect({
      transport: MemoryClient.loopback(server),
      protocolFlags: {
        ...REAL_SEAM_FLAGS,
        serverPrimaryExecutionContextLatticeClaimsV1: true,
      },
    });
    const bob = await bobClient.mount(
      space,
      {},
      (_space, _session, context) => ({
        invocation: {
          aud: context.audience,
          challenge: context.challenge.value,
        },
        authorization: { principal: FOREIGN_BOB },
      }),
    ) as typeof session;
    await bob.transact({
      localSeq: 1,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: SOURCE.id,
        value: { value: "bob-voted" },
      }],
    });
    await awaitControlBarrier(woke.promise, "session lane wake", events);

    // The recompute: the woken lane re-runs and its commit settles again to
    // the owning session.
    await commitUnderLane(43);
    assertEquals(
      await awaitControlBarrier(
        settlementBarrier.promise,
        "recompute settlement",
        events,
      ),
      "committed",
    );
    assertEquals(settlements, ["committed", "committed"]);
  } finally {
    unsubscribeControl();
    if (pool !== null) await pool.close();
    if (workerStorage !== null) await workerStorage.close();
    if (bobClient !== null) await bobClient.close();
    if (client !== null) await client.close();
    resetServerPrimaryExecutionClaimRankConfig();
    resetPersistentSchedulerStateConfig();
  }
});

Deno.test("CA9: session claims are refused at issuance without that session's live lane grant", async () => {
  const principal = await Identity.fromPassphrase(
    `executor session lane refusal ${crypto.randomUUID()}`,
  );
  const space = principal.did();
  const SESSION_PIECE = "space:of:session-refusal-piece";
  const server = new Server({
    authorizeSessionOpen(message) {
      const value = (message.authorization as { principal?: unknown })
        ?.principal;
      return typeof value === "string" ? value : undefined;
    },
    sessionOpenAuth: { audience: "did:key:z6Mk-session-refusal" },
    protocolFlags: {
      ...REAL_SEAM_FLAGS,
      serverPrimaryExecutionContextLatticeClaimsV1: true,
    },
    acl: { mode: "off", serviceDids: [space] },
  });
  setServerPrimaryExecutionClaimRankConfig("session");
  const events: string[] = [];
  let client: MemoryClient.Client | null = null;
  let executor: Awaited<ReturnType<DenoSpaceExecutorFactory["start"]>> | null =
    null;
  try {
    client = await MemoryClient.connect({
      transport: MemoryClient.loopback(server),
      protocolFlags: {
        ...REAL_SEAM_FLAGS,
        serverPrimaryExecutionContextLatticeClaimsV1: true,
      },
    });
    const session = await client.mount(
      space,
      {},
      (_space, _session, context) => ({
        invocation: {
          aud: context.audience,
          challenge: context.challenge.value,
        },
        authorization: { principal: space },
      }),
    ) as MemoryClient.SpaceSession & {
      sessionId: string;
      transact(commit: unknown): Promise<{ seq: number }>;
      setExecutionDemand(
        branch: string,
        pieces: readonly string[],
      ): Promise<boolean>;
    };
    await session.transact({
      localSeq: 1,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: "of:session-refusal-seed",
        value: { value: "seed" },
      }],
    });
    await session.setExecutionDemand("", [SESSION_PIECE]);
    const lease = await (server as unknown as {
      acquireExecutionLease(
        space: string,
        branch: string,
      ): Promise<ExecutionLeaseHandle | null>;
    }).acquireExecutionLease(space, "");
    assertExists(lease);

    const worker = new FakeWorker();
    const diagnostics: CandidateDiagnostic[] = [];
    const factory = new DenoSpaceExecutorFactory({
      server,
      apiUrl: new URL("https://toolshed.example/"),
      protocolFlags: {
        serverPrimaryExecutionV1: true,
        serverPrimaryExecutionClaimRoutingV1: true,
        serverPrimaryExecutionBuiltinPassivityV1: true,
      },
      onCandidateDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      createWorker: () => {
        queueMicrotask(() => worker.boot());
        return worker;
      },
    });
    executor = await factory.start({
      space,
      branch: "",
      lease: lease as ExecutionLeaseHandle,
      pieces: [SESSION_PIECE],
      onCrash: (error) => events.push(`crash:${error}`),
    });
    // A fabricated session id: canonical in SHAPE, but the host holds no
    // lane grant for it — the one authority a session identity can have.
    const fabricatedLane = sessionExecutionContextKey(
      space,
      "session:never-granted",
    );
    await executor.setDemand([SESSION_PIECE], [{
      contextKey: fabricatedLane,
      pieces: [SESSION_PIECE],
    }]);
    const fabricatedClaimKey: ActionClaimKey = {
      branch: "",
      space,
      contextKey: fabricatedLane as ActionClaimKey["contextKey"],
      pieceId: SESSION_PIECE,
      actionId: "action:session-refusal",
      actionKind: "computation",
      implementationFingerprint: "impl:session-refusal",
      runtimeFingerprint: "runtime:session-refusal",
    };
    const fabricatedLaneGeneration = setDemandMessages(worker)
      .at(-1)?.lanes?.find((lane) => lane.contextKey === fabricatedLane)
      ?.demandGeneration;
    assertExists(fabricatedLaneGeneration);
    worker.candidate(fabricatedClaimKey, {
      demandGeneration: fabricatedLaneGeneration,
    });
    const refused = await (async () => {
      for (let i = 0; i < 400; i++) {
        if (diagnostics.length > 0) return diagnostics;
        await new Promise((resolve) => setTimeout(resolve));
      }
      return diagnostics;
    })();
    assertEquals(refused.map((entry) => entry.diagnosticCode), [
      "claim-authority-lost",
    ]);
    // No activation ever reached the Worker for the fabricated session.
    assertEquals(
      worker.messages.some((message) =>
        (message as { type?: string }).type === "run-claimed-action"
      ),
      false,
    );

    // The same shape WITH a live grant issues — then closing the grant
    // (session-end = lane-end) refuses again: authority tracks the grant's
    // lifecycle exactly.
    const grant = await (server as unknown as {
      openSessionLaneGrant(
        space: string,
        branch: string,
        principal: string,
        sessionId: string,
      ): Promise<{ contextKey: `session:${string}:${string}` }>;
      closeSessionLaneGrant(grant: unknown): boolean;
    }).openSessionLaneGrant(space, "", space, session.sessionId);
    await executor.setDemand([SESSION_PIECE], [{
      contextKey: grant.contextKey,
      pieces: [SESSION_PIECE],
    }]);
    const grantedClaimKey: ActionClaimKey = {
      ...fabricatedClaimKey,
      contextKey: grant.contextKey as ActionClaimKey["contextKey"],
      actionId: "action:session-refusal-granted",
    };
    // The candidate must carry ITS lane's minted wire generation (A24).
    const grantedLaneGeneration = setDemandMessages(worker)
      .at(-1)?.lanes?.find((lane) => lane.contextKey === grant.contextKey)
      ?.demandGeneration;
    assertExists(grantedLaneGeneration);
    worker.candidate(grantedClaimKey, {
      demandGeneration: grantedLaneGeneration,
    });
    const activated = await (async () => {
      for (let i = 0; i < 400; i++) {
        const found = worker.messages.find((message) =>
          (message as { type?: string; claim?: { contextKey?: string } })
              .type === "run-claimed-action" &&
          (message as { claim?: { contextKey?: string } }).claim
              ?.contextKey === grant.contextKey
        );
        if (found !== undefined) return found;
        await new Promise((resolve) => setTimeout(resolve));
      }
      return undefined;
    })();
    assertExists(activated);
    assertEquals(events.filter((entry) => entry.startsWith("crash")), []);
  } finally {
    if (executor !== null) await executor.stop();
    if (client !== null) await client.close();
    resetServerPrimaryExecutionClaimRankConfig();
  }
});
