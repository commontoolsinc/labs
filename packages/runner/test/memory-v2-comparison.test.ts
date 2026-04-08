import { assertEquals, assertExists } from "@std/assert";
import { toFileUrl } from "@std/path";
import { Identity } from "@commonfabric/identity";
import type { FabricValue, URI } from "@commonfabric/memory/interface";
import * as Consumer from "@commonfabric/memory/consumer";
import * as MemoryProvider from "@commonfabric/memory/provider";
import type { EntityDocument } from "@commonfabric/memory/v2";
import * as MemoryV2Client from "@commonfabric/memory/v2/client";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";
import { Provider, StorageManager } from "../src/storage/cache.deno.ts";
import type { StorageNotification } from "../src/storage/interface.ts";
import { createGraphFixture } from "./memory-v2-graph.fixture.ts";
import * as StorageSubscription from "../src/storage/subscription.ts";
import {
  type Options as V2Options,
  type SessionFactory,
  StorageManager as V2StorageManager,
} from "../src/storage/v2.ts";

type TestProvider = {
  get(uri: URI): EntityDocument | undefined;
  send(
    batch: { uri: URI; value: EntityDocument | undefined }[],
  ): Promise<
    {
      ok?: Record<PropertyKey, never>;
      error?: { name?: string; message?: string };
    }
  >;
  sync(
    uri: URI,
    selector: { path: string[]; schema: unknown },
  ): Promise<
    {
      ok?: Record<PropertyKey, never>;
      error?: { name?: string; message?: string };
    }
  >;
  destroy(): Promise<void>;
};

type LegacyComparisonProvider = {
  send(
    batch: { uri: URI; value: { value: FabricValue | undefined } }[],
  ): Promise<
    {
      ok?: Record<PropertyKey, never>;
      error?: { name?: string; message?: string };
    }
  >;
};

type PersistentProviders = {
  writer: TestProvider;
  observer: TestProvider;
  notifications: NotificationRecorder;
  queryGraph?: () => Promise<Record<string, unknown>>;
  close(): Promise<void>;
};

const signer = await Identity.fromPassphrase("memory-v2-comparison");
const space = signer.did();

const mulberry32 = (seed: number) => {
  let current = seed >>> 0;
  return () => {
    current |= 0;
    current = (current + 0x6d2b79f5) | 0;
    let t = Math.imul(current ^ (current >>> 15), 1 | current);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const randomInt = (random: () => number, maxExclusive: number) =>
  Math.floor(random() * maxExclusive);

const randomValue = (random: () => number, step: number) => ({
  step,
  flag: random() > 0.5,
  text: `value-${step}-${randomInt(random, 1000)}`,
  nested: {
    count: randomInt(random, 10),
    label: `nested-${randomInt(random, 100)}`,
  },
  list: Array.from(
    { length: randomInt(random, 4) + 1 },
    () => randomInt(random, 50),
  ),
});

class NotificationRecorder {
  notifications: StorageNotification[] = [];

  next(notification: StorageNotification) {
    this.notifications.push(notification);
    return { done: false };
  }

  clear(): void {
    this.notifications = [];
  }
}

class LoopbackSessionFactory implements SessionFactory {
  constructor(private readonly server: MemoryV2Server.Server) {}

  async create(space: string) {
    const client = await MemoryV2Client.connect({
      transport: MemoryV2Client.loopback(this.server),
    });
    const session = await client.mount(space);
    return { client, session };
  }
}

class TestV2StorageManager extends V2StorageManager {
  static create(options: V2Options, sessionFactory: SessionFactory) {
    return new TestV2StorageManager(options, sessionFactory);
  }

  private constructor(options: V2Options, sessionFactory: SessionFactory) {
    super(options, sessionFactory);
  }
}

const waitFor = async (
  predicate: () => boolean,
  timeout = 500,
) => {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeout) {
      throw new Error("Timed out waiting for graph state");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

const waitForAsync = async (
  predicate: () => Promise<boolean>,
  timeout = 500,
) => {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > timeout) {
      throw new Error("Timed out waiting for graph state");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

const visibleGraphIds = (
  provider: TestProvider,
  ids: readonly URI[],
) => ids.filter((id) => provider.get(id)?.value !== undefined).sort();

const visibleGraphState = (
  provider: TestProvider,
  ids: readonly URI[],
) =>
  Object.fromEntries(
    ids
      .filter((id) => provider.get(id)?.value !== undefined)
      .sort()
      .map((id) => [id, normalizeValue(provider.get(id))]),
  );

const containsExpectedGraphState = (
  provider: TestProvider,
  expected: Record<string, unknown>,
): boolean =>
  Object.entries(expected).every(([id, value]) =>
    JSON.stringify(normalizeValue(provider.get(id as URI))) ===
      JSON.stringify(value)
  );

const normalizeValue = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeValue(entry));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .map(([key, entry]) => [key, normalizeValue(entry)]),
    );
  }
  return value;
};

