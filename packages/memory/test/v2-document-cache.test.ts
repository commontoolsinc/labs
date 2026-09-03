/**
 * The engine's decoded-document cache: that a working set stays resident
 * across the walks that read it, what its bounds evict first, and what it
 * declines to remember.
 *
 * The bounds are exercised with small budgets set through `open()`; the
 * default budget holds far more than any test here writes. The in-transaction
 * branch needs a read taken inside a transaction that is not a commit, which
 * nothing in the engine does today and which the guard exists to keep safe if
 * something starts to.
 */

import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { ensureDir } from "@std/fs";
import { describe, it } from "@std/testing/bdd";
import { join, toFileUrl } from "@std/path";

import {
  applyCommit,
  close,
  DEFAULT_DOCUMENT_CACHE_MAX_ENTRIES,
  documentCacheDiagnostics,
  type Engine,
  evictDocumentCacheEntries,
  open,
  type OpenOptions,
  read,
} from "../v2/engine.ts";
import {
  getDocumentCachesDiagnostics,
  getPushPriorityStats,
  Server,
} from "../v2/server.ts";
import { resolveSpaceStoreUrl } from "../v2/storage-path.ts";

const withEngine = async (
  fn: (engine: Engine) => void | Promise<void>,
  options: Omit<OpenOptions, "url"> = {},
): Promise<void> => {
  const path = await Deno.makeTempFile({ suffix: ".sqlite" });
  const engine = await open({ url: toFileUrl(path), ...options });
  try {
    await fn(engine);
  } finally {
    close(engine);
    await Deno.remove(path);
  }
};

const setOp = (id: string, value: unknown) =>
  ({ op: "set", id, value: { value } }) as never;

const commit = (localSeq: number, extra: Record<string, unknown>) =>
  ({
    localSeq,
    reads: { confirmed: [], pending: [] },
    operations: [],
    ...extra,
  }) as never;

const entityId = (index: number) =>
  `of:fid1:cache-${String(index).padStart(4, "0")}`;

const storedValue = (engine: Engine, index: number): unknown =>
  read(engine, { id: entityId(index) } as never);

const seed = (
  engine: Engine,
  count: number,
  valueOf: (i: number) => unknown = (i) => i,
) => {
  for (let index = 0; index < count; index++) {
    applyCommit(engine, {
      sessionId: "s:a",
      commit: commit(index + 1, {
        operations: [setOp(entityId(index), valueOf(index))],
      }),
    } as never);
  }
};

