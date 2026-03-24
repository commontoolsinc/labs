import { assertEquals } from "@std/assert";
import { FakeTime } from "@std/testing/time";
import { Identity } from "@commontools/identity";
import type { URI } from "@commontools/memory/interface";
import * as MemoryV2Client from "@commontools/memory/v2/client";
import type { SessionSync, SessionSyncUpsert } from "@commontools/memory/v2";
import type { IStorageProviderWithReplica } from "../src/storage/interface.ts";
import {
  type Options as V2Options,
  type SessionFactory,
  StorageManager as V2StorageManager,
} from "../src/storage/v2.ts";

const signer = await Identity.fromPassphrase("memory-v2-watch-refresh-race");
const space = signer.did();

type TestProvider = IStorageProviderWithReplica & {
  get(uri: URI): { value: unknown } | undefined;
  sync(
    uri: URI,
    selector?: { path: string[]; schema: unknown },
  ): Promise<unknown>;
};

class SingleSessionFactory implements SessionFactory {
  client: MemoryV2Client.Client | null = null;

  constructor(private readonly transport: MemoryV2Client.Transport) {}

  async create(space: string) {
    if (this.client !== null) {
      throw new Error(`Session already created for ${space}`);
    }
    const client = await MemoryV2Client.connect({
      transport: this.transport,
    });
    const session = await client.mount(space);
    this.client = client;
    return { client, session };
  }
}

class TestStorageManager extends V2StorageManager {
  static create(options: V2Options, sessionFactory: SessionFactory) {
    return new TestStorageManager(options, sessionFactory);
  }

  private constructor(options: V2Options, sessionFactory: SessionFactory) {
    super(options, sessionFactory);
  }
}

class CountingWatchSetTransport implements MemoryV2Client.Transport {
  #receiver: (payload: string) => void = () => {};
  #closeReceiver: (error?: Error) => void = () => {};
  watchSetCount = 0;
  watchAddCount = 0;
  rootCounts: number[] = [];

  setReceiver(receiver: (payload: string) => void): void {
    this.#receiver = receiver;
  }

  setCloseReceiver(receiver: (error?: Error) => void): void {
    this.#closeReceiver = receiver;
  }

  send(payload: string): Promise<void> {
    const message = JSON.parse(payload) as {
      type: string;
      requestId?: string;
      watches?: Array<{
        query?: { roots?: Array<{ id: string }> };
      }>;
    };

    switch (message.type) {
      case "hello":
        this.#respond({
          type: "hello.ok",
          protocol: "memory/v2",
        });
        return Promise.resolve();
      case "session.open":
        this.#respond({
          type: "response",
          requestId: message.requestId!,
          ok: {
            sessionId: "session:watch-refresh-batch",
            serverSeq: 0,
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

  #respond(message: unknown): void {
    this.#receiver(JSON.stringify(message));
  }
}

class IncrementalEffectTransport implements MemoryV2Client.Transport {
  #receiver: (payload: string) => void = () => {};
  #closeReceiver: (error?: Error) => void = () => {};
  readonly #sessionId = "session:incremental-effect";
  readonly #space = space;

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
    const message = JSON.parse(payload) as {
      type: string;
      requestId?: string;
      watches?: Array<{
        query?: { roots?: Array<{ id: string }> };
      }>;
    };

    switch (message.type) {
      case "hello":
        this.#respond({
          type: "hello.ok",
          protocol: "memory/v2",
        });
        return Promise.resolve();
      case "session.open":
        this.#respond({
          type: "response",
          requestId: message.requestId!,
          ok: {
            sessionId: this.#sessionId,
            serverSeq: 0,
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

  #respond(message: unknown): void {
    this.#receiver(JSON.stringify(message));
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
    address: new URL("memory://runner-v2-watch-refresh-batch"),
    memoryVersion: "v2",
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
    address: new URL("memory://runner-v2-watch-refresh-compact"),
    memoryVersion: "v2",
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

Deno.test("memory v2 runner incrementally adds later watches after the initial set", async () => {
  const docA = `of:watch-add-a-${crypto.randomUUID()}` as URI;
  const docB = `of:watch-add-b-${crypto.randomUUID()}` as URI;
  const transport = new CountingWatchSetTransport();
  const sessionFactory = new SingleSessionFactory(transport);
  const storageManager = TestStorageManager.create({
    as: signer,
    address: new URL("memory://runner-v2-watch-add"),
    memoryVersion: "v2",
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

Deno.test("memory v2 runner resolves synced on a microtask when idle", async () => {
  const transport = new CountingWatchSetTransport();
  const sessionFactory = new SingleSessionFactory(transport);
  const storageManager = TestStorageManager.create({
    as: signer,
    address: new URL("memory://runner-v2-synced-microtask"),
    memoryVersion: "v2",
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
    address: new URL("memory://runner-v2-watch-delta"),
    memoryVersion: "v2",
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