const normalizedGraphNotifications = (
  notifications: StorageNotification[],
  trackedIds: readonly URI[],
) => {
  const allowed = new Set(trackedIds);
  const grouped = new Map<"pull" | "integrate", Set<URI>>();

  for (const notification of notifications) {
    if (notification.type !== "pull" && notification.type !== "integrate") {
      continue;
    }
    let ids = grouped.get(notification.type);
    if (!ids) {
      ids = new Set();
      grouped.set(notification.type, ids);
    }
    if (!("changes" in notification)) {
      continue;
    }
    for (const change of notification.changes) {
      if (allowed.has(change.address.id)) {
        ids.add(change.address.id as URI);
      }
    }
  }

  return [...grouped.entries()]
    .map(([type, ids]) => ({
      type,
      ids: [...ids].sort(),
    }))
    .filter((notification) => notification.ids.length > 0);
};

const sendDocs = async (
  provider: TestProvider,
  docs: Array<{ id: URI; value: FabricValue }>,
) => {
  for (const doc of docs) {
    assertEquals(
      await provider.sync(doc.id, { path: [], schema: false }),
      { ok: {} },
    );
  }
  assertEquals(
    await provider.send(
      docs.map((doc) => ({
        uri: doc.id,
        value: { value: doc.value },
      })),
    ),
    { ok: {} },
  );
};

const createStore = async () => {
  const dir = await Deno.makeTempDir({
    prefix: "memory-v2-comparison-",
  });
  await Deno.mkdir(`${dir}/v2`, { recursive: true });
  return {
    dir,
    url: toFileUrl(`${dir}/`),
  };
};

const removeStore = async (dir: string) => {
  await Deno.remove(dir, { recursive: true }).catch(() => {});
};

const createPersistentProviders = async (
  memoryVersion: "v1" | "v2",
  store: URL,
): Promise<PersistentProviders> => {
  if (memoryVersion === "v1") {
    const opened = await MemoryProvider.open({
      store,
      serviceDid: signer.did(),
    });
    if (opened.error) {
      throw opened.error;
    }
    const memoryProvider = opened.ok;
    const writerSession = Consumer.open({
      as: signer,
      session: memoryProvider.session(),
    });
    const observerSession = Consumer.open({
      as: signer,
      session: memoryProvider.session(),
    });
    const writerSubscription = StorageSubscription.create();
    const observerSubscription = StorageSubscription.create();
    const writer = Provider.open({
      session: writerSession,
      subscription: writerSubscription,
      space,
      memoryVersion,
    }) as unknown as TestProvider;
    const observer = Provider.open({
      session: observerSession,
      subscription: observerSubscription,
      space,
      memoryVersion,
    }) as unknown as TestProvider;
    const notifications = new NotificationRecorder();
    observerSubscription.subscribe(notifications);

    return {
      writer,
      observer,
      notifications,
      close: async () => {
        await writer.destroy();
        await observer.destroy();
        writerSession.close();
        observerSession.close();
        await writerSession.closed;
        await observerSession.closed;
        memoryProvider.disposeSessions();
        await memoryProvider.close();
      },
    };
  }

  const server = new MemoryV2Server.Server({ store });
  const sessionFactory = new LoopbackSessionFactory(server);
  const writerManager = TestV2StorageManager.create({
    as: signer,
    address: new URL(`memory://writer-${crypto.randomUUID()}`),
    memoryVersion: "v2",
  }, sessionFactory);
  const observerManager = TestV2StorageManager.create({
    as: signer,
    address: new URL(`memory://observer-${crypto.randomUUID()}`),
    memoryVersion: "v2",
  }, sessionFactory);
  const notifications = new NotificationRecorder();
  observerManager.subscribe(notifications);

  return {
    writer: writerManager.open(space) as unknown as TestProvider,
    observer: observerManager.open(space) as unknown as TestProvider,
    notifications,
    queryGraph: async () => {
      const result = await server.evaluateGraphQuery(space, {
        roots: [{
          id: createGraphFixture(space).rootId,
          selector: {
            path: [],
            schema: createGraphFixture(space).schema,
          },
        }],
      });
      return Object.fromEntries(
        result.entities
          .filter((entity) => entity.document !== null)
          .sort((left, right) => left.id.localeCompare(right.id))
          .map((entity) => [entity.id, normalizeValue(entity.document)]),
      );
    },
    close: async () => {
      await writerManager.close();
      await observerManager.close();
      await server.close();
    },
  };
};

