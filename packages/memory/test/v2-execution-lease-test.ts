import { assertEquals, assertExists, assertRejects } from "@std/assert";
import { toFileUrl } from "@std/path";
import * as MemoryClient from "../v2/client.ts";
import * as Engine from "../v2/engine.ts";
import { type ExecutionLeaseHandle, Server } from "../v2/server.ts";
import { table } from "../v2/sqlite/schema.ts";
import { resolveSpaceStoreUrl } from "../v2/storage-path.ts";
import {
  encodeMemoryBoundary,
  type ExecutionControlEvent,
  type ExecutionLease,
  toDocumentPath,
} from "../v2.ts";

const SPACE = "did:key:z6Mk-execution-lease-space";
const OWNER = "did:key:z6Mk-execution-lease-owner";
const READER = "did:key:z6Mk-execution-lease-reader";
const WRITER_A = "did:key:z6Mk-execution-lease-writer-a";
const WRITER_B = "did:key:z6Mk-execution-lease-writer-b";

const flags = {
  serverPrimaryExecutionV1: true,
  serverPrimaryExecutionClaimRoutingV1: true,
  serverPrimaryExecutionBuiltinPassivityV1: true,
} as const;

type LeaseServer = Server & {
  executionOriginMatchesLeaseSponsor(
    lease: ExecutionLeaseHandle,
    originSessionId?: string,
  ): boolean;
  acquireExecutionLease(
    space: string,
    branch: string,
    options?: { preferredOriginSessionId?: string },
  ): Promise<ExecutionLeaseHandle | null>;
  currentExecutionLease(
    space: string,
    branch: string,
  ): Promise<ExecutionLease | null>;
  renewExecutionLease(
    lease: ExecutionLeaseHandle,
  ): Promise<ExecutionLeaseHandle | null>;
  beginExecutionLeaseDrain(
    lease: ExecutionLeaseHandle,
  ): Promise<ExecutionLeaseHandle | null>;
  flushExecutionLeaseTasks(): Promise<void>;
  finishExecutionLeaseDrain(
    lease: ExecutionLeaseHandle,
  ): Promise<ExecutionLease | null>;
  setExecutionClaim(
    lease: ExecutionLeaseHandle,
    claim: {
      branch: string;
      space: string;
      contextKey: "space";
      pieceId: string;
      actionId: string;
      actionKind: "computation";
      implementationFingerprint: string;
      runtimeFingerprint: string;
    },
  ): Promise<unknown>;
  bindExecutionSession(
    space: string,
    sessionId: string,
    lease: ExecutionLeaseHandle,
  ): () => void;
};

type LeaseSession = MemoryClient.SpaceSession & {
  setExecutionDemand(branch: string, pieces: readonly string[]): Promise<
    boolean
  >;
  subscribeExecutionControl(
    listener: (event: ExecutionControlEvent) => void,
  ): () => void;
};

const authFactoryFor = (
  principal: string,
): MemoryClient.SessionOpenAuthFactory =>
(_space, _session, context) => ({
  invocation: {
    aud: context.audience,
    challenge: context.challenge.value,
  },
  authorization: { principal },
});

const createLeaseServer = (
  store: URL,
  hostId: string,
  options: {
    acl?: "off" | "enforce";
    nowMs?: () => number;
    leaseTtlMs?: number;
    drainTimeoutMs?: number;
  } = {},
): LeaseServer =>
  new Server(
    {
      store,
      authorizeSessionOpen(message) {
        const principal = (message.authorization as { principal?: unknown })
          ?.principal;
        return typeof principal === "string" ? principal : undefined;
      },
      sessionOpenAuth: { audience: "did:key:z6Mk-execution-lease-test" },
      protocolFlags: flags,
      acl: {
        mode: options.acl ?? "off",
        serviceDids: [OWNER],
      },
      executionControl: {
        hostId,
        leaseTtlMs: options.leaseTtlMs ?? 30_000,
        ...(options.nowMs ? { nowMs: options.nowMs } : {}),
        ...(options.drainTimeoutMs
          ? { drainTimeoutMs: options.drainTimeoutMs }
          : {}),
      },
    } as ConstructorParameters<typeof Server>[0],
  ) as LeaseServer;

const connect = async (server: Server): Promise<MemoryClient.Client> =>
  await MemoryClient.connect({
    transport: MemoryClient.loopback(server),
    protocolFlags: flags,
    executionCapabilities: { routing: true, builtinPassivity: true },
  } as MemoryClient.ConnectOptions);

