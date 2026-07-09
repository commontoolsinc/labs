import { assert, assertEquals } from "@std/assert";
import { Identity } from "@commonfabric/identity";
import type { FabricValue } from "@commonfabric/data-model/fabric-value";
import type { URI } from "@commonfabric/memory/interface";
import * as MemoryV2Client from "@commonfabric/memory/v2/client";
import {
  decodeMemoryBoundary,
  encodeMemoryBoundary,
  type EntityDocument,
  getMemoryProtocolFlags,
  type SessionSync,
  type SessionSyncUpsert,
} from "@commonfabric/memory/v2";
import type {
  IStorageProviderWithReplica,
  StorageNotification,
} from "../src/storage/interface.ts";
import {
  NotificationRecorder,
  SingleSessionFactory,
  TEST_HELLO_SESSION_OPEN,
  testSessionOpenAuthMetadata,
  TestStorageManager,
} from "./memory-v2-test-utils.ts";

const signer = await Identity.fromPassphrase("memory-v2-sync-under-pending");
const space = signer.did();
const DOCUMENT_MIME = "application/json" as const;
const HELLO_OK = {
  type: "hello.ok",
  protocol: "memory",
  flags: getMemoryProtocolFlags(),
  sessionOpen: TEST_HELLO_SESSION_OPEN,
} as const;

type TestProvider = IStorageProviderWithReplica & {
  get(uri: URI): EntityDocument | undefined;
  sync(
    uri: URI,
    selector?: { path: string[]; schema: unknown },
  ): Promise<unknown>;
};

const doc = (
  id: URI,
  seq: number,
  doc: SessionSyncUpsert["doc"],
): SessionSyncUpsert => ({
  branch: "",
  id,
  seq,
  doc,
});

const fullSync = (
  toSeq: number,
  upserts: SessionSyncUpsert[],
): SessionSync => ({
  type: "sync",
  fromSeq: 0,
  toSeq,
  upserts,
  removes: [],
});

const getObjectValue = (
  provider: TestProvider,
  uri: URI,
): Record<string, unknown> | undefined => {
  const value = provider.get(uri)?.value;
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
};

type HeldTransact = {
  requestId: string;
  operations: Array<{ op: string; id: string }>;
};

/**
 * Scripted transport that serves an initial doc snapshot on watch, HOLDS every
 * transact response until the test releases it, and can push server syncs
 * (session/effect) at any point in between. This is what lets a test interleave
 * "a foreign writer's sync arrives" with "our own commit is still in flight".
 */
class HeldTransactTransport implements MemoryV2Client.Transport {
  #receiver: (payload: string) => void = () => {};
  #closeReceiver: (error?: Error) => void = () => {};
  readonly #sessionId = "session:sync-under-pending";
  readonly #space = space;
  #sessionOpen = TEST_HELLO_SESSION_OPEN;
  #sessionOpenCount = 0;
  #held: HeldTransact | null = null;
  #transactSent = Promise.withResolvers<void>();

  constructor(
    private readonly docs: Map<URI, SessionSyncUpsert["doc"]>,
  ) {}

  setReceiver(receiver: (payload: string) => void): void {
    this.#receiver = receiver;
  }

  setCloseReceiver(receiver: (error?: Error) => void): void {
    this.#closeReceiver = receiver;
  }

  /** Resolves when a transact request has arrived (and is being held). */
  get transactSent(): Promise<void> {
    return this.#transactSent.promise;
  }

