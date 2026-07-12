import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { toFileUrl } from "@std/path";
import * as MemoryClient from "../v2/client.ts";
import * as Engine from "../v2/engine.ts";
import { resolveSpaceStoreUrl } from "../v2/storage-path.ts";
import {
  type ExecutionLeaseHandle,
  parseClientMessage,
  Server,
} from "../v2/server.ts";
import {
  decodeMemoryBoundary,
  encodeMemoryBoundary,
  toDocumentPath,
} from "../v2.ts";
import {
  TEST_SESSION_OPEN_PRINCIPAL,
  testSessionOpenAuthFactory,
  testSessionOpenServerOptions,
} from "./v2-auth-test-helpers.ts";

const POLICY_SPACE = "did:key:z6Mk-server-execution-policy-space";

type ExecutionClientOptions = MemoryClient.ConnectOptions & {
  protocolFlags?: {
    serverPrimaryExecutionV1?: boolean;
    serverPrimaryExecutionClaimRoutingV1?: boolean;
    serverPrimaryExecutionBuiltinPassivityV1?: boolean;
  };
  executionCapabilities?: {
    routing?: boolean;
    builtinPassivity?: boolean;
  };
};

type ExecutionSession = MemoryClient.SpaceSession & {
  setExecutionDemand(branch: string, pieces: readonly string[]): Promise<
    boolean
  >;
  readonly executionClaims: readonly ExecutionClaim[];
  subscribeExecutionControl(
    listener: (event: ExecutionControlEvent) => void,
  ): () => void;
  noteAppliedCommit(seq: number): void;
};

type ActionClaimKey = {
  branch: string;
  space: string;
  contextKey: "space" | `user:${string}` | `session:${string}:${string}`;
  pieceId: string;
  actionId: string;
  actionKind: "computation" | "effect" | "event-handler";
  implementationFingerprint: string;
  runtimeFingerprint: string;
};

type ExecutionClaim = ActionClaimKey & {
  leaseGeneration: number;
  claimGeneration: number;
  expiresAt: number;
};

type ActionSettlement =
  | {
    branch: string;
    claim: ExecutionClaim;
    inputBasisSeq: number;
    outcome: "committed";
    acceptedCommitSeq: number;
  }
  | {
    branch: string;
    claim: ExecutionClaim;
    inputBasisSeq: number;
    outcome: "no-op" | "failed" | "unserved";
    diagnosticCode?: string;
  };

type ExecutionControlEvent =
  | { type: "session.execution.claim.set"; claim: ExecutionClaim }
  | {
    type: "session.execution.claim.revoke";
    branch: string;
    claim: ActionClaimKey;
    leaseGeneration: number;
    claimGeneration: number;
  }
  | { type: "session.execution.settlement"; settlement: ActionSettlement };

type AuthenticatedExecutionDemand = {
  space: string;
  branch: string;
  sessionId: string;
  connectionId: string;
  principal: string;
  pieces: readonly string[];
};

type ExecutionDemandSnapshot = {
  space: string;
  branch: string;
  order: number;
  demands: readonly AuthenticatedExecutionDemand[];
};

type ExecutionServer = Server & {
  listExecutionDemands(
    space: string,
    branch: string,
  ): readonly AuthenticatedExecutionDemand[];
  acquireExecutionLease(
    space: string,
    branch: string,
    options?: { preferredOriginSessionId?: string },
  ): Promise<ExecutionLeaseHandle | null>;
  setExecutionClaim(
    lease: ExecutionLeaseHandle,
    claim: ActionClaimKey,
  ): Promise<ExecutionClaim>;
  revokeExecutionClaim(claim: ExecutionClaim): boolean;
  publishActionSettlement(settlement: ActionSettlement): boolean;
  listExecutionClaims(space: string): readonly ExecutionClaim[];
  expireExecutionClaims(now?: number): number;
  subscribeExecutionDemands(
    listener: (snapshot: ExecutionDemandSnapshot) => void,
  ): () => void;
  bindExecutionSession(
    space: string,
    sessionId: string,
    lease: ExecutionLeaseHandle,
  ): () => void;
};

const createServer = (
  name: string,
  serverPrimaryExecutionV1: boolean,
): ExecutionServer =>
  new Server(
    {
      ...testSessionOpenServerOptions,
      store: new URL(`memory://${name}`),
      protocolFlags: { serverPrimaryExecutionV1 },
      acl: { mode: "off", serviceDids: [TEST_SESSION_OPEN_PRINCIPAL] },
    } as ConstructorParameters<typeof Server>[0],
  ) as ExecutionServer;

const connectClient = async (
  server: Server,
  serverPrimaryExecutionV1: boolean,
): Promise<MemoryClient.Client> =>
  await MemoryClient.connect({
    transport: MemoryClient.loopback(server),
    protocolFlags: { serverPrimaryExecutionV1 },
    executionCapabilities: {
      routing: true,
      builtinPassivity: true,
    },
  } as ExecutionClientOptions);

const createControlServer = (
  name: string,
  options: {
    subscriptionRefreshDelayMs?: number;
    executionControl?: { claimTtlMs?: number; nowMs?: () => number };
  } = {},
): ExecutionServer =>
  new Server(
    {
      ...testSessionOpenServerOptions,
      store: new URL(`memory://${name}`),
      ...options,
      protocolFlags: {
        serverPrimaryExecutionV1: true,
        serverPrimaryExecutionClaimRoutingV1: true,
        serverPrimaryExecutionBuiltinPassivityV1: true,
      },
      acl: { mode: "off", serviceDids: [TEST_SESSION_OPEN_PRINCIPAL] },
    } as ConstructorParameters<typeof Server>[0],
  ) as ExecutionServer;

const connectControlClient = async (
  server: Server,
): Promise<MemoryClient.Client> =>
  await MemoryClient.connect({
    transport: MemoryClient.loopback(server),
    protocolFlags: {
      serverPrimaryExecutionV1: true,
      serverPrimaryExecutionClaimRoutingV1: true,
      serverPrimaryExecutionBuiltinPassivityV1: true,
    },
  } as ExecutionClientOptions);

const claimKey = (
  space: string,
  branch: string,
  actionId = "action:derive",
): ActionClaimKey => ({
  branch,
  space,
  contextKey: "space",
  pieceId: "space:piece:one",
  actionId,
  actionKind: "computation",
  implementationFingerprint: "impl:v1",
  runtimeFingerprint: "runtime:v1",
});

