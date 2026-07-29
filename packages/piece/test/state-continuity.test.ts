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
 * - Additive REQUIRED field with no default (the estuary brick): caught by
 *   BOTH. Tier 1's `assertPatternSchemasBackwardCompatible` rejects the
 *   contract outright ("newly required result field has no default"); this
 *   tier shows the runtime refusing the setup commit over a real document.
 *   Overlap is the point — Tier 1 is the cheap per-PR gate, and this is what
 *   proves the runtime behavior that gate stands in for.
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
    for (const vintage of open) {
      await vintage.dispose().catch(() => {});
    }
    for (const dir of dirs) {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
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
    expect(materialized.error).toBeUndefined();

    // Populate: this is the state the new version has to keep reachable.
    const root = vintageRoot<Record<string, unknown>>(
      vintage,
      (await vintage.runtime.patternManager.compilePattern(program, {
        space: vintage.space as never,
      })).resultSchema,
    );
    const write = vintage.runtime.edit();
    (root.withTx(write).key("items") as { set: (v: string[]) => void }).set(
      items,
    );
    await write.commit();
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
    expect(result.value?.items).toEqual(["alpha", "beta"]);
  });

  it("keeps prior state reachable when the new field carries a default", async () => {
    const captured = await capture(OLD_WITHOUT_FAVORITES, ["alpha", "beta"]);
    const result = await replay(captured, NEW_DEFAULTED);

    expect(result.error).toBeUndefined();
    // The point of the tier: the data the OLD version wrote survives.
    expect(result.value?.items).toEqual(["alpha", "beta"]);
    expect(result.value?.favorites).toEqual([]);
  });

  it("refuses an additive REQUIRED field with no default over a vintage doc", async () => {
    // The 2026-07-22 estuary brick, reproduced from a captured prior state
    // rather than asserted against inline source text: `favorites` is additive,
    // required, and carries no default, so the old doc has no value for it and
    // none can be synthesized. The setup commit is refused and the piece is
    // loadable-but-unrunnable — a bricked home.
    //
    // This is the class Tier 1 structurally cannot see: BOTH contracts are
    // individually valid and the result schema only GAINS a property, which is
    // a covariant (compatible) change. Only a document says otherwise.
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
    const result = await replay(captured, RENAMED_STORAGE_KEY);

    expect(result.error).toBeUndefined();
    expect(result.value?.items).toEqual([]); // …not ["alpha", "beta"].
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

    // The additive-required class is caught by BOTH tiers. Tier 1 rejects the
    // contract; Tier 2 shows the runtime refusing the commit over a real doc.
    // Keeping both is deliberate — Tier 1 is the cheap gate on every PR, and
    // Tier 2 is what proves the runtime behavior the gate is a proxy for.
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
