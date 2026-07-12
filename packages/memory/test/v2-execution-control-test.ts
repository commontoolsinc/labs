import { assertEquals, assertRejects } from "@std/assert";
import * as MemoryClient from "../v2/client.ts";
import { parseClientMessage, Server } from "../v2/server.ts";
import { decodeMemoryBoundary, encodeMemoryBoundary } from "../v2.ts";
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
  setExecutionClaim(
    claim: ActionClaimKey & { leaseGeneration: number },
  ): Promise<ExecutionClaim>;
  revokeExecutionClaim(claim: ExecutionClaim): boolean;
  publishActionSettlement(settlement: ActionSettlement): boolean;
  listExecutionClaims(space: string): readonly ExecutionClaim[];
  expireExecutionClaims(now?: number): number;
  subscribeExecutionDemands(
    listener: (snapshot: ExecutionDemandSnapshot) => void,
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
  pieceId: "piece:one",
  actionId,
  actionKind: "computation",
  implementationFingerprint: "impl:v1",
  runtimeFingerprint: "runtime:v1",
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

Deno.test("claims are branch-qualified and reclaim mints a fresh generation", async () => {
  const server = createControlServer("memory-v2-execution-claims");
  const client = await connectControlClient(server);
  const session = await mount(client) as ExecutionSession;
  const events: ExecutionControlEvent[] = [];
  const unsubscribe = session.subscribeExecutionControl((event) =>
    events.push(event)
  );
  try {
    await setPolicy(session, true);
    const main = await server.setExecutionClaim({
      ...claimKey(POLICY_SPACE, ""),
      leaseGeneration: 7,
    });
    const feature = await server.setExecutionClaim({
      ...claimKey(POLICY_SPACE, "feature"),
      leaseGeneration: 7,
    });
    assertEquals(main.claimGeneration, 1);
    assertEquals(feature.claimGeneration, 1);
    assertEquals(session.executionClaims.map((claim) => claim.branch), [
      "",
      "feature",
    ]);

    assertEquals(server.revokeExecutionClaim(main), true);
    const reclaimed = await server.setExecutionClaim({
      ...claimKey(POLICY_SPACE, ""),
      leaseGeneration: 7,
    });
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
        claim.branch === "feature" &&
        claim.claimGeneration === feature.claimGeneration
      ),
      true,
    );
  } finally {
    unsubscribe();
    await client.close();
    await server.close();
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
    await assertRejects(
      () =>
        server.setExecutionClaim({
          ...claimKey(POLICY_SPACE, ""),
          leaseGeneration: 1,
        }),
      Error,
      "execution policy is not enabled",
    );

    await setPolicy(session, true);
    const claim = await server.setExecutionClaim({
      ...claimKey(POLICY_SPACE, ""),
      leaseGeneration: 1,
    });
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

Deno.test("claim expiry revokes clients and rejects stale settlement", async () => {
  let now = 1_000;
  const server = createControlServer("memory-v2-execution-claim-expiry", {
    executionControl: { claimTtlMs: 10, nowMs: () => now },
  });
  const client = await connectControlClient(server);
  const session = await mount(client) as ExecutionSession;
  const events: ExecutionControlEvent[] = [];
  const unsubscribe = session.subscribeExecutionControl((event) => {
    events.push(event);
  });
  try {
    await setPolicy(session, true);
    const claim = await server.setExecutionClaim({
      ...claimKey(POLICY_SPACE, ""),
      leaseGeneration: 2,
    });
    now = claim.expiresAt;

    assertEquals(server.expireExecutionClaims(), 1);
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
    const claim = await server.setExecutionClaim({
      ...claimKey(POLICY_SPACE, ""),
      leaseGeneration: 9,
    });
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

Deno.test("host cannot publish claims while the rollout flag is off", async () => {
  const server = createServer("memory-v2-execution-claims-off", false);
  try {
    await assertRejects(
      () =>
        server.setExecutionClaim({
          ...claimKey(POLICY_SPACE, ""),
          leaseGeneration: 1,
        }),
      Error,
      "server-primary-execution-v1 is disabled",
    );
  } finally {
    await server.close();
  }
});

Deno.test("reconnect applies the claim snapshot then restores connection demand", async () => {
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
      demands.branch === "feature"
    ) {
      demandRestored.resolve();
    }
  });
  try {
    await setPolicy(session, true);
    await session.setExecutionDemand("feature", ["piece:one"]);
    const first = await server.setExecutionClaim({
      ...claimKey(POLICY_SPACE, "feature"),
      leaseGeneration: 3,
    });
    assertEquals(first.claimGeneration, 1);

    transport.disconnect();
    assertEquals(server.revokeExecutionClaim(first), true);
    const second = await server.setExecutionClaim({
      ...claimKey(POLICY_SPACE, "feature"),
      leaseGeneration: 3,
    });
    assertEquals(
      server.publishActionSettlement({
        branch: "feature",
        claim: second,
        inputBasisSeq: 0,
        outcome: "no-op",
      }),
      true,
    );

    await transport.reconnected;
    await demandRestored.promise;
    assertEquals(session.executionClaims.length, 1);
    assertEquals(session.executionClaims[0].claimGeneration, 2);
    assertEquals(settlements.length, 1);
    assertEquals(settlements[0].claim.claimGeneration, 2);
    assertEquals(
      server.listExecutionDemands(POLICY_SPACE, "feature").length,
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
    const view = await session.watchSet([]);
    const syncs = view.subscribeSync();
    const claim = await server.setExecutionClaim({
      ...claimKey(POLICY_SPACE, ""),
      leaseGeneration: 11,
    });
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
    await server.setExecutionClaim({
      ...claimKey(POLICY_SPACE, "", "action:computation"),
      leaseGeneration: 1,
    });
    await server.setExecutionClaim({
      ...claimKey(POLICY_SPACE, "", "action:builtin"),
      actionKind: "effect",
      leaseGeneration: 1,
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
