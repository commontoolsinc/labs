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

import { assertEquals } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { toFileUrl } from "@std/path";

import {
  applyCommit,
  close,
  DEFAULT_DOCUMENT_CACHE_MAX_ENTRIES,
  documentCacheDiagnostics,
  type Engine,
  open,
  type OpenOptions,
  read,
} from "../v2/engine.ts";
import { getDocumentCachesDiagnostics, Server } from "../v2/server.ts";

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

  it("reports each open space's cache through the health provider", async () => {
    const space = "did:key:z6Mk-document-cache-diagnostics";
    // Whatever an earlier test left registered is what closing hands back to.
    const registeredBefore = getDocumentCachesDiagnostics();
    const server = new Server({
      store: new URL("memory://document-cache-diagnostics"),
      subscriptionRefreshDelayMs: 0,
      authorizeSessionOpen: () => "did:key:z6Mk-document-cache-principal",
      sessionOpenAuth: { audience: "did:key:z6Mk-document-cache-audience" },
    });
    try {
      assertEquals(getDocumentCachesDiagnostics(), { spaces: {} });
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
    // Closing withdraws the provider (back to whatever was registered before).
    assertEquals(getDocumentCachesDiagnostics(), registeredBefore);
  });
});