/** A temporary store directory for a Server, removed afterwards. */
const withStoreDir = async (
  fn: (store: URL) => Promise<void>,
): Promise<void> => {
  const dir = await Deno.makeTempDir();
  try {
    await fn(toFileUrl(join(dir, "/")));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
};

/** Populate each space's store directly, before a server opens it; every
 * engine is closed whether or not its seeding completes. */
const seedSpaces = async (
  store: URL,
  spaces: readonly `did:${string}:${string}`[],
  count: number,
  valueOf: (i: number) => unknown,
): Promise<void> => {
  for (const space of spaces) {
    const url = resolveSpaceStoreUrl(store, space);
    await ensureDir(new URL("./", url));
    const engine = await open({ url });
    try {
      seed(engine, count, valueOf);
    } finally {
      close(engine);
    }
  }
};

const serverOptions = (store: URL, processBudget?: number) => ({
  store,
  subscriptionRefreshDelayMs: 0,
  ...(processBudget === undefined
    ? {}
    : { documentCacheProcessBudgetBytes: processBudget }),
  authorizeSessionOpen: () => "did:key:z6Mk-document-cache-principal",
  sessionOpenAuth: { audience: "did:key:z6Mk-document-cache-audience" },
});

describe("v2 document cache", () => {
  it("keeps a working set larger than the old bound resident across passes", async () => {
    // Four hundred documents — past the 256 the cache used to clear itself
    // at, and the shape of a board load, which reads its whole set again on
    // every load. The second pass must be served entirely from the cache.
    const count = 400;
    await withEngine((engine) => {
      seed(engine, count);
      // Seeding reads its own rows through the staged cache, so start the
      // count from whatever that left behind.
      const before = documentCacheDiagnostics(engine);
      for (let index = 0; index < count; index++) {
        assertEquals(storedValue(engine, index), { value: index });
      }
      const afterFirst = documentCacheDiagnostics(engine);
      for (let index = 0; index < count; index++) {
        assertEquals(storedValue(engine, index), { value: index });
      }
      const afterSecond = documentCacheDiagnostics(engine);
      assertEquals(
        afterSecond.misses - afterFirst.misses,
        0,
        "the second pass decoded something again",
      );
      assertEquals(afterSecond.hits - afterFirst.hits, count);
      assertEquals(afterSecond.evictions - before.evictions, 0);
      assertEquals(afterSecond.entries >= count, true);
      assertEquals(afterSecond.maxEntries, DEFAULT_DOCUMENT_CACHE_MAX_ENTRIES);
    });
  });

  it("evicts the least recently read entry first at the entry cap", async () => {
    await withEngine((engine) => {
      seed(engine, 10);
      // Reads outside any commit go straight to the cache; an entry cap of
      // eight is reached by reading eight documents.
      for (let index = 0; index < 8; index++) storedValue(engine, index);
      const filled = documentCacheDiagnostics(engine);
      assertEquals(filled.entries, 8);
      // Touch the oldest, so it is no longer the oldest.
      storedValue(engine, 0);
      // The ninth document displaces the least recently read one: document 1,
      // not document 0.
      storedValue(engine, 8);
      const evicted = documentCacheDiagnostics(engine);
      assertEquals(evicted.entries, 8);
      assertEquals(evicted.evictions - filled.evictions, 1);
      const beforeProbe = documentCacheDiagnostics(engine);
      storedValue(engine, 0);
      assertEquals(documentCacheDiagnostics(engine).hits - beforeProbe.hits, 1);
      storedValue(engine, 1);
      assertEquals(
        documentCacheDiagnostics(engine).misses - beforeProbe.misses,
        1,
        "document 1 should have been the eviction victim",
      );
    }, { documentCacheMaxEntries: 8 });
  });

  it("holds the byte budget and does not retain a document heavier than it", async () => {
    // Forty small documents (a few dozen encoded bytes each) cannot all fit
    // in four hundred; the heavy one alone is far past the budget.
    const budget = 400;
    const small = 40;
    await withEngine((engine) => {
      seed(
        engine,
        small + 1,
        (index) => index === small ? "x".repeat(20_000) : index,
      );
      for (let index = 0; index < small; index++) storedValue(engine, index);
      const filled = documentCacheDiagnostics(engine);
      assertEquals(filled.bytes <= budget, true, `bytes ${filled.bytes}`);
      assertEquals(filled.entries < small, true, "the budget evicted nothing");
      assertEquals(filled.evictions > 0, true);
      // The heavy document is served but not remembered: reading it twice
      // misses twice, and the cache's occupancy does not move.
      const before = documentCacheDiagnostics(engine);
      assertEquals(storedValue(engine, small), { value: "x".repeat(20_000) });
      assertEquals(storedValue(engine, small), { value: "x".repeat(20_000) });
      const after = documentCacheDiagnostics(engine);
      assertEquals(after.misses - before.misses, 2);
      assertEquals(after.entries, before.entries);
      assertEquals(after.bytes, before.bytes);
      assertEquals(after.budgetBytes, budget);
    }, { documentCacheBudgetBytes: budget });
  });

  it("does not remember a document read inside an open transaction", async () => {
    // A cap of one: after seeding two documents at most one is cached, so
    // the other is a guaranteed miss when read inside the transaction below.
    await withEngine((engine) => {
      seed(engine, 2);
      // Document 0 is the one the cap of one has let go; read it cold inside
      // the transaction. A transaction that is not a commit stages nothing,
      // and what it decodes must not outlive it: the rows behind the read are
      // not durable until the transaction returns.
      const uncached = 0;
      const before = documentCacheDiagnostics(engine);
      engine.database.transaction(() => {
        assertEquals(storedValue(engine, uncached), { value: uncached });
      })();
      const inside = documentCacheDiagnostics(engine);
      assertEquals(inside.misses - before.misses, 1, "expected a cold read");
      // Not remembered: the same read outside the transaction misses again,
      // and only then is it cached — the read after that is a hit.
      assertEquals(storedValue(engine, uncached), { value: uncached });
      const after = documentCacheDiagnostics(engine);
      assertEquals(
        after.misses - inside.misses,
        1,
        "the transaction's read was remembered",
      );
      assertEquals(storedValue(engine, uncached), { value: uncached });
      assertEquals(documentCacheDiagnostics(engine).hits - after.hits, 1);
    }, { documentCacheMaxEntries: 1 });
  });

  it("reports each open space's cache through the health provider, withdrawn on close", async () => {
    const space = "did:key:z6Mk-document-cache-diagnostics";
    // Whatever an earlier test left registered is what closing hands back to.
    const registeredBefore = getDocumentCachesDiagnostics();
    const pushBefore = getPushPriorityStats();
    const server = new Server(
      serverOptions(new URL("memory://document-cache-diagnostics")),
    );
    try {
      const empty = getDocumentCachesDiagnostics();
      assertEquals(empty, server.documentCachesDiagnostics());
      // The push-priority provider follows the same registration.
      assertEquals(getPushPriorityStats(), server.pushPriorityStats());
      assertEquals(empty?.spaces, {});
      assertEquals(empty?.bytes, 0);
      assertEquals(typeof empty?.processBudgetBytes, "number");
      // Any read opens the space's engine; a never-opened space is absent.
      await server.evaluateGraphQuery(space, {
        roots: [{ id: "of:doc:1", selector: { path: [], schema: true } }],
      });
      const report = getDocumentCachesDiagnostics();
      assertEquals(report, server.documentCachesDiagnostics());
      assertEquals(Object.keys(report!.spaces), [space]);
      const cache = report!.spaces[space];
      assertEquals(typeof cache.hits, "number");
      assertEquals(typeof cache.misses, "number");
      assertEquals(cache.entries, cache.entries | 0);
      assertEquals(cache.bytes <= cache.budgetBytes, true);
    } finally {
      await server.close();
    }
    // Closing withdraws both providers (back to whatever was registered
    // before), so a closed server is never the one reported.
    assertEquals(getDocumentCachesDiagnostics(), registeredBefore);
    assertEquals(getPushPriorityStats(), pushBefore);
  });
  it("rejects cache bounds that are not positive integers at open", async () => {
    const url = toFileUrl(await Deno.makeTempFile({ suffix: ".sqlite" }));
    try {
      for (const bad of [0, -1, 1.5]) {
        await assertRejects(
          () => open({ url, documentCacheBudgetBytes: bad }),
          TypeError,
          "documentCacheBudgetBytes",
        );
        await assertRejects(
          () => open({ url, documentCacheMaxEntries: bad }),
          TypeError,
          "documentCacheMaxEntries",
        );
      }
    } finally {
      await Deno.remove(new URL(url));
    }
  });
  it("weighs a reconstructed document by what it retains, not by any row it replayed", async () => {
    // Nine additive patches on a small base: no single row bounds the
    // result, and the result is what the cache keeps.
    const id = entityId(0);
    const chunk = "x".repeat(449);
    await withEngine((engine) => {
      applyCommit(engine, {
        sessionId: "s:a",
        commit: commit(1, { operations: [setOp(id, { seed: true })] }),
      } as never);
      for (let n = 1; n <= 9; n++) {
        applyCommit(engine, {
          sessionId: "s:a",
          commit: commit(n + 1, {
            operations: [{
              op: "patch",
              id,
              patches: [{ op: "add", path: `/value/p${n}`, value: chunk }],
            }],
          }),
        } as never);
      }
      // Read outside any commit, cold: drop whatever the commits' own reads
      // left cached so this read decodes and weighs the document itself.
      evictDocumentCacheEntries(engine, Number.MAX_SAFE_INTEGER);
      const before = documentCacheDiagnostics(engine);
      const body = storedValue(engine, 0) as { value: Record<string, unknown> };
      assertEquals(body.value.p9, chunk);
      const after = documentCacheDiagnostics(engine);
      assertEquals(after.misses - before.misses, 1);
      const weight = after.bytes;
      assertEquals(
        weight >= 9 * chunk.length,
        true,
        `weight ${weight} charges less than the nine chunks retained`,
      );
    }, { documentCacheMaxEntries: 1 });
  });

  it("weighs documents in encoded bytes, not string code units", async () => {
    const cjk = "字".repeat(900); // three UTF-8 bytes per character
    await withEngine((engine) => {
      applyCommit(engine, {
        sessionId: "s:a",
        commit: commit(1, { operations: [setOp(entityId(0), cjk)] }),
      } as never);
      evictDocumentCacheEntries(engine, Number.MAX_SAFE_INTEGER);
      const before = documentCacheDiagnostics(engine);
      assertEquals(storedValue(engine, 0), { value: cjk });
      const after = documentCacheDiagnostics(engine);
      assertEquals(after.misses - before.misses, 1);
      assertEquals(
        after.bytes >= 3 * cjk.length,
        true,
        `weight ${after.bytes} counted code units, not bytes`,
      );
    }, { documentCacheMaxEntries: 1 });
  });

  it("drains the least recently read entries first when asked to free bytes", async () => {
    await withEngine((engine) => {
      seed(engine, 5);
      for (let index = 0; index < 5; index++) storedValue(engine, index);
      const filled = documentCacheDiagnostics(engine);
      // Free two entries' worth: the two least recently read go, the rest
      // stay, and what was freed is reported.
      const perEntry = filled.bytes / filled.entries;
      const freed = evictDocumentCacheEntries(engine, 2 * perEntry - 1);
      const drained = documentCacheDiagnostics(engine);
      assertEquals(freed >= 2 * perEntry - 1, true);
      assertEquals(drained.evictions - filled.evictions, 2);
      assertEquals(drained.entries, filled.entries - 2);
      assertEquals(drained.bytes, filled.bytes - freed);
      const probe = documentCacheDiagnostics(engine);
      storedValue(engine, 4);
      assertEquals(documentCacheDiagnostics(engine).hits - probe.hits, 1);
      storedValue(engine, 0);
      assertEquals(documentCacheDiagnostics(engine).misses - probe.misses, 1);
    }, { documentCacheMaxEntries: 64 });
  });

  it("holds the process-wide budget across spaces, draining the least recently used space first", async () => {
    const spaces = [
      "did:key:z6Mk-document-cache-process-a",
      "did:key:z6Mk-document-cache-process-b",
    ] as const;
    await withStoreDir(async (store) => {
      // Thirty documents of one weight each (the index is padded so every
      // row encodes to the same length): sixty-odd bytes apiece, so one
      // space's set fits the budget below and two sets do not.
      await seedSpaces(
        store,
        spaces,
        30,
        (index) =>
          `document ${String(index).padStart(2, "0")} ${"·".repeat(20)}`,
      );
      // Larger than one space's set, smaller than two: reading the second
      // space must trim the first — and only as far as needed.
      const budget = 2_500;
      const server = new Server(serverOptions(store, budget));
      try {
        const readAll = (space: string) =>
          server.evaluateGraphQuery(space, {
            roots: Array.from({ length: 30 }, (_, index) => ({
              id: entityId(index),
              selector: { path: [], schema: true },
            })),
          });
        await readAll(spaces[0]);
        const afterA = server.documentCachesDiagnostics();
        assertEquals(afterA.processBudgetBytes, budget);
        // One space fits whole.
        const first = afterA.spaces[spaces[0]];
        assertEquals(first.entries, 30);
        assertEquals(first.evictions, 0);
        assertEquals(afterA.bytes, first.bytes);
        assertEquals(afterA.bytes > budget / 2, true, `bytes ${afterA.bytes}`);
        const weight = first.bytes / 30;
        assertEquals(Number.isInteger(weight), true, "unequal row weights");

        await readAll(spaces[1]);
        const afterB = server.documentCachesDiagnostics();
        assertEquals(afterB.bytes <= budget, true, `bytes ${afterB.bytes}`);
        // The newest space is untouched; the least recently used one gave up
        // exactly what the budget needed — the fewest entries that bring the
        // total under it — and kept the rest.
        const newest = afterB.spaces[spaces[1]];
        assertEquals(newest.entries, 30);
        assertEquals(newest.evictions, 0);
        const older = afterB.spaces[spaces[0]];
        const required = Math.ceil(
          (first.bytes + newest.bytes - budget) / weight,
        );
        assertEquals(required > 0 && required < 30, true, `${required}`);
        assertEquals(
          older.evictions,
          required,
          "trimmed further than the budget required",
        );
        assertEquals(older.entries, 30 - required);
        assertEquals(
          afterB.bytes,
          first.bytes + newest.bytes - required * weight,
        );
      } finally {
        await server.close();
      }
    });
  });

  it("holds the process-wide budget on a plain document read, not only after an evaluation", async () => {
    // The budget is held as each document is cached, so a path with no
    // enforcement of its own — the public readDocument here — returns
    // within it: two spaces holding one document each of more than half the
    // budget cannot both stay resident, and the second read drains the
    // first space rather than returning over budget.
    const spaces = [
      "did:key:z6Mk-document-cache-read-a",
      "did:key:z6Mk-document-cache-read-b",
    ] as const;
    const body = "x".repeat(700);
    await withStoreDir(async (store) => {
      await seedSpaces(store, spaces, 1, () => body);
      const budget = 1_000;
      const server = new Server(serverOptions(store, budget));
      try {
        assertEquals(await server.readDocument(spaces[0], entityId(0)), {
          value: body,
        });
        const afterA = server.documentCachesDiagnostics();
        assertEquals(afterA.spaces[spaces[0]].entries, 1);
        assertEquals(afterA.bytes > budget / 2, true, `bytes ${afterA.bytes}`);
        assertEquals(afterA.bytes <= budget, true, `bytes ${afterA.bytes}`);

        assertEquals(await server.readDocument(spaces[1], entityId(0)), {
          value: body,
        });
        const afterB = server.documentCachesDiagnostics();
        assertEquals(afterB.bytes <= budget, true, `bytes ${afterB.bytes}`);
        assertEquals(afterB.spaces[spaces[1]].entries, 1);
        assertEquals(afterB.spaces[spaces[0]].entries, 0);
        assertEquals(afterB.spaces[spaces[0]].evictions, 1);
      } finally {
        await server.close();
      }
    });
  });

  it("rejects a cache bound that is not a positive integer at construction", () => {
    // Where it is configured, not at the first request that opens a space —
    // and a rejected server registers nothing for the health route.
    const registeredBefore = getDocumentCachesDiagnostics();
    const pushBefore = getPushPriorityStats();
    const bounds = [
      "documentCacheBudgetBytes",
      "documentCacheMaxEntries",
      "documentCacheProcessBudgetBytes",
    ] as const;
    for (const bound of bounds) {
      for (const bad of [0, -5, 2.5]) {
        assertThrows(
          () =>
            new Server({
              ...serverOptions(new URL("memory://document-cache-bad-bound")),
              [bound]: bad,
            }),
          TypeError,
          bound,
        );
      }
    }
    assertEquals(getDocumentCachesDiagnostics(), registeredBefore);
    assertEquals(getPushPriorityStats(), pushBefore);
  });
  it("remembers the revision a commit wrote once its rows are durable, and serves the next read from it", async () => {
    const id = entityId(0);
    await withEngine((engine) => {
      const patch = (localSeq: number, field: string) =>
        applyCommit(engine, {
          sessionId: "s:a",
          commit: commit(localSeq, {
            operations: [{
              op: "patch",
              id,
              patches: [{ op: "add", path: `/value/${field}`, value: true }],
            }],
          }),
        } as never);
      seed(engine, 1, () => ({ seed: true }));
      // Cold: nothing is cached when the commit below runs. A commit reads
      // the revision it has just written inside its own transaction
      // (snapshot materialization asks for the state it wrote), so that read
      // is staged and reaches the cache only once the commit's rows are
      // durable — as the one entry here.
      evictDocumentCacheEntries(engine, Number.MAX_SAFE_INTEGER);
      const cold = documentCacheDiagnostics(engine);
      assertEquals(cold.entries, 0);
      patch(2, "edited");
      const merged = documentCacheDiagnostics(engine);
      assertEquals(merged.entries, 1, "the commit's read was not remembered");
      // So the first read after the commit already sees the patched revision
      // from the cache.
      assertEquals(storedValue(engine, 0), {
        value: { seed: true, edited: true },
      });
      assertEquals(
        documentCacheDiagnostics(engine).hits - merged.hits,
        1,
        "the patched revision was not served from the cache",
      );
      // The next commit stages its own new revision the same way: one more
      // entry, nothing counted twice — the byte accounting equals the
      // entries' weights.
      patch(3, "again");
      const after = documentCacheDiagnostics(engine);
      assertEquals(after.entries, 2);
      assertEquals(storedValue(engine, 0), {
        value: { seed: true, edited: true, again: true },
      });
      assertEquals(documentCacheDiagnostics(engine).hits - after.hits, 1);
      let sum = 0;
      for (const entry of engine.documentCache.values()) sum += entry.weight;
      assertEquals(after.bytes, sum, "bytes drifted from the entries' weights");
      assertEquals(after.entries, engine.documentCache.size);
    });
  });
});
