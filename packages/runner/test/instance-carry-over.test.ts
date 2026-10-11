import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { getLoggerCountsBreakdown } from "@commonfabric/utils/logger";

import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import type { Cell } from "../src/cell.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";
import {
  instancePartialCause,
  stopNamingInstancesForTesting,
} from "../src/builder/instance-name.ts";
import { getDerivedInternalCellLink } from "../src/link-utils.ts";
import { type MetaField, rawMetaWriteAuthorization } from "../src/meta-seam.ts";
import { Runtime } from "../src/runtime.ts";

const signer = await Identity.fromPassphrase("instance-carry-over");
const space = signer.did();

// Two child patterns of one shape, so a parent's argument and result schemas
// accept either child at either spot, and nothing but the guard can refuse
// one running over the other's state.
const COUNTER = [
  "import { pattern, Writable } from 'commonfabric';",
  "export const Counter = pattern<",
  "  { label: string },",
  "  { count: Writable<number> }",
  ">(() => {",
  "  const count = new Writable<number>(0).for('count');",
  "  return { count };",
  "});",
  "",
].join("\n");

const OTHER = COUNTER.replace("Counter", "Other");

const THIRD = COUNTER.replace("Counter", "Third");

/**
 * A parent of `body`, which builds the children the result `{ views, aCount,
 * sCount? }` names. A child bound to a `const` is a named instance; one bound
 * by destructuring keeps the positional cause every child had before named
 * instances, which is how a deployed parent's stored state is reproduced.
 */
const parentProgram = (
  body: string,
  counter = COUNTER,
): RuntimeProgram => ({
  main: "/main.tsx",
  files: [
    { name: "/counter.tsx", contents: counter },
    { name: "/other.tsx", contents: OTHER },
    { name: "/third.tsx", contents: THIRD },
    {
      name: "/main.tsx",
      contents: [
        "import { pattern } from 'commonfabric';",
        "import { Counter } from './counter.tsx';",
        "import { Other } from './other.tsx';",
        "import { Third } from './third.tsx';",
        "export default pattern<Record<string, never>>(() => {",
        body,
        "});",
        "",
      ].join("\n"),
    },
  ],
});

// The parent as deployed: one child, `a`, at a positional spot.
const DEPLOYED = parentProgram([
  "  const [a] = [Counter({ label: 'a' })];",
  "  return { views: [a], aCount: a.count };",
].join("\n"));

// The same parent source with `a` bound to a `const`, which is what the
// deployed parent's own source compiles to once instances are named.
const NAMED = parentProgram([
  "  const a = Counter({ label: 'a' });",
  "  return { views: [a], aCount: a.count };",
].join("\n"));

// `NAMED` under a newer version of `Counter`'s own source.
const NAMED_WITH_NEWER_COUNTER = parentProgram(
  [
    "  const a = Counter({ label: 'a' });",
    "  return { views: [a], aCount: a.count };",
  ].join("\n"),
  `${COUNTER}// A newer version.\n`,
);

// The parent as deployed with two children of one pattern, `a` and `b`.
const DEPLOYED_TWO = parentProgram([
  "  const [a, b] = [Counter({ label: 'a' }), Counter({ label: 'b' })];",
  "  return { views: [a, b], aCount: a.count, bCount: b.count };",
].join("\n"));

// The same parent source with both children bound to a `const`.
const NAMED_TWO = parentProgram([
  "  const a = Counter({ label: 'a' });",
  "  const b = Counter({ label: 'b' });",
  "  return { views: [a, b], aCount: a.count, bCount: b.count };",
].join("\n"));

// An unrelated sibling `s` inserted ahead of `a`.
const NAMED_WITH_SIBLING = parentProgram([
  "  const s = Other({ label: 's' });",
  "  const a = Counter({ label: 'a' });",
  "  return { views: [s, a], aCount: a.count, sCount: s.count };",
].join("\n"));

// The same insertion with the sibling positional, which puts it at the
// positional spot the deployed parent gave `a`.
const POSITIONAL_SIBLING_OF_NAMED = parentProgram([
  "  const [s] = [Other({ label: 's' })];",
  "  const a = Counter({ label: 'a' });",
  "  return { views: [s, a], aCount: a.count, sCount: s.count };",
].join("\n"));

