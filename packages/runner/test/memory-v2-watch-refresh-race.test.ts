import { assertEquals } from "@std/assert";
import { FakeTime } from "@std/testing/time";
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
import type { IStorageProviderWithReplica } from "../src/storage/interface.ts";
import {
  SingleSessionFactory,
  TEST_HELLO_SESSION_OPEN,
  testSessionOpenAuthMetadata,
  TestStorageManager,
} from "./memory-v2-test-utils.ts";

const signer = await Identity.fromPassphrase("memory-v2-watch-refresh-race");
const space = signer.did();
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

class CountingWatchSetTransport implements MemoryV2Client.Transport {
  #receiver: (payload: string) => void = () => {};
  #closeReceiver: (error?: Error) => void = () => {};
  watchSetCount = 0;
  watchAddCount = 0;
  rootCounts: number[] = [];
  #sessionOpen = TEST_HELLO_SESSION_OPEN;
  #sessionOpenCount = 0;

  setReceiver(receiver: (payload: string) => void): void {
    this.#receiver = receiver;
  }

  setCloseReceiver(receiver: (error?: Error) => void): void {
    this.#closeReceiver = receiver;
  }

  send(payload: string): Promise<void> {
    const message = decodeMemoryBoundary(payload) as {
      type: string;
      requestId?: string;
      invocation?: { aud?: unknown; challenge?: unknown };
      watches?: Array<{
        query?: { roots?: Array<{ id: string }> };
      }>;
    };

    switch (message.type) {
      case "hello":
        this.#sessionOpen = testSessionOpenAuthMetadata(
          "watch-refresh-batch-hello",
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
          `watch-refresh-batch-open-${++this.#sessionOpenCount}`,
        );
        this.#respond({
          type: "response",
          requestId: message.requestId!,
          ok: {
            sessionId: "session:watch-refresh-batch",
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
            serverSeq: 3,
          },
        });
        return Promise.resolve();
      case "session.watch.set":
      case "session.watch.add": {
        const roots =
          message.watches?.flatMap((watch) =>
            watch.query?.roots?.map((root) => root.id) ?? []
          ) ?? [];

        if (message.type === "session.watch.set") {
          this.watchSetCount += 1;
        } else {
          this.watchAddCount += 1;
        }
        this.rootCounts.push(roots.length);

        this.#respond({
          type: "response",
          requestId: message.requestId!,
          ok: {
            serverSeq: roots.length,
            sync: fullSync(
              roots.length,
              roots.map((id, index) =>
                doc(id as URI, index + 1, { value: { label: id } })
              ),
            ),
          },
        });
        return Promise.resolve();
      }
      default:
        throw new Error(`Unhandled scripted message: ${message.type}`);
    }
  }

  close(): Promise<void> {
    this.#closeReceiver();
    return Promise.resolve();
  }

  #respond(message: FabricValue): void {
    this.#receiver(encodeMemoryBoundary(message));
  }
}

class DelayedWatchAddTransport implements MemoryV2Client.Transport {
  #receiver: (payload: string) => void = () => {};
  #closeReceiver: (error?: Error) => void = () => {};
  readonly firstWatchAddSent = Promise.withResolvers<void>();
  readonly releaseFirstWatchAdd = Promise.withResolvers<
    SessionSyncUpsert["doc"]
  >();
  watchAddCount = 0;
  rootCounts: number[] = [];
  #sessionOpen = TEST_HELLO_SESSION_OPEN;
  #sessionOpenCount = 0;

  setReceiver(receiver: (payload: string) => void): void {
    this.#receiver = receiver;
  }

  setCloseReceiver(receiver: (error?: Error) => void): void {
    this.#closeReceiver = receiver;
  }

