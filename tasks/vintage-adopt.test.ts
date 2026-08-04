/**
 * The adopter's own invariant: an adopt the tool accepts must be a replay the
 * gate accepts, and an adopt the gate would refuse must refuse HERE, with
 * nothing written. `captureVintage` holds the same invariant for native
 * captures; these cases hold it for the adopted route, where the operator
 * supplies by hand what a capture derives mechanically — so every argument is
 * a chance to pin a fixture whose every replay fails.
 */
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { FileSystemProgramResolver } from "@commonfabric/js-compiler";
import {
  materializeOnCell,
  openFileBackedRuntime,
} from "../packages/piece/test/state-continuity-harness.ts";
import { type AdoptRoots, adoptVintage } from "./vintage-adopt.ts";
import { collectVintages } from "./pattern-vintage-lib.ts";
import { replayAll } from "./pattern-vintage-run.ts";

const signer = await Identity.fromPassphrase("pattern vintage fixture");

const KEY = "adopt-subject.tsx";
const CAUSE = "adopt-test-root";

/** Minimal but real: a durable `.for()` cell, so the replay's before/after
 * comparison has state to protect. */
const SUBJECT = [
  "import { Writable, pattern } from 'commonfabric';",
  "export interface Output { items: Writable<string[]> }",
  "export default pattern<Record<string, never>, Output>(() => {",
  "  const items = new Writable<string[]>(['kept']).for('items');",
  "  return { items };",
  "});",
  "",
].join("\n");

/**
 * A compatible evolution of SUBJECT — a new defaulted field — so today's
 * identity differs from the captured one and the replay actually
 * materializes and compares state instead of short-circuiting on an
 * unchanged identity. This is the shape a real adoption always has: the
 * whole point of an old-toolchain capture is that today's source moved on.
 */
const SUBJECT_CHANGED = SUBJECT
  .replace(
    "import { Writable, pattern }",
    "import { Default, Writable, pattern }",
  )
  .replace(
    "export interface Output { items: Writable<string[]> }",
    "export interface Output { items: Writable<string[]>; " +
      "later: Writable<string[] | Default<[]>> }",
  )
  .replace(
    "  return { items };",
    "  const later = new Writable<string[]>([]).for('later');\n" +
      "  return { items, later };",
  );

