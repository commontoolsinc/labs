import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import type { RuntimeProgram } from "@commonfabric/runner";
import { CFC_SCHEMA_MIGRATION_INCOMPATIBLE_REASON } from "@commonfabric/runner/cfc/migration-reason";
import { assertPatternSchemasBackwardCompatible } from "../src/schema-compatibility.ts";
import {
  materializeOver,
  openFileBackedRuntime,
  vintageRoot,
  type VintageRuntime,
} from "./state-continuity-harness.ts";

/**
 * Tier 2: replay a captured prior state under a NEW pattern version.
 *
 * Shape of each case: capture a real space written by the OLD pattern,
 * snapshot it, then open a fresh runtime over that snapshot and materialize
 * the NEW pattern onto the same root through the production repair call.
 *
 * Where the line with Tier 1 falls — measured, and pinned by the last case
 * here so neither tier is dropped on a wrong assumption about the other:
 *
 * - Additive REQUIRED field with no default (the estuary brick): already
 *   covered twice over. Tier 1's `assertPatternSchemasBackwardCompatible`
 *   rejects the contract ("newly required result field has no default"), and
 *   `packages/runner/test/cfc-additive-default-preserves-old-doc.test.ts`
 *   drives the runtime rejection over a legacy root. This tier replays it not
 *   for the guard but for the PIPELINE: a class with a known-good outcome is
 *   what makes capture → snapshot → reopen → materialize testable end to end.
 * - Moving where a field is STORED under an identical contract: this tier
 *   only. The two result schemas are byte-identical, so no contract check can
 *   see it, and nothing throws — the data is simply gone. What a pattern
 *   writes is not determined by its schema.
 */

const signer = await Identity.fromPassphrase("state continuity vintage");

/**
 * The vintage carries a CFC-labelled field, which is what makes its root doc
 * store a CFC schema envelope. That envelope is the thing a later version's
 * schema has to MERGE with, and the merge is where the additive-required guard
 * lives (`packages/runner/src/cfc/schema-merge.ts` — `mergeRequired`). A root
 * with no stored envelope has nothing to merge against, so the guard never
 * runs and the whole migration class is invisible; that is precisely why an
 * earlier version of this test watched a required-no-default field materialize
 * happily. Real system roots (home, profile) are CFC-relevant, so this models
 * them rather than working around them.
 *
 * A CONFIDENTIALITY label is deliberate: it makes the doc CFC-relevant without
 * imposing a write requirement. An ownership label (`ownerPrincipal`) would
 * also work, but its writes must carry matching `represents-principal`
 * integrity, so every case here would fail on the authorization check before
 * ever reaching the schema merge — green or red for the wrong reason.
 */
const CFC_PRELUDE = [
  "import { Confidential, Default, Writable, pattern } from 'commonfabric';",
  "const OWNER_ATOM = {",
  "  type: 'https://commonfabric.org/cfc/atom/Resource',",
  "  class: 'StateContinuityVintage',",
  "  subject: 'did:example:state-continuity',",
  "} as const;",
  "type VintageLabel = readonly [typeof OWNER_ATOM];",
];

/** The vintage: no `favorites` field at all, so a doc it writes has no value. */
const OLD_WITHOUT_FAVORITES: RuntimeProgram = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      ...CFC_PRELUDE,
      "interface Output {",
      "  owner: Confidential<Writable<string>, VintageLabel>;",
      "  items: Writable<string[]>;",
      "}",
      "export default pattern<Record<string, never>, Output>(() => {",
      "  const owner = new Writable<string>('vintage').for('owner');",
      "  const items = new Writable<string[]>([]).for('items');",
      "  return { owner, items };",
      "});",
      "",
    ].join("\n"),
  }],
};

/**
 * The estuary brick: `favorites` is additive AND required AND has no default.
 * CFC schema-merge refuses the setup commit over a doc that predates the field
 * ("required field <name> needs a default to preserve old documents").
 */