  send(payload: string): Promise<void> {
    const message = decodeMemoryBoundary(payload) as {
      type: string;
      requestId?: string;
      invocation?: { aud?: unknown; challenge?: unknown };
      watches?: Array<{
        query?: { roots?: Array<{ id: string }> };
      }>;
    };

    switch (message.type) {
      case "hello":
        this.#sessionOpen = testSessionOpenAuthMetadata(
          "delayed-watch-add-hello",
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
          `delayed-watch-add-open-${++this.#sessionOpenCount}`,
        );
        this.#respond({
          type: "response",
          requestId: message.requestId!,
          ok: {
            sessionId: "session:delayed-watch-add",
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
      case "session.watch.add": {
        this.watchAddCount += 1;
        const roots =
          message.watches?.flatMap((watch) =>
            watch.query?.roots?.map((root) => root.id as URI) ?? []
          ) ?? [];
        this.rootCounts.push(roots.length);

        if (this.watchAddCount === 1) {
          this.firstWatchAddSent.resolve();
          void this.releaseFirstWatchAdd.promise.then((docValue) => {
            this.#respond({
              type: "response",
              requestId: message.requestId!,
              ok: {
                serverSeq: 1,
                sync: fullSync(1, [doc(roots[0], 1, docValue)]),
              },
            });
          });
          return Promise.resolve();
        }

        this.#respond({
          type: "response",
          requestId: message.requestId!,
          ok: {
            serverSeq: roots.length + 1,
            sync: fullSync(
              roots.length + 1,
              roots.map((id, index) =>
                doc(id, index + 2, { value: { label: id } })
              ),
            ),
          },
        });
        return Promise.resolve();
      }
      default:
        throw new Error(`Unhandled scripted message: ${message.type}`);
    }
  }

  close(): Promise<void> {
    this.#closeReceiver();
    return Promise.resolve();
  }

  #respond(message: FabricValue): void {
    this.#receiver(encodeMemoryBoundary(message));
  }
}

class IncrementalEffectTransport implements MemoryV2Client.Transport {
  #receiver: (payload: string) => void = () => {};
  #closeReceiver: (error?: Error) => void = () => {};
  readonly #sessionId = "session:incremental-effect";
  readonly #space = space;
  #sessionOpen = TEST_HELLO_SESSION_OPEN;
  #sessionOpenCount = 0;

  constructor(
    private readonly docs: Map<URI, SessionSyncUpsert["doc"]>,
  ) {}

  setReceiver(receiver: (payload: string) => void): void {
    this.#receiver = receiver;
  }

  setCloseReceiver(receiver: (error?: Error) => void): void {
    this.#closeReceiver = receiver;
  }

  send(payload: string): Promise<void> {
    const message = decodeMemoryBoundary(payload) as {
      type: string;
      requestId?: string;
      invocation?: { aud?: unknown; challenge?: unknown };
      watches?: Array<{
        query?: { roots?: Array<{ id: string }> };
      }>;
    };

    switch (message.type) {
      case "hello":
        this.#sessionOpen = testSessionOpenAuthMetadata(
          "incremental-effect-hello",
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
          `incremental-effect-open-${++this.#sessionOpenCount}`,
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
              roots.map((id, index) => doc(id, index + 1, this.docs.get(id))),
            ),
          },
        });
        return Promise.resolve();
      }
      default:
        throw new Error(`Unhandled scripted message: ${message.type}`);
    }
  }

  close(): Promise<void> {
    this.#closeReceiver();
    return Promise.resolve();
  }

  emitSync(sync: SessionSync): void {
    this.#respond({
      type: "session/effect",
      space: this.#space,
      sessionId: this.#sessionId,
      effect: sync,
    });
  }

  #respond(message: FabricValue): void {
    this.#receiver(encodeMemoryBoundary(message));
  }
}

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

Deno.test("memory v2 runner batches concurrent watch refreshes", async () => {
  const docA = `of:watch-batch-a-${crypto.randomUUID()}` as URI;
  const docB = `of:watch-batch-b-${crypto.randomUUID()}` as URI;
  const docC = `of:watch-batch-c-${crypto.randomUUID()}` as URI;
  const transport = new CountingWatchSetTransport();
  const sessionFactory = new SingleSessionFactory(transport);
  const storageManager = TestStorageManager.create({
    as: signer,
    memoryHost: new URL("memory://runner-v2-watch-refresh-batch"),
  }, sessionFactory);
  const provider = storageManager.open(space) as TestProvider;

  try {
    await Promise.all([
      provider.sync(docA, { path: [], schema: false }),
      provider.sync(docB, { path: [], schema: false }),
      provider.sync(docC, { path: [], schema: false }),
    ]);

    assertEquals(transport.watchSetCount, 0);
    assertEquals(transport.watchAddCount, 1);
    assertEquals(transport.rootCounts, [3]);
    assertEquals(getObjectValue(provider, docA), { label: docA });
    assertEquals(getObjectValue(provider, docB), { label: docB });
    assertEquals(getObjectValue(provider, docC), { label: docC });
  } finally {
    await storageManager.close();
  }
});