const claimedSpaceObservation = (
  claim: ExecutionClaim,
  outputId: string,
) => ({
  version: 2 as const,
  ownerSpace: claim.space,
  branch: claim.branch,
  pieceId: claim.pieceId,
  processGeneration: 1,
  actionId: claim.actionId,
  actionKind: claim.actionKind,
  implementationFingerprint: claim.implementationFingerprint,
  runtimeFingerprint: claim.runtimeFingerprint,
  executionClaimAssertion: {
    contextKey: claim.contextKey,
    leaseGeneration: claim.leaseGeneration,
    claimGeneration: claim.claimGeneration,
  },
  completeActionScopeSummary: {
    version: 1 as const,
    complete: true as const,
    implementationFingerprint: claim.implementationFingerprint,
    runtimeFingerprint: claim.runtimeFingerprint,
    piece: {
      space: claim.space,
      scope: "space" as const,
      id: claim.pieceId.slice("space:".length),
      path: [],
    },
    reads: [],
    writes: [{
      space: claim.space,
      scope: "space" as const,
      id: outputId,
      path: ["value"],
    }],
    materializerWriteEnvelopes: [],
    directOutputs: [{
      space: claim.space,
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
    space: claim.space,
    scope: "space" as const,
    id: outputId,
    path: ["value"],
  }],
  currentKnownWrites: [{
    space: claim.space,
    scope: "space" as const,
    id: outputId,
    path: ["value"],
  }],
  declaredWrites: [{
    space: claim.space,
    scope: "space" as const,
    id: outputId,
    path: ["value"],
  }],
  materializerWriteEnvelopes: [],
  status: "success" as const,
});

class ReconnectableExecutionTransport implements MemoryClient.Transport {
  #receiver: (payload: string) => void = () => {};
  #closeReceiver: (error?: Error) => void = () => {};
  #connection: ReturnType<Server["connect"]> | null = null;
  #reconnected = Promise.withResolvers<void>();
  connectionCount = 0;

  constructor(private readonly server: Server) {}

  get reconnected(): Promise<void> {
    return this.#reconnected.promise;
  }

  async send(payload: string): Promise<void> {
    // Decode here to prove every reconnect still starts with hello; the server
    // remains the sole parser for all actual behavior.
    decodeMemoryBoundary(payload);
    await this.#getConnection().receive(payload);
  }

  close(): Promise<void> {
    this.disconnect();
    return Promise.resolve();
  }

  setReceiver(receiver: (payload: string) => void): void {
    this.#receiver = receiver;
  }

  setCloseReceiver(receiver: (error?: Error) => void): void {
    this.#closeReceiver = receiver;
  }

  disconnect(): void {
    this.#connection?.close();
    this.#connection = null;
    this.#closeReceiver(new Error("controlled disconnect"));
  }

  #getConnection(): ReturnType<Server["connect"]> {
    if (this.#connection === null) {
      this.connectionCount += 1;
      if (this.connectionCount === 2) this.#reconnected.resolve();
      this.#connection = this.server.connect((message) =>
        this.#receiver(encodeMemoryBoundary(message))
      );
    }
    return this.#connection;
  }
}

const mount = async (
  client: MemoryClient.Client,
  space = POLICY_SPACE,
): Promise<ExecutionSession> =>
  await client.mount(
    space,
    {},
    testSessionOpenAuthFactory,
  ) as ExecutionSession;

const setPolicy = async (
  session: MemoryClient.SpaceSession,
  enabled: boolean,
  localSeq = 1,
): Promise<void> => {
  await session.transact({
    localSeq,
    reads: { confirmed: [], pending: [] },
    operations: [{
      op: "set",
      id: `of:${session.space}:execution-policy`,
      value: {
        value: { version: 1, serverPrimaryExecution: enabled },
      },
    }],
  });
};

const demandAndAcquireLease = async (
  server: ExecutionServer,
  session: ExecutionSession,
  branch = "",
): Promise<ExecutionLeaseHandle> => {
  await session.setExecutionDemand(branch, ["space:piece:one"]);
  const lease = await server.acquireExecutionLease(
    session.space,
    branch,
  );
  if (lease === null) {
    throw new Error(`expected an execution lease for branch ${branch}`);
  }
  return lease;
};

Deno.test("enabled execution policy rejects a stale client but disabled policy does not", async () => {
  const server = createServer(
    "memory-v2-execution-policy-capability",
    true,
  );
  const capable = await connectClient(server, true);
  const owner = await mount(capable);
  try {
    await setPolicy(owner, true);

    const stale = await connectClient(server, false);
    try {
      await assertRejects(
        () => mount(stale),
        Error,
        "requires memory capability server-primary-execution-v1",
      );
    } finally {
      await stale.close();
    }

    await owner.transact({
      localSeq: 2,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: `of:${owner.space}:execution-policy`,
        value: {
          value: { version: 1, serverPrimaryExecution: false },
        },
      }],
    });

    const legacy = await connectClient(server, false);
    try {
      const session = await mount(legacy);
      assertEquals(session.space, POLICY_SPACE);
    } finally {
      await legacy.close();
    }
  } finally {
    await capable.close();
    await server.close();
  }
});

Deno.test("flag off is a rollback even when execution policy remains enabled", async () => {
  const server = createServer("memory-v2-execution-policy-rollback", false);
  const legacy = await connectClient(server, false);
  try {
    const owner = await mount(legacy);
    await setPolicy(owner, true);

    const second = await connectClient(server, false);
    try {
      const session = await mount(second);
      assertEquals(session.space, POLICY_SPACE);
    } finally {
      await second.close();
    }
  } finally {
    await legacy.close();
    await server.close();
  }
});

Deno.test("execution demand is connection-owned and reference-counted", async () => {
  const server = createServer("memory-v2-execution-demand", true);
  const firstClient = await connectClient(server, true);
  const secondClient = await connectClient(server, true);
  const first = await mount(firstClient);
  const second = await mount(secondClient);
  try {
    assertEquals(
      await first.setExecutionDemand("feature", ["piece:one"]),
      true,
    );
    assertEquals(
      await second.setExecutionDemand("feature", ["piece:one"]),
      true,
    );

    const both = server.listExecutionDemands(POLICY_SPACE, "feature");
    assertEquals(both.length, 2);
    assertEquals(both.map((entry) => entry.pieces), [
      ["piece:one"],
      ["piece:one"],
    ]);
    assertEquals(new Set(both.map((entry) => entry.connectionId)).size, 2);

    await firstClient.close();
    assertEquals(
      server.listExecutionDemands(POLICY_SPACE, "feature").length,
      1,
    );

    await secondClient.close();
    assertEquals(
      server.listExecutionDemands(POLICY_SPACE, "feature"),
      [],
    );
  } finally {
    await firstClient.close();
    await secondClient.close();
    await server.close();
  }
});

Deno.test("demand snapshots identify a branch after its last reference is removed", async () => {
  const server = createServer("memory-v2-execution-demand-snapshot-slot", true);
  const client = await connectClient(server, true);
  const session = await mount(client);
  const snapshots: ExecutionDemandSnapshot[] = [];
  const unsubscribe = server.subscribeExecutionDemands((snapshot) => {
    snapshots.push(snapshot);
  });
  try {
    await session.setExecutionDemand("feature", ["piece:one"]);
    await session.setExecutionDemand("feature", []);

    assertEquals(snapshots.length, 2);
    assertEquals(snapshots[0].space, POLICY_SPACE);
    assertEquals(snapshots[0].branch, "feature");
    assertEquals(snapshots[0].demands.length, 1);
    assertEquals(snapshots[1], {
      space: POLICY_SPACE,
      branch: "feature",
      order: snapshots[0].order + 1,
      demands: [],
    });
  } finally {
    unsubscribe();
    await client.close();
    await server.close();
  }
});

Deno.test("flag-off clients do not send execution demand messages", async () => {
  const server = createServer("memory-v2-execution-demand-off", false);
  const client = await connectClient(server, false);
  try {
    const session = await mount(client);
    assertEquals(
      await session.setExecutionDemand("", ["piece:off"]),
      false,
    );
    assertEquals(server.listExecutionDemands(POLICY_SPACE, ""), []);
  } finally {
    await client.close();
    await server.close();
  }
});

Deno.test("one connection replaces demand independently on each branch", async () => {
  const server = createServer("memory-v2-execution-demand-branches", true);
  const client = await connectClient(server, true);
  const session = await mount(client);
  try {
    await session.setExecutionDemand("", ["piece:main"]);
    await session.setExecutionDemand("feature", ["piece:feature-v1"]);
    await session.setExecutionDemand("feature", ["piece:feature-v2"]);
    assertEquals(server.listExecutionDemands(POLICY_SPACE, "")[0].pieces, [
      "piece:main",
    ]);
    assertEquals(
      server.listExecutionDemands(POLICY_SPACE, "feature")[0].pieces,
      ["piece:feature-v2"],
    );

    await session.setExecutionDemand("feature", []);
    assertEquals(server.listExecutionDemands(POLICY_SPACE, "feature"), []);
    assertEquals(server.listExecutionDemands(POLICY_SPACE, "").length, 1);
  } finally {
    await client.close();
    await server.close();
  }
});

