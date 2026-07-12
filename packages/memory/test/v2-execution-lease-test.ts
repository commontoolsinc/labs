import { assertEquals, assertExists, assertRejects } from "@std/assert";
import { toFileUrl } from "@std/path";
import * as MemoryClient from "../v2/client.ts";
import { type ExecutionLeaseHandle, Server } from "../v2/server.ts";
import type { ExecutionLease } from "../v2.ts";

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
  acquireExecutionLease(
    space: string,
    branch: string,
    options?: { preferredOriginSessionId?: string },
  ): Promise<ExecutionLeaseHandle | null>;
  currentExecutionLease(
    space: string,
    branch: string,
  ): Promise<ExecutionLease | null>;
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