Deno.test("memory v2 runner compacts redundant selectors for the same doc", async () => {
  const docA = `of:watch-compact-a-${crypto.randomUUID()}` as URI;
  const transport = new CountingWatchSetTransport();
  const sessionFactory = new SingleSessionFactory(transport);
  const storageManager = TestStorageManager.create({
    as: signer,
    memoryHost: new URL("memory://runner-v2-watch-refresh-compact"),
  }, sessionFactory);
  const provider = storageManager.open(space) as TestProvider;

  try {
    await Promise.all([
      provider.sync(docA, {
        path: [],
        schema: {
          type: "object",
          properties: {
            child: {
              type: "object",
              properties: {
                label: { type: "string" },
              },
            },
          },
        },
      }),
      provider.sync(docA, {
        path: ["child", "label"],
        schema: { type: "string" },
      }),
    ]);

    assertEquals(transport.watchSetCount, 0);
    assertEquals(transport.watchAddCount, 1);
    assertEquals(transport.rootCounts, [1]);
    assertEquals(getObjectValue(provider, docA), { label: docA });
  } finally {
    await storageManager.close();
  }
});

Deno.test("memory v2 runner deduplicates semantically identical selectors with reordered schema keys", async () => {
  const docA = `of:watch-compact-order-${crypto.randomUUID()}` as URI;
  const transport = new CountingWatchSetTransport();
  const sessionFactory = new SingleSessionFactory(transport);
  const storageManager = TestStorageManager.create({
    as: signer,
    memoryHost: new URL("memory://runner-v2-watch-refresh-order"),
  }, sessionFactory);
  const provider = storageManager.open(space) as TestProvider;

  try {
    await Promise.all([
      provider.sync(docA, {
        path: [],
        schema: {
          type: "object",
          properties: {
            child: {
              type: "string",
            },
          },
        },
      }),
      provider.sync(docA, {
        schema: {
          properties: {
            child: {
              type: "string",
            },
          },
          type: "object",
        },
        path: [],
      }),
    ]);

    assertEquals(transport.watchAddCount, 1);
    assertEquals(transport.rootCounts, [1]);
  } finally {
    await storageManager.close();
  }
});

Deno.test("memory v2 runner incrementally adds later watches after the initial set", async () => {
  const docA = `of:watch-add-a-${crypto.randomUUID()}` as URI;
  const docB = `of:watch-add-b-${crypto.randomUUID()}` as URI;
  const transport = new CountingWatchSetTransport();
  const sessionFactory = new SingleSessionFactory(transport);
  const storageManager = TestStorageManager.create({
    as: signer,
    memoryHost: new URL("memory://runner-v2-watch-add"),
  }, sessionFactory);
  const provider = storageManager.open(space) as TestProvider;

  try {
    await provider.sync(docA, { path: [], schema: false });
    await provider.sync(docB, { path: [], schema: false });

    assertEquals(transport.watchSetCount, 0);
    assertEquals(transport.watchAddCount, 2);
    assertEquals(transport.rootCounts, [1, 1]);
    assertEquals(getObjectValue(provider, docA), { label: docA });
    assertEquals(getObjectValue(provider, docB), { label: docB });
  } finally {
    await storageManager.close();
  }
});

Deno.test("memory v2 runner does not resend prior pending watches in later batches", async () => {
  const docA = `of:watch-delta-a-${crypto.randomUUID()}` as URI;
  const docB = `of:watch-delta-b-${crypto.randomUUID()}` as URI;
  const transport = new DelayedWatchAddTransport();
  const sessionFactory = new SingleSessionFactory(transport);
  const storageManager = TestStorageManager.create({
    as: signer,
    memoryHost: new URL("memory://runner-v2-watch-add-delta"),
  }, sessionFactory);
  const provider = storageManager.open(space) as TestProvider;

  try {
    const firstSync = provider.sync(docA, { path: [], schema: false });
    await transport.firstWatchAddSent.promise;

    const secondSync = provider.sync(docB, { path: [], schema: false });
    transport.releaseFirstWatchAdd.resolve({ value: { label: docA } });

    await Promise.all([firstSync, secondSync]);

    assertEquals(transport.watchAddCount, 2);
    assertEquals(transport.rootCounts, [1, 1]);
    assertEquals(getObjectValue(provider, docA), { label: docA });
    assertEquals(getObjectValue(provider, docB), { label: docB });
  } finally {
    await storageManager.close();
  }
});

