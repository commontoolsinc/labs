import * as MemoryClient from "../../v2/client.ts";
import * as Engine from "../../v2/engine.ts";
import { type ExecutionLeaseHandle, Server } from "../../v2/server.ts";
import type { ExecutionClaim } from "../../v2.ts";

type Operation = "renew" | "commit" | "claimed-commit";

type WorkerCommand =
  | {
    type: "init-holder";
    database: string;
    gate: SharedArrayBuffer;
  }
  | {
    type: "init-executor";
    store: string;
    space: string;
    clock: SharedArrayBuffer;
    leaseTtlMs: number;
    claimTtlMs: number;
  }
  | { type: "hold-lock" }
  | { type: Operation }
  | { type: "close" };

const protocolFlags = {
  serverPrimaryExecutionV1: true,
  serverPrimaryExecutionClaimRoutingV1: true,
  serverPrimaryExecutionBuiltinPassivityV1: true,
} as const;

let holderEngine: Engine.Engine | undefined;
let holderGate: Int32Array | undefined;

let server: Server | undefined;
let sponsorClient: MemoryClient.Client | undefined;
let executorClient: MemoryClient.Client | undefined;
let executorSession: MemoryClient.SpaceSession | undefined;
let lease: ExecutionLeaseHandle | undefined;
let claim: ExecutionClaim | undefined;
let clock: Int32Array | undefined;
let sampledOperation: Operation | undefined;
let samplePublished = false;
let claimedCommitClockSamples = 0;

const principalFromAuthorization = (
  message: { authorization?: unknown },
): string | undefined => {
  const principal =
    (message.authorization as { principal?: unknown } | undefined)
      ?.principal;
  return typeof principal === "string" ? principal : undefined;
};

const sessionAuth: MemoryClient.SessionOpenAuthFactory = (
  _space,
  _session,
  context,
) => ({
  invocation: {
    aud: context.audience,
    challenge: context.challenge.value,
  },
  authorization: { principal: principalSpace },
});

let principalSpace = "";

const sampleClock = (): number => {
  if (clock === undefined) throw new Error("executor clock is not initialized");
  const nowMs = Atomics.load(clock, 0);
  if (sampledOperation === "claimed-commit") {
    claimedCommitClockSamples += 1;
    if (claimedCommitClockSamples === 2) {
      // expireExecutionClaims samples once, then its timer reconciliation
      // samples again before the exact live claim is selected from the map.
      self.postMessage({ type: "claim-selected", nowMs });
    } else if (claimedCommitClockSamples > 2 && !samplePublished) {
      samplePublished = true;
      self.postMessage({
        type: "clock-sampled",
        operation: sampledOperation,
        nowMs,
      });
    }
    return nowMs;
  }
  if (sampledOperation !== undefined && !samplePublished) {
    samplePublished = true;
    self.postMessage({
      type: "clock-sampled",
      operation: sampledOperation,
      nowMs,
    });
  }
  return nowMs;
};

const initializeExecutor = async (
  command: Extract<WorkerCommand, { type: "init-executor" }>,
): Promise<void> => {
  if (server !== undefined) throw new Error("executor is already initialized");
  principalSpace = command.space;
  clock = new Int32Array(command.clock);
  server = new Server({
    store: new URL(command.store),
    authorizeSessionOpen: principalFromAuthorization,
    sessionOpenAuth: { audience: "did:key:z6Mk-lease-clock-worker" },
    protocolFlags,
    acl: { mode: "off", serviceDids: [command.space] },
    executionControl: {
      hostId: "host:transaction-clock",
      leaseTtlMs: command.leaseTtlMs,
      claimTtlMs: command.claimTtlMs,
      nowMs: sampleClock,
    },
  });

  const connect = async (): Promise<MemoryClient.Client> =>
    await MemoryClient.connect({
      transport: MemoryClient.loopback(server!),
      protocolFlags,
      executionCapabilities: { routing: true, builtinPassivity: true },
    } as MemoryClient.ConnectOptions);

  sponsorClient = await connect();
  const sponsor = await sponsorClient.mount(command.space, {}, sessionAuth);
  await sponsor.setExecutionDemand("", ["space:of:piece"]);
  lease = await server.acquireExecutionLease(command.space, "") ?? undefined;
  if (lease === undefined) throw new Error("executor lease was not acquired");
  claim = await server.setExecutionClaim(lease, {
    branch: "",
    space: command.space,
    contextKey: "space",
    pieceId: "space:of:piece",
    actionId: "action:transaction-clock",
    actionKind: "computation",
    implementationFingerprint: "impl:v1",
    runtimeFingerprint: "runtime:v1",
  });

  executorClient = await connect();
  executorSession = await executorClient.mount(command.space, {}, sessionAuth);
  server.bindExecutionSession(command.space, executorSession.sessionId, lease);
  self.postMessage({
    type: "executor-ready",
    expiresAt: lease.expiresAt,
    claimExpiresAt: claim.expiresAt,
  });
};

const runRenewal = async (): Promise<void> => {
  if (server === undefined || lease === undefined) {
    throw new Error("executor is not initialized");
  }
  sampledOperation = "renew";
  samplePublished = false;
  self.postMessage({ type: "renew-starting" });
  const renewed = await server.renewExecutionLease(lease);
  sampledOperation = undefined;
  self.postMessage({ type: "renew-result", lease: renewed });
};