const runGraphExpansion = async (
  memoryVersion: "v1" | "v2",
) => {
  const store = await createStore();
  const fixture = createGraphFixture(space);
  const seed = await createPersistentProviders(memoryVersion, store.url);
  let shared: PersistentProviders | undefined;

  try {
    await sendDocs(seed.writer, fixture.docs);
    await seed.close();
    shared = await createPersistentProviders(memoryVersion, store.url);
    if (!shared) {
      throw new Error("Failed to reopen persistent comparison providers");
    }
    const active = shared;
    active.notifications.clear();

    assertEquals(
      await active.observer.sync(fixture.rootId, {
        path: [],
        schema: fixture.schema,
      }),
      { ok: {} },
    );
    await waitFor(() =>
      visibleGraphIds(active.observer, fixture.expandedReachableIds).length ===
        fixture.initialReachableIds.length
    );

    const initialState = visibleGraphState(
      active.observer,
      fixture.expandedReachableIds,
    );
    const initialNotifications = normalizedGraphNotifications(
      active.notifications.notifications,
      fixture.expandedReachableIds,
    );
    active.notifications.clear();

    assertEquals(
      visibleGraphIds(active.observer, fixture.expandedReachableIds),
      fixture.initialReachableIds,
    );

    await sendDocs(active.writer, [{
      id: fixture.rootId,
      value: fixture.expandedRootValue,
    }]);
    await waitFor(() =>
      visibleGraphIds(active.observer, fixture.expandedReachableIds).length ===
        fixture.expandedReachableIds.length
    );

    return {
      close: async () => {
        await active.close();
        await removeStore(store.dir);
      },
      initialState,
      expandedState: visibleGraphState(
        active.observer,
        fixture.expandedReachableIds,
      ),
      initialNotifications,
      expandedNotifications: normalizedGraphNotifications(
        active.notifications.notifications,
        fixture.expandedReachableIds,
      ),
      fixture,
    };
  } catch (error) {
    await seed.close().catch(() => {});
    await shared?.close().catch(() => {});
    await removeStore(store.dir);
    throw error;
  }
};

Deno.test("memory v2 matches v1 provider-visible behavior for a randomized basic workload", async () => {
  const signer = await Identity.fromPassphrase("memory-v2-comparison");
  const space = signer.did();
  const v1 = StorageManager.emulate({ as: signer, memoryVersion: "v1" });
  const v2 = StorageManager.emulate({ as: signer, memoryVersion: "v2" });
  const v1Provider = v1.open(space) as unknown as TestProvider;
  const v2Provider = v2.open(space) as unknown as TestProvider;
  const random = mulberry32(0x5eedc0de);
  const uris = Array.from(
    { length: 6 },
    (_, index) => `of:memory-v2-compare-${index}` as const,
  );

  try {
    for (let step = 0; step < 40; step++) {
      const uri = uris[randomInt(random, uris.length)];
      const shouldDelete = random() < 0.25;
      const value = shouldDelete ? undefined : randomValue(random, step);
      const v1Batch = [{ uri, value: { value } }];
      const v2Batch = [{
        uri,
        value: shouldDelete ? undefined : { value },
      }];

      assertEquals(
        await (v1Provider as unknown as LegacyComparisonProvider).send(v1Batch),
        { ok: {} },
      );
      assertEquals(await v2Provider.send(v2Batch), { ok: {} });

      for (const currentUri of uris) {
        assertEquals(v2Provider.get(currentUri), v1Provider.get(currentUri));
      }
    }
  } finally {
    await v1.close();
    await v2.close();
  }
});

