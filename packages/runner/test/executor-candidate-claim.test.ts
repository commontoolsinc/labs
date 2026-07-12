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
  claim: ExecutionClaim;
  diagnosticCode: string;
}

type CandidateAwareFactoryOptions = DenoSpaceExecutorFactoryOptions & {
  /** Host-local diagnostic only. This callback never publishes authority. */
  onCandidateClaim?: (candidate: CandidateClaim) => void;
  onCandidateDiagnostic?: (diagnostic: CandidateDiagnostic) => void;
};

class FakeWorker extends EventTarget implements ExecutorWorkerLike {
  readonly messages: unknown[] = [];
  terminated = false;

  boot(): void {
    this.dispatchEvent(
      new MessageEvent("message", {
        data: { type: "booted" },
      }),
    );
  }

  candidate(claimKey: ActionClaimKey): void {
    this.dispatchEvent(
      new MessageEvent("message", {
        data: {
          type: "candidate-claim",
          candidate: { claimKey },
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

  postMessage(message: unknown, _transfer?: Transferable[]): void {
    this.messages.push(message);
    const request = message as { type?: string; requestId?: number };
    if (request.type === "initialize") {
      this.dispatchEvent(
        new MessageEvent("message", {
          data: { type: "ready", requestId: request.requestId },
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

  setExecutionClaim(
    lease: ExecutionLeaseHandle,
    claimKey: ActionClaimKey,
  ): Promise<ExecutionClaim> {
    this.claimRequests.push({ lease, claimKey });
    return Promise.resolve(CLAIM);
  }

  revokeExecutionClaim(claim: ExecutionClaim): boolean {
    this.revoked.push(claim);
    return true;
  }
}

const flushClaimControl = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

const startExecutor = async (options: {
  routing: boolean;
  onCandidateClaim?: (candidate: CandidateClaim) => void;
  onCandidateDiagnostic?: (diagnostic: CandidateDiagnostic) => void;
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

    assertEquals(diagnostics, [{
      claim: CLAIM,
      diagnosticCode: "dynamic-non-space-read-scope",
    }]);
    assertEquals(server.revoked, [CLAIM]);
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