// The same insertion with both children positional.
const POSITIONAL_WITH_SIBLING = parentProgram([
  "  const [s, a] = [Other({ label: 's' }), Counter({ label: 'a' })];",
  "  return { views: [s, a], aCount: a.count, sCount: s.count };",
].join("\n"));

// The parent as deployed with an `Other` child ahead of two `Counter`
// children.
const DEPLOYED_THREE = parentProgram([
  "  const [o, c1, c2] = [",
  "    Other({ label: 'o' }),",
  "    Counter({ label: '1' }),",
  "    Counter({ label: '2' }),",
  "  ];",
  "  return {",
  "    views: [o, c1, c2],",
  "    oCount: o.count,",
  "    c1Count: c1.count,",
  "    c2Count: c2.count,",
  "  };",
].join("\n"));

// `DEPLOYED_TWO` under a newer version of `Counter`'s own source.
const DEPLOYED_TWO_NEWER_COUNTER = parentProgram(
  [
    "  const [a, b] = [Counter({ label: 'a' }), Counter({ label: 'b' })];",
    "  return { views: [a, b], aCount: a.count, bCount: b.count };",
  ].join("\n"),
  `${COUNTER}// A newer version.\n`,
);

describe("instance-carry-over", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let rt: Runtime;
  // Runtimes `freshRuntime()` has replaced, kept running until the case ends.
  let replaced: Runtime[];

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    rt = new Runtime({ apiUrl: new URL(import.meta.url), storageManager });
    replaced = [];
  });
  afterEach(async () => {
    await rt?.dispose();
    for (const runtime of replaced) await runtime.dispose();
    await storageManager?.close();
  });

  const compile = (program: RuntimeProgram) =>
    rt.patternManager.compilePattern(program, { space });

  /**
   * A stopped parent that ran `deployed`, with `counts` written to its result,
   * its pattern pointers naming `named`, the source it runs, unless `marker`
   * is `"absent"`, which leaves no setup marker, as a parent set up before
   * the marker existed has none. By default the parent holds `a`'s count of 7
   * at the positional spot `DEPLOYED` gives it.
   */
  const deployedParent = async (
    name: string,
    {
      marker = "named",
      deployed: deployedProgram = DEPLOYED,
      named: namedProgram = NAMED,
      counts = { aCount: 7 },
    }: {
      marker?: "named" | "absent";
      deployed?: RuntimeProgram;
      named?: RuntimeProgram;
      counts?: Record<string, number>;
    } = {},
  ): Promise<Cell<Record<string, unknown>>> => {
    const deployed = await compile(deployedProgram);
    const named = await compile(namedProgram);
    const namedRef = rt.patternManager.getArtifactEntryRef(named)!;
    const tx = rt.edit();
    const cell = rt.getCell<Record<string, unknown>>(
      space,
      name,
      undefined,
      tx,
    );
    const running = rt.run(tx, deployed, {}, cell);
    await tx.commit().settled;
    await running.pull();
    const write = rt.edit();
    for (const [key, count] of Object.entries(counts)) {
      cell.withTx(write).key(key).set(count);
    }
    expect((await write.commit().settled).error).toBeUndefined();
    await rt.idle();
    rt.runner.stop(cell);
    const stamp = rt.edit();
    cell.withTx(stamp).setMetaRaw("patternIdentity", {
      identity: namedRef.identity,
      symbol: namedRef.symbol,
    }, rawMetaWriteAuthorization);
    cell.withTx(stamp).setMetaRaw(
      "patternSetupIdentity",
      marker === "named"
        ? { identity: namedRef.identity, symbol: namedRef.symbol }
        : undefined,
      rawMetaWriteAuthorization,
    );
    expect((await stamp.commit().settled).error).toBeUndefined();
    return cell;
  };

  // How many times an instance has been reported starting fresh.
  const freshStarts = (): number =>
    (getLoggerCountsBreakdown()["runner"]?.["instance-carry-over"] as
      | { warn?: number }
      | undefined)?.warn ?? 0;

  /**
   * Updates the parent at `cell` to `program`, through the root repair call
   * the updater makes, and returns the parent's result.
   */
  const update = async (
    cell: Cell<Record<string, unknown>>,
    program: RuntimeProgram,
  ): Promise<Record<string, unknown>> => {
    const pattern = await compile(program);
    const ref = rt.patternManager.getArtifactEntryRef(pattern)!;
    const stamp = rt.edit();
    cell.withTx(stamp).setMetaRaw("patternIdentity", {
      identity: ref.identity,
      symbol: ref.symbol,
    }, rawMetaWriteAuthorization);
    expect((await stamp.commit().settled).error).toBeUndefined();
    await rt.runSynced(cell.withTx(), pattern, undefined, {
      expectedPatternIdentity: ref,
    });
    await rt.idle();
    await cell.pull();
    return cell.get() as Record<string, unknown>;
  };

  /**
   * A runtime of its own over the same storage, in place of `rt`, holding
   * none of the patterns `rt` compiled, and the parent `name` as it reads it.
   */
  const freshRuntime = async (
    name: string,
  ): Promise<Cell<Record<string, unknown>>> => {
    await rt.patternManager.flushCompileCacheWrites();
    await rt.storageManager.synced();
    replaced.push(rt);
    rt = new Runtime({ apiUrl: new URL(import.meta.url), storageManager });
    const cell = rt.getCell<Record<string, unknown>>(space, name);
    await cell.sync();
    return cell;
  };

  // The child the parent at `cell` runs at the positional cause
  // `{ $generated: n }`.
  const positionalChild = (cell: Cell<unknown>, n: number) => {
    const spot = getDerivedInternalCellLink(cell, {
      partialCause: { $generated: n },
    });
    return rt.getCell(space, {
      resultFor: { space: spot.space, id: spot.id, path: [] },
    });
  };

  // Writes each entry of `fields` to the meta field it names on `cell`.
  const writeMeta = async (
    cell: Cell<unknown>,
    fields: Record<string, unknown>,
  ) => {
    const tx = rt.edit();
    for (const [field, value] of Object.entries(fields)) {
      cell.withTx(tx).setMetaRaw(
        field as MetaField,
        value as never,
        rawMetaWriteAuthorization,
      );
    }
    expect((await tx.commit().settled).error).toBeUndefined();
  };

  describe("a named instance", () => {
    it("keeps its deployed child's state when an unrelated sibling is inserted ahead of it, and the sibling starts fresh", async () => {
      const cell = await deployedParent("sibling-inserted");

      const result = await update(cell, NAMED_WITH_SIBLING);

      expect({ aCount: result.aCount, sCount: result.sCount }).toEqual({
        aCount: 7,
        sCount: 0,
      });
    });

    it("keeps its deployed child's state when the parent carries no setup marker", async () => {
      const cell = await deployedParent("no-setup-marker", {
        marker: "absent",
      });

      const result = await update(cell, NAMED_WITH_SIBLING);

      expect({ aCount: result.aCount, sCount: result.sCount }).toEqual({
        aCount: 7,
        sCount: 0,
      });
    });

    it("keeps its deployed child's state at its own positional spot when the parent carries no setup marker and the child's own source changed", async () => {
      const cell = await deployedParent("no-setup-marker-newer-child", {
        marker: "absent",
      });
      const before = freshStarts();

      const result = await update(cell, NAMED_WITH_NEWER_COUNTER);

      expect(result.aCount).toBe(7);
      expect(freshStarts() - before).toBe(0);
    });

    it("keeps each deployed child's state at its own positional spot when the parent carries no setup marker and two deployed children run its pattern", async () => {
      const cell = await deployedParent("no-setup-marker-two-candidates", {
        marker: "absent",
        deployed: DEPLOYED_TWO,
        named: NAMED_TWO,
        counts: { aCount: 7, bCount: 9 },
      });

      const result = await update(cell, NAMED_TWO);

      expect({ aCount: result.aCount, bCount: result.bCount }).toEqual({
        aCount: 7,
        bCount: 9,
      });
    });

    it("starts fresh, and reports it, when the parent carries no setup marker and no deployed child sits at its positional spot", async () => {
      // `a` and `b` both match the one deployed child by identity, so it goes
      // to neither that way. `a` then takes it at its own positional spot,
      // and `b`, which the deployed parent never had, finds nothing at its
      // own.

      const cell = await deployedParent("no-setup-marker-new-instance", {
        marker: "absent",
      });
      const before = freshStarts();

      const result = await update(cell, NAMED_TWO);

      expect({ aCount: result.aCount, bCount: result.bCount }).toEqual({
        aCount: 7,
        bCount: 0,
      });
      expect(freshStarts() - before).toBe(1);
    });

    it("starts fresh, and reports it, rather than take the child at its positional spot when another instance sets up the pattern that child runs", async () => {
      // `s` is inserted ahead of two deployed `Counter` children, so its own
      // positional spot holds one of them. Both match `a` and `b` alike, so
      // neither is carried over by identity, and `a` and `b` setting up
      // `Counter` is the sign that the children have moved. The second
      // fresh start is `b`'s, whose own spot holds nothing.

      const cell = await deployedParent("no-setup-marker-moved", {
        marker: "absent",
        deployed: DEPLOYED_TWO,
        named: NAMED_TWO,
        counts: { aCount: 7, bCount: 9 },
      });
      const before = freshStarts();

      const result = await update(
        cell,
        parentProgram([
          "  const s = Other({ label: 's' });",
          "  const a = Counter({ label: 'a' });",
          "  const b = Counter({ label: 'b' });",
          "  return {",
          "    views: [s, a, b],",
          "    sCount: s.count,",
          "    aCount: a.count,",
          "    bCount: b.count,",
          "  };",
        ].join("\n")),
      );

      expect(result.sCount).toBe(0);
      expect(freshStarts() - before).toBe(2);
    });

    it("keeps each deployed child's state when the parent's previous pattern names two children of one pattern", async () => {
      const cell = await deployedParent("two-children-named", {
        deployed: DEPLOYED_TWO,
        named: NAMED_TWO,
        counts: { aCount: 7, bCount: 9 },
      });

      const result = await update(cell, NAMED_TWO);

      expect({ aCount: result.aCount, bCount: result.bCount }).toEqual({
        aCount: 7,
        bCount: 9,
      });
    });

    it("keeps its deployed child's state through an update that moves it and changes its source, in a runtime that has not loaded the parent's previous pattern", async () => {
      // Only the previous pattern places `a` here: its identity changed, and
      // the spot `s` takes holds `a`'s deployed child. The start's pre-sync
      // is what loads that pattern from the parent's stored source.

      await deployedParent("fresh-runtime-previous-pattern");
      const cell = await freshRuntime("fresh-runtime-previous-pattern");

      const result = await update(
        cell,
        parentProgram(
          [
            "  const s = Other({ label: 's' });",
            "  const a = Counter({ label: 'a' });",
            "  return { views: [s, a], aCount: a.count, sCount: s.count };",
          ].join("\n"),
          `${COUNTER}// A newer version.\n`,
        ),
      );

      expect({ aCount: result.aCount, sCount: result.sCount }).toEqual({
        aCount: 7,
        sCount: 0,
      });
    });

    it("starts fresh, rather than take a child at its positional spot that carries another instance's name, when the parent carries no setup marker", async () => {
      const cell = await deployedParent("no-setup-marker-stamped", {
        marker: "absent",
      });
      await writeMeta(positionalChild(cell, 0), { instanceName: "zzz" });

      const result = await update(cell, NAMED_WITH_NEWER_COUNTER);

      expect(result.aCount).toBe(0);
    });

    it("starts fresh, rather than take a child of another pattern at its positional spot, when children of its own pattern run at other spots of a parent with no setup marker", async () => {
      // Two `Counter` children leave identity matching undecided, and the
      // `Other` child at `a`'s own spot is the sign the children moved.

      const cell = await deployedParent("no-setup-marker-own-identity-moved", {
        marker: "absent",
        deployed: DEPLOYED_THREE,
        named: DEPLOYED_THREE,
        counts: { oCount: 5, c1Count: 7, c2Count: 9 },
      });

      const result = await update(cell, NAMED);

      expect(result.aCount).toBe(0);
    });

    it("takes the child at its own positional spot, rather than either of two children of its pattern, when the parent carries no setup marker", async () => {
      const cell = await deployedParent("no-setup-marker-two-matches", {
        marker: "absent",
        deployed: DEPLOYED_TWO,
        named: NAMED_TWO,
        counts: { aCount: 7, bCount: 9 },
      });

      const result = await update(cell, NAMED_WITH_SIBLING);

      expect({ aCount: result.aCount, sCount: result.sCount }).toEqual({
        aCount: 9,
        sCount: 0,
      });
    });

    it("starts fresh, rather than take a child another instance carries, through the parent's previous pattern", async () => {
      const cell = await deployedParent("claimed-previous-pattern");
      const taken = positionalChild(cell, 0).getAsNormalizedFullLink();
      await writeMeta(cell, {
        instanceChildren: {
          x: { space: taken.space, id: taken.id, scope: taken.scope },
        },
      });

      const result = await update(cell, NAMED);

      expect(result.aCount).toBe(0);
    });

    it("starts fresh, rather than take a child another instance carries, at its own positional spot", async () => {
      const cell = await deployedParent("claimed-own-spot", {
        marker: "absent",
      });
      const taken = positionalChild(cell, 0).getAsNormalizedFullLink();
      await writeMeta(cell, {
        instanceChildren: {
          x: { space: taken.space, id: taken.id, scope: taken.scope },
        },
      });

      const result = await update(cell, NAMED_WITH_NEWER_COUNTER);

      expect(result.aCount).toBe(0);
    });

    it("keeps each `.map()` element's child state through a start in a runtime that names instances", async () => {
      // The elements were set up by a runtime that named no instance, which
      // the switch reproduces with the very source that names `row`.

      const program: RuntimeProgram = {
        main: "/main.tsx",
        files: [
          { name: "/counter.tsx", contents: COUNTER },
          {
            name: "/main.tsx",
            contents: [
              "import { pattern } from 'commonfabric';",
              "import { Counter } from './counter.tsx';",
              "export default pattern<{ items: string[] }>(({ items }) => {",
              "  const rows = items.map((item) => {",
              "    const row = Counter({ label: item });",
              "    return { count: row.count };",
              "  });",
              "  return { rows };",
              "});",
              "",
            ].join("\n"),
          },
        ],
      };
      const restoreNaming = stopNamingInstancesForTesting();
      try {
        const deployed = await compile(program);
        const tx = rt.edit();
        const cell = rt.getCell<Record<string, unknown>>(
          space,
          "map-elements",
          undefined,
          tx,
        );
        const running = rt.run(tx, deployed, { items: ["x", "y"] }, cell);
        await tx.commit().settled;
        await running.pull();
        await rt.idle();
        const write = rt.edit();
        cell.withTx(write).key("rows").key(0).key("count").set(7);
        cell.withTx(write).key("rows").key(1).key("count").set(9);
        expect((await write.commit().settled).error).toBeUndefined();
        await rt.idle();
        rt.runner.stop(cell);
      } finally {
        restoreNaming();
      }
      const cell = await freshRuntime("map-elements");

      expect(await rt.runner.start(cell)).toBe(true);
      await rt.idle();
      await cell.pull();

      const rows = cell.key("rows");
      expect([
        rows.key(0).key("count").get(),
        rows.key(1).key("count").get(),
      ]).toEqual([7, 9]);
    });

    it("starts fresh, and reports it, when it is renamed", async () => {
      const named = await compile(NAMED);
      const tx = rt.edit();
      const cell = rt.getCell<Record<string, unknown>>(
        space,
        "renamed",
        undefined,
        tx,
      );
      const running = rt.run(tx, named, {}, cell);
      await tx.commit().settled;
      await running.pull();
      const write = rt.edit();
      cell.withTx(write).key("aCount").set(7);
      expect((await write.commit().settled).error).toBeUndefined();
      await rt.idle();
      rt.runner.stop(cell);
      const before = freshStarts();

      const result = await update(
        cell,
        parentProgram([
          "  const b = Counter({ label: 'a' });",
          "  return { views: [b], aCount: b.count };",
        ].join("\n")),
      );

      expect(result.aCount).toBe(0);
      expect(freshStarts() - before).toBe(1);
    });

    it("keeps the child it carried over across a further update", async () => {
      const cell = await deployedParent("further-update");
      await update(cell, NAMED_WITH_SIBLING);

      const result = await update(cell, NAMED);

      expect(result.aCount).toBe(7);
    });

    it("keeps its deployed child's state through a start under the same source and a live update after it", async () => {
      // The start is a runtime first running a deployed parent whose source
      // has not changed, and the update a pointer move the running parent's
      // watcher follows.

      const cell = await deployedParent("same-source-start");
      expect(await rt.runner.start(cell)).toBe(true);
      await rt.idle();
      await cell.pull();
      expect((cell.get() as Record<string, unknown>).aCount).toBe(7);

      const withSibling = await compile(NAMED_WITH_SIBLING);
      const ref = rt.patternManager.getArtifactEntryRef(withSibling)!;
      const stamp = rt.edit();
      cell.withTx(stamp).setMetaRaw("patternIdentity", {
        identity: ref.identity,
        symbol: ref.symbol,
      }, rawMetaWriteAuthorization);
      expect((await stamp.commit().settled).error).toBeUndefined();
      await rt.idle();
      await cell.pull();

      const result = cell.get() as Record<string, unknown>;
      expect({ aCount: result.aCount, sCount: result.sCount }).toEqual({
        aCount: 7,
        sCount: 0,
      });
    });
  });

  describe("a named instance's name", () => {
    it("gives each of two children a handler's loop binds to one `const` a child of its own", async () => {
      const program: RuntimeProgram = {
        main: "/main.tsx",
        files: [
          { name: "/counter.tsx", contents: COUNTER },
          {
            name: "/main.tsx",
            contents: [
              "import { handler, pattern, Writable } from 'commonfabric';",
              "import { Counter } from './counter.tsx';",
              "const make = handler<",
              "  void,",
              "  { counts: Writable<Writable<number>[]> }",
              ">((_, { counts }) => {",
              "  for (const label of ['x', 'y']) {",
              "    const c = Counter({ label });",
              "    counts.push(c.count);",
              "  }",
              "});",
              "export default pattern<Record<string, never>>(() => {",
              "  const counts = new Writable<Writable<number>[]>([]).for('counts');",
              "  return { counts, make: make({ counts }) };",
              "});",
              "",
            ].join("\n"),
          },
        ],
      };
      const pattern = await compile(program);
      const tx = rt.edit();
      const cell = rt.getCell<Record<string, unknown>>(
        space,
        "handler-loop-children",
        undefined,
        tx,
      );
      const running = rt.run(tx, pattern, {}, cell);
      await tx.commit().settled;
      await running.pull();
      cell.key("make").send(undefined);
      await rt.idle();
      await cell.pull();

      // Each element links to the `count` of the child the loop made for it.
      const links = cell.key("counts").resolveAsCell().getRaw() as {
        "/": { "link@1": { id: string } };
      }[];
      expect(links.length).toBe(2);
      expect(links[0]["/"]["link@1"].id).not.toBe(links[1]["/"]["link@1"].id);
    });

    it("binds an instance named for an inherited member to a child of its own", async () => {
      const program = parentProgram([
        "  const toString = Counter({ label: 'a' });",
        "  return { views: [toString], aCount: toString.count };",
      ].join("\n"));
      const pattern = await compile(program);
      const tx = rt.edit();
      const cell = rt.getCell<Record<string, unknown>>(
        space,
        "inherited-member-name",
        undefined,
        tx,
      );
      const running = rt.run(tx, pattern, {}, cell);
      await tx.commit().settled;
      await running.pull();
      const write = rt.edit();
      cell.withTx(write).key("aCount").set(5);
      expect((await write.commit().settled).error).toBeUndefined();
      await rt.idle();
      await cell.pull();

      expect((cell.get() as Record<string, unknown>).aCount).toBe(5);
    });
  });

  describe("a named instance's child", () => {
    it("refuses to set up for one instance over the child another instance set up", async () => {
      // A parent's `instanceChildren` pointing instance `a` at `b`'s child is
      // what a wrong carry-over would leave.

      const named = await compile(NAMED_TWO);
      const tx = rt.edit();
      const cell = rt.getCell<Record<string, unknown>>(
        space,
        "stamped-children",
        undefined,
        tx,
      );
      const running = rt.run(tx, named, {}, cell);
      await tx.commit().settled;
      await running.pull();
      await rt.idle();
      rt.runner.stop(cell);
      const spot = getDerivedInternalCellLink(cell, {
        partialCause: instancePartialCause("b"),
      });
      const bChild = rt.getCell(space, {
        resultFor: { space: spot.space, id: spot.id, path: [] },
      }).getAsNormalizedFullLink();
      const wrong = rt.edit();
      cell.withTx(wrong).setMetaRaw("instanceChildren", {
        a: { space: bChild.space, id: bChild.id, scope: bChild.scope },
      }, rawMetaWriteAuthorization);
      expect((await wrong.commit().settled).error).toBeUndefined();

      await expect(update(cell, NAMED_TWO)).rejects.toThrow(
        /refusing to set up .*#Counter for instance "a" over the child of .*#Counter that instance "b" set up/,
      );
    });
  });

  describe("a positional child", () => {
    it("leaves its parent on the pattern it ran before when it refuses", async () => {
      const cell = await deployedParent("refusal-leaves-parent");
      const before = cell.getMetaRaw("patternSetupIdentity");

      await expect(update(cell, POSITIONAL_WITH_SIBLING)).rejects.toThrow(
        /refusing to set up/,
      );
      await cell.sync();

      expect(cell.getMetaRaw("patternSetupIdentity")).toEqual(before);
    });

    it("updates in place when two children of one pattern take a newer version of its source", async () => {
      const cell = await deployedParent("positional-same-pattern-newer", {
        deployed: DEPLOYED_TWO,
        named: DEPLOYED_TWO,
        counts: { aCount: 7, bCount: 9 },
      });

      const result = await update(cell, DEPLOYED_TWO_NEWER_COUNTER);

      expect({ aCount: result.aCount, bCount: result.bCount }).toEqual({
        aCount: 7,
        bCount: 9,
      });
    });

    it("refuses to set up over a child whose own pattern another positional spot sets up", async () => {
      const cell = await deployedParent("positional-moved");

      await expect(update(cell, POSITIONAL_WITH_SIBLING)).rejects.toThrow(
        /refusing to set up .*#Other for a positional spot over the child of .*#Counter: another positional spot of its parent sets up .*#Counter/,
      );
    });

    it("refuses to set up over a child of another pattern when a child of its own pattern runs at another positional spot", async () => {
      const positional = parentProgram([
        "  const [o, a] = [Other({ label: 'o' }), Counter({ label: 'a' })];",
        "  return { views: [o, a], aCount: a.count, oCount: o.count };",
      ].join("\n"));
      const cell = await deployedParent("positional-incoming-elsewhere", {
        deployed: positional,
        named: positional,
      });

      await expect(update(
        cell,
        parentProgram([
          "  const [a, t] = [Counter({ label: 'a' }), Third({ label: 't' })];",
          "  return { views: [a, t], aCount: a.count, tCount: t.count };",
        ].join("\n")),
      )).rejects.toThrow(
        /refusing to set up .*#Counter for a positional spot over the child of .*#Other: a child of .*#Counter runs at another positional spot/,
      );
    });

    it("refuses to set up over the child a named instance carried over", async () => {
      const cell = await deployedParent("positional-over-carried");

      await expect(update(cell, POSITIONAL_SIBLING_OF_NAMED)).rejects.toThrow(
        /refusing to set up .*#Other for a positional spot over the child of .*#Counter that instance "a" carries/,
      );
    });
  });
});