Deno.test(
  "memory v2 matches v1 for 64-node graph expansion across sessions",
  async () => {
    const v1 = await runGraphExpansion("v1");
    const v2 = await runGraphExpansion("v2");

    try {
      assertEquals(
        v2.fixture.initialReachableIds,
        v1.fixture.initialReachableIds,
      );
      assertEquals(
        v2.fixture.expandedReachableIds,
        v1.fixture.expandedReachableIds,
      );
      assertEquals(v2.initialState, v1.initialState);
      assertEquals(v2.expandedState, v1.expandedState);
      assertEquals(v2.initialNotifications, v1.initialNotifications);
      assertEquals(v2.expandedNotifications, v1.expandedNotifications);
    } finally {
      await v1.close();
      await v2.close();
    }
  },
);

Deno.test(
  "memory v2 matches authoritative graph queries for repeated 64-node graph retarget workloads",
  async () => {
    const fixture = createGraphFixture(space);
    const initialDocs = new Map(
      fixture.docs.map((doc) => [doc.id, structuredClone(doc.value)]),
    );
    const store = await createStore();
    const seed = await createPersistentProviders("v2", store.url);
    let active: PersistentProviders | undefined;

    const applyMutation = async (id: URI) => {
      const value = structuredClone(initialDocs.get(id)!);
      assertExists(value);
      await sendDocs(active!.writer, [{ id, value }]);
    };

    try {
      await sendDocs(seed.writer, fixture.docs);
      await seed.close();
      active = await createPersistentProviders("v2", store.url);
      if (!active?.queryGraph) {
        throw new Error("Failed to reopen persistent v2 graph providers");
      }

      assertEquals(
        await active.observer.sync(fixture.rootId, {
          path: [],
          schema: fixture.schema,
        }),
        { ok: {} },
      );
      active.notifications.clear();

      const retargetIds = [
        fixture.rootId,
        "of:test-node-03" as URI,
        "of:test-node-06" as URI,
        "of:test-node-09" as URI,
      ];
      const ringTargets = [
        "of:test-node-28" as URI,
        "of:test-node-29" as URI,
        "of:test-node-30" as URI,
        "of:test-node-31" as URI,
      ] as const;

      for (let step = 0; step < 20; step += 1) {
        if (step % 3 === 0) {
          const root = structuredClone(initialDocs.get(fixture.rootId)!);
          root.alternate = step % 6 === 0 ? undefined : {
            "/": {
              "link@1": {
                id: fixture.hiddenRootId,
                path: [],
                space,
              },
            },
          };
          initialDocs.set(fixture.rootId, root);
          await applyMutation(fixture.rootId);
        } else if (step % 3 === 1) {
          const id = retargetIds[(step / 3 | 0) % retargetIds.length];
          const doc = structuredClone(initialDocs.get(id)!);
          doc.alternate = {
            "/": {
              "link@1": {
                id: ringTargets[step % ringTargets.length],
                path: [],
                space,
              },
            },
          };
          initialDocs.set(id, doc);
          await applyMutation(id);
        } else {
          const id = retargetIds[(step / 3 | 0) % retargetIds.length];
          const doc = structuredClone(initialDocs.get(id)!);
          if (Array.isArray(doc.children) && doc.children.length > 1) {
            doc.children = [...doc.children].reverse();
          }
          initialDocs.set(id, doc);
          await applyMutation(id);
        }

        await waitForAsync(async () =>
          containsExpectedGraphState(
            active!.observer,
            await active!.queryGraph!(),
          )
        );

        assertEquals(
          containsExpectedGraphState(
            active.observer,
            await active.queryGraph(),
          ),
          true,
        );
        active.notifications.clear();
      }
    } finally {
      await seed.close().catch(() => {});
      await active?.close().catch(() => {});
      await removeStore(store.dir);
    }
  },
);