describe("vintage adopt", () => {
  let dir = "";
  let roots: AdoptRoots;
  let snapshotPath = "";
  let identity = "";

  beforeEach(async () => {
    dir = await Deno.makeTempDir({ prefix: "vintage-adopt-test-" });
    await Deno.mkdir(`${dir}/patterns`, { recursive: true });
    await Deno.writeTextFile(`${dir}/patterns/${KEY}`, SUBJECT);
    roots = {
      repoRoot: dir,
      patternsRoot: `${dir}/patterns`,
      vintagesRoot: `${dir}/vintages`,
      signer,
    };

    // Stand in for an external capture: a store holding the subject
    // materialized at a known cause. The adopter must not care who wrote the
    // store — only that the root at the cause carries a pattern identity.
    const storeDir = await Deno.makeTempDir({ prefix: "adopt-capture-" });
    const capture = await openFileBackedRuntime(signer, storeDir);
    try {
      const program = await capture.runtime.harness.resolve(
        new FileSystemProgramResolver(`${dir}/patterns/${KEY}`, dir),
      );
      const outcome = await materializeOnCell(
        capture,
        program as never,
        (v, resultSchema) =>
          v.runtime.getCell(
            v.space as never,
            CAUSE,
            resultSchema as never,
          ),
      );
      expect(outcome.error).toBeUndefined();
      identity = capture.runtime.patternManager.getArtifactEntryRef(
        await capture.runtime.patternManager.compilePattern(program as never, {
          space: capture.space as never,
        }),
      )!.identity;
      snapshotPath = `${dir}/external-capture.sqlite`;
      await capture.snapshot(snapshotPath);
    } finally {
      await capture.dispose();
      await Deno.remove(storeDir, { recursive: true }).catch(() => {});
    }
  });

  afterEach(async () => {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  });

  const adopt = (overrides: Record<string, unknown> = {}) =>
    adoptVintage({
      snapshotPath,
      expectedIdentity: identity,
      testKey: "adopt-subject.test.tsx",
      main: `/patterns/${KEY}`,
      cause: CAUSE,
      roots,
      now: new Date("2026-08-04T12:00:00.000Z"),
      ...overrides,
    });

  it("adopts a snapshot the replay then accepts and MIGRATES", async () => {
    // The invariant itself, end to end — and through the path adoption
    // exists for. The source moves on after the capture, so today's identity
    // differs from the recorded one and the replay must actually materialize
    // today's source over the adopted root and compare state, not
    // short-circuit on an unchanged identity.
    await Deno.writeTextFile(`${dir}/patterns/${KEY}`, SUBJECT_CHANGED);
    const dest = await adopt();
    expect((await Deno.stat(dest)).size).toBeGreaterThan(0);
    expect(await collectVintages(roots.vintagesRoot)).toHaveLength(1);

    const { replayed, failures, changed, updated, stranded } = await replayAll(
      roots,
    );
    expect(failures).toEqual([]);
    expect(replayed).toBe(1);
    expect(changed).toBe(1);
    expect(updated).toBe(1);
    expect(stranded).toBe(0);
  });

  it("refuses a main the replay could not map, writing nothing", async () => {
    await expect(adopt({ main: "not-a-repo-path" })).rejects.toThrow(
      "does not map to a pattern key",
    );
    expect(await collectVintages(roots.vintagesRoot)).toHaveLength(0);
  });

  it("refuses a test entry, which is never an upgrade target", async () => {
    await expect(adopt({ main: "/patterns/adopt-subject.test.tsx" })).rejects
      .toThrow("not an upgrade target");
    expect(await collectVintages(roots.vintagesRoot)).toHaveLength(0);
  });

  it("refuses a served route, which is not identity-compared", async () => {
    // `patternKeyFromMain` maps `/api/patterns/...` too, but the replay
    // accounts served routes apart from identity comparison — the opposite of
    // what an adopted fixture is for.
    await expect(adopt({ main: `/api/patterns/${KEY}` })).rejects.toThrow(
      "served route",
    );
    expect(await collectVintages(roots.vintagesRoot)).toHaveLength(0);
  });

  it("refuses when today's source for main is missing", async () => {
    await expect(adopt({ main: "/patterns/no-such-file.tsx" })).rejects
      .toThrow("does not resolve");
    expect(await collectVintages(roots.vintagesRoot)).toHaveLength(0);
  });

  it("refuses when today's source no longer compiles", async () => {
    // The drift class itself, pointed the WRONG way: the fixture must hold an
    // old source today cannot compile, but a pin against a broken CURRENT
    // source would fail every replay from the moment it lands.
    await Deno.writeTextFile(
      `${dir}/patterns/${KEY}`,
      SUBJECT.replace("['kept']", "(no_such_symbol)"),
    );
    await expect(adopt()).rejects.toThrow("does not compile");
    expect(await collectVintages(roots.vintagesRoot)).toHaveLength(0);
  });

  it("refuses an identity the stored root does not carry", async () => {
    await expect(adopt({ expectedIdentity: "someOtherIdentity" })).rejects
      .toThrow("!= expected");
    expect(await collectVintages(roots.vintagesRoot)).toHaveLength(0);
  });

  it("refuses a cause that derives no captured root", async () => {
    await expect(adopt({ cause: "nothing-was-minted-here" })).rejects.toThrow(
      "carries no patternIdentity",
    );
    expect(await collectVintages(roots.vintagesRoot)).toHaveLength(0);
  });

  it("never overwrites an existing fixture", async () => {
    // Same `now`, same identity → same destination path. The second adopt
    // must refuse rather than replace the fixture the first one pinned.
    await adopt();
    await expect(adopt()).rejects.toThrow("refusing to overwrite");
    expect(await collectVintages(roots.vintagesRoot)).toHaveLength(1);
  });
});