const mount = async (
  client: MemoryClient.Client,
  principal: string,
): Promise<LeaseSession> =>
  await client.mount(SPACE, {}, authFactoryFor(principal)) as LeaseSession;

const setAcl = async (
  owner: MemoryClient.SpaceSession,
  grants: Record<string, "OWNER" | "WRITE" | "READ">,
): Promise<void> => {
  await owner.transact({
    localSeq: 1,
    reads: { confirmed: [], pending: [] },
    operations: [{
      op: "set",
      id: `of:${SPACE}`,
      value: { value: grants },
    }],
  });
};

const setPolicy = async (
  owner: MemoryClient.SpaceSession,
  localSeq: number,
  enabled = true,
): Promise<void> => {
  await owner.transact({
    localSeq,
    reads: { confirmed: [], pending: [] },
    operations: [{
      op: "set",
      id: `of:${SPACE}:execution-policy`,
      value: { value: { version: 1, serverPrimaryExecution: enabled } },
    }],
  });
};

Deno.test("one WRITE-capable requester acquires one sticky durable execution lease", async () => {
  const directory = await Deno.makeTempDir();
  const server = createLeaseServer(toFileUrl(`${directory}/`), "host:one");
  const client = await connect(server);
  const session = await mount(client, OWNER);
  try {
    await session.setExecutionDemand("", ["space:of:piece"]);

    const lease = await server.acquireExecutionLease(SPACE, "");
    assertExists(lease);
    assertEquals(lease.version, 1);
    assertEquals(lease.space, SPACE);
    assertEquals(lease.branch, "");
    assertEquals(lease.leaseGeneration, 1);
    assertEquals(lease.hostId, "host:one");
    assertEquals(lease.onBehalfOf, OWNER);
    assertEquals(lease.state, "active");

    assertEquals(
      await server.acquireExecutionLease(SPACE, ""),
      lease,
    );
    assertEquals(await server.currentExecutionLease(SPACE, ""), lease);
  } finally {
    await client.close();
    await server.close();
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("explicit demand clear leaves the captured sponsor lease renewable for graceful drain", async () => {
  const directory = await Deno.makeTempDir();
  let now = 1_000;
  const server = createLeaseServer(
    toFileUrl(`${directory}/`),
    "host:graceful-clear",
    { nowMs: () => now, leaseTtlMs: 100 },
  );
  const client = await connect(server);
  const session = await mount(client, OWNER);
  try {
    await session.setExecutionDemand("", ["space:of:piece"]);
    const lease = await server.acquireExecutionLease(SPACE, "");
    assertExists(lease);

    await session.setExecutionDemand("", []);
    await server.flushExecutionLeaseTasks();
    assertEquals(
      (await server.currentExecutionLease(SPACE, ""))?.state,
      "active",
    );

    now += 50;
    const renewed = await server.renewExecutionLease(lease);
    assertExists(renewed);
    assertEquals(renewed.state, "active");
    assertEquals(renewed.expiresAt, now + 100);

    const draining = await server.beginExecutionLeaseDrain(renewed);
    assertExists(draining);
    await server.finishExecutionLeaseDrain(draining);
  } finally {
    await client.close();
    await server.close();
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("READ-only demand cannot sponsor an execution lease", async () => {
  const directory = await Deno.makeTempDir();
  const server = createLeaseServer(
    toFileUrl(`${directory}/`),
    "host:readonly",
    {
      acl: "enforce",
    },
  );
  const ownerClient = await connect(server);
  const owner = await mount(ownerClient, OWNER);
  let readerClient: MemoryClient.Client | undefined;
  try {
    await setAcl(owner, { [OWNER]: "OWNER", [READER]: "READ" });
    readerClient = await connect(server);
    const reader = await mount(readerClient, READER);
    await reader.setExecutionDemand("", ["space:of:piece"]);

    assertEquals(await server.acquireExecutionLease(SPACE, ""), null);
    assertEquals(await server.currentExecutionLease(SPACE, ""), null);
  } finally {
    await readerClient?.close();
    await ownerClient.close();
    await server.close();
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("preferred origin principal sponsors a sticky generation", async () => {
  const directory = await Deno.makeTempDir();
  const server = createLeaseServer(
    toFileUrl(`${directory}/`),
    "host:preferred",
    { acl: "enforce" },
  );
  const ownerClient = await connect(server);
  const owner = await mount(ownerClient, OWNER);
  let firstClient: MemoryClient.Client | undefined;
  let secondClient: MemoryClient.Client | undefined;
  try {
    await setAcl(owner, {
      [OWNER]: "OWNER",
      [WRITER_A]: "WRITE",
      [WRITER_B]: "WRITE",
    });
    firstClient = await connect(server);
    const first = await mount(firstClient, WRITER_A);
    await first.setExecutionDemand("", ["space:first"]);
    secondClient = await connect(server);
    const second = await mount(secondClient, WRITER_B);
    await second.setExecutionDemand("", ["space:second"]);

    const lease = await server.acquireExecutionLease(SPACE, "", {
      preferredOriginSessionId: second.sessionId,
    });
    assertExists(lease);
    assertEquals(lease.onBehalfOf, WRITER_B);
    assertEquals(
      await server.acquireExecutionLease(SPACE, "", {
        preferredOriginSessionId: first.sessionId,
      }),
      lease,
    );
  } finally {
    await firstClient?.close();
    await secondClient?.close();
    await ownerClient.close();
    await server.close();
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("execution origins match the exact lease sponsor principal", async () => {
  const directory = await Deno.makeTempDir();
  const server = createLeaseServer(
    toFileUrl(`${directory}/`),
    "host:origin-match",
    { acl: "enforce" },
  );
  const ownerClient = await connect(server);
  const owner = await mount(ownerClient, OWNER);
  let sponsorClient: MemoryClient.Client | undefined;
  let samePrincipalClient: MemoryClient.Client | undefined;
  let otherPrincipalClient: MemoryClient.Client | undefined;
  try {
    await setAcl(owner, {
      [OWNER]: "OWNER",
      [WRITER_A]: "WRITE",
      [WRITER_B]: "WRITE",
    });
    sponsorClient = await connect(server);
    const sponsor = await mount(sponsorClient, WRITER_A);
    await sponsor.setExecutionDemand("", ["space:first"]);
    samePrincipalClient = await connect(server);
    const samePrincipal = await mount(samePrincipalClient, WRITER_A);
    otherPrincipalClient = await connect(server);
    const otherPrincipal = await mount(otherPrincipalClient, WRITER_B);

    const lease = await server.acquireExecutionLease(SPACE, "", {
      preferredOriginSessionId: sponsor.sessionId,
    });
    assertExists(lease);
    assertEquals(
      server.executionOriginMatchesLeaseSponsor(lease, sponsor.sessionId),
      true,
    );
    assertEquals(
      server.executionOriginMatchesLeaseSponsor(
        lease,
        samePrincipal.sessionId,
      ),
      true,
    );
    assertEquals(
      server.executionOriginMatchesLeaseSponsor(
        lease,
        otherPrincipal.sessionId,
      ),
      false,
    );
    assertEquals(
      server.executionOriginMatchesLeaseSponsor(lease, undefined),
      false,
    );
    assertEquals(
      server.executionOriginMatchesLeaseSponsor(
        { ...lease } as ExecutionLeaseHandle,
        sponsor.sessionId,
      ),
      false,
    );

    const renewed = await server.renewExecutionLease(lease);
    assertExists(renewed);
    assertEquals(
      server.executionOriginMatchesLeaseSponsor(lease, sponsor.sessionId),
      false,
    );
    assertEquals(
      server.executionOriginMatchesLeaseSponsor(renewed, sponsor.sessionId),
      true,
    );
  } finally {
    await sponsorClient?.close();
    await samePrincipalClient?.close();
    await otherPrincipalClient?.close();
    await ownerClient.close();
    await server.close();
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("sponsor disconnect drains before a remaining writer can replace it", async () => {
  const directory = await Deno.makeTempDir();
  let nowMs = 10_000;
  const server = createLeaseServer(
    toFileUrl(`${directory}/`),
    "host:drain",
    {
      acl: "enforce",
      nowMs: () => nowMs,
      leaseTtlMs: 1_000,
      drainTimeoutMs: 100,
    },
  );
  const ownerClient = await connect(server);
  const owner = await mount(ownerClient, OWNER);
  let firstClient: MemoryClient.Client | undefined;
  let secondClient: MemoryClient.Client | undefined;
  try {
    await setAcl(owner, {
      [OWNER]: "OWNER",
      [WRITER_A]: "WRITE",
      [WRITER_B]: "WRITE",
    });
    await setPolicy(owner, 2);
    firstClient = await connect(server);
    const first = await mount(firstClient, WRITER_A);
    await first.setExecutionDemand("", ["space:first"]);
    secondClient = await connect(server);
    const second = await mount(secondClient, WRITER_B);
    await second.setExecutionDemand("", ["space:second"]);

    const firstLease = await server.acquireExecutionLease(SPACE, "");
    assertExists(firstLease);
    assertEquals(firstLease.onBehalfOf, WRITER_A);

    await firstClient.close();
    firstClient = undefined;
    await server.flushExecutionLeaseTasks();
    const draining = await server.currentExecutionLease(SPACE, "");
    assertExists(draining);
    assertEquals(draining.state, "draining");
    assertEquals(await server.acquireExecutionLease(SPACE, ""), draining);
    await assertRejects(
      () =>
        server.setExecutionClaim(firstLease, {
          branch: "",
          space: SPACE,
          contextKey: "space",
          pieceId: "of:piece",
          actionId: "action:after-drain",
          actionKind: "computation",
          implementationFingerprint: "impl:v1",
          runtimeFingerprint: "runtime:v1",
        }),
      Error,
      "current owned lease",
    );

    nowMs = 10_100;
    assertEquals(await server.expireExecutionLeases(nowMs), 1);
    const replacement = await server.acquireExecutionLease(SPACE, "");
    assertExists(replacement);
    assertEquals(replacement.leaseGeneration, firstLease.leaseGeneration + 1);
    assertEquals(replacement.onBehalfOf, WRITER_B);
  } finally {
    await firstClient?.close();
    await secondClient?.close();
    await ownerClient.close();
    await server.close();
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("stale host relinquishes claims after another host acquires the next generation", async () => {
  const directory = await Deno.makeTempDir();
  const store = toFileUrl(`${directory}/`);
  let nowA = 1_000;
  let nowB = 1_000;
  const serverA = createLeaseServer(store, "host:stale-a", {
    nowMs: () => nowA,
    leaseTtlMs: 100_000,
  });
  const serverB = createLeaseServer(store, "host:replacement-b", {
    nowMs: () => nowB,
    leaseTtlMs: 100_000,
  });
  const clientA = await connect(serverA);
  const clientB = await connect(serverB);
  const sponsorA = await mount(clientA, OWNER);
  const sponsorB = await mount(clientB, OWNER);
  const events: ExecutionControlEvent[] = [];
  const unsubscribe = sponsorA.subscribeExecutionControl((event) => {
    events.push(event);
  });
  try {
    await setPolicy(sponsorA, 1);
    await sponsorA.setExecutionDemand("", ["space:piece-a"]);
    await sponsorB.setExecutionDemand("", ["space:piece-b"]);
    const first = await serverA.acquireExecutionLease(SPACE, "");
    assertExists(first);
    await serverA.setExecutionClaim(first, {
      branch: "",
      space: SPACE,
      contextKey: "space",
      pieceId: "of:piece",
      actionId: "action:stale-host",
      actionKind: "computation",
      implementationFingerprint: "impl:v1",
      runtimeFingerprint: "runtime:v1",
    });

    nowB = first.expiresAt + 1;
    const replacement = await serverB.acquireExecutionLease(SPACE, "");
    assertExists(replacement);
    assertEquals(
      replacement.leaseGeneration,
      first.leaseGeneration + 1,
    );

    nowA = first.expiresAt;
    assertEquals(await serverA.expireExecutionLeases(nowA), 0);
    assertEquals(
      events.some((event) =>
        event.type === "session.execution.claim.revoke" &&
        event.leaseGeneration === first.leaseGeneration
      ),
      true,
    );
  } finally {
    unsubscribe();
    await clientA.close();
    await clientB.close();
    await serverA.close();
    await serverB.close();
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("draining lease rejects work started after sponsor disconnect", async () => {
  const directory = await Deno.makeTempDir();
  const server = createLeaseServer(
    toFileUrl(`${directory}/`),
    "host:fresh-after-drain",
    { leaseTtlMs: 30_000, drainTimeoutMs: 5_000 },
  );
  const sponsorClient = await connect(server);
  const sponsor = await mount(sponsorClient, OWNER);
  const executorClient = await connect(server);
  const executor = await mount(executorClient, OWNER);
  try {
    await setPolicy(sponsor, 1);
    await sponsor.setExecutionDemand("", ["space:piece"]);
    const acquired = await server.acquireExecutionLease(SPACE, "");
    assertExists(acquired);
    server.bindExecutionSession(SPACE, executor.sessionId, acquired);

    await sponsorClient.close();
    await server.flushExecutionLeaseTasks();
    assertEquals(
      (await server.currentExecutionLease(SPACE, ""))?.state,
      "draining",
    );

    await assertRejects(
      () =>
        executor.transact({
          localSeq: 1,
          reads: { confirmed: [], pending: [] },
          operations: [{
            op: "set",
            id: "of:fresh-after-drain",
            value: { value: { accepted: true } },
          }],
        }),
      Error,
      "execution lease",
    );
    assertEquals(
      await server.readDocument(SPACE, "of:fresh-after-drain"),
      null,
    );
  } finally {
    await executorClient.close();
    await sponsorClient.close();
    await server.close();
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("a lease-bound session cannot commit after its generation is replaced", async () => {
  const directory = await Deno.makeTempDir();
  const server = createLeaseServer(toFileUrl(`${directory}/`), "host:fence");
  const sponsorClient = await connect(server);
  const sponsor = await mount(sponsorClient, OWNER);
  const executorClient = await connect(server);
  const executor = await mount(executorClient, OWNER);
  try {
    await sponsor.setExecutionDemand("", ["space:piece"]);
    const first = await server.acquireExecutionLease(SPACE, "");
    assertExists(first);
    await setPolicy(sponsor, 1);
    server.bindExecutionSession(SPACE, executor.sessionId, first);

    assertExists(await server.finishExecutionLeaseDrain(first));
    const replacement = await server.acquireExecutionLease(SPACE, "");
    assertExists(replacement);
    assertEquals(replacement.leaseGeneration, first.leaseGeneration + 1);

    await assertRejects(
      () =>
        executor.transact({
          localSeq: 1,
          reads: { confirmed: [], pending: [] },
          operations: [{
            op: "set",
            id: "of:stale-executor-output",
            value: { value: { stale: true } },
          }],
        }),
      Error,
    );
    assertEquals(
      await server.readDocument(SPACE, "of:stale-executor-output"),
      null,
    );
  } finally {
    await executorClient.close();
    await sponsorClient.close();
    await server.close();
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("policy disable revokes claims and immediately fences a draining executor", async () => {
  const directory = await Deno.makeTempDir();
  const server = createLeaseServer(toFileUrl(`${directory}/`), "host:policy");
  const sponsorClient = await connect(server);
  const sponsor = await mount(sponsorClient, OWNER);
  const executorClient = await connect(server);
  const executor = await mount(executorClient, OWNER);
  try {
    await sponsor.setExecutionDemand("", ["space:piece"]);
    const lease = await server.acquireExecutionLease(SPACE, "");
    assertExists(lease);
    await setPolicy(sponsor, 1);
    server.bindExecutionSession(SPACE, executor.sessionId, lease);
    await server.setExecutionClaim(lease, {
      branch: "",
      space: SPACE,
      contextKey: "space",
      pieceId: "of:piece",
      actionId: "action:policy-disable",
      actionKind: "computation",
      implementationFingerprint: "impl:v1",
      runtimeFingerprint: "runtime:v1",
    });
    assertEquals(server.listExecutionClaims(SPACE).length, 1);

    await setPolicy(sponsor, 2, false);
    await server.flushExecutionLeaseTasks();
    assertEquals(server.listExecutionClaims(SPACE), []);
    assertEquals(
      (await server.currentExecutionLease(SPACE, ""))?.state,
      "draining",
    );
    await assertRejects(
      () =>
        executor.transact({
          localSeq: 1,
          reads: { confirmed: [], pending: [] },
          operations: [{
            op: "set",
            id: "of:disabled-policy-output",
            value: { value: { forbidden: true } },
          }],
        }),
      Error,
    );
    assertEquals(
      await server.readDocument(SPACE, "of:disabled-policy-output"),
      null,
    );
  } finally {
    await executorClient.close();
    await sponsorClient.close();
    await server.close();
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("sponsor WRITE loss fences commits before replacement", async () => {
  const directory = await Deno.makeTempDir();
  const server = createLeaseServer(
    toFileUrl(`${directory}/`),
    "host:write-loss",
    { acl: "enforce" },
  );
  const ownerClient = await connect(server);
  const owner = await mount(ownerClient, OWNER);
  let sponsorClient: MemoryClient.Client | undefined;
  let replacementClient: MemoryClient.Client | undefined;
  let executorClient: MemoryClient.Client | undefined;
  try {
    await setAcl(owner, {
      [OWNER]: "OWNER",
      [WRITER_A]: "WRITE",
      [WRITER_B]: "WRITE",
    });
    await setPolicy(owner, 2);
    sponsorClient = await connect(server);
    const sponsor = await mount(sponsorClient, WRITER_A);
    await sponsor.setExecutionDemand("", ["space:first"]);
    replacementClient = await connect(server);
    const replacementSponsor = await mount(replacementClient, WRITER_B);
    await replacementSponsor.setExecutionDemand("", ["space:second"]);
    const lease = await server.acquireExecutionLease(SPACE, "");
    assertExists(lease);
    assertEquals(lease.onBehalfOf, WRITER_A);

    executorClient = await connect(server);
    const executor = await mount(executorClient, WRITER_A);
    server.bindExecutionSession(SPACE, executor.sessionId, lease);
    await owner.transact({
      localSeq: 3,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: `of:${SPACE}`,
        value: {
          value: {
            [OWNER]: "OWNER",
            [WRITER_A]: "READ",
            [WRITER_B]: "WRITE",
          },
        },
      }],
    });
    await server.flushExecutionLeaseTasks();
    assertEquals(
      (await server.currentExecutionLease(SPACE, ""))?.state,
      "draining",
    );
    await assertRejects(
      () =>
        executor.transact({
          localSeq: 1,
          reads: { confirmed: [], pending: [] },
          operations: [{
            op: "set",
            id: "of:write-revoked-output",
            value: { value: { forbidden: true } },
          }],
        }),
      Error,
    );
    assertExists(await server.finishExecutionLeaseDrain(lease));
    const replacement = await server.acquireExecutionLease(SPACE, "");
    assertExists(replacement);
    assertEquals(replacement.onBehalfOf, WRITER_B);
  } finally {
    await executorClient?.close();
    await sponsorClient?.close();
    await replacementClient?.close();
    await ownerClient.close();
    await server.close();
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("lease-bound execution projects the sponsor PerSession scope", async () => {
  const directory = await Deno.makeTempDir();
  const server = createLeaseServer(
    toFileUrl(`${directory}/`),
    "host:sponsor-session-scope",
  );
  const sponsorClient = await connect(server);
  const sponsor = await mount(sponsorClient, OWNER);
  const siblingClient = await connect(server);
  const sibling = await mount(siblingClient, OWNER);
  const executorClient = await connect(server);
  const executor = await mount(executorClient, OWNER);
  const sessionDb = {
    id: "of:sponsor-session-db",
    scope: "session" as const,
    tables: { notes: table({ body: "text" }) },
  };
  const sessionValue = async (session: MemoryClient.SpaceSession, id: string) =>
    (await session.queryGraph({
      roots: [{
        id,
        scope: "session",
        selector: {
          path: [],
          schema: {
            type: "object",
            properties: { lane: { type: "string" } },
            required: ["lane"],
          },
        },
      }],
    })).entities[0]?.document?.value;

  try {
    await sponsor.transact({
      localSeq: 1,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: "of:sponsor-session-input",
        scope: "session",
        value: { value: { lane: "sponsor" } },
      }, {
        op: "set",
        id: "of:sponsor-session-added",
        scope: "session",
        value: { value: { lane: "sponsor-added" } },
      }],
    });
    await sibling.transact({
      localSeq: 1,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: "of:sponsor-session-input",
        scope: "session",
        value: { value: { lane: "sibling" } },
      }],
    });
    await setPolicy(sponsor, 2);
    await sponsor.setExecutionDemand("", ["space:piece"]);
    const lease = await server.acquireExecutionLease(SPACE, "");
    assertExists(lease);
    server.bindExecutionSession(SPACE, executor.sessionId, lease);

    assertEquals(
      await sessionValue(executor, "of:sponsor-session-input"),
      { lane: "sponsor" },
    );

    const watch = await executor.watchSet([{
      id: "sponsor-session-root",
      kind: "graph",
      query: {
        roots: [{
          id: "of:sponsor-session-input",
          scope: "session",
          selector: { path: [], schema: false },
        }],
      },
    }]);
    assertEquals(watch.entities[0]?.document?.value, { lane: "sponsor" });
    await executor.watchAdd([{
      id: "sponsor-session-added",
      kind: "graph",
      query: {
        roots: [{
          id: "of:sponsor-session-added",
          scope: "session",
          selector: { path: [], schema: false },
        }],
      },
    }]);
    assertEquals(
      watch.entities.find((entity) => entity.id === "of:sponsor-session-added")
        ?.document?.value,
      { lane: "sponsor-added" },
    );
    const updates = watch.subscribe();
    const nextUpdate = updates.next();
    await sponsor.transact({
      localSeq: 3,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: "of:sponsor-session-input",
        scope: "session",
        value: { value: { lane: "sponsor-updated" } },
      }],
    });
    const refreshed = await nextUpdate;
    if (refreshed.done) throw new Error("sponsor-scoped watch ended early");
    assertEquals(
      refreshed.value.entities.find((entity) =>
        entity.id === "of:sponsor-session-input"
      )?.document?.value,
      { lane: "sponsor-updated" },
    );

    const schedulerWrite = {
      space: SPACE,
      id: "of:sponsor-scheduler-output",
      scope: "session" as const,
      path: [],
    };
    await sponsor.transact({
      localSeq: 4,
      reads: { confirmed: [], pending: [] },
      operations: [],
      schedulerObservation: {
        version: 2,
        ownerSpace: SPACE,
        branch: "",
        pieceId: "space:of:piece",
        processGeneration: 1,
        actionId: "action:sponsor-session",
        actionKind: "computation",
        implementationFingerprint: "impl:sponsor-session",
        runtimeFingerprint: "runtime:sponsor-session",
        observedAtSeq: 0,
        transactionKind: "action-run",
        reads: [],
        shallowReads: [],
        actualChangedWrites: [],
        currentKnownWrites: [schedulerWrite],
        materializerWriteEnvelopes: [],
        ignoredSchedulingWrites: [],
        actionOptions: {},
        status: "success",
        completeActionScopeSummary: {
          version: 1,
          complete: true,
          implementationFingerprint: "impl:sponsor-session",
          runtimeFingerprint: "runtime:sponsor-session",
          piece: {
            space: SPACE,
            id: "of:piece",
            scope: "space",
            path: [],
          },
          reads: [],
          writes: [schedulerWrite],
          materializerWriteEnvelopes: [],
          directOutputs: [schedulerWrite],
        },
      },
    });
    assertEquals(
      (await executor.listSchedulerActionSnapshots()).snapshots.map(
        (snapshot) => (snapshot.observation as { actionId?: string }).actionId,
      ),
      ["action:sponsor-session"],
    );
    assertEquals(
      (await sibling.listSchedulerActionSnapshots()).snapshots,
      [],
    );
    assertEquals(
      (await executor.writersForTargets({
        targets: [{
          id: schedulerWrite.id,
          scope: schedulerWrite.scope,
          path: toDocumentPath([]),
        }],
      })).writers.map((writer) => writer.actionId),
      ["action:sponsor-session"],
    );

    await sponsor.transact({
      localSeq: 5,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "sqlite",
        db: sessionDb,
        sql: "INSERT INTO notes (body) VALUES (?)",
        params: ["sponsor-row"],
      }],
    });
    assertEquals(
      (await executor.sqliteQuery(
        sessionDb,
        "SELECT body FROM notes ORDER BY rowid",
      )).rows,
      [{ body: "sponsor-row" }],
    );

    await executor.transact({
      localSeq: 1,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: "of:sponsor-session-output",
        scope: "session",
        value: { value: { lane: "executor" } },
      }, {
        op: "sqlite",
        db: sessionDb,
        sql: "INSERT INTO notes (body) VALUES (?)",
        params: ["executor-row"],
      }],
    });
    assertEquals(
      await sessionValue(sponsor, "of:sponsor-session-output"),
      { lane: "executor" },
    );
    assertEquals(
      await sessionValue(sibling, "of:sponsor-session-output"),
      undefined,
    );
    assertEquals(
      (await sponsor.sqliteQuery(
        sessionDb,
        "SELECT body FROM notes ORDER BY rowid",
      )).rows,
      [{ body: "sponsor-row" }, { body: "executor-row" }],
    );
    assertEquals(
      (await sibling.sqliteQuery(
        sessionDb,
        "SELECT body FROM notes ORDER BY rowid",
      )).rows,
      [],
    );
  } finally {
    await executorClient.close();
    await siblingClient.close();
    await sponsorClient.close();
    await server.close();
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("scheduler mirrors retain sponsor scope across executor disconnect", async () => {
  const directory = await Deno.makeTempDir();
  const store = toFileUrl(`${directory}/`);
  const readSpace = "did:key:z6Mk-execution-lease-sponsor-mirror-read";
  const disconnected = Promise.withResolvers<void>();
  let disconnectDuringFence = false;
  let armedClockSamples = 0;
  let disconnectExecutor = () => {};
  const server = createLeaseServer(store, "host:sponsor-mirror", {
    nowMs: () => {
      if (disconnectDuringFence && ++armedClockSamples === 2) {
        disconnectDuringFence = false;
        disconnectExecutor();
        disconnected.resolve();
      }
      return Date.now();
    },
  });
  const sponsorClient = await connect(server);
  const sponsor = await mount(sponsorClient, OWNER);

  let receiver = (_payload: string) => {};
  const rawConnection = server.connect((message) => {
    receiver(encodeMemoryBoundary(message));
  });
  const executorClient = await MemoryClient.connect({
    transport: {
      async send(payload: string) {
        await rawConnection.receive(payload);
      },
      close() {
        rawConnection.close();
        return Promise.resolve();
      },
      setReceiver(next: (payload: string) => void) {
        receiver = next;
      },
      setCloseReceiver() {},
    },
    protocolFlags: flags,
    executionCapabilities: { routing: true, builtinPassivity: true },
  } as MemoryClient.ConnectOptions);
  const executor = await mount(executorClient, OWNER);
  disconnectExecutor = () => {
    server.detachSession(SPACE, executor.sessionId, rawConnection.id);
  };
  await executorClient.mount(
    readSpace,
    { sessionId: executor.sessionId },
    authFactoryFor(OWNER),
  );

  const actionId = "action:sponsor-session-disconnect-mirror";
  const sessionRead = {
    space: readSpace,
    id: "of:sponsor-session-mirror-input",
    scope: "session" as const,
    path: [],
  };
  const sessionWrite = {
    space: SPACE,
    id: "of:sponsor-session-mirror-output",
    scope: "session" as const,
    path: [],
  };
  const secondSessionWrite = {
    ...sessionWrite,
    id: "of:sponsor-session-mirror-output-v2",
  };
  const schedulerObservation = {
    version: 2 as const,
    ownerSpace: SPACE,
    branch: "",
    pieceId: "space:of:piece",
    processGeneration: 1,
    actionId,
    actionKind: "event-handler" as const,
    implementationFingerprint: "impl:sponsor-session-mirror",
    runtimeFingerprint: "runtime:sponsor-session-mirror",
    observedAtSeq: 0,
    transactionKind: "action-run" as const,
    reads: [sessionRead],
    shallowReads: [],
    actualChangedWrites: [],
    currentKnownWrites: [sessionWrite],
    materializerWriteEnvelopes: [],
    ignoredSchedulingWrites: [],
    actionOptions: {},
    status: "success" as const,
    completeActionScopeSummary: {
      version: 1 as const,
      complete: true as const,
      implementationFingerprint: "impl:sponsor-session-mirror",
      runtimeFingerprint: "runtime:sponsor-session-mirror",
      piece: {
        space: SPACE,
        id: "of:piece",
        scope: "space" as const,
        path: [],
      },
      reads: [sessionRead],
      writes: [sessionWrite],
      materializerWriteEnvelopes: [],
      directOutputs: [sessionWrite],
    },
  };

  try {
    await setPolicy(sponsor, 1);
    await sponsor.setExecutionDemand("", ["space:piece"]);
    const lease = await server.acquireExecutionLease(SPACE, "");
    assertExists(lease);
    server.bindExecutionSession(SPACE, executor.sessionId, lease);

    await executor.transact({
      localSeq: 1,
      reads: { confirmed: [], pending: [] },
      operations: [],
      schedulerObservation,
    });

    disconnectDuringFence = true;
    const inFlight = executor.transact({
      localSeq: 2,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: secondSessionWrite.id,
        scope: secondSessionWrite.scope,
        value: { value: { updated: true } },
      }],
      schedulerObservation: {
        ...schedulerObservation,
        actualChangedWrites: [secondSessionWrite],
        currentKnownWrites: [sessionWrite, secondSessionWrite],
        completeActionScopeSummary: {
          ...schedulerObservation.completeActionScopeSummary,
          writes: [sessionWrite, secondSessionWrite],
          directOutputs: [sessionWrite, secondSessionWrite],
        },
      },
    });
    await disconnected.promise;
    await inFlight;

    const readEngine = await Engine.open({
      url: resolveSpaceStoreUrl(store, readSpace),
    });
    try {
      const snapshots = Engine.listSchedulerActionSnapshots(readEngine, {
        actionId,
      }).snapshots;
      assertEquals(snapshots.length, 1);
      assertEquals(
        snapshots[0].executionContextKey,
        Engine.resolveScopeKey("session", {
          principal: OWNER,
          sessionId: sponsor.sessionId,
        }),
      );
      assertEquals(
        snapshots[0].writerSessionId,
        Engine.resolveCommitSessionKey(executor.sessionId, OWNER),
      );
      assertEquals(
        snapshots[0].observation.currentKnownWrites,
        [sessionWrite, secondSessionWrite],
      );
    } finally {
      Engine.close(readEngine);
    }
  } finally {
    await executorClient.close();
    await sponsorClient.close();
    await server.close();
    await Deno.remove(directory, { recursive: true });
  }
});
