/**
 * SCRATCH instrumentation test (scratch/cellset-conflict-probe) — NOT for merge.
 *
 * Confirms, with the env-gated `[CSPROBE]` probes (CELLSET_PROBE=1), the two
 * mechanisms behind the cfc-group-chat-demo cell-write flake:
 *
 *   Claim 1 — the `$value` profileDraft set commit carries a confirmed read of
 *     the write target; under a concurrent same-user write that read is rejected
 *     (tier-2 patch path-overlap → "stale confirmed read … conflicted"), and the
 *     rejected write is rolled back — the flake.
 *   Claim 2 — because of Claim 1, a genuine concurrent edit is LOST: alice's
 *     later edit, baselined at a stale seq, conflicts and rolls back, so the
 *     older remote write wins.
 *
 * THE FIX (prototype): mark the `handleCellSet` transaction as a UI-input blind
 * write (markUiInputBlindWriteTx); the storage layer then records its reads for
 * CFC/scheduling but excludes them from commit preconditions, so a `$value` set
 * is a precondition-free LWW leaf write. S3 (conflict) and S4 (lost edit) both
 * go to 0. (A same-VALUE echo of the stale local value remains a no-op — that is
 * NOT data loss and forcing it is a separate, design-open question.)
 *
 * profileDraft is PerUser, so two sessions of the SAME identity share the doc —
 * the documented "own-write race" (≈ two browser tabs of one user).
 *
 * Run:
 *   CELLSET_PROBE=1 deno test -A \
 *     packages/patterns/integration/cfc-cellset-conflict-probe.test.ts 2>&1 \
 *     | tee /tmp/csprobe.out
 */

import { assert } from "@std/assert";
import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { join } from "@std/path";
import { Identity } from "@commonfabric/identity";
import {
  MultiRuntimeHarness,
  type MultiRuntimeSession,
} from "./multi-runtime-harness.ts";

const PROGRAM_PATH = join(
  import.meta.dirname!,
  "..",
  "cfc-group-chat-demo",
  "main.tsx",
);
const ROOT_PATH = join(import.meta.dirname!, "..");
const DRAFT_PATH: (string | number)[] = ["profileDraft"];

describe("cellset conflict probe (scratch)", () => {
  let harness: MultiRuntimeHarness;
  let alice: MultiRuntimeSession;
  let aliceTab2: MultiRuntimeSession;

  beforeAll(async () => {
    const aliceId = await Identity.fromPassphrase("cellset-probe alice", {
      implementation: "noble",
    });
    harness = await MultiRuntimeHarness.create({
      programPath: PROGRAM_PATH,
      rootPath: ROOT_PATH,
      sessions: [
        { label: "alice", identity: aliceId },
        // Same user as alice, separate session ≈ second browser tab.
        { label: "alice-tab2", identity: aliceId },
      ],
    });
    alice = harness.session("alice");
    aliceTab2 = harness.session("alice-tab2");
    const link = await alice.link([...DRAFT_PATH]);
    console.log(
      `[SCENARIO] profileDraft link: id=${link.id} scope=${link.scope} ` +
        `path=${JSON.stringify(link.path)}`,
    );
  });

  afterAll(async () => {
    await harness?.dispose();
  });

  it("S1: enumerates the confirmed reads a $value profileDraft set carries", async () => {
    await harness.settle();
    console.log("[SCENARIO] S1 begin: single profileDraft set (grep engine reads)");
    const res = await alice.set([...DRAFT_PATH], "Alice-S1");
    console.log(`[SCENARIO] S1 end: set result=${JSON.stringify(res)}`);
    await harness.settle();
    assert(res.ok, `S1 set should succeed: ${JSON.stringify(res.error)}`);
  });

  it("S2: no-op suppression — re-setting the same value sends nothing", async () => {
    await alice.set([...DRAFT_PATH], "Repeat-S2");
    await harness.settle();
    console.log(
      "[SCENARIO] S2 begin: re-set IDENTICAL value (expect NOOP-SUPPRESS + hasWrites=false)",
    );
    const res = await alice.set([...DRAFT_PATH], "Repeat-S2");
    console.log(`[SCENARIO] S2 end: re-set result=${JSON.stringify(res)}`);
    await harness.settle();
    assert(res.ok, "S2 suppressed re-set still resolves ok");
  });

  it("S3: own-write race — concurrent same-user sets conflict via stale confirmed read", async () => {
    const ITERS = 8;
    let conflicts = 0;
    for (let i = 0; i < ITERS; i++) {
      await harness.settle(); // both converge to the same baseline seq
      console.log(`[SCENARIO] S3 iter=${i}: concurrent alice/tab2 set`);
      const [a, b] = await Promise.all([
        alice.set([...DRAFT_PATH], `alice-${i}`, { idle: false }),
        aliceTab2.set([...DRAFT_PATH], `tab2-${i}`, { idle: false }),
      ]);
      const conflicted = [a, b].filter((r) => !r.ok);
      if (conflicted.length > 0) {
        conflicts++;
        console.log(
          `[SCENARIO] S3 iter=${i} CONFLICT: ${
            JSON.stringify(conflicted.map((c) => c.error))
          }`,
        );
      } else {
        console.log(`[SCENARIO] S3 iter=${i}: no conflict (both ok)`);
      }
    }
    console.log(`[SCENARIO] S3 total conflicts: ${conflicts}/${ITERS}`);
    // POST-FIX expectation. Pre-fix (no blind-write mode) this was 8/8.
    // The precondition-free leaf write removes the conflicting write-target read.
    assert(
      conflicts === 0,
      `S3: own-write race should no longer conflict (pre-fix 8/8), got ${conflicts}/${ITERS}`,
    );
  });

  it("S4: LWW — alice's genuine later edit against a stale baseline is not lost", async () => {
    const ITERS = 10;
    let lost = 0;
    for (let i = 0; i < ITERS; i++) {
      const base = `base-${i}`;
      const remote = `remote-${i}`;
      const aliceEdit = `alice-edit-${i}`;
      // 1) baseline both sessions at `base`.
      await alice.set([...DRAFT_PATH], base);
      await harness.settle();
      // 2) tab2 writes a new value; do NOT settle alice — her local stays stale
      //    at `base` while tab2's `remote` is in flight.
      await aliceTab2.set([...DRAFT_PATH], remote, { idle: false });
      // 3) alice makes a GENUINE edit (a different value), later in wall-clock.
      //    Pre-fix this was lost: her write-target read, baselined at the stale
      //    seq, conflicted with tab2's overlapping patch → reject + rollback →
      //    her edit vanished. Fix A removes that precondition, so her later edit
      //    commits and wins LWW.
      const aRes = await alice.set([...DRAFT_PATH], aliceEdit, { idle: false });
      await harness.settle();
      const finalA = await alice.read([...DRAFT_PATH]);
      const won = finalA === aliceEdit;
      if (!won) lost++;
      console.log(
        `[SCENARIO] S4 iter=${i}: aliceEdit(${aliceEdit}) ok=${aRes.ok} ` +
          `final=${JSON.stringify(finalA)} won=${won}`,
      );
    }
    console.log(`[SCENARIO] S4 alice-edit lost: ${lost}/${ITERS}`);
    // A genuine concurrent edit must not be lost. (A same-VALUE echo of the
    // stale local value is a separate, design-open question — it is correctly a
    // no-op here and is NOT data loss; see the prototype notes.)
    assert(
      lost === 0,
      `S4: alice's later genuine edit must win LWW (pre-fix lost via conflict rollback), got ${lost}/${ITERS} lost`,
    );
  });
});
