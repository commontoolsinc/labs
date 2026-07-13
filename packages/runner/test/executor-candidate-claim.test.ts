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

interface CandidateClaim {
  claimKey: ActionClaimKey;
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

type CandidateAwareFactoryOptions = DenoSpaceExecutorFactoryOptions & {
  /** Host-local diagnostic only. This callback never publishes authority. */
  onCandidateClaim?: (candidate: CandidateClaim) => void;
  onCandidateDiagnostic?: (diagnostic: CandidateDiagnostic) => void;
  onWriterDiscovery?: (discovery: WriterDiscovery) => void;
};

class FakeWorker extends EventTarget implements ExecutorWorkerLike {
  readonly messages: unknown[] = [];
  terminated = false;
  settledSeq = 41;

  boot(): void {
    this.dispatchEvent(
      new MessageEvent("message", {
        data: { type: "booted" },
      }),
    );
  }

  candidate(claimKey: ActionClaimKey, demandGeneration?: number): void {
    this.dispatchEvent(
      new MessageEvent("message", {
        data: {
          type: "candidate-claim",
          candidate: {
            claimKey,
            ...(demandGeneration !== undefined ? { demandGeneration } : {}),
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

  writerDiscovery(discovery: WriterDiscovery): void {
    this.dispatchEvent(
      new MessageEvent("message", {
        data: { type: "writer-discovery", discovery },
      }),
    );
  }

  postMessage(message: unknown, _transfer?: Transferable[]): void {
    this.messages.push(message);
    const request = message as { type?: string; requestId?: number };
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
      request.type === "set-demand" || request.type === "wake" ||
      request.type === "stop"
    ) {
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
  claimAvailable = true;

  trySetExecutionClaim(
    lease: ExecutionLeaseHandle,
    claimKey: ActionClaimKey,
  ): Promise<ExecutionClaim | null> {
    this.claimRequests.push({ lease, claimKey });
    return Promise.resolve(this.claimAvailable ? CLAIM : null);
  }

  setExecutionClaim(
    lease: ExecutionLeaseHandle,
    claimKey: ActionClaimKey,
  ): Promise<ExecutionClaim> {
    this.claimRequests.push({ lease, claimKey });
    if (!this.claimAvailable) {
      return Promise.reject(new Error("execution policy is not enabled"));
    }
    return Promise.resolve(CLAIM);
  }

  revokeExecutionClaim(claim: ExecutionClaim): boolean {
    this.revoked.push(claim);
    return true;
  }

  renewExecutionClaim(
    _lease: ExecutionLeaseHandle,
    claim: ExecutionClaim,
  ): Promise<ExecutionClaim> {
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
}) => {
  const worker = new FakeWorker();
  const server = new ClaimRecordingServer();
  const channel = new MessageChannel();
  const crashes: unknown[] = [];
  const factoryOptions: CandidateAwareFactoryOptions = {
    server: server as unknown as Server,
    apiUrl: new URL("https://toolshed.example/"),
    protocolFlags: {
      serverPrimaryExecutionV1: true,
      serverPrimaryExecutionClaimRoutingV1: options.routing,
    },
    onCandidateClaim: options.onCandidateClaim,
    onCandidateDiagnostic: options.onCandidateDiagnostic,
    onWriterDiscovery: options.onWriterDiscovery,
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

Deno.test("policy-inactive candidates remain shadow and later acquire authority", async () => {
  const diagnostics: CandidateDiagnostic[] = [];
  const { worker, server, crashes, executor } = await startExecutor({
    routing: true,
    onCandidateDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
  });
  server.claimAvailable = false;
  try {
    worker.candidate(CLAIM_KEY);
    await flushClaimControl();

    assertEquals(server.claimRequests, [{
      lease: LEASE,
      claimKey: CLAIM_KEY,
    }]);
    assertEquals(diagnostics, [{
      claimKey: CLAIM_KEY,
      diagnosticCode: "execution-policy-disabled",
    }]);
    assertEquals(
      worker.messages.some((message) =>
        (message as { type?: string }).type === "run-claimed-action"
      ),
      false,
    );
    assertEquals(crashes, []);

    server.claimAvailable = true;
    worker.candidate(CLAIM_KEY);
    await flushClaimControl();
    assertEquals(server.claimRequests, [{
      lease: LEASE,
      claimKey: CLAIM_KEY,
    }, {
      lease: LEASE,
      claimKey: CLAIM_KEY,
    }]);
    assertEquals(worker.messages.at(-1), {
      type: "run-claimed-action",
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
    worker.candidate(CLAIM_KEY, 1);
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