Deno.test("claims are action-qualified and reclaim mints a fresh generation", async () => {
  const server = createControlServer("memory-v2-execution-claims");
  const client = await connectControlClient(server);
  const session = await mount(client) as ExecutionSession;
  const events: ExecutionControlEvent[] = [];
  const unsubscribe = session.subscribeExecutionControl((event) =>
    events.push(event)
  );
  try {
    await setPolicy(session, true);
    const lease = await demandAndAcquireLease(server, session);
    const main = await server.setExecutionClaim(
      lease,
      claimKey(POLICY_SPACE, ""),
    );
    const sibling = await server.setExecutionClaim(
      lease,
      claimKey(POLICY_SPACE, "", "action:sibling"),
    );
    assertEquals(main.claimGeneration, 1);
    assertEquals(sibling.claimGeneration, 1);
    assertEquals(session.executionClaims.map((claim) => claim.actionId), [
      "action:derive",
      "action:sibling",
    ]);

    assertEquals(server.revokeExecutionClaim(main), true);
    const reclaimed = await server.setExecutionClaim(
      lease,
      claimKey(POLICY_SPACE, ""),
    );
    assertEquals(reclaimed.claimGeneration, 2);

    assertEquals(
      server.publishActionSettlement({
        branch: "",
        claim: main,
        inputBasisSeq: 1,
        outcome: "no-op",
      }),
      false,
    );
    assertEquals(
      server.publishActionSettlement({
        branch: "",
        claim: reclaimed,
        inputBasisSeq: 1,
        outcome: "no-op",
      }),
      true,
    );

    const settlements = events.filter((event) =>
      event.type === "session.execution.settlement"
    );
    assertEquals(settlements.length, 1);
    assertEquals(
      (settlements[0] as { settlement: ActionSettlement }).settlement.claim
        .claimGeneration,
      2,
    );
    assertEquals(
      session.executionClaims.some((claim) =>
        claim.actionId === sibling.actionId &&
        claim.claimGeneration === sibling.claimGeneration
      ),
      true,
    );
  } finally {
    unsubscribe();
    await client.close();
    await server.close();
  }
});

