/**
 * A terminal CFC refusal ends the RETRY sequence, not the subscription.
 *
 * Classifying the boundary refusal as terminal stops the scheduler
 * re-running a doomed computation against unchanged inputs. It must not also
 * strand the action: when something the run READ changes — its value, or the
 * CFC metadata that decides the verdict — the action re-runs on that change
 * like any other, and can then succeed. Nothing in the terminal path touches
 * subscription or trigger registration (the resubscribe is on the run path,
 * keyed on the run happening at all), and these pin that end to end.
 */
import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { Runtime } from "../src/runtime.ts";
import type { Action } from "../src/scheduler.ts";

const signer = await Identity.fromPassphrase("runner-cfc-terminal-rerun");

const LABELLED = {
  version: 1 as const,
  schemaHash: "seed-schema",
  labelMap: {
    version: 1 as const,
    entries: [{
      path: ["secret"],
      label: { confidentiality: ["secret"] },
    }],
  },
};

const UNLABELLED = {
  version: 1 as const,
  schemaHash: "seed-schema",
  labelMap: { version: 1 as const, entries: [] },
};

/** A strict runtime holding one source doc whose `secret` is confidential. */
const seedStrict = async () => {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL("https://example.com"),
    storageManager,
    // The shipped shell posture; the action's own transaction escalates to
    // `enforce-strict` per-tx, the same seam cfc-writer-fit uses. Running the
    // whole runtime strict would put the SEED under strict too, and seeding a
    // label means writing the protected `cfc` path.
    cfcEnforcementMode: "enforce-explicit",
    cfcFlowLabels: "persist",
  });
  const space = signer.did();
  const seed = runtime.edit();
  const source = runtime.getCell<{ secret: string }>(
    space,
    "terminal-rerun-source",
    { type: "object", properties: { secret: { type: "string" } } },
    seed,
  );
  const sourceId = source.getAsNormalizedFullLink().id;
  seed.writeOrThrow({ space, scope: "space", id: sourceId, path: [] }, {
    value: { secret: "s3cr3t" },
    cfc: LABELLED,
  });
  // Assert on the ERROR rather than on `ok`: a seed that cannot land says why
  // in the failure message instead of reporting an undefined `ok`.
  expect((await seed.commit()).error).toBeUndefined();
  return { storageManager, runtime, space, source, sourceId };
};

describe("cfc terminal refusal re-run", () => {
  it("re-runs the refused action when a read VALUE changes, and lands once the verdict changes", async () => {
    const { storageManager, runtime, space, source, sourceId } =
      await seedStrict();
    try {
      const out = runtime.getCell<{ copied?: string }>(
        space,
        "terminal-rerun-out-value",
        { type: "object", properties: { copied: { type: "string" } } },
      );

      let runs = 0;
      const copy: Action = (tx) => {
        runs++;
        tx.setCfcEnforcementMode("enforce-strict");
        const secret = source.withTx(tx).get()?.secret ?? "";
        out.withTx(tx).set({ copied: `${secret}!` });
      };
      runtime.scheduler.subscribe(copy, { isEffect: true });
      await runtime.scheduler.idleWithPendingCommits();

      // The derived write carries the source's confidentiality and is
      // refused. Terminal: the doomed computation is not re-run against the
      // unchanged input.
      const refusedRuns = runs;
      // Exactly one: the refusal is terminal, so the doomed computation is
      // not re-run against the unchanged input. Before this change it ran
      // ten times and then deferred past the convergence budget.
      expect(refusedRuns).toBe(1);
      expect(out.get()?.copied).toBeUndefined();
      await runtime.scheduler.idleWithPendingCommits();
      expect(runs).toBe(1);

      // A change to what the run READ re-triggers it, exactly as it would
      // after a successful commit. Here the change also clears the label, so
      // the re-run's write is no longer refused and the value lands — a
      // terminal refusal is a verdict on one attempt, not a permanent stop.
      const update = runtime.edit();
      update.writeOrThrow({ space, scope: "space", id: sourceId, path: [] }, {
        value: { secret: "public" },
        cfc: UNLABELLED,
      });
      expect((await update.commit()).ok).toBeDefined();
      await runtime.scheduler.idleWithPendingCommits();

      expect(runs).toBeGreaterThan(refusedRuns);
      expect(out.get()?.copied).toBe("public!");
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("re-runs the refused action when only the read METADATA changes", async () => {
    const { storageManager, runtime, space, source, sourceId } =
      await seedStrict();
    try {
      const out = runtime.getCell<{ copied?: string }>(
        space,
        "terminal-rerun-out-meta",
        { type: "object", properties: { copied: { type: "string" } } },
      );

      let runs = 0;
      const copy: Action = (tx) => {
        runs++;
        tx.setCfcEnforcementMode("enforce-strict");
        const secret = source.withTx(tx).get()?.secret ?? "";
        out.withTx(tx).set({ copied: `${secret}!` });
      };
      runtime.scheduler.subscribe(copy, { isEffect: true });
      await runtime.scheduler.idleWithPendingCommits();

      const refusedRuns = runs;
      expect(refusedRuns).toBe(1);
      expect(out.get()?.copied).toBeUndefined();

      // The VALUE is byte-identical; only the CFC metadata that produced the
      // verdict changes. The label is what the refusal was about, so a
      // reader that cannot see this change can never recover from a policy
      // edit — the action must re-run on it.
      const relabel = runtime.edit();
      relabel.writeOrThrow({ space, scope: "space", id: sourceId, path: [] }, {
        value: { secret: "s3cr3t" },
        cfc: UNLABELLED,
      });
      expect((await relabel.commit()).ok).toBeDefined();
      await runtime.scheduler.idleWithPendingCommits();

      expect(runs).toBeGreaterThan(refusedRuns);
      expect(out.get()?.copied).toBe("s3cr3t!");
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });
});