  send(payload: string): Promise<void> {
    const message = decodeMemoryBoundary(payload) as {
      type: string;
      requestId?: string;
      invocation?: { aud?: unknown; challenge?: unknown };
      commit?: { operations?: Array<{ op: string; id: string }> };
      watches?: Array<{
        query?: { roots?: Array<{ id: string }> };
      }>;
    };

    switch (message.type) {
      case "hello":
        this.#sessionOpen = testSessionOpenAuthMetadata(
          "sync-under-pending-hello",
        );
        this.#respond({
          ...HELLO_OK,
          sessionOpen: this.#sessionOpen,
        });
        return Promise.resolve();
      case "session.open":
        assertEquals(message.invocation?.aud, this.#sessionOpen.audience);
        assertEquals(
          message.invocation?.challenge,
          this.#sessionOpen.challenge.value,
        );
        this.#sessionOpen = testSessionOpenAuthMetadata(
          `sync-under-pending-open-${++this.#sessionOpenCount}`,
        );
        this.#respond({
          type: "response",
          requestId: message.requestId!,
          ok: {
            sessionId: this.#sessionId,
            serverSeq: 0,
            sessionOpen: this.#sessionOpen,
          },
        });
        return Promise.resolve();
      case "session.ack":
        this.#respond({
          type: "response",
          requestId: message.requestId!,
          ok: {
            serverSeq: 10,
          },
        });
        return Promise.resolve();
      case "session.watch.set":
      case "session.watch.add": {
        const roots =
          message.watches?.flatMap((watch) =>
            watch.query?.roots?.map((root) => root.id as URI) ?? []
          ) ?? [];
        this.#respond({
          type: "response",
          requestId: message.requestId!,
          ok: {
            serverSeq: roots.length,
            sync: fullSync(
              roots.length,
              roots.map((id) => doc(id, 1, this.docs.get(id))),
            ),
          },
        });
        return Promise.resolve();
      }
      case "transact": {
        if (this.#held !== null) {
          throw new Error("Test transport holds only one transact at a time");
        }
        this.#held = {
          requestId: message.requestId!,
          operations: message.commit?.operations ?? [],
        };
        this.#transactSent.resolve();
        return Promise.resolve();
      }
      default:
        throw new Error(`Unhandled scripted message: ${message.type}`);
    }
  }

  /** Acknowledge the held commit as applied at `seq`. */
  releaseTransact(seq: number): void {
    const held = this.#held;
    if (held === null) {
      throw new Error("No held transact to release");
    }
    this.#held = null;
    this.#transactSent = Promise.withResolvers<void>();
    this.#respond({
      type: "response",
      requestId: held.requestId,
      ok: {
        seq,
        branch: "",
        revisions: held.operations.map((operation, opIndex) => ({
          id: operation.id,
          branch: "",
          seq,
          opIndex,
          commitSeq: seq,
          op: operation.op,
        })),
      },
    });
  }

  emitSync(sync: SessionSync): void {
    this.#respond({
      type: "session/effect",
      space: this.#space,
      sessionId: this.#sessionId,
      effect: sync,
    });
  }

  close(): Promise<void> {
    this.#closeReceiver();
    return Promise.resolve();
  }

  #respond(message: FabricValue): void {
    this.#receiver(encodeMemoryBoundary(message));
  }
}

const notificationCarriesField = (
  notification: StorageNotification,
  uri: URI,
  key: string,
  expected: unknown,
): boolean =>
  "changes" in notification &&
  [...notification.changes].some((change) => {
    if (change.address.id !== uri) {
      return false;
    }
    const after = change.after as { value?: Record<string, unknown> } | null;
    return after != null && typeof after === "object" &&
      after.value != null && typeof after.value === "object" &&
      after.value[key] === expected;
  });