Deno.test("memory v2 runner resolves synced on a microtask when idle", async () => {
  const transport = new CountingWatchSetTransport();
  const sessionFactory = new SingleSessionFactory(transport);
  const storageManager = TestStorageManager.create({
    as: signer,
    memoryHost: new URL("memory://runner-v2-synced-microtask"),
  }, sessionFactory);
  using time = new FakeTime();

  try {
    let settled = false;
    const synced = storageManager.synced().then(() => {
      settled = true;
    });
    await time.runMicrotasks();

    assertEquals(settled, true);
    await synced;
  } finally {
    await storageManager.close();
  }
});

Deno.test(
  "memory v2 runner waits for cross-space syncs registered later in the same turn",
  async () => {
    const transport = new CountingWatchSetTransport();
    const sessionFactory = new SingleSessionFactory(transport);
    const storageManager = TestStorageManager.create({
      as: signer,
      memoryHost: new URL("memory://runner-v2-synced-cross-space"),
    }, sessionFactory);
    using time = new FakeTime();

    try {
      let settled = false;
      const crossSpace = Promise.withResolvers<void>();
      let trackedPromise: Promise<void> | undefined;
      const synced = storageManager.synced().then(() => {
        settled = true;
      });

      queueMicrotask(() => {
        trackedPromise = crossSpace.promise.finally(() => {
          if (trackedPromise) {
            storageManager.removeCrossSpacePromise(trackedPromise);
          }
        });
        storageManager.addCrossSpacePromise(trackedPromise);
      });

      await time.runMicrotasks();
      assertEquals(settled, false);

      crossSpace.resolve();
      await time.runMicrotasks();
      assertEquals(settled, true);
      await synced;
    } finally {
      await storageManager.close();
    }
  },
);

Deno.test("memory v2 runner integrates watch deltas without re-diffing cold watched docs", async () => {
  const docA = `of:watch-delta-a-${crypto.randomUUID()}` as URI;
  const docB = `of:watch-delta-b-${crypto.randomUUID()}` as URI;
  const docC = `of:watch-delta-c-${crypto.randomUUID()}` as URI;
  const transport = new IncrementalEffectTransport(
    new Map([
      [docA, { value: { label: docA } }],
      [docB, { value: { label: docB } }],
      [docC, { value: { label: docC } }],
    ]),
  );
  const sessionFactory = new SingleSessionFactory(transport);
  const storageManager = TestStorageManager.create({
    as: signer,
    memoryHost: new URL("memory://runner-v2-watch-delta"),
  }, sessionFactory);
  const provider = storageManager.open(space) as TestProvider;

  try {
    await Promise.all([
      provider.sync(docA, { path: [], schema: false }),
      provider.sync(docB, { path: [], schema: false }),
      provider.sync(docC, { path: [], schema: false }),
    ]);

    const replica = provider.replica as typeof provider.replica & {
      get: typeof provider.replica.get;
    };
    const originalGet = replica.get.bind(replica);
    const touched = new Set<URI>();
    let recording = false;
    replica.get = ((entry) => {
      if (recording && entry.type === "application/json") {
        touched.add(entry.id as URI);
      }
      return originalGet(entry);
    }) as typeof replica.get;

    const integrated = Promise.withResolvers<void>();
    const subscription = {
      next(notification: { type: string }) {
        if (recording && notification.type === "integrate") {
          integrated.resolve();
        }
        return undefined;
      },
    };
    storageManager.subscribe(subscription);
    recording = true;
    transport.emitSync(fullSync(4, [doc(docA, 4, {
      value: {
        label: "updated",
      },
    })]));

    await integrated.promise;
    recording = false;
    storageManager.unsubscribe(subscription);

    assertEquals(touched.has(docA), true);
    assertEquals(touched.has(docB), false);
    assertEquals(touched.has(docC), false);
    assertEquals(getObjectValue(provider, docA), { label: "updated" });
    assertEquals(getObjectValue(provider, docB), { label: docB });
    assertEquals(getObjectValue(provider, docC), { label: docC });
  } finally {
    await storageManager.close();
  }
});