const NEW_REQUIRED_NO_DEFAULT: RuntimeProgram = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      ...CFC_PRELUDE,
      "interface Output {",
      "  owner: Confidential<Writable<string>, VintageLabel>;",
      "  items: Writable<string[]>;",
      "  favorites: Writable<string[]>;",
      "}",
      "export default pattern<Record<string, never>, Output>(() => {",
      "  const owner = new Writable<string>('vintage').for('owner');",
      "  const items = new Writable<string[]>([]).for('items');",
      "  const favorites = new Writable<string[]>([]).for('favorites');",
      "  return { owner, items, favorites };",
      "});",
      "",
    ].join("\n"),
  }],
};

/** The fix: identical, except `favorites` rides `Default<[]>`. */
const NEW_DEFAULTED: RuntimeProgram = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      ...CFC_PRELUDE,
      "interface Output {",
      "  owner: Confidential<Writable<string>, VintageLabel>;",
      "  items: Writable<string[]>;",
      "  favorites: Writable<string[] | Default<[]>>;",
      "}",
      "export default pattern<Record<string, never>, Output>(() => {",
      "  const owner = new Writable<string>('vintage').for('owner');",
      "  const items = new Writable<string[]>([]).for('items');",
      "  const favorites = new Writable<string[]>([]).for('favorites');",
      "  return { owner, items, favorites };",
      "});",
      "",
    ].join("\n"),
  }],
};

/**
 * Same declared contract, different STORAGE. `items` is backed by
 * `.for('itemList')` instead of `.for('items')`, so the result schema is
 * byte-identical to the vintage's while the data the vintage wrote is no
 * longer where this version looks. Nothing in a contract comparison can see
 * this; only a document can.
 */
const RENAMED_STORAGE_KEY: RuntimeProgram = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      ...CFC_PRELUDE,
      "interface Output {",
      "  owner: Confidential<Writable<string>, VintageLabel>;",
      "  items: Writable<string[]>;",
      "}",
      "export default pattern<Record<string, never>, Output>(() => {",
      "  const owner = new Writable<string>('vintage').for('owner');",
      "  const items = new Writable<string[]>([]).for('itemList');",
      "  return { owner, items };",
      "});",
      "",
    ].join("\n"),
  }],
};

interface Captured {
  snapshot: string;
  dir: string;
}

