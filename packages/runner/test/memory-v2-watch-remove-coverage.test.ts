// Deterministic coverage for the "removes" arm of applySessionSync in
// storage/v2.ts. A watch refresh / sync batch can carry removals when a watched
// doc is deleted upstream. Most tests only deliver upserts, so the removes path
// runs intermittently. Here the scripted transport answers the watch.add with a
// sync that upserts two docs and removes one of them in the same batch, so the
// removes loop always runs while provider.sync() is awaited.

import { assertEquals } from "@std/assert";
import { Identity } from "@commonfabric/identity";
import type { URI } from "@commonfabric/memory/interface";
import {
  type EntityDocument,
  type SessionSync,
  type SessionSyncUpsert,
} from "@commonfabric/memory/v2";
import type { IStorageProvider } from "../src/storage/interface.ts";
import { Runtime } from "../src/runtime.ts";
import {
  ScriptedSessionTransport,
  type ScriptedTransportMessage,
  SingleSessionFactory,
  TestStorageManager,
} from "./memory-v2-test-utils.ts";

const signer = await Identity.fromPassphrase("memory-v2-watch-remove-coverage");
const space = signer.did();

type TestProvider = IStorageProvider & {
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

const getObjectValue = (
  provider: TestProvider,
  uri: URI,
): Record<string, unknown> | undefined => {
  const value = provider.get(uri)?.value;
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
};

// Answers the watch.add with a sync that upserts every requested root and then
// removes `removedId` in the same batch, simulating a watched doc deleted
// upstream as the watch is established.
class WatchAddRemoveTransport extends ScriptedSessionTransport {
  readonly #removedId: URI;

  constructor(removedId: URI) {
    super({
      name: "watch-remove-coverage",
      sessionId: "session:watch-remove-coverage",
      space,
    });
    this.#removedId = removedId;
  }

  protected override ackServerSeq(): number {
    return 5;
  }

  protected override handle(message: ScriptedTransportMessage): void {
    switch (message.type) {
      case "session.watch.add": {
        const roots =
          message.watches?.flatMap((watch) =>
            watch.query?.roots?.map((root) => root.id as URI) ?? []
          ) ?? [];
        const toSeq = roots.length + 1;
        this.respond({
          type: "response",
          requestId: message.requestId!,
          ok: {
            serverSeq: toSeq,
            sync: {
              type: "sync",
              fromSeq: 0,
              toSeq,
              upserts: roots.map((id, index) =>
                doc(id, index + 1, { value: { label: id } })
              ),
              removes: [{ branch: "", id: this.#removedId }],
            } satisfies SessionSync,
          },
        });
        return;
      }
      default:
        throw new Error(`Unhandled scripted message: ${message.type}`);
    }
  }
}

// The first full watch-set update fails without changing server state. The
// runner must issue it again: watchRemoveSync has already removed the probe id
// from the session's local watch intent, so the second request carries the
// corrected complete set and acknowledges cleanup.
class FailFirstWatchRemovalTransport extends ScriptedSessionTransport {
  watchRemovalAttempts = 0;
  onWatchAdded?: () => void;
  readonly #failuresBeforeSuccess: number;
  readonly #precedingId?: URI;
  #serverSeq = 1;

  constructor(failuresBeforeSuccess = 1, precedingId?: URI) {
    super({
      name: "watch-removal-retry",
      sessionId: "session:watch-removal-retry",
      space,
    });
    this.#failuresBeforeSuccess = failuresBeforeSuccess;
    this.#precedingId = precedingId;
  }

  protected override handle(message: ScriptedTransportMessage): void {
    switch (message.type) {
      case "session.watch.add": {
        const roots =
          message.watches?.flatMap((watch) =>
            watch.query?.roots?.map((root) => root.id as URI) ?? []
          ) ?? [];
        this.onWatchAdded?.();
        this.respond({
          type: "response",
          requestId: message.requestId!,
          ok: {
            serverSeq: this.#serverSeq,
            sync: {
              type: "sync",
              fromSeq: 0,
              toSeq: this.#serverSeq,
              upserts: [],
              removes: roots.map((id) => ({
                branch: "",
                id,
                scope: "space" as const,
              })),
            } satisfies SessionSync,
          },
        });
        return;
      }
      case "session.watch.set":
        this.watchRemovalAttempts++;
        if (this.watchRemovalAttempts <= this.#failuresBeforeSuccess) {
          this.respond({
            type: "response",
            requestId: message.requestId!,
            error: {
              name: "ConnectionError",
              message: "synthetic first removal failure",
            },
          });
          return;
        }
        if (this.#precedingId !== undefined) {
          const fromSeq = this.#serverSeq;
          this.#serverSeq++;
          this.emitSync({
            type: "sync",
            fromSeq,
            toSeq: this.#serverSeq,
            upserts: [
              doc(this.#precedingId, this.#serverSeq, {
                value: { label: "preceding cleanup sync" },
              }),
            ],
            removes: [],
          });
        }
        this.respond({
          type: "response",
          requestId: message.requestId!,
          ok: {
            serverSeq: this.#serverSeq,
            sync: {
              type: "sync",
              fromSeq: this.#serverSeq,
              toSeq: this.#serverSeq,
              upserts: [],
              removes: [],
            } satisfies SessionSync,
          },
        });
        return;
      default:
        throw new Error(`Unhandled scripted message: ${message.type}`);
    }
  }
}

Deno.test("memory v2 runner applies removes carried in a watch refresh batch", async () => {
  const docA = `of:watch-remove-keep-${crypto.randomUUID()}` as URI;
  const docB = `of:watch-remove-drop-${crypto.randomUUID()}` as URI;
  const transport = new WatchAddRemoveTransport(docB);
  const sessionFactory = new SingleSessionFactory(transport);
  const storageManager = TestStorageManager.create({
    as: signer,
    memoryHost: new URL("memory://runner-v2-watch-remove-coverage"),
  }, sessionFactory);
  const provider = storageManager.open(space) as TestProvider;

  try {
    await Promise.all([
      provider.sync(docA, { path: [], schema: false }),
      provider.sync(docB, { path: [], schema: false }),
    ]);

    // docA was upserted and kept; docB was upserted in the same sync and then
    // removed, so the removes loop must have reset it back to absent.
    assertEquals(getObjectValue(provider, docA), { label: docA });
    assertEquals(provider.get(docB), undefined);
  } finally {
    await storageManager.close();
  }
});

Deno.test("absence reconciliation retries a failed temporary watch removal", async () => {
  const transport = new FailFirstWatchRemovalTransport();
  const sessionFactory = new SingleSessionFactory(transport);
  const storageManager = TestStorageManager.create({
    as: signer,
    memoryHost: new URL("memory://runner-v2-watch-removal-retry"),
  }, sessionFactory);
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  const provider = storageManager.open(space);
  const tx = runtime.edit();
  tx.read({
    space,
    id: `of:watch-removal-retry-${crypto.randomUUID()}`,
    type: "application/json",
    scope: "space",
    path: [],
  }, { trackReadWithoutLoad: true });

  try {
    if (provider.loadUnexaminedAbsences === undefined) {
      throw new Error("absence reconciliation capability unavailable");
    }
    assertEquals(await provider.loadUnexaminedAbsences(tx.tx), 0);
    assertEquals(transport.watchRemovalAttempts, 2);
  } finally {
    tx.abort("inspection only");
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("absence cleanup integrates syncs that precede its watch mutation", async () => {
  const precedingId =
    `of:watch-removal-preceding-${crypto.randomUUID()}` as URI;
  const transport = new FailFirstWatchRemovalTransport(0, precedingId);
  const sessionFactory = new SingleSessionFactory(transport);
  const storageManager = TestStorageManager.create({
    as: signer,
    memoryHost: new URL("memory://runner-v2-watch-removal-preceding"),
  }, sessionFactory);
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  const provider = storageManager.open(space) as TestProvider;
  const tx = runtime.edit();
  tx.read({
    space,
    id: `of:watch-removal-preceding-probe-${crypto.randomUUID()}`,
    type: "application/json",
    scope: "space",
    path: [],
  }, { trackReadWithoutLoad: true });

  try {
    assertEquals(await provider.loadUnexaminedAbsences!(tx.tx), 0);
    assertEquals(getObjectValue(provider, precedingId), {
      label: "preceding cleanup sync",
    });
  } finally {
    tx.abort("inspection only");
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("absence cleanup closes a returned view when the replica closes concurrently", async () => {
  const transport = new FailFirstWatchRemovalTransport(0);
  const sessionFactory = new SingleSessionFactory(transport);
  const storageManager = TestStorageManager.create({
    as: signer,
    memoryHost: new URL("memory://runner-v2-watch-removal-close-race"),
  }, sessionFactory);
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  const provider = storageManager.open(space);
  let closing: Promise<void> | undefined;
  transport.onWatchAdded = () => {
    const session = sessionFactory.session!;
    const original = session.watchRemoveSync.bind(session);
    session.watchRemoveSync = async (watchIds) => {
      const result = await original(watchIds);
      closing = (provider.replica as unknown as { close(): Promise<void> })
        .close();
      return result;
    };
    transport.onWatchAdded = undefined;
  };
  const tx = runtime.edit();
  tx.read({
    space,
    id: `of:watch-removal-close-race-${crypto.randomUUID()}`,
    type: "application/json",
    scope: "space",
    path: [],
  }, { trackReadWithoutLoad: true });

  try {
    assertEquals(await provider.loadUnexaminedAbsences!(tx.tx), 0);
    await closing;
  } finally {
    tx.abort("inspection only");
    await closing;
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("absence reconciliation cleans up after an unexpected probe exception", async () => {
  const transport = new FailFirstWatchRemovalTransport(0);
  const sessionFactory = new SingleSessionFactory(transport);
  const storageManager = TestStorageManager.create({
    as: signer,
    memoryHost: new URL("memory://runner-v2-watch-probe-exception"),
  }, sessionFactory);
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  const provider = storageManager.open(space);
  const replica = provider.replica as unknown as {
    refreshWatchSet(...args: unknown[]): Promise<unknown>;
  };
  const originalRefresh = replica.refreshWatchSet.bind(replica);
  replica.refreshWatchSet = () =>
    Promise.reject(new Error("synthetic unexpected probe exception"));
  const tx = runtime.edit();
  tx.read({
    space,
    id: `of:watch-probe-exception-${crypto.randomUUID()}`,
    type: "application/json",
    scope: "space",
    path: [],
  }, { trackReadWithoutLoad: true });

  try {
    assertEquals(await provider.loadUnexaminedAbsences!(tx.tx), 0);
    assertEquals(transport.watchRemovalAttempts, 1);
  } finally {
    replica.refreshWatchSet = originalRefresh;
    tx.abort("inspection only");
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("absence reconciliation retries when applying a watch removal sync fails", async () => {
  const transport = new FailFirstWatchRemovalTransport(0);
  const sessionFactory = new SingleSessionFactory(transport);
  const storageManager = TestStorageManager.create({
    as: signer,
    memoryHost: new URL("memory://runner-v2-watch-removal-apply-retry"),
  }, sessionFactory);
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  const provider = storageManager.open(space);
  const replica = provider.replica as unknown as {
    applySessionSync(sync: unknown, type: string): void;
  };
  const originalApply = replica.applySessionSync.bind(replica);
  let applyCalls = 0;
  replica.applySessionSync = (sync, type) => {
    applyCalls++;
    if (applyCalls === 2) {
      replica.applySessionSync = originalApply;
      throw new Error("synthetic watch removal apply failure");
    }
    originalApply(sync, type);
  };
  const tx = runtime.edit();
  tx.read({
    space,
    id: `of:watch-removal-apply-retry-${crypto.randomUUID()}`,
    type: "application/json",
    scope: "space",
    path: [],
  }, { trackReadWithoutLoad: true });

  try {
    assertEquals(await provider.loadUnexaminedAbsences!(tx.tx), 0);
    assertEquals(transport.watchRemovalAttempts, 2);
  } finally {
    replica.applySessionSync = originalApply;
    tx.abort("inspection only");
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("absence reconciliation warns after temporary watch cleanup exhausts retries", async () => {
  const transport = new FailFirstWatchRemovalTransport(2);
  const sessionFactory = new SingleSessionFactory(transport);
  const storageManager = TestStorageManager.create({
    as: signer,
    memoryHost: new URL("memory://runner-v2-watch-removal-exhausted"),
  }, sessionFactory);
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  const provider = storageManager.open(space);
  const tx = runtime.edit();
  tx.read({
    space,
    id: `of:watch-removal-exhausted-${crypto.randomUUID()}`,
    type: "application/json",
    scope: "space",
    path: [],
  }, { trackReadWithoutLoad: true });
  const originalWarn = console.warn;
  const warnings: unknown[][] = [];
  console.warn = (...values: unknown[]) => warnings.push(values);

  try {
    assertEquals(await provider.loadUnexaminedAbsences!(tx.tx), 0);
    assertEquals(transport.watchRemovalAttempts, 2);
    assertEquals(
      warnings.some((values) =>
        values[0] === "failed to remove temporary graph watches after retry"
      ),
      true,
    );
  } finally {
    console.warn = originalWarn;
    tx.abort("inspection only");
    await runtime.dispose();
    await storageManager.close();
  }
});
