import {
  assertEquals,
  assertRejects,
  assertThrows,
} from "@std/assert";
import * as MemoryClient from "../v2/client.ts";
import { parseClientMessage, Server } from "../v2/server.ts";
import { encodeMemoryBoundary } from "../v2.ts";
import {
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

type ExecutionServer = Server & {
  listExecutionDemands(
    space: string,
    branch: string,
  ): readonly AuthenticatedExecutionDemand[];
  setExecutionClaim(
    claim: ActionClaimKey & { leaseGeneration: number },
  ): ExecutionClaim;
  revokeExecutionClaim(claim: ExecutionClaim): boolean;
  publishActionSettlement(settlement: ActionSettlement): boolean;
};

const createServer = (
  name: string,
  serverPrimaryExecutionV1: boolean,
): ExecutionServer =>
  new Server({
    ...testSessionOpenServerOptions,
    store: new URL(`memory://${name}`),
    protocolFlags: { serverPrimaryExecutionV1 },
  } as ConstructorParameters<typeof Server>[0]) as ExecutionServer;

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
  options: { subscriptionRefreshDelayMs?: number } = {},
): ExecutionServer =>
  new Server({
    ...testSessionOpenServerOptions,
    store: new URL(`memory://${name}`),
    ...options,
    protocolFlags: {
      serverPrimaryExecutionV1: true,
      serverPrimaryExecutionClaimRoutingV1: true,
      serverPrimaryExecutionBuiltinPassivityV1: true,
    },
  } as ConstructorParameters<typeof Server>[0]) as ExecutionServer;

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
): Promise<void> => {
  await session.transact({
    localSeq: 1,
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
    assertEquals(await first.setExecutionDemand("feature", ["piece:one"]), true);
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

Deno.test("claims are branch-qualified and reclaim mints a fresh generation", async () => {
  const server = createControlServer("memory-v2-execution-claims");
  const client = await connectControlClient(server);
  const session = await mount(client) as ExecutionSession;
  const events: ExecutionControlEvent[] = [];
  const unsubscribe = session.subscribeExecutionControl((event) =>
    events.push(event)
  );
  try {
    const main = server.setExecutionClaim({
      ...claimKey(POLICY_SPACE, ""),
      leaseGeneration: 7,
    });
    const feature = server.setExecutionClaim({
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
    const reclaimed = server.setExecutionClaim({
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
    const claim = server.setExecutionClaim({
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
  for (const type of [
    "session.execution.claim.set",
    "session.execution.claim.revoke",
    "session.execution.settlement",
  ]) {
    assertEquals(parseClientMessage(encodeMemoryBoundary({
      type,
      requestId: "spoof",
      space: POLICY_SPACE,
      sessionId: "session:spoof",
      branch: "",
      principal: "did:key:spoof",
      claim: {},
    })), null);
  }
});

Deno.test("host cannot publish claims while the rollout flag is off", async () => {
  const server = createServer("memory-v2-execution-claims-off", false);
  try {
    assertThrows(
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