describe("pattern update over captured prior state", () => {
  let dirs: string[] = [];
  let open: VintageRuntime[] = [];

  const tempDir = async (prefix: string) => {
    const dir = await Deno.makeTempDir({ prefix });
    dirs.push(dir);
    return dir;
  };

  const openRuntime = async (dir: string, fromSnapshot?: string) => {
    const vintage = await openFileBackedRuntime(signer, dir, fromSnapshot);
    open.push(vintage);
    return vintage;
  };

  beforeEach(() => {
    dirs = [];
    open = [];
  });

  afterEach(async () => {
    // Tear everything down first, THEN surface what went wrong. A vintage owns
    // a memory server — SQLite engines, a read pool, a refresh timer — and
    // `dispose()` failing means those outlived the case. Swallowing that would
    // hide the very leak `dispose()` exists to close, and leave the next case
    // to fail on a symptom instead. Every vintage still gets its turn: one
    // broken teardown must not strand the rest.
    const teardown: unknown[] = [];
    for (const vintage of open) {
      try {
        await vintage.dispose();
      } catch (error) {
        teardown.push(error);
      }
    }
    // Temp-dir removal stays best-effort: it is the OS's business, not the
    // runtime's, and a failure here says nothing about the code under test.
    for (const dir of dirs) {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
    if (teardown.length > 0) {
      throw new AggregateError(teardown, "vintage teardown failed");
    }
  });

  /** Write a space with `program`, populate it, and snapshot it. */
  async function capture(
    program: RuntimeProgram,
    items: string[],
  ): Promise<Captured> {
    const dir = await tempDir("continuity-capture-");
    const vintage = await openRuntime(dir);
    // Materialize through the SAME call the replay uses. Not tidiness: a
    // pattern's owned cells (`.for('items')`) are addressed off the pattern
    // instance, so a capture that allocated them by a different route would
    // hand the replay a root whose keys resolve to docs it never wrote — the
    // fixture would look empty and every continuity assertion would fail for a
    // reason that has nothing to do with the pattern being tested.
    const materialized = await materializeOver(vintage, program);
    expect(
      materialized.error,
      "capture could not materialize the vintage pattern onto an empty space",
    ).toBeUndefined();

    // Populate: this is the state the new version has to keep reachable.
    // Address the root through the schema of the pattern that was actually
    // materialized, so the write cannot land on a shape nobody ran.
    const root = vintageRoot<Record<string, unknown>>(
      vintage,
      materialized.resultSchema,
    );
    // `editWithRetry`, not a bare `edit()`, and the result is CHECKED: this
    // write races the tail of the materialize above on the same documents, and
    // `commit()` REPORTS a conflict in its result rather than throwing. An
    // unread result buys a snapshot that silently lacks the very state the tier
    // exists to replay — every downstream case then fails on an empty read,
    // several layers away from the cause.
    const { error: writeError } = await vintage.runtime.editWithRetry((tx) => {
      (root.withTx(tx).key("items") as { set: (v: string[]) => void }).set(
        items,
      );
    });
    expect(
      writeError?.message,
      "capture could not write the vintage's prior state",
    ).toBeUndefined();
    await vintage.runtime.idle();

    const snapshot = `${dir}/vintage.sqlite`;
    await vintage.snapshot(snapshot);
    return { snapshot, dir };
  }

  /** Open a fresh runtime over `captured` and materialize `program` on it. */
  async function replay(captured: Captured, program: RuntimeProgram) {
    const dir = await tempDir("continuity-replay-");
    const vintage = await openRuntime(dir, captured.snapshot);
    return await materializeOver(vintage, program);
  }

  it("captures a real space and reads its state back from the snapshot", async () => {
    // The mechanism itself: a snapshot must be a faithful, reopenable space.
    const captured = await capture(OLD_WITHOUT_FAVORITES, ["alpha", "beta"]);
    expect(Deno.statSync(captured.snapshot).size).toBeGreaterThan(0);

    const result = await replay(captured, OLD_WITHOUT_FAVORITES);
    expect(result.error).toBeUndefined();
    expect(
      result.value?.items,
      "the snapshot did not round-trip: the SAME pattern replayed over the " +
        "captured space cannot see the state that space was captured holding, " +
        "so capture, snapshot or restore is broken — not any pattern change",
    ).toEqual(["alpha", "beta"]);
  });

  it("keeps prior state reachable when the new field carries a default", async () => {
    const captured = await capture(OLD_WITHOUT_FAVORITES, ["alpha", "beta"]);
    const result = await replay(captured, NEW_DEFAULTED);

    expect(result.error).toBeUndefined();
    // The point of the tier: the data the OLD version wrote survives.
    expect(
      result.value?.items,
      "adding a DEFAULTED field lost the prior version's data — a regression " +
        "in update continuity, not in this test's fixture (the round-trip " +
        "case proves the same snapshot reads back under the old pattern)",
    ).toEqual(["alpha", "beta"]);
    expect(
      result.value?.favorites,
      "the new field did not materialize from its Default<[]>",
    ).toEqual([]);
  });

  it("refuses an additive REQUIRED field with no default over a vintage doc", async () => {
    // The 2026-07-22 estuary brick, reproduced from a captured prior state
    // rather than asserted against inline source text: `favorites` is additive,
    // required, and carries no default, so the old doc has no value for it and
    // none can be synthesized. The setup commit is refused and the piece is
    // loadable-but-unrunnable — a bricked home.
    //
    // This class is NOT Tier 2's alone, and the overlap is worth being exact
    // about. Tier 1 rejects the contract (pinned by the last case here), and
    // `packages/runner/test/cfc-additive-default-preserves-old-doc.test.ts`
    // already drives the runtime rejection over a legacy root. What that one
    // cannot show is the part this tier is built for: its vintage is a doc
    // hand-written in-process from a schema, where this one was written by a
    // real prior pattern version, snapshotted to a file, and reopened. So this
    // case earns its keep as the capture/replay pipeline's end-to-end proof on
    // a class whose correct outcome is independently known — not as the only
    // evidence the guard fires.
    const captured = await capture(OLD_WITHOUT_FAVORITES, ["alpha", "beta"]);
    const result = await replay(captured, NEW_REQUIRED_NO_DEFAULT);

    expect(result.error).toBeDefined();
    // Assert the SPECIFIC rejection: a generic failure would let this pass for
    // the wrong reason (a compile error, a missing store, a disposed runtime).
    expect(result.error).toContain(CFC_SCHEMA_MIGRATION_INCOMPATIBLE_REASON);
    expect(result.error).toContain(
      "required field favorites needs a default to preserve old documents",
    );
  });

  it("strands prior state when the storage key moves under an IDENTICAL schema", async () => {
    // The class that is Tier 2's alone, and the reason this tier exists.
    //
    // `RENAMED_STORAGE_KEY` differs from the vintage only in which cell backs
    // `items` — `.for('items')` became `.for('itemList')`. The declared
    // contract is untouched: the two result schemas are BYTE-IDENTICAL
    // (asserted below). Tier 1 compares contracts, so there is nothing there
    // for it to see, and no amount of strengthening the schema check would
    // change that: what a pattern WRITES is not determined by its schema.
    //
    // Nothing throws, either. The materialize succeeds and the piece runs —
    // it just quietly reads a cell nobody ever wrote, and the user's data is
    // gone. Silence is what makes this class worth a gate.
    const captured = await capture(OLD_WITHOUT_FAVORITES, ["alpha", "beta"]);

    // The control belongs INSIDE this case, not in the round-trip case above.
    // `items === []` is also what a fixture that was never restored reads back,
    // so on its own the assertion below cannot tell "the rename stranded the
    // data" from "there was no data" — measured: no-op the restore and this
    // case stays green while every other case here goes red. Replaying the
    // VINTAGE over the SAME snapshot first is what makes the emptiness a
    // property of the rename.
    const control = await replay(captured, OLD_WITHOUT_FAVORITES);
    expect(control.error).toBeUndefined();
    expect(
      control.value?.items,
      "CONTROL failed, so the case below proves nothing: the vintage itself " +
        "cannot read the captured state, which means the fixture is broken " +
        "rather than the rename stranding anything",
    ).toEqual(["alpha", "beta"]);

    const result = await replay(captured, RENAMED_STORAGE_KEY);
    expect(result.error).toBeUndefined();
    expect(
      result.value?.items,
      "moving a field's `.for()` key no longer strands the prior version's " +
        "data. If the runtime gained key migration this test should be " +
        "REWRITTEN, not deleted — Tier 2 exists for this class and Tier 1 " +
        "structurally cannot see it",
    ).toEqual([]); // …not ["alpha", "beta"].
  });

  it("records which classes Tier 1 already covers", async () => {
    // Tier 2 is not a superset of Tier 1 and this pins where the line falls,
    // so neither tier gets removed on a wrong assumption about the other.
    //
    // `assertPatternSchemasBackwardCompatible` is what `cf piece setsrc` runs
    // and what Tier 1 checks every pattern against its recorded baselines.
    const dir = await tempDir("continuity-tier1-");
    const vintage = await openRuntime(dir);
    const compile = (program: RuntimeProgram) =>
      vintage.runtime.patternManager.compilePattern(program, {
        space: vintage.space as never,
      });
    const previous = await compile(OLD_WITHOUT_FAVORITES);

    // The additive-required class is caught by Tier 1 outright, which is why
    // Tier 2 replays it as a pipeline check rather than as its own coverage.
    let requiredIssue: string | undefined;
    try {
      assertPatternSchemasBackwardCompatible(
        previous,
        await compile(NEW_REQUIRED_NO_DEFAULT),
      );
    } catch (error) {
      requiredIssue = error instanceof Error ? error.message : String(error);
    }
    expect(requiredIssue).toContain(
      "result.favorites: newly required result field has no default",
    );

    // The storage-key move is invisible to it: identical schemas, no issue.
    const renamed = await compile(RENAMED_STORAGE_KEY);
    expect(renamed.resultSchema).toEqual(previous.resultSchema);
    expect(() => assertPatternSchemasBackwardCompatible(previous, renamed)).not
      .toThrow();
  });
});
