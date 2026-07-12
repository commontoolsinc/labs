import { assertEquals, assertExists } from "@std/assert";
import { toFileUrl } from "@std/path";
import * as MemoryClient from "../v2/client.ts";
import { Server } from "../v2/server.ts";

const SPACE = "did:key:z6Mk-execution-lease-space";
const OWNER = "did:key:z6Mk-execution-lease-owner";
const READER = "did:key:z6Mk-execution-lease-reader";

const flags = {
  serverPrimaryExecutionV1: true,
  serverPrimaryExecutionClaimRoutingV1: true,
  serverPrimaryExecutionBuiltinPassivityV1: true,
} as const;

type ExecutionLease = {
  version: 1;
  space: string;
  branch: string;
  leaseGeneration: number;
  hostId: string;
  onBehalfOf: string;
  sponsorSessionId: string;
  sponsorConnectionId: string;
  state: "active" | "draining" | "revoked";
  expiresAt: number;
};

type LeaseServer = Server & {
  acquireExecutionLease(
    space: string,
    branch: string,
    options?: { preferredPrincipal?: string },
  ): Promise<ExecutionLease | null>;
  currentExecutionLease(
    space: string,
    branch: string,
  ): Promise<ExecutionLease | null>;
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
  options: { acl?: "off" | "enforce" } = {},
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
        leaseTtlMs: 30_000,
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

const setPolicy = async (
  session: MemoryClient.SpaceSession,
  localSeq = 1,
): Promise<void> => {
  await session.transact({
    localSeq,
    reads: { confirmed: [], pending: [] },
    operations: [{
      op: "set",
      id: `of:${SPACE}:execution-policy`,
      value: { value: { version: 1, serverPrimaryExecution: true } },
    }],
  });
};

Deno.test("one WRITE-capable requester acquires one sticky durable execution lease", async () => {
  const path = await Deno.makeTempFile({ suffix: ".sqlite" });
  const server = createLeaseServer(toFileUrl(path), "host:one");
  const client = await connect(server);
  const session = await mount(client, OWNER);
  try {
    await setPolicy(session);
    await session.setExecutionDemand("feature", ["space:of:piece"]);

    const lease = await server.acquireExecutionLease(SPACE, "feature");
    assertExists(lease);
    assertEquals(lease.version, 1);
    assertEquals(lease.space, SPACE);
    assertEquals(lease.branch, "feature");
    assertEquals(lease.leaseGeneration, 1);
    assertEquals(lease.hostId, "host:one");
    assertEquals(lease.onBehalfOf, OWNER);
    assertEquals(lease.sponsorSessionId, session.sessionId);
    assertEquals(lease.state, "active");

    assertEquals(
      await server.acquireExecutionLease(SPACE, "feature"),
      lease,
    );
    assertEquals(await server.currentExecutionLease(SPACE, "feature"), lease);
  } finally {
    await client.close();
    await server.close();
    await Deno.remove(path);
  }
});

Deno.test("two hosts racing a durable execution lease produce exactly one winner", async () => {
  const directory = await Deno.makeTempDir();
  const store = toFileUrl(`${directory}/`);
  const firstServer = createLeaseServer(store, "host:first");
  const firstClient = await connect(firstServer);
  const firstSession = await mount(firstClient, OWNER);
  let secondServer: LeaseServer | undefined;
  let secondClient: MemoryClient.Client | undefined;
  try {
    await setPolicy(firstSession);
    await firstSession.setExecutionDemand("", ["space:of:piece"]);

    secondServer = createLeaseServer(store, "host:second");
    secondClient = await connect(secondServer);
    const secondSession = await mount(secondClient, OWNER);
    await secondSession.setExecutionDemand("", ["space:of:piece"]);

    const attempts = await Promise.all([
      firstServer.acquireExecutionLease(SPACE, ""),
      secondServer.acquireExecutionLease(SPACE, ""),
    ]);
    assertEquals(attempts.filter((lease) => lease !== null).length, 1);
    assertEquals(
      new Set(attempts.flatMap((lease) => lease ? [lease.hostId] : [])).size,
      1,
    );
  } finally {
    await firstClient.close();
    await secondClient?.close();
    await firstServer.close();
    await secondServer?.close();
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("READ-only demand cannot sponsor an execution lease", async () => {
  const path = await Deno.makeTempFile({ suffix: ".sqlite" });
  const server = createLeaseServer(toFileUrl(path), "host:readonly", {
    acl: "enforce",
  });
  const ownerClient = await connect(server);
  const owner = await mount(ownerClient, OWNER);
  let readerClient: MemoryClient.Client | undefined;
  try {
    await owner.transact({
      localSeq: 1,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: SPACE,
        value: { value: { [OWNER]: "OWNER", [READER]: "READ" } },
      }],
    });
    await setPolicy(owner, 2);

    readerClient = await connect(server);
    const reader = await mount(readerClient, READER);
    await reader.setExecutionDemand("", ["space:of:piece"]);

    assertEquals(await server.acquireExecutionLease(SPACE, ""), null);
    assertEquals(await server.currentExecutionLease(SPACE, ""), null);
  } finally {
    await readerClient?.close();
    await ownerClient.close();
    await server.close();
    await Deno.remove(path);
  }
});