Deno.test("claims, revokes, and settlements remain independent across branches", async () => {
  const directory = await Deno.makeTempDir();
  const store = toFileUrl(`${directory}/`);
  await Deno.mkdir(new URL("./engine-v3/", store), { recursive: true });
  const engine = await Engine.open({
    url: resolveSpaceStoreUrl(store, POLICY_SPACE),
  });
  Engine.createBranch(engine, "feature");
  Engine.close(engine);
  const server = new Server({
    ...testSessionOpenServerOptions,
    store,
    protocolFlags: {
      serverPrimaryExecutionV1: true,
      serverPrimaryExecutionClaimRoutingV1: true,
      serverPrimaryExecutionBuiltinPassivityV1: true,
    },
    acl: { mode: "off", serviceDids: [TEST_SESSION_OPEN_PRINCIPAL] },
  }) as ExecutionServer;
  const client = await connectControlClient(server);
  const session = await mount(client) as ExecutionSession;
  const events: ExecutionControlEvent[] = [];
  const unsubscribe = session.subscribeExecutionControl((event) => {
    events.push(event);
  });
  try {
    await setPolicy(session, true);
    const mainLease = await demandAndAcquireLease(server, session, "");
    const featureLease = await demandAndAcquireLease(
      server,
      session,
      "feature",
    );
    const main = await server.setExecutionClaim(
      mainLease,
      claimKey(POLICY_SPACE, ""),
    );
    const feature = await server.setExecutionClaim(
      featureLease,
      claimKey(POLICY_SPACE, "feature"),
    );
    assertEquals(session.executionClaims.map((claim) => claim.branch), [
      "",
      "feature",
    ]);

    assertEquals(server.revokeExecutionClaim(main), true);
    assertEquals(
      session.executionClaims.map((claim) => claim.branch),
      ["feature"],
    );
    assertEquals(
      server.publishActionSettlement({
        branch: "",
        claim: main,
        inputBasisSeq: 1,
        outcome: "no-op",
      }),
      false,
    );
    assertEquals(
      server.publishActionSettlement({
        branch: "feature",
        claim: feature,
        inputBasisSeq: 1,
        outcome: "no-op",
      }),
      true,
    );
    assertEquals(
      events.filter((event) => event.type === "session.execution.settlement")
        .map((event) =>
          (event as { settlement: ActionSettlement }).settlement.branch
        ),
      ["feature"],
    );
  } finally {
    unsubscribe();
    await client.close();
    await server.close();
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("positive claims require enabled policy and disabling it revokes authority", async () => {
  const server = createControlServer("memory-v2-execution-claim-policy");
  const client = await connectControlClient(server);
  const session = await mount(client) as ExecutionSession;
  const events: ExecutionControlEvent[] = [];
  const unsubscribe = session.subscribeExecutionControl((event) => {
    events.push(event);
  });
  try {
    const lease = await demandAndAcquireLease(server, session);
    await assertRejects(
      () =>
        server.setExecutionClaim(
          lease,
          claimKey(POLICY_SPACE, ""),
        ),
      Error,
      "execution policy",
    );

    await setPolicy(session, true);
    const claim = await server.setExecutionClaim(
      lease,
      claimKey(POLICY_SPACE, ""),
    );
    assertEquals(session.executionClaims.length, 1);

    await setPolicy(session, false, 2);
    assertEquals(server.listExecutionClaims(POLICY_SPACE), []);
    assertEquals(session.executionClaims, []);
    assertEquals(
      server.publishActionSettlement({
        branch: "",
        claim,
        inputBasisSeq: 1,
        outcome: "no-op",
      }),
      false,
    );
    assertEquals(
      events.filter((event) => event.type === "session.execution.claim.revoke")
        .length,
      1,
    );
  } finally {
    unsubscribe();
    await client.close();
    await server.close();
  }
});

Deno.test("out-of-band inactive policy revokes claims without removing shadow demand", async () => {
  for (
    const testCase of [
      {
        name: "disabled",
        operation: {
          op: "set" as const,
          id: `of:${POLICY_SPACE}:execution-policy`,
          value: {
            value: { version: 1, serverPrimaryExecution: false },
          },
        },
        probe: "claim" as const,
      },
      {
        name: "deleted",
        operation: {
          op: "delete" as const,
          id: `of:${POLICY_SPACE}:execution-policy`,
        },
        probe: "listing" as const,
      },
      {
        name: "malformed",
        operation: {
          op: "set" as const,
          id: `of:${POLICY_SPACE}:execution-policy`,
          value: {
            value: { version: 2, serverPrimaryExecution: true },
          },
        },
        probe: "settlement" as const,
      },
    ]
  ) {
    const directory = await Deno.makeTempDir();
    const store = toFileUrl(`${directory}/`);
    const server = new Server({
      ...testSessionOpenServerOptions,
      store,
      protocolFlags: {
        serverPrimaryExecutionV1: true,
        serverPrimaryExecutionClaimRoutingV1: true,
        serverPrimaryExecutionBuiltinPassivityV1: true,
      },
      acl: { mode: "off", serviceDids: [TEST_SESSION_OPEN_PRINCIPAL] },
    }) as ExecutionServer;
    const client = await connectControlClient(server);
    const session = await mount(client) as ExecutionSession;
    const events: ExecutionControlEvent[] = [];
    const unsubscribe = session.subscribeExecutionControl((event) => {
      events.push(event);
    });
    try {
      await setPolicy(session, true);
      const lease = await demandAndAcquireLease(server, session);
      const claim = await server.setExecutionClaim(
        lease,
        claimKey(POLICY_SPACE, ""),
      );

      const external = await Engine.open({
        url: resolveSpaceStoreUrl(store, POLICY_SPACE),
      });
      try {
        Engine.applyCommit(external, {
          sessionId: `external-policy-${testCase.name}`,
          space: POLICY_SPACE,
          commit: {
            localSeq: 1,
            reads: { confirmed: [], pending: [] },
            operations: [testCase.operation],
          },
        });
      } finally {
        Engine.close(external);
      }

      if (testCase.probe === "claim") {
        await assertRejects(
          () =>
            server.setExecutionClaim(
              lease,
              claimKey(POLICY_SPACE, "", "action:after-policy-loss"),
            ),
          Error,
          "execution policy",
        );
      } else if (testCase.probe === "settlement") {
        assertEquals(
          await server.publishActionSettlement({
            branch: "",
            claim,
            inputBasisSeq: 1,
            outcome: "no-op",
          }),
          false,
        );
      } else {
        assertEquals(server.listExecutionClaims(POLICY_SPACE), []);
      }

      assertEquals(server.listExecutionClaims(POLICY_SPACE), []);
      assertEquals(session.executionClaims, []);
      assertEquals(
        events.filter((event) =>
          event.type === "session.execution.claim.revoke"
        ).length,
        1,
      );
      assertEquals(
        server.listExecutionDemands(POLICY_SPACE, "").length,
        1,
      );
    } finally {
      unsubscribe();
      await client.close();
      await server.close();
      await Deno.remove(directory, { recursive: true });
    }
  }
});

Deno.test("claim expiry timer revokes clients and rejects stale settlement", async () => {
  const server = createControlServer("memory-v2-execution-claim-expiry", {
    executionControl: { claimTtlMs: 5 },
  });
  const client = await connectControlClient(server);
  const session = await mount(client) as ExecutionSession;
  const events: ExecutionControlEvent[] = [];
  const expired = Promise.withResolvers<void>();
  const unsubscribe = session.subscribeExecutionControl((event) => {
    events.push(event);
    if (event.type === "session.execution.claim.revoke") expired.resolve();
  });
  try {
    await setPolicy(session, true);
    const lease = await demandAndAcquireLease(server, session);
    const claim = await server.setExecutionClaim(
      lease,
      claimKey(POLICY_SPACE, ""),
    );
    await expired.promise;

    assertEquals(server.listExecutionClaims(POLICY_SPACE), []);
    assertEquals(session.executionClaims, []);
    assertEquals(
      server.publishActionSettlement({
        branch: "",
        claim,
        inputBasisSeq: 1,
        outcome: "no-op",
      }),
      false,
    );
    assertEquals(
      events.filter((event) => event.type === "session.execution.claim.revoke")
        .length,
      1,
    );
  } finally {
    unsubscribe();
    await client.close();
    await server.close();
  }
});

Deno.test("closing a control server cancels a live claim deadline", async () => {
  const server = createControlServer("memory-v2-execution-claim-expiry-close", {
    executionControl: { claimTtlMs: 60_000 },
  });
  const client = await connectControlClient(server);
  const session = await mount(client) as ExecutionSession;
  try {
    await setPolicy(session, true);
    const lease = await demandAndAcquireLease(server, session);
    await server.setExecutionClaim(lease, claimKey(POLICY_SPACE, ""));
    assertEquals(server.listExecutionClaims(POLICY_SPACE).length, 1);
  } finally {
    await client.close();
    await server.close();
  }
});

Deno.test("committed settlement waits for its accepted data patch", async () => {
  const server = createControlServer("memory-v2-execution-settlement-gate", {
    subscriptionRefreshDelayMs: 60_000,
  });
  const writerClient = await connectControlClient(server);
  const observerClient = await connectControlClient(server);
  const writer = await mount(writerClient);
  const observer = await mount(observerClient) as ExecutionSession;
  const delivered: ActionSettlement[] = [];
  const unsubscribe = observer.subscribeExecutionControl((event) => {
    if (event.type === "session.execution.settlement") {
      delivered.push(event.settlement);
    }
  });
  try {
    await setPolicy(observer, true);
    const lease = await demandAndAcquireLease(server, observer);
    await observer.watchSet([{
      id: "derived",
      kind: "graph",
      query: {
        roots: [{
          id: "of:derived",
          selector: { path: [], schema: true },
        }],
      },
    }]);
    const claim = await server.setExecutionClaim(
      lease,
      claimKey(POLICY_SPACE, ""),
    );
    const commit = await writer.transact({
      localSeq: 1,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: "of:derived",
        value: { value: { answer: 42 } },
      }],
    });
    assertEquals(
      server.publishActionSettlement({
        branch: "",
        claim,
        inputBasisSeq: commit.seq,
        outcome: "committed",
        acceptedCommitSeq: commit.seq,
      }),
      true,
    );
    assertEquals(delivered, []);

    await server.flushSessions();
    assertEquals(delivered.length, 1);
    assertEquals(delivered[0].outcome, "committed");
    if (delivered[0].outcome === "committed") {
      assertEquals(delivered[0].acceptedCommitSeq, commit.seq);
    }
  } finally {
    unsubscribe();
    await writerClient.close();
    await observerClient.close();
    await server.close();
  }
});

Deno.test("accepted claimed runs derive provenance and settlements on the host", async () => {
  const server = createControlServer("memory-v2-execution-provenance");
  const client = await connectControlClient(server);
  const session = await mount(client) as ExecutionSession;
  const settlements: ActionSettlement[] = [];
  const firstSettlement = Promise.withResolvers<void>();
  const secondSettlement = Promise.withResolvers<void>();
  const thirdSettlement = Promise.withResolvers<void>();
  const unsubscribeControl = session.subscribeExecutionControl((event) => {
    if (event.type === "session.execution.settlement") {
      settlements.push(event.settlement);
      if (settlements.length === 1) firstSettlement.resolve();
      if (settlements.length === 2) secondSettlement.resolve();
      if (settlements.length === 3) thirdSettlement.resolve();
    }
  });
  let unbind = () => {};
  try {
    await setPolicy(session, true);
    const lease = await demandAndAcquireLease(server, session);
    await session.watchSet([{
      id: "provenance-output",
      kind: "graph",
      query: {
        roots: [{
          id: "of:provenance-output",
          selector: { path: [], schema: true },
        }],
      },
    }]);
    const claim = await server.setExecutionClaim(
      lease,
      claimKey(POLICY_SPACE, "", "action:provenance"),
    );
    unbind = server.bindExecutionSession(
      POLICY_SPACE,
      session.sessionId,
      lease,
    );

    const source = await session.transact({
      localSeq: 2,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: "of:provenance-source",
        value: { value: { count: 1 } },
      }],
    });
    const observation = {
      version: 2 as const,
      ownerSpace: POLICY_SPACE,
      branch: "",
      pieceId: claim.pieceId,
      processGeneration: 1,
      actionId: claim.actionId,
      actionKind: claim.actionKind,
      implementationFingerprint: claim.implementationFingerprint,
      runtimeFingerprint: claim.runtimeFingerprint,
      // This is an executor assertion about the exact claim incarnation under
      // which the attempt started. The host validates it against live control
      // state and never persists it as authority metadata.
      executionClaimAssertion: {
        contextKey: claim.contextKey,
        leaseGeneration: claim.leaseGeneration,
        claimGeneration: claim.claimGeneration,
      },
      completeActionScopeSummary: {
        version: 1 as const,
        complete: true as const,
        implementationFingerprint: claim.implementationFingerprint,
        runtimeFingerprint: claim.runtimeFingerprint,
        piece: {
          space: POLICY_SPACE,
          scope: "space" as const,
          id: claim.pieceId.slice("space:".length),
          path: [],
        },
        reads: [{
          space: POLICY_SPACE,
          scope: "space" as const,
          id: "of:provenance-source",
          path: ["value", "count"],
        }],
        writes: [{
          space: POLICY_SPACE,
          scope: "space" as const,
          id: "of:provenance-output",
          path: ["value"],
        }],
        materializerWriteEnvelopes: [],
        directOutputs: [{
          space: POLICY_SPACE,
          scope: "space" as const,
          id: "of:provenance-output",
          path: ["value"],
        }],
      },
      observedAtSeq: 0,
      // Both fields are deliberately forged. The host must derive/overwrite
      // them from accepted reads and authenticated session authority.
      inputBasisSeq: 999_999,
      executionProvenance: {
        claim,
        onBehalfOf: "did:key:forged",
        leaseGeneration: 999,
        claimGeneration: 999,
        causedBy: [999_999],
        inputBasisSeq: 999_999,
      },
      transactionKind: "action-run" as const,
      reads: [{
        space: POLICY_SPACE,
        scope: "space" as const,
        id: "of:provenance-source",
        path: ["value", "count"],
      }],
      shallowReads: [],
      actualChangedWrites: [{
        space: POLICY_SPACE,
        scope: "space" as const,
        id: "of:provenance-output",
        path: ["value", "answer"],
      }],
      currentKnownWrites: [{
        space: POLICY_SPACE,
        scope: "space" as const,
        id: "of:provenance-output",
        path: ["value"],
      }],
      materializerWriteEnvelopes: [],
      status: "success" as const,
    };

    const committed = await session.transact({
      localSeq: 3,
      reads: {
        confirmed: [{
          id: "of:provenance-source",
          path: toDocumentPath(["value", "count"]),
          seq: source.seq,
        }],
        pending: [],
      },
      operations: [{
        op: "set",
        id: "of:provenance-output",
        value: { value: { answer: 2 } },
      }],
      schedulerObservation: observation,
    });

    const snapshots = await session.listSchedulerActionSnapshots({
      actionId: claim.actionId,
      pieceId: claim.pieceId,
      processGeneration: 1,
    });
    const stored = snapshots.snapshots[0]?.observation as {
      inputBasisSeq?: number;
      executionProvenance?: {
        claim: ActionClaimKey;
        onBehalfOf: string;
        leaseGeneration: number;
        claimGeneration: number;
        causedBy: number[];
        inputBasisSeq: number;
      };
    };
    assertEquals(stored.inputBasisSeq, source.seq);
    assertEquals(stored.executionProvenance, {
      claim: claimKey(POLICY_SPACE, "", "action:provenance"),
      onBehalfOf: TEST_SESSION_OPEN_PRINCIPAL,
      leaseGeneration: claim.leaseGeneration,
      claimGeneration: claim.claimGeneration,
      causedBy: [],
      inputBasisSeq: source.seq,
    });
    session.noteAppliedCommit(committed.seq);
    await Promise.race([
      firstSettlement.promise,
      new Promise<never>((_resolve, reject) =>
        setTimeout(
          () => reject(new Error("committed settlement was not delivered")),
          1_000,
        )
      ),
    ]);
    assertEquals(settlements, [{
      branch: "",
      claim,
      inputBasisSeq: source.seq,
      outcome: "committed",
      acceptedCommitSeq: committed.seq,
    }]);

    const noop = await session.transact({
      localSeq: 4,
      reads: {
        confirmed: [{
          id: "of:provenance-source",
          path: toDocumentPath(["value", "count"]),
          seq: source.seq,
        }],
        pending: [],
      },
      operations: [],
      schedulerObservation: {
        ...observation,
        actualChangedWrites: [],
      },
    });
    assertEquals(noop.actionAttempts?.map((attempt) => attempt.outcome), [
      "no-op",
    ]);
    await server.flushSessions();
    await Promise.race([
      secondSettlement.promise,
      new Promise<never>((_resolve, reject) =>
        setTimeout(
          () => reject(new Error("no-op settlement was not delivered")),
          1_000,
        )
      ),
    ]);
    assertEquals(settlements.at(-1), {
      branch: "",
      claim,
      inputBasisSeq: source.seq,
      outcome: "no-op",
    });

    const failedClaim = await server.setExecutionClaim(
      lease,
      claimKey(POLICY_SPACE, "", "action:provenance-failed"),
    );
    const failedObservation = {
      ...observation,
      actionId: failedClaim.actionId,
      executionClaimAssertion: {
        contextKey: failedClaim.contextKey,
        leaseGeneration: failedClaim.leaseGeneration,
        claimGeneration: failedClaim.claimGeneration,
      },
      status: "failed" as const,
      errorFingerprint: "error:test",
      actualChangedWrites: [],
    };
    await assertRejects(
      () =>
        session.transact({
          localSeq: 5,
          reads: {
            confirmed: [{
              id: "of:provenance-source",
              path: toDocumentPath(["value", "count"]),
              seq: source.seq,
            }],
            pending: [],
          },
          operations: [{
            op: "set",
            id: "of:failed-must-not-land",
            value: { value: true },
          }],
          schedulerObservation: failedObservation,
        }),
      Error,
      "failed claimed actions must not include semantic operations",
    );
    assertEquals(
      await server.readDocument(POLICY_SPACE, "of:failed-must-not-land"),
      null,
    );
    await session.transact({
      localSeq: 6,
      reads: {
        confirmed: [{
          id: "of:provenance-source",
          path: toDocumentPath(["value", "count"]),
          seq: source.seq,
        }],
        pending: [],
      },
      operations: [],
      schedulerObservation: failedObservation,
    });
    await Promise.race([
      thirdSettlement.promise,
      new Promise<never>((_resolve, reject) =>
        setTimeout(
          () => reject(new Error("failed settlement was not delivered")),
          1_000,
        )
      ),
    ]);
    assertEquals(settlements.at(-1), {
      branch: "",
      claim: failedClaim,
      inputBasisSeq: source.seq,
      outcome: "failed",
    });
  } finally {
    unbind();
    unsubscribeControl();
    await client.close();
    await server.close();
  }
});

