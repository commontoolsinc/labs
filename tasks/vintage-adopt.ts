/**
 * Adopt an externally captured space snapshot as a pinned vintage fixture.
 *
 * The capture side of this runs OUT of process — in a git worktree at an old
 * revision, under that revision's own toolchain — precisely because the store
 * it produces holds source closures the current toolchain may no longer
 * compile (`docs/specs/pattern-update-testing.md`, "Adopting an externally
 * captured fixture"). This tool is the current-tree half: it opens the
 * snapshot (running the memory migration chain, as reopening any old space
 * does), re-derives the recorded root from its capture cause, verifies the
 * root's stored `patternIdentity` matches what the capture reported, writes
 * the in-store manifest and restore-control doc, and emits a normal pinned
 * fixture.
 *
 * The root is derived from CAUSE rather than taken as an id argument: entity
 * ids are cause-derived and stable across revisions, so a derivation that
 * lands on a cell with the wrong (or no) stored identity fails the adopt
 * loudly instead of minting a fixture whose manifest addresses nothing.
 *
 * Usage:
 *   deno run --allow-ffi --allow-read --allow-write --allow-env --allow-net \
 *     tasks/vintage-adopt.ts <snapshot.sqlite> <identity> <test key> <main> [cause]
 *
 *   <identity>  the pattern identity the capture reported for the root
 *   <test key>  fixture directory key, e.g. system/home.test.tsx
 *   <main>      repo path replay resolves today's source from,
 *               e.g. /packages/patterns/system/home.tsx
 *   [cause]     capture cause of the root cell (default "home-pattern",
 *               the cause `ensureDefaultPattern` mints the home root with)
 */
import { Identity } from "@commonfabric/identity";
import {
  openFileBackedRuntime,
  readVintageManifest,
  type VintageManifestEntry,
  vintageRoot,
  writeVintageManifest,
} from "../packages/piece/test/state-continuity-harness.ts";
import { getPatternIdentityRef } from "@commonfabric/runner";
import type { Cell } from "@commonfabric/runner";
import {
  PINNED,
  stampFor,
  vintageFileName,
  VINTAGES_DIR,
} from "./pattern-vintage-lib.ts";

const [snapshotPath, expectedIdentity, testKey, main] = Deno.args;
const cause = Deno.args[4] ?? "home-pattern";
if (!snapshotPath || !expectedIdentity || !testKey || !main) {
  console.error(
    "usage: vintage-adopt.ts <snapshot.sqlite> <identity> <test key> <main> [cause]",
  );
  Deno.exit(2);
}

const signer = await Identity.fromPassphrase("pattern vintage fixture");
const dir = await Deno.makeTempDir({ prefix: "vintage-adopt-" });
const vintage = await openFileBackedRuntime(signer, dir, snapshotPath);
try {
  console.log("space:", vintage.space);
  console.log("restored spaces:", vintage.restoredSpaces);

  const root = vintage.runtime.getCell(
    vintage.space as never,
    cause,
    undefined as never,
  ) as Cell<unknown>;
  await root.sync();
  const link = root.getAsNormalizedFullLink();
  console.log("derived root id:", link.id);

  const ref = getPatternIdentityRef(root);
  console.log("stored patternIdentity:", ref);
  if (ref === undefined) {
    throw new Error(
      `root derived from cause "${cause}" carries no patternIdentity — ` +
        "wrong cause or empty store",
    );
  }
  if (ref.identity !== expectedIdentity) {
    throw new Error(
      `stored identity ${ref.identity} != expected ${expectedIdentity}`,
    );
  }

  const entry: VintageManifestEntry = {
    identity: ref.identity,
    symbol: ref.symbol,
    main,
    cellId: String(link.id),
    space: vintage.space,
  };
  await writeVintageManifest(vintage, [entry]);
  const back = await readVintageManifest(vintage);
  console.log("manifest readback:", JSON.stringify(back));

  // The replay's restore control reads a doc at the known vintage-root cause
  // (a native capture pins the test run's result there). An adopted fixture
  // has no test run, so stamp a marker doc: it travels in the same file, so
  // its presence after restore proves restoration the same way.
  const control = vintageRoot<Record<string, unknown>>(vintage, undefined);
  const { error } = await vintage.runtime.editWithRetry((tx) => {
    control.withTx(tx).set({
      adoptedFrom: snapshotPath.split("/").pop() ?? snapshotPath,
    });
  });
  if (error !== undefined) {
    throw new Error(`could not stamp restore control: ${error.message}`);
  }
  await vintage.runtime.idle();
  await vintage.runtime.storageManager.synced();

  const stamp = stampFor(new Date());
  const outDir = `${VINTAGES_DIR}/${testKey}/${PINNED}`;
  await Deno.mkdir(outDir, { recursive: true });
  const dest = `${outDir}/${vintageFileName(stamp, ref.identity)}`;
  try {
    await Deno.lstat(dest);
    throw new Error(`refusing to overwrite existing fixture: ${dest}`);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  await vintage.snapshot(dest);
  console.log("fixture written:", dest);
} finally {
  await vintage.dispose();
  await Deno.remove(dir, { recursive: true }).catch(() => {});
}
