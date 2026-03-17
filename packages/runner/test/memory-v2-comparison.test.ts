import { assertEquals, assertExists } from "@std/assert";
import { Identity } from "@commontools/identity";
import type { URI } from "@commontools/memory/interface";
import * as Consumer from "@commontools/memory/consumer";
import * as MemoryProvider from "@commontools/memory/provider";
import { Provider, StorageManager } from "../src/storage/cache.deno.ts";
import type { StorageNotification } from "../src/storage/interface.ts";
import { createGraphFixture } from "./memory-v2-graph.fixture.ts";
import * as StorageSubscription from "../src/storage/subscription.ts";

type TestProvider = {
  get(uri: URI): { value: unknown } | undefined;
  send(
    batch: { uri: URI; value: { value: unknown } }[],
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

const normalizedGraphNotifications = (notifications: StorageNotification[]) =>
  notifications
    .filter((notification) =>
      notification.type === "pull" || notification.type === "integrate"
    )
    .map((notification) => ({
      type: notification.type,
      ids: "changes" in notification
        ? [...notification.changes].map((change) => change.address.id).sort()
        : [],
    }));

const sendDocs = async (
  provider: TestProvider,
  docs: Array<{ id: URI; value: unknown }>,
) => {
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

const createSharedProviders = (memoryVersion: "v1" | "v2") => {
  const memoryProvider = MemoryProvider.emulate({
    serviceDid: signer.did(),
    memoryVersion,
  });
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
    },
  };
};

const runGraphExpansion = async (
  memoryVersion: "v1" | "v2",
) => {
  const shared = createSharedProviders(memoryVersion);
  const fixture = createGraphFixture(space);

  try {
    await sendDocs(shared.writer, fixture.docs);
    shared.notifications.clear();

    assertEquals(
      await shared.observer.sync(fixture.rootId, {
        path: [],
        schema: fixture.schema,
      }),
      { ok: {} },
    );
    await waitFor(() =>
      visibleGraphIds(shared.observer, fixture.expandedReachableIds).length ===
        fixture.initialReachableIds.length
    );

    const initialState = visibleGraphState(
      shared.observer,
      fixture.expandedReachableIds,
    );
    const initialNotifications = normalizedGraphNotifications(
      shared.notifications.notifications,
    );
    shared.notifications.clear();

    assertEquals(
      visibleGraphIds(shared.observer, fixture.expandedReachableIds),
      fixture.initialReachableIds,
    );

    await sendDocs(shared.writer, [{
      id: fixture.rootId,
      value: fixture.expandedRootValue,
    }]);
    await waitFor(() =>
      visibleGraphIds(shared.observer, fixture.expandedReachableIds).length ===
        fixture.expandedReachableIds.length
    );

    return {
      close: shared.close,
      initialState,
      expandedState: visibleGraphState(
        shared.observer,
        fixture.expandedReachableIds,
      ),
      initialNotifications,
      expandedNotifications: normalizedGraphNotifications(
        shared.notifications.notifications,
      ),
      fixture,
    };
  } catch (error) {
    await shared.close();
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
      const batch = [{ uri, value: { value } }];

      assertEquals(await v1Provider.send(batch), { ok: {} });
      assertEquals(await v2Provider.send(batch), { ok: {} });

      for (const currentUri of uris) {
        assertEquals(v2Provider.get(currentUri), v1Provider.get(currentUri));
      }
    }
  } finally {
    await v1.close();
    await v2.close();
  }
});

Deno.test.ignore(
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

Deno.test.ignore(
  "memory v2 matches v1 for repeated 64-node graph retarget workloads",
  async () => {
    const fixture = createGraphFixture(space);
    const initialDocs = new Map(
      fixture.docs.map((doc) => [doc.id, structuredClone(doc.value)]),
    );
    const v1 = createSharedProviders("v1");
    const v2 = createSharedProviders("v2");

    const applyMutation = async (id: URI) => {
      const value = structuredClone(initialDocs.get(id)!);
      assertExists(value);
      await sendDocs(v1.writer, [{ id, value }]);
      await sendDocs(v2.writer, [{ id, value }]);
    };

    try {
      await sendDocs(v1.writer, fixture.docs);
      await sendDocs(v2.writer, fixture.docs);
      assertEquals(
        await v1.observer.sync(fixture.rootId, {
          path: [],
          schema: fixture.schema,
        }),
        { ok: {} },
      );
      assertEquals(
        await v2.observer.sync(fixture.rootId, {
          path: [],
          schema: fixture.schema,
        }),
        { ok: {} },
      );
      v1.notifications.clear();
      v2.notifications.clear();

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

        await waitFor(() =>
          JSON.stringify(
            visibleGraphState(v1.observer, fixture.expandedReachableIds),
          ) ===
            JSON.stringify(
              visibleGraphState(v2.observer, fixture.expandedReachableIds),
            )
        );
        assertEquals(
          visibleGraphState(v2.observer, fixture.expandedReachableIds),
          visibleGraphState(v1.observer, fixture.expandedReachableIds),
        );
        assertEquals(
          normalizedGraphNotifications(v2.notifications.notifications),
          normalizedGraphNotifications(v1.notifications.notifications),
        );
        v1.notifications.clear();
        v2.notifications.clear();
      }
    } finally {
      await v1.close();
      await v2.close();
    }
  },
);
