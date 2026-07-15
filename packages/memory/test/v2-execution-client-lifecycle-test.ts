import { assertEquals } from "@std/assert";
import type { FabricValue } from "@commonfabric/data-model/fabric-value";
import * as MemoryClient from "../v2/client.ts";
import { Server, SessionRegistry } from "../v2/server.ts";
import {
  type ActionClaimKey,
  type ActionSettlement,
  decodeMemoryBoundary,
  encodeMemoryBoundary,
  toAcceptedCommitSeq,
  toInputBasisSeq,
} from "../v2.ts";
import {
  TEST_SESSION_OPEN_PRINCIPAL,
  testSessionOpenAuthFactory,
  testSessionOpenServerOptions,
} from "./v2-auth-test-helpers.ts";

const CONTROL_SPACE = "did:key:z6Mk-execution-client-lifecycle";
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

class GatedReconnectTransport implements MemoryClient.Transport {
  #receiver: (payload: string) => void = () => {};
  #closeReceiver: (error?: Error) => void = () => {};
  #connection: ReturnType<Server["connect"]> | null = null;
  #releaseReconnect = Promise.withResolvers<void>();
  readonly reconnectStarted = Promise.withResolvers<void>();
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

Deno.test("client reconnect delivers an evicted successful settlement frontier exactly once", async () => {
  const server = new Server({
    ...testSessionOpenServerOptions,
    store: new URL("memory://execution-client-settlement-frontier"),
    sessions: new SessionRegistry({ maxExecutionEvents: 2 }),
    protocolFlags: executionProtocolFlags,
    acl: { mode: "off", serviceDids: [TEST_SESSION_OPEN_PRINCIPAL] },
  });
  const sponsorClient = await MemoryClient.connect({
    transport: MemoryClient.loopback(server),
    protocolFlags: executionProtocolFlags,
  });
  const sponsor = await sponsorClient.mount(
    CONTROL_SPACE,
    {},
    testSessionOpenAuthFactory,
  );
  const transport = new GatedReconnectTransport(server);
  const observerClient = await MemoryClient.connect({
    transport,
    protocolFlags: executionProtocolFlags,
  });
  const observer = await observerClient.mount(
    CONTROL_SPACE,
    {},
    testSessionOpenAuthFactory,
  );
  const delivered: ActionSettlement[] = [];
  const claimDelivered = Promise.withResolvers<void>();
  const settlementDelivered = Promise.withResolvers<void>();
  const unsubscribe = observer.subscribeExecutionControl((event) => {
    if (
      event.type === "session.execution.claim.set" &&
      event.claim.actionId === claimKey(CONTROL_SPACE).actionId
    ) {
      claimDelivered.resolve();
    }
    if (event.type === "session.execution.settlement") {
      delivered.push(event.settlement);
      settlementDelivered.resolve();
    }
  });

  try {
    await sponsor.setExecutionDemand("", ["piece:one"]);
    const lease = await server.acquireExecutionLease(CONTROL_SPACE, "");
    if (lease === null) throw new Error("expected execution lease");
    const live = await server.setExecutionClaim(
      lease,
      claimKey(CONTROL_SPACE),
    );
    await withTimeout(
      claimDelivered.promise,
      "observer did not receive the live execution claim",
    );
    assertEquals(observer.executionClaims, [live]);

    transport.disconnect();
    await withTimeout(
      transport.reconnectStarted.promise,
      "observer reconnect did not start",
    );
    const settlement: ActionSettlement = {
      branch: "",
      claim: live,
      inputBasisSeq: toInputBasisSeq(0),
      outcome: "no-op",
    };
    assertEquals(server.publishActionSettlement(settlement), true);
    const noise = await server.setExecutionClaim(lease, {
      ...claimKey(CONTROL_SPACE),
      actionId: "action:noise",
    });
    assertEquals(server.revokeExecutionClaim(noise), true);
    transport.releaseReconnect();

    await withTimeout(
      settlementDelivered.promise,
      "evicted successful settlement frontier was not delivered",
    );
    assertEquals(delivered, [settlement]);
    assertEquals(observer.executionClaims, [live]);
  } finally {
    transport.releaseReconnect();
    unsubscribe();
    await observerClient.close();
    await sponsorClient.close();
    await server.close();
  }
});
