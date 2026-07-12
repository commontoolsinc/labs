import * as MemoryClient from "../../v2/client.ts";
import * as Engine from "../../v2/engine.ts";
import { type ExecutionLeaseHandle, Server } from "../../v2/server.ts";

type Operation = "renew" | "commit";

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
let clock: Int32Array | undefined;
let sampledOperation: Operation | undefined;
let samplePublished = false;

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
  await sponsor.transact({
    localSeq: 1,
    reads: { confirmed: [], pending: [] },
    operations: [{
      op: "set",
      id: `of:${command.space}:execution-policy`,
      value: { value: { version: 1, serverPrimaryExecution: true } },
    }],
  });
  await sponsor.setExecutionDemand("", ["space:of:piece"]);
  lease = await server.acquireExecutionLease(command.space, "") ?? undefined;
  if (lease === undefined) throw new Error("executor lease was not acquired");

  executorClient = await connect();
  executorSession = await executorClient.mount(command.space, {}, sessionAuth);
  server.bindExecutionSession(command.space, executorSession.sessionId, lease);
  self.postMessage({ type: "executor-ready", expiresAt: lease.expiresAt });
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

const runCommit = async (): Promise<void> => {
  if (server === undefined || executorSession === undefined) {
    throw new Error("executor is not initialized");
  }
  sampledOperation = "commit";
  samplePublished = false;
  self.postMessage({ type: "commit-starting" });
  let accepted = false;
  let seq: number | undefined;
  let errorName: string | undefined;
  let errorMessage: string | undefined;
  try {
    const result = await executorSession.transact({
      localSeq: 1,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: "of:transaction-clock-output",
        value: { value: { accepted: true } },
      }],
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
    "of:transaction-clock-output",
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
        await runCommit();
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