Deno.test("claimed transactions reject non-space surfaces atomically", async () => {
  const server = createControlServer("memory-v2-execution-scope-firewall");
  const client = await connectControlClient(server);
  const session = await mount(client) as ExecutionSession;
  let unbind = () => {};
  try {
    await setPolicy(session, true);
    const lease = await demandAndAcquireLease(server, session);
    const claim = await server.setExecutionClaim(
      lease,
      claimKey(POLICY_SPACE, "", "action:scope-firewall"),
    );
    unbind = server.bindExecutionSession(
      POLICY_SPACE,
      session.sessionId,
      lease,
    );

    const spaceOutput = "of:scope-firewall-space";
    const userOutput = "of:scope-firewall-user";
    const userSurface = {
      space: POLICY_SPACE,
      scope: "user" as const,
      id: userOutput,
      path: ["value"],
    };
    const base = claimedSpaceObservation(claim, spaceOutput);
    const observation = {
      ...base,
      completeActionScopeSummary: {
        ...base.completeActionScopeSummary,
        writes: [
          ...base.completeActionScopeSummary.writes,
          userSurface,
        ],
        directOutputs: [
          ...base.completeActionScopeSummary.directOutputs,
          userSurface,
        ],
      },
      actualChangedWrites: [...base.actualChangedWrites, userSurface],
      currentKnownWrites: [...base.currentKnownWrites, userSurface],
      declaredWrites: [...base.declaredWrites, userSurface],
    };
    const error = await assertRejects(() =>
      session.transact({
        localSeq: 2,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: spaceOutput,
          value: { value: "must-roll-back" },
        }, {
          op: "set",
          id: userOutput,
          scope: "user",
          value: { value: "must-not-land" },
        }],
        schedulerObservation: observation,
      })
    );
    assertEquals((error as Error).name, "ExecutionActionFirewallError");
    assertEquals(
      (error as Error & { diagnosticCode?: string }).diagnosticCode,
      "non-space-scope",
    );
    assertEquals(await server.readDocument(POLICY_SPACE, spaceOutput), null);
    assertEquals(await server.readDocument(POLICY_SPACE, userOutput), null);
  } finally {
    unbind();
    await client.close();
    await server.close();
  }
});