Deno.test("memory v2 runner never moves a confirmed doc backwards on a stale watch refresh", async () => {
  // Watch refreshes can arrive after local confirmations; an upsert whose
  // seq is below the confirmed base must be skipped (pending replay depends
  // on monotonic bases). Pins the applySessionSync guard directly — its
  // only other coverage was an incidental race in unrelated tests.
  const docA = `of:watch-stale-a-${crypto.randomUUID()}` as URI;
  const docB = `of:watch-stale-b-${crypto.randomUUID()}` as URI;
  const transport = new IncrementalEffectTransport(
    new Map([
      [docA, { value: { label: docA } }],
      [docB, { value: { label: docB } }],
    ]),
  );
  const sessionFactory = new SingleSessionFactory(transport);
  const storageManager = TestStorageManager.create({
    as: signer,
    memoryHost: new URL("memory://runner-v2-watch-stale"),
  }, sessionFactory);
  const provider = storageManager.open(space) as TestProvider;

  try {
    await Promise.all([
      provider.sync(docA, { path: [], schema: false }),
      provider.sync(docB, { path: [], schema: false }),
    ]);
    assertEquals(getObjectValue(provider, docA), { label: docA });

    let integrations = 0;
    const first = Promise.withResolvers<void>();
    const second = Promise.withResolvers<void>();
    const subscription = {
      next(notification: { type: string }) {
        if (notification.type === "integrate") {
          integrations += 1;
          if (integrations === 1) first.resolve();
          if (integrations === 2) second.resolve();
        }
        return undefined;
      },
    };
    storageManager.subscribe(subscription);

    // Fresh refresh: moves the confirmed base forward.
    transport.emitSync(fullSync(4, [doc(docA, 4, {
      value: { label: "updated" },
    })]));
    await first.promise;
    assertEquals(getObjectValue(provider, docA), { label: "updated" });

    // Stale refresh: a newer sync envelope replaying an OLD snapshot of the
    // doc. The upsert's seq (2) is below the confirmed base (4) — it must
    // not move the base backwards or resurface the old value. A guard-
    // skipped sync changes nothing, so it emits no notification of its own;
    // the follow-up fresh sync on docB is the barrier — syncs apply in
    // order, so its integrate proves the stale one was fully processed.
    transport.emitSync(fullSync(5, [doc(docA, 2, {
      value: { label: "stale" },
    })]));
    transport.emitSync(fullSync(6, [doc(docB, 6, {
      value: { label: "barrier" },
    })]));
    await second.promise;
    storageManager.unsubscribe(subscription);

    assertEquals(getObjectValue(provider, docB), { label: "barrier" });
    assertEquals(getObjectValue(provider, docA), { label: "updated" });
  } finally {
    await storageManager.close();
  }
});

Deno.test("memory v2 runner applies watch remove syncs to confirmed docs", async () => {
  const docA = `of:watch-remove-a-${crypto.randomUUID()}` as URI;
  const docB = `of:watch-remove-b-${crypto.randomUUID()}` as URI;
  const transport = new IncrementalEffectTransport(
    new Map([
      [docA, { value: { label: docA } }],
      [docB, { value: { label: docB } }],
    ]),
  );
  const sessionFactory = new SingleSessionFactory(transport);
  const storageManager = TestStorageManager.create({
    as: signer,
    memoryHost: new URL("memory://runner-v2-watch-remove"),
  }, sessionFactory);
  const provider = storageManager.open(space) as TestProvider;

  try {
    await Promise.all([
      provider.sync(docA, { path: [], schema: false }),
      provider.sync(docB, { path: [], schema: false }),
    ]);
    assertEquals(getObjectValue(provider, docA), { label: docA });
    assertEquals(getObjectValue(provider, docB), { label: docB });

    const integrated = Promise.withResolvers<void>();
    const subscription = {
      next(notification: { type: string }) {
        if (notification.type === "integrate") {
          integrated.resolve();
        }
        return undefined;
      },
    };
    storageManager.subscribe(subscription);
    transport.emitSync({
      type: "sync",
      fromSeq: 2,
      toSeq: 3,
      upserts: [],
      removes: [{
        branch: "",
        id: docB,
      }],
    });

    await integrated.promise;
    storageManager.unsubscribe(subscription);

    assertEquals(getObjectValue(provider, docA), { label: docA });
    assertEquals(provider.get(docB), undefined);
  } finally {
    await storageManager.close();
  }
});
