import { assertEquals, assertRejects } from "@std/assert";
import { FakeTime } from "@std/testing/time";
import type { FabricValue } from "@commonfabric/data-model/fabric-value";
import * as MemoryClient from "../v2/client.ts";
import { Server } from "../v2/server.ts";
import {
  type ActionClaimKey,
  type ActionSettlement,
  decodeMemoryBoundary,
  encodeMemoryBoundary,
  toAcceptedCommitSeq,
  toInputBasisSeq,
} from "../v2.ts";
import {
  TEST_SESSION_OPEN_AUDIENCE,
  TEST_SESSION_OPEN_PRINCIPAL,
  testSessionOpenAuthFactory,
  testSessionOpenServerOptions,
} from "./v2-auth-test-helpers.ts";

const CONTROL_SPACE = "did:key:z6Mk-execution-client-lifecycle";
const POLICY_SPACE = "did:key:z6Mk-execution-reopen-policy";
const CLIENT_PRIMARY_SPACE = "did:key:z6Mk-execution-reopen-client-primary";
const OWNER = "did:key:z6Mk-execution-reopen-owner";
const READER = "did:key:z6Mk-execution-reopen-reader";
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;

const executionProtocolFlags = {
  serverPrimaryExecutionV1: true,
  serverPrimaryExecutionClaimRoutingV1: true,
  serverPrimaryExecutionBuiltinPassivityV1: true,
} as const;

const claimKey = (space: string): ActionClaimKey => ({
  branch: "",
  space,
  contextKey: "space",
  pieceId: "piece:one",
  actionId: "action:derive",
  actionKind: "computation",
  implementationFingerprint: "impl:v1",
  runtimeFingerprint: "runtime:v1",
});

Deno.test("buffered settlements are dropped when their claim is replaced before data arrives", async () => {
  const server = new Server({
    ...testSessionOpenServerOptions,
    store: new URL("memory://execution-client-stale-settlement"),
    subscriptionRefreshDelayMs: 60_000,
    protocolFlags: executionProtocolFlags,
    acl: { mode: "off", serviceDids: [TEST_SESSION_OPEN_PRINCIPAL] },
  });
  const connect = () =>
    MemoryClient.connect({
      transport: MemoryClient.loopback(server),
      protocolFlags: executionProtocolFlags,
    });
  const writerClient = await connect();
  const observerClient = await connect();
  const writer = await writerClient.mount(
    CONTROL_SPACE,
    {},
    testSessionOpenAuthFactory,
  );
  const observer = await observerClient.mount(
    CONTROL_SPACE,
    {},
    testSessionOpenAuthFactory,
  );
  const delivered: ActionSettlement[] = [];
  const unsubscribe = observer.subscribeExecutionControl((event) => {
    if (event.type === "session.execution.settlement") {
      delivered.push(event.settlement);
    }
  });

  try {
    await observer.transact({
      localSeq: 1,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: `of:${CONTROL_SPACE}:execution-policy`,
        value: {
          value: { version: 1, serverPrimaryExecution: true },
        },
      }],
    });
    await observer.setExecutionDemand("", ["piece:one"]);
    const lease = await server.acquireExecutionLease(CONTROL_SPACE, "");
    if (lease === null) throw new Error("expected an execution lease");
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
    const first = await server.setExecutionClaim(
      lease,
      claimKey(CONTROL_SPACE),
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
        claim: first,
        inputBasisSeq: toInputBasisSeq(commit.seq),
        outcome: "committed",
        acceptedCommitSeq: toAcceptedCommitSeq(commit.seq),
      }),
      true,
    );
    assertEquals(delivered, []);

    assertEquals(server.revokeExecutionClaim(first), true);
    const replacement = await server.setExecutionClaim(
      lease,
      claimKey(CONTROL_SPACE),
    );
    assertEquals(replacement.claimGeneration, first.claimGeneration + 1);
    assertEquals(observer.executionClaims, [replacement]);

    await server.flushSessions();
    assertEquals(delivered, []);
  } finally {
    unsubscribe();
    await writerClient.close();
    await observerClient.close();
    await server.close();
  }
});

const authFactory =
  (principal: string): MemoryClient.SessionOpenAuthFactory =>
  (_space, _session, context) => ({
    invocation: {
      aud: context.audience,
      challenge: context.challenge.value,
    },
    authorization: { principal },
  });

class GatedReconnectTransport implements MemoryClient.Transport {
  #receiver: (payload: string) => void = () => {};
  #closeReceiver: (error?: Error) => void = () => {};
  #connection: ReturnType<Server["connect"]> | null = null;
  #releaseReconnect = Promise.withResolvers<void>();
  readonly reconnectStarted = Promise.withResolvers<void>();
  readonly clientPrimaryReopened = Promise.withResolvers<void>();
  helloCount = 0;