Deno.test("claimed transactions reject foreign and unsupported surfaces", async () => {
  const server = createControlServer("memory-v2-execution-shape-firewall");
  const client = await connectControlClient(server);
  const session = await mount(client) as ExecutionSession;
  let unbind = () => {};
  try {
    await setPolicy(session, true);
    const lease = await demandAndAcquireLease(server, session);
    unbind = server.bindExecutionSession(
      POLICY_SPACE,
      session.sessionId,
      lease,
    );

    const foreignClaim = await server.setExecutionClaim(
      lease,
      claimKey(POLICY_SPACE, "", "action:foreign-firewall"),
    );
    const output = "of:foreign-firewall-output";
    const base = claimedSpaceObservation(foreignClaim, output);
    const foreignRead = {
      space: "did:key:z6Mk-foreign-firewall-space",
      scope: "space" as const,
      id: "of:foreign-input",
      path: ["value"],
    };
    const foreignObservation = {
      ...base,
      completeActionScopeSummary: {
        ...base.completeActionScopeSummary,
        reads: [foreignRead],
      },
      reads: [foreignRead],
    };
    const foreignError = await assertRejects(() =>
      session.transact({
        localSeq: 2,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: output,
          value: { value: "must-not-land" },
        }],
        schedulerObservation: foreignObservation,
      })
    );
    assertEquals(
      (foreignError as Error).name,
      "ExecutionActionFirewallError",
    );
    assertEquals(
      (foreignError as Error & { diagnosticCode?: string }).diagnosticCode,
      "foreign-space-surface",
    );
    assertEquals(await server.readDocument(POLICY_SPACE, output), null);

    const sqliteClaim = await server.setExecutionClaim(
      lease,
      claimKey(POLICY_SPACE, "", "action:sqlite-firewall"),
    );
    const sqliteError = await assertRejects(() =>
      session.transact({
        localSeq: 3,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "sqlite",
          db: {
            id: "of:claimed-sqlite-firewall",
            tables: {
              messages: {
                columns: { body: { type: "TEXT" } },
              },
            },
          },
          sql: "INSERT INTO messages (body) VALUES ('must-not-land')",
        }],
        schedulerObservation: claimedSpaceObservation(
          sqliteClaim,
          "of:claimed-sqlite-firewall",
        ),
      })
    );
    assertEquals(
      (sqliteError as Error).name,
      "ExecutionActionFirewallError",
    );
    assertEquals(
      (sqliteError as Error & { diagnosticCode?: string }).diagnosticCode,
      "sqlite-operation",
    );

    const mergeClaim = await server.setExecutionClaim(
      lease,
      claimKey(POLICY_SPACE, "", "action:merge-firewall"),
    );
    const mergeOutput = "of:merge-firewall-output";
    const mergeError = await assertRejects(() =>
      session.transact({
        localSeq: 4,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: mergeOutput,
          value: { value: "must-not-land" },
        }],
        merge: {
          sourceBranch: "source",
          sourceSeq: 1,
          baseBranch: "",
          baseSeq: 0,
        },
        schedulerObservation: claimedSpaceObservation(
          mergeClaim,
          mergeOutput,
        ),
      })
    );
    assertEquals(
      (mergeError as Error).name,
      "ExecutionActionFirewallError",
    );
    assertEquals(
      (mergeError as Error & { diagnosticCode?: string }).diagnosticCode,
      "merge-commit",
    );
    assertEquals(
      await server.readDocument(POLICY_SPACE, mergeOutput),
      null,
    );
  } finally {
    unbind();
    await client.close();
    await server.close();
  }
});

Deno.test("unserved attempts derive their basis and settle canonically", async () => {
  const server = createControlServer("memory-v2-execution-unserved-attempt");
  const client = await connectControlClient(server);
  const session = await mount(client) as ExecutionSession;
  const settlements: ActionSettlement[] = [];
  const settled = Promise.withResolvers<void>();
  const unsubscribe = session.subscribeExecutionControl((event) => {
    if (event.type === "session.execution.settlement") {
      settlements.push(event.settlement);
      settled.resolve();
    }
  });
  let unbind = () => {};
  try {
    await setPolicy(session, true);
    const lease = await demandAndAcquireLease(server, session);
    const claim = await server.setExecutionClaim(
      lease,
      claimKey(POLICY_SPACE, "", "action:unserved-attempt"),
    );
    unbind = server.bindExecutionSession(
      POLICY_SPACE,
      session.sessionId,
      lease,
    );
    const confirmed = await session.transact({
      localSeq: 2,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: "of:unserved-confirmed",
        value: { value: 1 },
      }],
    });
    const pending = await session.transact({
      localSeq: 3,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: "of:unserved-pending",
        value: { value: 2 },
      }],
    });

    const base = claimedSpaceObservation(
      claim,
      "of:unserved-output",
    );
    const confirmedRead = {
      space: POLICY_SPACE,
      scope: "space" as const,
      id: "of:unserved-confirmed",
      path: ["value"],
    };
    const pendingRead = {
      space: POLICY_SPACE,
      scope: "space" as const,
      id: "of:unserved-pending",
      path: ["value"],
    };
    const rejectedUserSurface = {
      space: POLICY_SPACE,
      scope: "user" as const,
      id: "of:unserved-user-surface",
      path: ["value"],
    };
    const observation = {
      ...base,
      inputBasisSeq: 999_999,
      executionUnservedAttempt: {
        diagnosticCode: "dynamic-non-space-scope",
      },
      completeActionScopeSummary: {
        ...base.completeActionScopeSummary,
        reads: [confirmedRead, pendingRead, rejectedUserSurface],
      },
      reads: [confirmedRead, pendingRead, rejectedUserSurface],
      actualChangedWrites: [],
    };
    const result = await session.transact({
      localSeq: 4,
      reads: {
        confirmed: [{
          id: confirmedRead.id,
          path: toDocumentPath(confirmedRead.path),
          seq: confirmed.seq,
        }],
        pending: [{
          id: pendingRead.id,
          path: toDocumentPath(pendingRead.path),
          localSeq: 3,
        }],
      },
      operations: [],
      schedulerObservation: observation,
    });
    assertEquals(result.actionAttempts as unknown, [{
      localSeq: 4,
      claim,
      provenance: {
        claim: claimKey(POLICY_SPACE, "", "action:unserved-attempt"),
        onBehalfOf: TEST_SESSION_OPEN_PRINCIPAL,
        leaseGeneration: claim.leaseGeneration,
        claimGeneration: claim.claimGeneration,
        causedBy: [],
        inputBasisSeq: pending.seq,
      },
      outcome: "unserved",
      diagnosticCode: "dynamic-non-space-scope",
    }]);
    await Promise.race([
      settled.promise,
      new Promise<never>((_resolve, reject) =>
        setTimeout(
          () => reject(new Error("unserved settlement was not delivered")),
          1_000,
        )
      ),
    ]);
    assertEquals(settlements, [{
      branch: "",
      claim,
      inputBasisSeq: pending.seq,
      outcome: "unserved",
      diagnosticCode: "dynamic-non-space-scope",
    }]);

    const snapshots = await session.listSchedulerActionSnapshots({
      actionId: claim.actionId,
      pieceId: claim.pieceId,
      processGeneration: 1,
    });
    const stored = snapshots.snapshots[0]?.observation as Record<
      string,
      unknown
    >;
    assertEquals(stored.executionUnservedAttempt, undefined);
    assertEquals(stored.inputBasisSeq, pending.seq);
    assertEquals(stored.executionProvenance, undefined);

    assertEquals(server.revokeExecutionClaim(claim), true);
    await assertRejects(
      () =>
        session.transact({
          localSeq: 5,
          reads: { confirmed: [], pending: [] },
          operations: [],
          schedulerObservation: observation,
        }),
      Error,
      "execution claim incarnation",
    );
    assertEquals(settlements.length, 1);
  } finally {
    unbind();
    unsubscribe();
    await client.close();
    await server.close();
  }
});

