/**
 * The engine's decoded-document cache: how far past its bound it stays
 * correct, and what it declines to remember.
 *
 * Both branches below are out of reach of an ordinary commit-and-read
 * sequence. One needs more revisions than the cache holds, which no other test
 * in this package produces; the other needs a read taken inside a transaction
 * that is not a commit, which nothing in the engine does today and which the
 * guard exists to keep safe if something starts to. Exercising them here keeps
 * them honest rather than leaving them to run first in production.
 */

import { assertEquals } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { toFileUrl } from "@std/path";

import { applyCommit, close, type Engine, open, read } from "../v2/engine.ts";

const withEngine = async (
  fn: (engine: Engine) => void | Promise<void>,
): Promise<void> => {
  const path = await Deno.makeTempFile({ suffix: ".sqlite" });
  const engine = await open({ url: toFileUrl(path) });
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

/** Comfortably past `DOCUMENT_CACHE_MAX_ENTRIES`, so the bound is reached. */
const DOCUMENT_COUNT = 400;

const entityId = (index: number) =>
  `of:fid1:cache-${String(index).padStart(4, "0")}`;

const storedValue = (engine: Engine, index: number): unknown =>
  read(engine, { id: entityId(index) } as never);

describe("v2 document cache", () => {
  it("reads back every document once more of them exist than it holds", async () => {
    await withEngine((engine) => {
      for (let index = 0; index < DOCUMENT_COUNT; index++) {
        applyCommit(engine, {
          sessionId: "s:a",
          commit: commit(index + 1, {
            operations: [setOp(entityId(index), index)],
          }),
        } as never);
      }

      // Twice over, so the second pass reads through a cache that has already
      // been filled and cleared rather than a cold one.
      for (let pass = 0; pass < 2; pass++) {
        for (let index = 0; index < DOCUMENT_COUNT; index++) {
          assertEquals(storedValue(engine, index), { value: index });
        }
      }

      // And the bound held while that happened. Reading every document would
      // answer correctly whether or not anything was ever evicted, so without
      // this the test would pass against a cache that simply grew.
      assertEquals(
        engine.documentCache.size < DOCUMENT_COUNT,
        true,
        `cache holds ${engine.documentCache.size} of ${DOCUMENT_COUNT} documents`,
      );
    });
  });

  it("does not remember a document read inside an open transaction", async () => {
    await withEngine((engine) => {
      applyCommit(engine, {
        sessionId: "s:a",
        commit: commit(1, { operations: [setOp(entityId(0), 7)] }),
      } as never);

      // A transaction that is not a commit, so nothing stages its reads. What
      // it decodes must not outlive it: the rows behind the read are not
      // durable until the transaction returns.
      engine.database.transaction(() => {
        engine.documentCache.clear();
        assertEquals(storedValue(engine, 0), { value: 7 });
        assertEquals(
          engine.documentCache.size,
          0,
          "a read inside an open transaction was remembered",
        );
      })();

      // Still readable afterwards, and now cacheable.
      assertEquals(storedValue(engine, 0), { value: 7 });
    });
  });
});