  constructor(private readonly server: Server) {}

  setReceiver(receiver: (payload: string) => void): void {
    this.#receiver = receiver;
  }

  setCloseReceiver(receiver: (error?: Error) => void): void {
    this.#closeReceiver = receiver;
  }

  async send(payload: string): Promise<void> {
    const message = decodeMemoryBoundary(payload) as {
      type: string;
      space?: string;
    };
    if (message.type === "hello") {
      this.helloCount += 1;
      if (this.helloCount === 2) {
        this.reconnectStarted.resolve();
        await this.#releaseReconnect.promise;
      }
    }
    await this.#getConnection().receive(payload);
    if (
      message.type === "session.open" &&
      message.space === CLIENT_PRIMARY_SPACE &&
      this.helloCount >= 2
    ) {
      this.clientPrimaryReopened.resolve();
    }
  }

  disconnect(): void {
    this.#connection?.close();
    this.#connection = null;
    this.#closeReceiver(new Error("controlled disconnect"));
  }

  releaseReconnect(): void {
    this.#releaseReconnect.resolve();
  }

  close(): Promise<void> {
    this.#connection?.close();
    this.#connection = null;
    return Promise.resolve();
  }

  #getConnection(): ReturnType<Server["connect"]> {
    if (this.#connection === null) {
      this.#connection = this.server.connect((message: FabricValue) =>
        this.#receiver(encodeMemoryBoundary(message))
      );
    }
    return this.#connection;
  }
}

const withTimeout = async <T>(promise: Promise<T>, message: string) => {
  let timer: ReturnType<typeof realSetTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = realSetTimeout(() => reject(new Error(message)), 1_000);
      }),
    ]);
  } finally {
    realClearTimeout(timer);
  }
};

Deno.test("a reopen ProtocolError closes only the incompatible space session", async () => {
  using time = new FakeTime();
  const server = new Server({
    store: new URL("memory://execution-client-protocol-terminal"),
    authorizeSessionOpen(message) {
      const principal = (message.authorization as { principal?: unknown })
        ?.principal;
      return typeof principal === "string" ? principal : undefined;
    },
    sessionOpenAuth: { audience: TEST_SESSION_OPEN_AUDIENCE },
    acl: { mode: "enforce", serviceDids: [OWNER] },
    protocolFlags: { serverPrimaryExecutionV1: true },
  });
  const ownerClient = await MemoryClient.connect({
    transport: MemoryClient.loopback(server),
    protocolFlags: { serverPrimaryExecutionV1: true },
  });
  const ownerAuth = authFactory(OWNER);
  const policyOwner = await ownerClient.mount(POLICY_SPACE, {}, ownerAuth);
  const clientPrimaryOwner = await ownerClient.mount(
    CLIENT_PRIMARY_SPACE,
    {},
    ownerAuth,
  );
  const installAcl = (
    session: MemoryClient.SpaceSession,
    space: string,
  ) =>
    session.transact({
      localSeq: 1,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: `of:${space}`,
        value: { value: { [OWNER]: "OWNER", [READER]: "READ" } },
      }],
    });
  await installAcl(policyOwner, POLICY_SPACE);
  await installAcl(clientPrimaryOwner, CLIENT_PRIMARY_SPACE);

  const transport = new GatedReconnectTransport(server);
  const staleClient = await MemoryClient.connect({
    transport,
    protocolFlags: { serverPrimaryExecutionV1: false },
  });
  const readerAuth = authFactory(READER);
  const policySession = await staleClient.mount(
    POLICY_SPACE,
    {},
    readerAuth,
  );
  const clientPrimarySession = await staleClient.mount(
    CLIENT_PRIMARY_SPACE,
    {},
    readerAuth,
  );

  try {
    transport.disconnect();
    await transport.reconnectStarted.promise;
    await policyOwner.transact({
      localSeq: 2,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: `of:${POLICY_SPACE}:execution-policy`,
        value: {
          value: { version: 1, serverPrimaryExecution: true },
        },
      }],
    });
    transport.releaseReconnect();

    await withTimeout(
      transport.clientPrimaryReopened.promise,
      "compatible space was not reopened after another space rejected the client",
    );
    const protocolError = await assertRejects(
      () => policySession.queryGraph({ roots: [] }),
      Error,
      "requires memory capability server-primary-execution-v1",
    );
    assertEquals(protocolError.name, "ProtocolError");
    const query = await clientPrimarySession.queryGraph({ roots: [] });
    assertEquals(query.entities, []);

    time.tick(60_000);
    await time.runMicrotasks();
    assertEquals(transport.helloCount, 3);
    assertEquals(staleClient.isConnected(), true);
  } finally {
    transport.releaseReconnect();
    await staleClient.close();
    await ownerClient.close();
    await server.close();
  }
});
