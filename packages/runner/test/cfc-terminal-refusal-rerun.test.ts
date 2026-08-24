/**
 * A terminal CFC refusal ends the RETRY sequence, not the subscription.
 *
 * Classifying the boundary refusal as terminal stops the scheduler
 * re-running a doomed computation against unchanged inputs. It must not also
 * strand the action: when a value the run READ changes, the action re-runs on
 * that change like any other. Nothing in the terminal path touches
 * subscription or trigger registration — the resubscribe is on the run path,
 * keyed on the run having happened at all — and this pins that end to end.
 *
 * It asserts that the action RE-RUNS, not that the re-run's write lands: CFC
 * labels are monotone, so a source cannot be un-labelled and a re-run over
 * still-labelled data is refused again, correctly. Re-running is the property
 * under test; whether the fresh verdict differs is policy's business.
 *
 * A METADATA-only change (widening a declared label, value byte-identical)
 * does NOT re-trigger a reader. That is pre-existing and independent of this
 * change — a succeeding action that never meets a refusal does not re-run on
 * one either — so it is reported rather than pinned here. It is also coherent
 * with monotonicity: a label can only widen, so a metadata change can tighten
 * a verdict but never loosen one, and a re-run could not turn a refusal into
 * a success.
 */
import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { Runtime } from "../src/runtime.ts";
import type { Action } from "../src/scheduler.ts";

const signer = await Identity.fromPassphrase("runner-cfc-terminal-rerun");

/**
 * The source's schema DECLARES its labels, rather than the seed hand-writing
 * a `cfc` envelope: an envelope has to name a schema hash, and an invented
 * one refuses at the memory boundary, where a content-addressed schema
 * document must be included in the commit or already stored. Declaring it
 * lets the runtime derive the label and persist the canonical schema document
 * itself, which is also how a pattern author would write it.
 */
const sourceSchema = (confidentiality: readonly string[]) => ({
  type: "object" as const,
  properties: {
    secret: { type: "string" as const, ifc: { confidentiality } },
  },
});

const SOURCE = "terminal-rerun-source";

const seedSource = async () => {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL("https://example.com"),
    storageManager,
    // The shipped shell posture; the action's own transaction escalates to
    // `enforce-strict` per-tx, the same seam cfc-writer-fit uses. A
    // runtime-wide strict would put the SEED under strict too.
    cfcEnforcementMode: "enforce-explicit",
    cfcFlowLabels: "persist",
  });
  const space = signer.did();
  const tx = runtime.edit();
  const source = runtime.getCell<{ secret: string }>(
    space,
    SOURCE,
    sourceSchema(["secret"]),
    tx,
  );
  source.set({ secret: "s3cr3t" });
  runtime.prepareTxForCommit(tx);
  // Assert on the ERROR, not on `ok`: a seed that cannot land says why in the
  // failure message instead of reporting an undefined `ok`.
  expect((await tx.commit()).error).toBeUndefined();
  return { storageManager, runtime, space, source };
};

/** Subscribes an action whose own transaction runs at enforce-strict. */
const subscribeRefusedCopy = (
  runtime: Runtime,
  space: string,
  source: {
    withTx: (tx: unknown) => { get(): { secret: string } | undefined };
  },
  outName: string,
) => {
  const out = runtime.getCell<{ copied?: string }>(space, outName, {
    type: "object",
    properties: { copied: { type: "string" } },
  });
  const state = { runs: 0 };
  const copy: Action = (tx) => {
    state.runs++;
    tx.setCfcEnforcementMode("enforce-strict");
    const secret = source.withTx(tx).get()?.secret ?? "";
    out.withTx(tx).set({ copied: `${secret}!` });
  };
  runtime.scheduler.subscribe(copy, { isEffect: true });
  return { out, state };
};

describe("cfc terminal refusal re-run", () => {
  it("re-runs the refused action when a read VALUE changes", async () => {
    const { storageManager, runtime, space, source } = await seedSource();
    try {
      const { out, state } = subscribeRefusedCopy(
        runtime,
        space,
        source,
        "terminal-rerun-out-value",
      );
      await runtime.scheduler.idleWithPendingCommits();

      // The derived write carries the source's confidentiality and is
      // refused. Terminal: exactly one run, where the bounded retry used to
      // spend ten and then defer past the convergence budget.
      expect(state.runs).toBe(1);
      expect(out.get()?.copied).toBeUndefined();
      await runtime.scheduler.idleWithPendingCommits();
      expect(state.runs).toBe(1);

      // A change to what the run READ re-triggers it, exactly as it would
      // after a successful commit.
      const update = runtime.edit();
      runtime.getCell<{ secret: string }>(
        space,
        SOURCE,
        sourceSchema(["secret"]),
        update,
      ).set({ secret: "rotated" });
      runtime.prepareTxForCommit(update);
      expect((await update.commit()).error).toBeUndefined();
      await runtime.scheduler.idleWithPendingCommits();

      expect(state.runs).toBeGreaterThan(1);
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });
});