Deno.test("bound executor rejects a delayed attempt after claim replacement", async () => {
  const server = createControlServer("memory-v2-execution-stale-attempt");
  const client = await connectControlClient(server);
  const session = await mount(client) as ExecutionSession;
  let unbind = () => {};
  try {
    await setPolicy(session, true);
    const lease = await demandAndAcquireLease(server, session);
    const first = await server.setExecutionClaim(
      lease,
      claimKey(POLICY_SPACE, "", "action:stale-attempt"),
    );
    unbind = server.bindExecutionSession(
      POLICY_SPACE,
      session.sessionId,
      lease,
    );
    assertEquals(server.revokeExecutionClaim(first), true);
    const replacement = await server.setExecutionClaim(
      lease,
      claimKey(POLICY_SPACE, "", "action:stale-attempt"),
    );
    assertEquals(replacement.claimGeneration, first.claimGeneration + 1);

    await assertRejects(
      () =>
        session.transact({
          localSeq: 2,
          reads: { confirmed: [], pending: [] },
          operations: [{
            op: "set",
            id: "of:stale-attempt-must-not-land",
            value: { value: "stale" },
          }],
          schedulerObservation: claimedSpaceObservation(
            first,
            "of:stale-attempt-must-not-land",
          ),
        }),
      Error,
      "execution claim incarnation",
    );
    assertEquals(
      await server.readDocument(
        POLICY_SPACE,
        "of:stale-attempt-must-not-land",
      ),
      null,
    );
  } finally {
    unbind();
    await client.close();
    await server.close();
  }
});

Deno.test("bound executor never downgrades a revoked attempt to an ordinary write", async () => {
  const server = createControlServer("memory-v2-execution-revoked-attempt");
  const client = await connectControlClient(server);
  const session = await mount(client) as ExecutionSession;
  let unbind = () => {};
  try {
    await setPolicy(session, true);
    const lease = await demandAndAcquireLease(server, session);
    const claim = await server.setExecutionClaim(
      lease,
      claimKey(POLICY_SPACE, "", "action:revoked-attempt"),
    );
    unbind = server.bindExecutionSession(
      POLICY_SPACE,
      session.sessionId,
      lease,
    );
    assertEquals(server.revokeExecutionClaim(claim), true);

    await assertRejects(
      () =>
        session.transact({
          localSeq: 2,
          reads: { confirmed: [], pending: [] },
          operations: [{
            op: "set",
            id: "of:revoked-attempt-must-not-land",
            value: { value: "revoked" },
          }],
          schedulerObservation: claimedSpaceObservation(
            claim,
            "of:revoked-attempt-must-not-land",
          ),
        }),
      Error,
      "execution claim incarnation",
    );
    assertEquals(
      await server.readDocument(
        POLICY_SPACE,
        "of:revoked-attempt-must-not-land",
      ),
      null,
    );
  } finally {
    unbind();
    await client.close();
    await server.close();
  }
});

Deno.test("claimed executor rejects an effective context narrower than its claim", async () => {
  const server = createControlServer("memory-v2-execution-context-fence");
  const client = await connectControlClient(server);
  const session = await mount(client) as ExecutionSession;
  let unbind = () => {};
  try {
    await setPolicy(session, true);
    const lease = await demandAndAcquireLease(server, session);
    const claim = await server.setExecutionClaim(
      lease,
      claimKey(POLICY_SPACE, "", "action:context-fence"),
    );
    unbind = server.bindExecutionSession(
      POLICY_SPACE,
      session.sessionId,
      lease,
    );
    const incomplete = claimedSpaceObservation(
      claim,
      "of:context-fence-must-not-land",
    );
    delete (incomplete as { completeActionScopeSummary?: unknown })
      .completeActionScopeSummary;

    await assertRejects(
      () =>
        session.transact({
          localSeq: 2,
          reads: { confirmed: [], pending: [] },
          operations: [{
            op: "set",
            id: "of:context-fence-must-not-land",
            value: { value: "narrower" },
          }],
          schedulerObservation: incomplete,
        }),
      Error,
      "execution claim context",
    );
    assertEquals(
      await server.readDocument(POLICY_SPACE, "of:context-fence-must-not-land"),
      null,
    );
  } finally {
    unbind();
    await client.close();
    await server.close();
  }
});

Deno.test("detached resumable sessions cannot acquire executor authority", async () => {
  const server = createControlServer("memory-v2-execution-detached-binding");
  const client = await connectControlClient(server);
  const session = await mount(client) as ExecutionSession;
  const sessionId = session.sessionId;
  try {
    await setPolicy(session, true);
    const lease = await demandAndAcquireLease(server, session);
    await client.close();
    assertThrows(
      () => server.bindExecutionSession(POLICY_SPACE, sessionId, lease),
      Error,
      "sponsor is no longer attached",
    );
  } finally {
    await server.close();
  }
});

Deno.test("an accepted claim replay stays idempotent after revoke", async () => {
  const server = createControlServer("memory-v2-execution-replay-fence");
  const client = await connectControlClient(server);
  const session = await mount(client) as ExecutionSession;
  let unbind = () => {};
  try {
    await setPolicy(session, true);
    const lease = await demandAndAcquireLease(server, session);
    const firstClaim = await server.setExecutionClaim(
      lease,
      claimKey(POLICY_SPACE, "", "action:replay-fence"),
    );
    unbind = server.bindExecutionSession(
      POLICY_SPACE,
      session.sessionId,
      lease,
    );
    const commit = {
      localSeq: 2,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set" as const,
        id: "of:accepted-claim-replay",
        value: { value: "accepted" },
      }],
      schedulerObservation: claimedSpaceObservation(
        firstClaim,
        "of:accepted-claim-replay",
      ),
    };
    const accepted = await session.transact(commit);
    assertEquals(accepted.actionAttempts?.[0]?.claim.claimGeneration, 1);
    assertEquals(server.revokeExecutionClaim(firstClaim), true);

    const replay = await session.transact(commit);
    assertEquals(replay.seq, accepted.seq);
    assertEquals(replay.actionAttempts, undefined);

    const replacement = await server.setExecutionClaim(
      lease,
      claimKey(POLICY_SPACE, "", "action:replay-fence"),
    );
    await assertRejects(
      () =>
        session.transact({
          ...commit,
          schedulerObservation: claimedSpaceObservation(
            replacement,
            "of:accepted-claim-replay",
          ),
        }),
      Error,
      "replay mismatch",
    );
  } finally {
    unbind();
    await client.close();
    await server.close();
  }
});

Deno.test("an unbound client claim assertion cannot create executor provenance", async () => {
  const server = createControlServer("memory-v2-execution-unbound-assertion");
  const client = await connectControlClient(server);
  const session = await mount(client) as ExecutionSession;
  try {
    await setPolicy(session, true);
    const lease = await demandAndAcquireLease(server, session);
    const claim = await server.setExecutionClaim(
      lease,
      claimKey(POLICY_SPACE, "", "action:unbound-assertion"),
    );
    await assertRejects(
      () =>
        session.transact({
          localSeq: 2,
          reads: { confirmed: [], pending: [] },
          operations: [{
            op: "set",
            id: "of:unbound-assertion-must-not-land",
            value: { value: "forged" },
          }],
          schedulerObservation: claimedSpaceObservation(
            claim,
            "of:unbound-assertion-must-not-land",
          ),
        }),
      Error,
      "execution claim incarnation",
    );
    assertEquals(
      await server.readDocument(
        POLICY_SPACE,
        "of:unbound-assertion-must-not-land",
      ),
      null,
    );
  } finally {
    await client.close();
    await server.close();
  }
});

