/**
 * Multi-runtime regression test: CFC Phase 3.b read-time-clearance results
 * are READER-ISOLATED (#4478 review P0, fixed in 52e3e7e7).
 *
 * Two users (alice, bob) share one space and one rule-bearing SQLite db whose
 * rows each name their intended reader. Both runtimes run the same
 * `readClearance: true` query. Before the fix the cleared result landed in a
 * SPACE-scoped result cell keyed by a reader-blind request hash, so the
 * runtime that settled second either reused the other reader's filtered rows
 * (request-hash dedup) or clobbered them with its own — cross-reader
 * disclosure either way. The fix forces the cleared result to per-`user`
 * scope and keys the request hash by the acting reader.
 *
 * Asserts:
 * - each reader's cleared query returns EXACTLY the rows naming them;
 * - `withheld` is per-reader (each reader's own audit count);
 * - the cleared result cell resolves at scope "user" (isolated instance per
 *   reader on one shared link);
 * - the two readers' cleared request hashes DIFFER, while the non-clearance
 *   query keeps ONE shared hash (non-clearance queries unchanged).
 *
 * No toolshed or browser required (Deno workers + in-process storage server).
 */

import { assert, assertEquals, assertNotEquals } from "@std/assert";
import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { join } from "@std/path";
import {
  MultiRuntimeHarness,
  type MultiRuntimeSession,
} from "./multi-runtime-harness.ts";

const PROGRAM_PATH = join(
  import.meta.dirname!,
  "fixtures",
  "sqlite-read-clearance",
  "main.tsx",
);
const ROOT_PATH = join(import.meta.dirname!, "..");

interface NoteRow {
  id: number;
  reader: string;
  body: string;
}

interface QueryState {
  pending?: boolean;
  result?: NoteRow[];
  error?: unknown;
  withheld?: number;
}

async function queryState(
  session: MultiRuntimeSession,
  key: string,
): Promise<QueryState> {
  return ((await session.read([key])) ?? {}) as QueryState;
}