const claimedObservation = (liveClaim: ExecutionClaim, outputId: string) => ({
  version: 2 as const,
  ownerSpace: liveClaim.space,
  branch: liveClaim.branch,
  pieceId: liveClaim.pieceId,
  processGeneration: 1,
  actionId: liveClaim.actionId,
  actionKind: liveClaim.actionKind,
  implementationFingerprint: liveClaim.implementationFingerprint,
  runtimeFingerprint: liveClaim.runtimeFingerprint,
  executionClaimAssertion: {
    contextKey: liveClaim.contextKey,
    leaseGeneration: liveClaim.leaseGeneration,
    claimGeneration: liveClaim.claimGeneration,
  },
  completeActionScopeSummary: {
    version: 1 as const,
    complete: true as const,
    implementationFingerprint: liveClaim.implementationFingerprint,
    runtimeFingerprint: liveClaim.runtimeFingerprint,
    piece: {
      space: liveClaim.space,
      scope: "space" as const,
      id: liveClaim.pieceId.slice("space:".length),
      path: [],
    },
    reads: [],
    writes: [{
      space: liveClaim.space,
      scope: "space" as const,
      id: outputId,
      path: ["value"],
    }],
    materializerWriteEnvelopes: [],
    directOutputs: [{
      space: liveClaim.space,
      scope: "space" as const,
      id: outputId,
      path: ["value"],
    }],
  },
  observedAtSeq: 0,
  transactionKind: "action-run" as const,
  reads: [],
  shallowReads: [],
  actualChangedWrites: [{
    space: liveClaim.space,
    scope: "space" as const,
    id: outputId,
    path: ["value"],
  }],
  currentKnownWrites: [{
    space: liveClaim.space,
    scope: "space" as const,
    id: outputId,
    path: ["value"],
  }],
  declaredWrites: [{
    space: liveClaim.space,
    scope: "space" as const,
    id: outputId,
    path: ["value"],
  }],
  materializerWriteEnvelopes: [],
  status: "success" as const,
});

const runCommit = async (claimed: boolean): Promise<void> => {
  if (server === undefined || executorSession === undefined) {
    throw new Error("executor is not initialized");
  }
  if (claimed && claim === undefined) {
    throw new Error("executor claim is not initialized");
  }
  sampledOperation = claimed ? "claimed-commit" : "commit";
  samplePublished = false;
  claimedCommitClockSamples = 0;
  self.postMessage({ type: "commit-starting" });
  let accepted = false;
  let seq: number | undefined;
  let errorName: string | undefined;
  let errorMessage: string | undefined;
  try {
    const outputId = claimed
      ? "of:transaction-clock-claimed-output"
      : "of:transaction-clock-output";
    const result = await executorSession.transact({
      localSeq: 1,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: outputId,
        value: { value: { accepted: true } },
      }],
      ...(claimed
        ? { schedulerObservation: claimedObservation(claim!, outputId) }
        : {}),
    });
    accepted = true;
    seq = result.seq;
  } catch (cause) {
    errorName = cause instanceof Error ? cause.name : "Error";
    errorMessage = cause instanceof Error ? cause.message : String(cause);
  } finally {
    sampledOperation = undefined;
  }
  const document = await server.readDocument(
    principalSpace,
    claimed
      ? "of:transaction-clock-claimed-output"
      : "of:transaction-clock-output",
  );
  self.postMessage({
    type: "commit-result",
    accepted,
    ...(seq !== undefined ? { seq } : {}),
    ...(errorName !== undefined ? { errorName } : {}),
    ...(errorMessage !== undefined ? { errorMessage } : {}),
    document,
  });
};

const closeWorker = async (): Promise<void> => {
  await executorClient?.close();
  executorClient = undefined;
  await sponsorClient?.close();
  sponsorClient = undefined;
  await server?.close();
  server = undefined;
  if (holderEngine !== undefined) {
    Engine.close(holderEngine);
    holderEngine = undefined;
  }
  self.postMessage({ type: "closed" });
};

self.onmessage = async (event: MessageEvent<WorkerCommand>) => {
  try {
    switch (event.data.type) {
      case "init-holder":
        if (holderEngine !== undefined) {
          throw new Error("lock holder is already initialized");
        }
        holderGate = new Int32Array(event.data.gate);
        holderEngine = await Engine.open({ url: new URL(event.data.database) });
        self.postMessage({ type: "holder-ready" });
        break;
      case "init-executor":
        await initializeExecutor(event.data);
        break;
      case "hold-lock":
        if (holderEngine === undefined || holderGate === undefined) {
          throw new Error("lock holder is not initialized");
        }
        holderEngine.database.transaction(() => {
          self.postMessage({ type: "locked" });
          Atomics.wait(holderGate!, 0, 0);
        }).immediate();
        self.postMessage({ type: "released" });
        break;
      case "renew":
        await runRenewal();
        break;
      case "commit":
        await runCommit(false);
        break;
      case "claimed-commit":
        await runCommit(true);
        break;
      case "close":
        await closeWorker();
        break;
    }
  } catch (cause) {
    self.postMessage({
      type: "error",
      message: cause instanceof Error ? cause.message : String(cause),
      stack: cause instanceof Error ? cause.stack : undefined,
    });
  }
};

self.postMessage({ type: "booted" });