Deno.test("clients cannot spoof server execution claims or settlements", () => {
  for (
    const type of [
      "session.execution.claim.set",
      "session.execution.claim.revoke",
      "session.execution.settlement",
    ]
  ) {
    assertEquals(
      parseClientMessage(encodeMemoryBoundary({
        type,
        requestId: "spoof",
        space: POLICY_SPACE,
        sessionId: "session:spoof",
        branch: "",
        principal: "did:key:spoof",
        claim: {},
      })),
      null,
    );
  }
  assertEquals(
    parseClientMessage(encodeMemoryBoundary({
      type: "session.execution.demand.set",
      requestId: "spoof-demand",
      space: POLICY_SPACE,
      sessionId: "session:spoof",
      branch: "",
      pieces: ["piece:one"],
      connectionId: "connection:spoof",
      principal: "did:key:spoof",
      onBehalfOf: "did:key:spoof",
    })),
    null,
  );
});

Deno.test("host cannot acquire claim authority while the rollout flag is off", async () => {
  const server = createServer("memory-v2-execution-claims-off", true);
  const client = await connectClient(server, true);
  try {
    const session = await mount(client);
    await session.setExecutionDemand("", ["piece:off"]);
    assertEquals(server.listExecutionDemands(POLICY_SPACE, "").length, 1);
    server.options.protocolFlags = { serverPrimaryExecutionV1: false };
    assertEquals(
      await server.acquireExecutionLease(POLICY_SPACE, ""),
      null,
    );
  } finally {
    await client.close();
    await server.close();
  }
});

Deno.test("reconnect restores demand before a replacement sponsor claim", async () => {
  const server = createControlServer("memory-v2-execution-reconnect");
  const transport = new ReconnectableExecutionTransport(server);
  const client = await MemoryClient.connect({
    transport,
    protocolFlags: {
      serverPrimaryExecutionV1: true,
      serverPrimaryExecutionClaimRoutingV1: true,
      serverPrimaryExecutionBuiltinPassivityV1: true,
    },
  } as ExecutionClientOptions);
  const session = await mount(client) as ExecutionSession;
  const settlements: ActionSettlement[] = [];
  const unsubscribeControl = session.subscribeExecutionControl((event) => {
    if (event.type === "session.execution.settlement") {
      settlements.push(event.settlement);
    }
  });
  const demandRestored = Promise.withResolvers<void>();
  const unsubscribeDemand = server.subscribeExecutionDemands((demands) => {
    if (
      transport.connectionCount >= 2 && demands.demands.length === 1 &&
      demands.branch === ""
    ) {
      demandRestored.resolve();
    }
  });
  try {
    await setPolicy(session, true);
    const firstLease = await demandAndAcquireLease(server, session);
    const first = await server.setExecutionClaim(
      firstLease,
      claimKey(POLICY_SPACE, ""),
    );
    assertEquals(first.claimGeneration, 1);

    transport.disconnect();
    await server.flushExecutionLeaseTasks();
    const revoked = await server.finishExecutionLeaseDrain(firstLease);
    assertEquals(revoked?.state, "revoked");
    assertEquals(server.listExecutionClaims(POLICY_SPACE), []);

    await transport.reconnected;
    await demandRestored.promise;
    assertEquals(session.executionClaims, []);

    const secondLease = await demandAndAcquireLease(server, session);
    assertEquals(
      secondLease.leaseGeneration,
      firstLease.leaseGeneration + 1,
    );
    const second = await server.setExecutionClaim(
      secondLease,
      claimKey(POLICY_SPACE, ""),
    );
    assertEquals(second.claimGeneration, 2);
    assertEquals(
      server.publishActionSettlement({
        branch: "",
        claim: second,
        inputBasisSeq: 0,
        outcome: "no-op",
      }),
      true,
    );
    assertEquals(session.executionClaims, [second]);
    assertEquals(settlements.length, 1);
    assertEquals(settlements[0].claim.claimGeneration, 2);
    assertEquals(
      server.listExecutionDemands(POLICY_SPACE, "").length,
      1,
    );
  } finally {
    unsubscribeControl();
    unsubscribeDemand();
    await client.close();
    await server.close();
  }
});

Deno.test("control-only claim frames advance one feed sequence without advancing data", async () => {
  const server = createControlServer("memory-v2-execution-feed-order");
  const client = await connectControlClient(server);
  const session = await mount(client) as ExecutionSession;
  try {
    await setPolicy(session, true);
    const lease = await demandAndAcquireLease(server, session);
    const view = await session.watchSet([]);
    const syncs = view.subscribeSync();
    const claim = await server.setExecutionClaim(
      lease,
      claimKey(POLICY_SPACE, ""),
    );
    const setFrame = await syncs.next();
    assertEquals(setFrame.done, false);
    assertEquals(setFrame.value.fromSeq, setFrame.value.toSeq);
    assertEquals(
      setFrame.value.execution!.toFeedSeq,
      setFrame.value.execution!.fromFeedSeq + 1,
    );
    assertEquals(
      setFrame.value.execution!.events[0].type,
      "session.execution.claim.set",
    );

    assertEquals(server.revokeExecutionClaim(claim), true);
    const revokeFrame = await syncs.next();
    assertEquals(revokeFrame.done, false);
    assertEquals(revokeFrame.value.fromSeq, revokeFrame.value.toSeq);
    assertEquals(
      revokeFrame.value.execution!.fromFeedSeq,
      setFrame.value.execution!.toFeedSeq,
    );
    assertEquals(
      revokeFrame.value.execution!.events[0].type,
      "session.execution.claim.revoke",
    );
  } finally {
    await client.close();
    await server.close();
  }
});

Deno.test("server publishes only claim classes the client advertises", async () => {
  const server = createControlServer("memory-v2-execution-subcapabilities");
  const noRoutingClient = await MemoryClient.connect({
    transport: MemoryClient.loopback(server),
    protocolFlags: {
      serverPrimaryExecutionV1: true,
      serverPrimaryExecutionClaimRoutingV1: false,
      serverPrimaryExecutionBuiltinPassivityV1: false,
    },
  });
  const computationOnlyClient = await MemoryClient.connect({
    transport: MemoryClient.loopback(server),
    protocolFlags: {
      serverPrimaryExecutionV1: true,
      serverPrimaryExecutionClaimRoutingV1: true,
      serverPrimaryExecutionBuiltinPassivityV1: false,
    },
  });
  const noRouting = await mount(noRoutingClient) as ExecutionSession;
  const computationOnly = await mount(
    computationOnlyClient,
  ) as ExecutionSession;
  try {
    await setPolicy(computationOnly, true);
    const lease = await demandAndAcquireLease(server, computationOnly);
    await server.setExecutionClaim(
      lease,
      claimKey(POLICY_SPACE, "", "action:computation"),
    );
    await server.setExecutionClaim(lease, {
      ...claimKey(POLICY_SPACE, "", "action:builtin"),
      actionKind: "effect",
    });
    assertEquals(noRouting.executionClaims, []);
    assertEquals(
      computationOnly.executionClaims.map((claim) => claim.actionKind),
      ["computation"],
    );
  } finally {
    await noRoutingClient.close();
    await computationOnlyClient.close();
    await server.close();
  }
});