describe("sqlite read-time clearance across runtimes", () => {
  let harness: MultiRuntimeHarness;
  let alice: MultiRuntimeSession;
  let bob: MultiRuntimeSession;

  beforeAll(async () => {
    harness = await MultiRuntimeHarness.create({
      programPath: PROGRAM_PATH,
      rootPath: ROOT_PATH,
      sessions: ["alice", "bob"],
    });
    alice = harness.session("alice");
    bob = harness.session("bob");
  });

  afterAll(async () => {
    await harness?.dispose();
  });

  it("returns each reader only their own admissible rows", async () => {
    const aliceDid = alice.identity.did();
    const bobDid = bob.identity.did();

    // One writer seeds rows for BOTH readers (the write gate labels each row
    // from its own data; it does not require the writer to be a reader).
    await alice.send("seed", {
      rows: [
        { reader: aliceDid, body: "alice-1" },
        { reader: aliceDid, body: "alice-2" },
        { reader: bobDid, body: "bob-only" },
      ],
    });

    const settled = async (
      session: MultiRuntimeSession,
      key: string,
      rows: number,
    ): Promise<QueryState | undefined> => {
      const state = await queryState(session, key);
      return state.pending === false && state.error === undefined &&
          (state.result?.length ?? -1) === rows
        ? state
        : undefined;
    };

    // Baseline sanity: without clearance BOTH readers see all three rows —
    // the table is genuinely shared, so any qClear narrowing is clearance-made.
    await harness.waitFor(
      "baseline query settles on all rows in both runtimes",
      async () =>
        (await settled(alice, "qAll", 3)) !== undefined &&
        (await settled(bob, "qAll", 3)) !== undefined,
    );

    // THE POINT — the cleared query is per-reader: each runtime's acting
    // principal admits exactly the rows naming it, with a per-reader
    // withheld audit count.
    await harness.waitFor(
      "alice's cleared query settles on her two rows",
      async () => (await settled(alice, "qClear", 2)) !== undefined,
    );
    await harness.waitFor(
      "bob's cleared query settles on his one row",
      async () => (await settled(bob, "qClear", 1)) !== undefined,
    );

    const aliceClear = await queryState(alice, "qClear");
    assertEquals(
      aliceClear.result?.map((r) => r.body),
      ["alice-1", "alice-2"],
      "alice must see exactly her rows",
    );
    assert(
      aliceClear.result!.every((r) => r.reader === aliceDid),
      "every row alice sees must name alice as its reader",
    );
    assertEquals(aliceClear.withheld, 1, "alice's withheld count (bob's row)");

    const bobClear = await queryState(bob, "qClear");
    assertEquals(
      bobClear.result?.map((r) => r.body),
      ["bob-only"],
      "bob must see exactly his row",
    );
    assert(
      bobClear.result!.every((r) => r.reader === bobDid),
      "every row bob sees must name bob as its reader",
    );
    assertEquals(bobClear.withheld, 2, "bob's withheld count (alice's rows)");
  });

  it("isolates the cleared result cell per user and keys the request hash by reader", async () => {
    // One shared link, per-user instances: the cleared result cell must
    // resolve at scope "user" in both runtimes (a space-scoped cell is the
    // pre-fix shared-result leak).
    const aliceLink = await alice.link(["qClear"]);
    const bobLink = await bob.link(["qClear"]);
    assertEquals(aliceLink.scope, "user", "alice's cleared result scope");
    assertEquals(bobLink.scope, "user", "bob's cleared result scope");
    assertEquals(
      aliceLink.id,
      bobLink.id,
      "same base entity — isolation comes from the per-user scope partition",
    );

    // Belt-and-suspenders: a cleared result's request hash includes the
    // acting reader, so the two runtimes must record DIFFERENT hashes (a
    // shared reader-blind hash is what let one reader dedup against the
    // other's rows). requestHash is not in the declared result schema, so
    // read it raw.
    const aliceClearRaw = await alice.readRaw(["qClear"]) as QueryState & {
      requestHash?: string;
    };
    const bobClearRaw = await bob.readRaw(["qClear"]) as QueryState & {
      requestHash?: string;
    };
    assert(aliceClearRaw.requestHash, "alice's cleared query recorded a hash");
    assert(bobClearRaw.requestHash, "bob's cleared query recorded a hash");
    assertNotEquals(
      aliceClearRaw.requestHash,
      bobClearRaw.requestHash,
      "cleared request hashes must be keyed by the acting reader",
    );

    // Contrast: the non-clearance query stays reader-blind — one shared
    // space-scoped result cell, one shared hash (the fix must not re-scope or
    // re-hash plain queries).
    const aliceAllLink = await alice.link(["qAll"]);
    assertEquals(aliceAllLink.scope, "space", "baseline result stays shared");
    const aliceAllRaw = await alice.readRaw(["qAll"]) as {
      requestHash?: string;
    };
    const bobAllRaw = await bob.readRaw(["qAll"]) as { requestHash?: string };
    assert(aliceAllRaw.requestHash, "baseline query recorded a hash");
    assertEquals(
      aliceAllRaw.requestHash,
      bobAllRaw.requestHash,
      "baseline request hash stays reader-blind",
    );
  });

  it("releases nothing about withheld rows beyond the declared surface", async () => {
    // §6 E3 (docs/history/plans/cfc-future-work-implementation.md): "the
    // withheld-count is not observable in the result shape beyond the
    // declared release". The raw stored doc — read with NO result-schema
    // shaping, so it is the query's ENTIRE observable surface — must carry
    // exactly the declared release: the kept rows, the withheld count, and
    // the request bookkeeping. Withheld rows leave no artifacts: no
    // placeholder slots, no index gaps, no ids, no content.
    const bobRaw = await bob.readRaw(["qClear"]) as Record<string, unknown>;
    assertEquals(
      Object.keys(bobRaw).sort(),
      ["pending", "requestHash", "result", "withheld"],
      "the cleared result doc carries ONLY the declared surface",
    );
    const bobRows = bobRaw.result as unknown[];
    assertEquals(bobRows.length, 1, "kept rows only — no per-withheld slots");
    assert(
      bobRows.every((r) => r !== null && r !== undefined),
      "the kept-row array is dense — no placeholder gaps",
    );
    // Content opacity: nothing reachable in bob's raw doc mentions a
    // withheld row (kept rows split into per-row link docs, so the doc
    // itself holds no row content — a leak would surface right here).
    const bobFlat = JSON.stringify(bobRaw);
    for (const leaked of ["alice-1", "alice-2"]) {
      assert(
        !bobFlat.includes(leaked),
        `withheld row content "${leaked}" leaked into bob's raw result doc`,
      );
    }

    const aliceRaw = await alice.readRaw(["qClear"]) as Record<string, unknown>;
    assertEquals(
      Object.keys(aliceRaw).sort(),
      ["pending", "requestHash", "result", "withheld"],
      "the cleared result doc carries ONLY the declared surface",
    );
    assertEquals((aliceRaw.result as unknown[]).length, 2);
    assert(
      !JSON.stringify(aliceRaw).includes("bob-only"),
      "withheld row content leaked into alice's raw result doc",
    );

    // The boundary in the other direction: a NON-clearance query result
    // carries no clearance artifact at all — `withheld` is absent, not 0.
    const allRaw = await alice.readRaw(["qAll"]) as Record<string, unknown>;
    assertEquals(
      Object.keys(allRaw).sort(),
      ["pending", "requestHash", "result"],
      "a non-clearance result must not carry a withheld field",
    );
  });
});