// The red/green/blue race: a local leaf write ("green") is committed and in
// flight (unconfirmed) when a foreign writer's server sync ("blue", which also
// changes a sibling field) arrives. applySessionSync must only advance the
// CONFIRMED base — the pending write replays on top, so the visible value keeps
// the local leaf while integrating the sibling change, exactly matching what
// the server computes when it later applies the patch on top of blue. The
// other guards then hold the line: confirming the commit promotes the merged
// value forward, and a late stale replay of blue can never regress it.
// (The individual guards are pinned elsewhere — the watch-refresh-race test
// covers monotonicity, the stacked-commit suite covers pending visibility —
// but this is the only test that delivers a foreign sync WHILE a commit is
// pending.)
Deno.test("memory v2 runner rebases a pending write over a sync arriving before its confirmation", async () => {
  const docA = `of:sync-under-pending-a-${crypto.randomUUID()}` as URI;
  const docB = `of:sync-under-pending-b-${crypto.randomUUID()}` as URI;
  const transport = new HeldTransactTransport(
    new Map([
      [docA, { value: { color: "red", note: "seed" } }],
      [docB, { value: { label: "seed" } }],
    ]),
  );
  const sessionFactory = new SingleSessionFactory(transport);
  const storageManager = TestStorageManager.create({
    as: signer,
    memoryHost: new URL("memory://runner-v2-sync-under-pending"),
  }, sessionFactory);
  const provider = storageManager.open(space) as TestProvider;
  const notifications = new NotificationRecorder();
  const firstIntegrate = Promise.withResolvers<void>();
  const secondIntegrate = Promise.withResolvers<void>();
  let integrations = 0;
  notifications.onNotification = (notification) => {
    if (notification.type === "integrate") {
      integrations += 1;
      if (integrations === 1) firstIntegrate.resolve();
      if (integrations === 2) secondIntegrate.resolve();
    }
  };
  storageManager.subscribe(notifications);

  try {
    await Promise.all([
      provider.sync(docA, { path: [], schema: false }),
      provider.sync(docB, { path: [], schema: false }),
    ]);
    assertEquals(getObjectValue(provider, docA), {
      color: "red",
      note: "seed",
    });

    // Local leaf write: color -> "green". The transact is held by the
    // transport, so the write sits in the pending overlay, unconfirmed.
    // Transaction paths address the document envelope, so the cell payload
    // lives under ["value", ...].
    const tx = storageManager.edit();
    const read = tx.read({ space, id: docA, type: DOCUMENT_MIME, path: [] });
    assert(read.ok, "seeded doc should be readable in the tx");
    const write = tx.write(
      { space, id: docA, type: DOCUMENT_MIME, path: ["value", "color"] },
      "green",
    );
    assert(write.ok, "leaf write should apply in the tx");
    const commitPromise = tx.commit();
    await transport.transactSent;
    assertEquals(getObjectValue(provider, docA), {
      color: "green",
      note: "seed",
    });

    // Foreign writer's sync lands while green is still pending: blue at a
    // newer confirmed seq, also rewriting the sibling `note` field. The
    // confirmed base must advance to blue with the pending green replayed on
    // top: sibling integrates, leaf stays green.
    transport.emitSync(fullSync(2, [doc(docA, 2, {
      value: { color: "blue", note: "remote" },
    })]));
    await firstIntegrate.promise;
    assertEquals(getObjectValue(provider, docA), {
      color: "green",
      note: "remote",
    });

    // The replica must never have surfaced blue at the leaf — not even
    // transiently in a notification.
    assert(
      !notifications.notifications.some((notification) =>
        notificationCarriesField(notification, docA, "color", "blue")
      ),
      "no notification should carry the foreign leaf value under the pending write",
    );

    // The server (which accepted the blind leaf write on top of blue — the
    // structural parent precondition does not conflict with a leaf write)
    // acknowledges the commit at the next seq. confirmPending promotes the
    // merged value into the confirmed base; the visible value is unchanged.
    transport.releaseTransact(3);
    const result = await commitPromise;
    assert(!result.error, `commit should confirm cleanly: ${result.error}`);
    assertEquals(getObjectValue(provider, docA), {
      color: "green",
      note: "remote",
    });

    // A stale watch refresh replaying blue (doc seq 2, below the promoted
    // confirmed seq 3) must be skipped by the monotonic guard. A guard-skipped
    // sync emits no notification, so a follow-up fresh sync on docB is the
    // barrier proving the stale one was fully processed (syncs apply in
    // order).
    transport.emitSync(fullSync(4, [doc(docA, 2, {
      value: { color: "blue", note: "remote" },
    })]));
    transport.emitSync(fullSync(5, [doc(docB, 6, {
      value: { label: "barrier" },
    })]));
    await secondIntegrate.promise;
    assertEquals(getObjectValue(provider, docB), { label: "barrier" });
    assertEquals(getObjectValue(provider, docA), {
      color: "green",
      note: "remote",
    });
  } finally {
    storageManager.unsubscribe(notifications);
    await storageManager.close();
  }
});
