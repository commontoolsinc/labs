import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import type { RuntimeProgram } from "@commonfabric/runner";
import {
  openFileBackedRuntime,
  VINTAGE_ROOT_CAUSE,
  type VintageRuntime,
} from "./state-continuity-harness.ts";

/**
 * Tier 2: replay a captured prior state under a NEW pattern version.
 *
 * Tier 1 proves the argument/result contract is backward compatible. These
 * cases are the ones it cannot see — both patterns below have contracts Tier 1
 * is happy with, and one of them still cannot be applied to a document the
 * other wrote.
 *
 * Shape of each test: capture a real space written by the OLD pattern, snapshot
 * it, then open a fresh runtime over that snapshot and materialize the NEW
 * pattern onto the same root cell.
 */

const signer = await Identity.fromPassphrase("state continuity vintage");

/** The vintage: no `favorites` field at all, so a doc it writes has no value. */
const OLD_WITHOUT_FAVORITES: RuntimeProgram = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      "import { Writable, pattern } from 'commonfabric';",
      "interface Output { items: Writable<string[]>; }",
      "export default pattern<Record<string, never>, Output>(() => {",
      "  const items = new Writable<string[]>([]).for('items');",
      "  return { items };",
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
      "import { Writable, pattern } from 'commonfabric';",
      "interface Output {",
      "  items: Writable<string[]>;",
      "  favorites: Writable<string[]>;",
      "}",
      "export default pattern<Record<string, never>, Output>(() => {",
      "  const items = new Writable<string[]>([]).for('items');",
      "  const favorites = new Writable<string[]>([]).for('favorites');",
      "  return { items, favorites };",
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
      "import { Default, Writable, pattern } from 'commonfabric';",
      "interface Output {",
      "  items: Writable<string[]>;",
      "  favorites: Writable<string[] | Default<[]>>;",
      "}",
      "export default pattern<Record<string, never>, Output>(() => {",
      "  const items = new Writable<string[]>([]).for('items');",
      "  const favorites = new Writable<string[]>([]).for('favorites');",
      "  return { items, favorites };",
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
    const pattern = await vintage.runtime.patternManager.compilePattern(
      program,
      { space: vintage.space as never },
    );
    const root = vintage.runtime.getCell(
      vintage.space as never,
      VINTAGE_ROOT_CAUSE,
      pattern.resultSchema,
    );
    const tx = vintage.runtime.edit();
    vintage.runtime.setup(tx, pattern, {}, root);
    await tx.commit();
    await vintage.runtime.idle();

    // Populate: this is the state the new version has to keep reachable.
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

  /** Materialize `program` onto the captured root. Returns the setup error. */
  async function applyOver(
    captured: Captured,
    program: RuntimeProgram,
  ): Promise<
    {
      error?: string;
      items?: unknown;
      favorites?: unknown;
      cfcMode?: string;
    }
  > {
    const dir = await tempDir("continuity-replay-");
    const vintage = await openRuntime(dir, captured.snapshot);
    const pattern = await vintage.runtime.patternManager.compilePattern(
      program,
      { space: vintage.space as never },
    );
    const root = vintage.runtime.getCell(
      vintage.space as never,
      VINTAGE_ROOT_CAUSE,
      pattern.resultSchema,
    );
    await root.sync();
    try {
      const tx = vintage.runtime.edit();
      vintage.runtime.setup(tx, pattern, {}, root, {
        prepareForResume: true,
        reapplyStoredSetup: true,
      });
      await tx.commit();
      await vintage.runtime.idle();
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
    const value = root.get() as Record<string, unknown> | undefined;
    return {
      items: value?.items,
      favorites: value?.favorites,
      cfcMode: vintage.runtime.cfcEnforcementMode,
    };
  }

  it("captures a real space and reads its state back from the snapshot", async () => {
    // The mechanism itself: a snapshot must be a faithful, reopenable space.
    const captured = await capture(OLD_WITHOUT_FAVORITES, ["alpha", "beta"]);
    expect(Deno.statSync(captured.snapshot).size).toBeGreaterThan(0);

    const result = await applyOver(captured, OLD_WITHOUT_FAVORITES);
    expect(result.error).toBeUndefined();
    expect(result.items).toEqual(["alpha", "beta"]);
  });

  it("keeps prior state reachable when the new field carries a default", async () => {
    const captured = await capture(OLD_WITHOUT_FAVORITES, ["alpha", "beta"]);
    const result = await applyOver(captured, NEW_DEFAULTED);

    expect(result.error).toBeUndefined();
    // The point of the tier: the data the OLD version wrote survives.
    expect(result.items).toEqual(["alpha", "beta"]);
    expect(result.favorites).toEqual([]);
  });

  it("materializes an additive field over a vintage doc through bare setup", async () => {
    // Boundary marker, and a correction to an assumption worth recording.
    //
    // The 2026-07-22 estuary brick is CFC schema-merge refusing an additive
    // REQUIRED field with no `default` ("required field <name> needs a default
    // to preserve old documents", packages/runner/src/cfc/schema-merge.ts:407).
    // That guard does NOT fire on this path: enforcement is on
    // (`enforce-explicit`) and the field still materializes, because the
    // pattern's own setup creates the owned cell with its initial value, so
    // there is no missing value to preserve.
    //
    // Reaching the guard needs the root repair path — `PiecesController`
    // /`ensureDefaultPattern` over a piece result cell, as
    // check-update-default-pattern.test.ts drives it — not a bare
    // `runtime.setup` onto a plain cell. Wiring this harness to that path is
    // the next step; until then this tier catches reachability, not the CFC
    // migration class.
    const captured = await capture(OLD_WITHOUT_FAVORITES, ["alpha", "beta"]);
    const result = await applyOver(captured, NEW_REQUIRED_NO_DEFAULT);

    expect(result.cfcMode).toBe("enforce-explicit");
    expect(result.error).toBeUndefined();
    expect(result.items).toEqual(["alpha", "beta"]);
    expect(result.favorites).toEqual([]);
  });
});
