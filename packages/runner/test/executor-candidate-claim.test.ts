import { assertEquals } from "@std/assert";
import type {
  ActionClaimKey,
  BranchName,
  ExecutionClaim,
} from "@commonfabric/memory/v2";
import type {
  ExecutionLeaseHandle,
  Server,
} from "@commonfabric/memory/v2/server";
import {
  DenoSpaceExecutorFactory,
  type DenoSpaceExecutorFactoryOptions,
  type ExecutorWorkerLike,
} from "../src/executor/deno-space-executor.ts";

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

Deno.test("demand shrink revokes stale claims so re-added roots can reclaim", async () => {
  const { worker, server, crashes, executor } = await startExecutor({
    routing: true,
  });
  try {
    worker.candidate(CLAIM_KEY);
    await flushClaimControl();
    assertEquals(server.claimRequests.length, 1);

    await executor.setDemand(["space:of:other-piece"]);
    assertEquals(server.revoked, [CLAIM]);

    await executor.setDemand([CLAIM_KEY.pieceId, "space:of:other-piece"]);
    worker.candidate(CLAIM_KEY, { demandGeneration: 1 });
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
    assertEquals(server.revoked, [CLAIM]);
  } finally {
    if (!changed) worker.acknowledgeLatestClaimedRun();
    await changing;
    await flushClaimControl();
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
