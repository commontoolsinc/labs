/**
 * Push vs Pull scheduler comparison benchmarks.
 *
 * Runs the same workloads in both modes so Deno.bench groups
 * produce side-by-side numbers.
 *
 * Key insight: pull mode should shine when there are many computation
 * chains but only a subset of sinks (effects) are active. Push mode
 * executes everything; pull mode only runs what's reachable from
 * active effects.
 */
import { Identity } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import type { Action } from "../src/scheduler.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("bench operator");
const space = signer.did();

function setup(pullMode: boolean) {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  if (pullMode) {
    runtime.scheduler.enablePullMode();
  } else {
    runtime.scheduler.disablePullMode();
  }
  const tx = runtime.edit();
  return { runtime, storageManager, tx };
}

async function cleanup(
  runtime: Runtime,
  storageManager: ReturnType<typeof StorageManager.emulate>,
  tx: IExtendedStorageTransaction,
) {
  await tx.commit();
  await runtime.dispose();
  await storageManager.close();
}

// Helper: build a chain of N computations from source → ... → sink.
// Returns { actions, sinkAction } where sinkAction is the final action.
function buildChain(
  runtime: Runtime,
  tx: IExtendedStorageTransaction,
  prefix: string,
  length: number,
  opts: { markSinkAsEffect: boolean },
) {
  // deno-lint-ignore no-explicit-any
  const cells: any[] = [];
  const actions: Action[] = [];

  for (let i = 0; i <= length; i++) {
    const cell = runtime.getCell<number>(
      space,
      `${prefix}-${i}`,
      undefined,
      tx,
    );
    cell.set(0);
    cells.push(cell);
  }

  for (let i = 0; i < length; i++) {
    const input = cells[i];
    const output = cells[i + 1];
    const isLast = i === length - 1;

    const action: Action = (atx) => {
      const val = input.withTx(atx).get() ?? 0;
      output.withTx(atx).send(val + 1);
    };
    actions.push(action);

    runtime.scheduler.subscribe(
      action,
      {
        reads: [input.getAsNormalizedFullLink()],
        writes: [output.getAsNormalizedFullLink()],
      },
      { isEffect: isLast && opts.markSinkAsEffect },
    );
  }

  return { cells, actions, source: cells[0], sink: cells[length] };
}

// ===========================================================================
// SELECTIVE PULL BENCHMARKS
// These demonstrate the core advantage of pull-based scheduling:
// when only some sinks are active, pull skips unreachable computations.
// ===========================================================================

// ---------------------------------------------------------------------------
// 10 independent chains, only 1 sink active
// Push runs all 10 chains. Pull only runs the 1 chain feeding the active sink.
// ---------------------------------------------------------------------------
for (const mode of ["push", "pull"] as const) {
  Deno.bench(
    `${mode} - 10 chains (depth 10), 1 active sink`,
    { group: "selective-1-of-10" },
    async () => {
      const pull = mode === "pull";
      const { runtime, storageManager, tx } = setup(pull);

      const allActions: Action[] = [];

      for (let c = 0; c < 10; c++) {
        const chain = buildChain(runtime, tx, `sel1-${c}`, 10, {
          // In pull mode: only chain 0 has an effect (active sink).
          // In push mode: all are computations and all run.
          markSinkAsEffect: pull && c === 0,
        });
        allActions.push(...chain.actions);
      }

      await runtime.idle();

      for (const a of allActions) runtime.scheduler.unsubscribe(a);
      await cleanup(runtime, storageManager, tx);
    },
  );
}

// ---------------------------------------------------------------------------
// 10 chains (depth 10), 5 active sinks
// Pull should be ~2x faster than push (skips 5 chains).
// ---------------------------------------------------------------------------
for (const mode of ["push", "pull"] as const) {
  Deno.bench(
    `${mode} - 10 chains (depth 10), 5 active sinks`,
    { group: "selective-5-of-10" },
    async () => {
      const pull = mode === "pull";
      const { runtime, storageManager, tx } = setup(pull);

      const allActions: Action[] = [];

      for (let c = 0; c < 10; c++) {
        const chain = buildChain(runtime, tx, `sel5-${c}`, 10, {
          markSinkAsEffect: pull && c < 5,
        });
        allActions.push(...chain.actions);
      }

      await runtime.idle();

      for (const a of allActions) runtime.scheduler.unsubscribe(a);
      await cleanup(runtime, storageManager, tx);
    },
  );
}

// ---------------------------------------------------------------------------
// 10 chains (depth 10), all 10 sinks active
// This is the "no savings" case: pull should be similar to push.
// ---------------------------------------------------------------------------
for (const mode of ["push", "pull"] as const) {
  Deno.bench(
    `${mode} - 10 chains (depth 10), 10 active sinks`,
    { group: "selective-10-of-10" },
    async () => {
      const pull = mode === "pull";
      const { runtime, storageManager, tx } = setup(pull);

      const allActions: Action[] = [];

      for (let c = 0; c < 10; c++) {
        const chain = buildChain(runtime, tx, `sel10-${c}`, 10, {
          markSinkAsEffect: pull,
        });
        allActions.push(...chain.actions);
      }

      await runtime.idle();

      for (const a of allActions) runtime.scheduler.unsubscribe(a);
      await cleanup(runtime, storageManager, tx);
    },
  );
}

// ---------------------------------------------------------------------------
// 50 chains (depth 5), only 1 active sink — bigger fan-out
// Push: runs all 250 computations. Pull: runs only 5.
// ---------------------------------------------------------------------------
for (const mode of ["push", "pull"] as const) {
  Deno.bench(
    `${mode} - 50 chains (depth 5), 1 active sink`,
    { group: "selective-1-of-50" },
    async () => {
      const pull = mode === "pull";
      const { runtime, storageManager, tx } = setup(pull);

      const allActions: Action[] = [];

      for (let c = 0; c < 50; c++) {
        const chain = buildChain(runtime, tx, `sel50-${c}`, 5, {
          markSinkAsEffect: pull && c === 0,
        });
        allActions.push(...chain.actions);
      }

      await runtime.idle();

      for (const a of allActions) runtime.scheduler.unsubscribe(a);
      await cleanup(runtime, storageManager, tx);
    },
  );
}

// ---------------------------------------------------------------------------
// 50 chains (depth 5), 5 active sinks — realistic "5 open tabs"
// Push: 250 computations. Pull: 25 computations.
// ---------------------------------------------------------------------------
for (const mode of ["push", "pull"] as const) {
  Deno.bench(
    `${mode} - 50 chains (depth 5), 5 active sinks`,
    { group: "selective-5-of-50" },
    async () => {
      const pull = mode === "pull";
      const { runtime, storageManager, tx } = setup(pull);

      const allActions: Action[] = [];

      for (let c = 0; c < 50; c++) {
        const chain = buildChain(runtime, tx, `sel50x5-${c}`, 5, {
          markSinkAsEffect: pull && c < 5,
        });
        allActions.push(...chain.actions);
      }

      await runtime.idle();

      for (const a of allActions) runtime.scheduler.unsubscribe(a);
      await cleanup(runtime, storageManager, tx);
    },
  );
}

// ===========================================================================
// SHARED SOURCE + SELECTIVE SINK BENCHMARKS
// Multiple computations reading the same source, each writing to its own
// output, but only some outputs have active sinks.
// ===========================================================================

// ---------------------------------------------------------------------------
// 100 computations from shared source, only 1 has an active sink
// Push: runs all 100. Pull: runs only 1.
// ---------------------------------------------------------------------------
for (const mode of ["push", "pull"] as const) {
  Deno.bench(
    `${mode} - shared source, 100 computations, 1 active sink`,
    { group: "shared-src-1-of-100" },
    async () => {
      const pull = mode === "pull";
      const { runtime, storageManager, tx } = setup(pull);

      const source = runtime.getCell<number>(space, "ss1-src", undefined, tx);
      source.set(1);

      const actions: Action[] = [];
      for (let i = 0; i < 100; i++) {
        const out = runtime.getCell<number>(
          space,
          `ss1-out-${i}`,
          undefined,
          tx,
        );
        out.set(0);

        const action: Action = (atx) => {
          const val = source.withTx(atx).get() ?? 0;
          out.withTx(atx).send(val * (i + 1));
        };
        actions.push(action);

        runtime.scheduler.subscribe(
          action,
          {
            reads: [source.getAsNormalizedFullLink()],
            writes: [out.getAsNormalizedFullLink()],
          },
          { isEffect: pull && i === 0 },
        );
      }

      await runtime.idle();

      // Update source and propagate
      source.send(2);
      await runtime.idle();

      for (const a of actions) runtime.scheduler.unsubscribe(a);
      await cleanup(runtime, storageManager, tx);
    },
  );
}

// ---------------------------------------------------------------------------
// 100 computations from shared source, 10 have active sinks
// ---------------------------------------------------------------------------
for (const mode of ["push", "pull"] as const) {
  Deno.bench(
    `${mode} - shared source, 100 computations, 10 active sinks`,
    { group: "shared-src-10-of-100" },
    async () => {
      const pull = mode === "pull";
      const { runtime, storageManager, tx } = setup(pull);

      const source = runtime.getCell<number>(space, "ss10-src", undefined, tx);
      source.set(1);

      const actions: Action[] = [];
      for (let i = 0; i < 100; i++) {
        const out = runtime.getCell<number>(
          space,
          `ss10-out-${i}`,
          undefined,
          tx,
        );
        out.set(0);

        const action: Action = (atx) => {
          const val = source.withTx(atx).get() ?? 0;
          out.withTx(atx).send(val * (i + 1));
        };
        actions.push(action);

        runtime.scheduler.subscribe(
          action,
          {
            reads: [source.getAsNormalizedFullLink()],
            writes: [out.getAsNormalizedFullLink()],
          },
          { isEffect: pull && i < 10 },
        );
      }

      await runtime.idle();

      source.send(2);
      await runtime.idle();

      for (const a of actions) runtime.scheduler.unsubscribe(a);
      await cleanup(runtime, storageManager, tx);
    },
  );
}

// ---------------------------------------------------------------------------
// 100 computations from shared source, all 100 active sinks
// Pull should match push here (no savings).
// ---------------------------------------------------------------------------
for (const mode of ["push", "pull"] as const) {
  Deno.bench(
    `${mode} - shared source, 100 computations, 100 active sinks`,
    { group: "shared-src-100-of-100" },
    async () => {
      const pull = mode === "pull";
      const { runtime, storageManager, tx } = setup(pull);

      const source = runtime.getCell<number>(
        space,
        "ss100-src",
        undefined,
        tx,
      );
      source.set(1);

      const actions: Action[] = [];
      for (let i = 0; i < 100; i++) {
        const out = runtime.getCell<number>(
          space,
          `ss100-out-${i}`,
          undefined,
          tx,
        );
        out.set(0);

        const action: Action = (atx) => {
          const val = source.withTx(atx).get() ?? 0;
          out.withTx(atx).send(val * (i + 1));
        };
        actions.push(action);

        runtime.scheduler.subscribe(
          action,
          {
            reads: [source.getAsNormalizedFullLink()],
            writes: [out.getAsNormalizedFullLink()],
          },
          { isEffect: pull },
        );
      }

      await runtime.idle();

      source.send(2);
      await runtime.idle();

      for (const a of actions) runtime.scheduler.unsubscribe(a);
      await cleanup(runtime, storageManager, tx);
    },
  );
}

// ===========================================================================
// UPDATE PROPAGATION WITH SELECTIVE SINKS
// Source changes, many chains exist, only some sinks care.
// Measures the steady-state update cost (not initial execution).
// ===========================================================================

// ---------------------------------------------------------------------------
// Steady-state: 20 chains (depth 10), update source, only 1 sink active
// ---------------------------------------------------------------------------
for (const mode of ["push", "pull"] as const) {
  Deno.bench(
    `${mode} - update: 20 chains (depth 10), 1 active sink`,
    { group: "update-1-of-20" },
    async () => {
      const pull = mode === "pull";
      const { runtime, storageManager, tx } = setup(pull);

      // All chains share the same source
      const source = runtime.getCell<number>(
        space,
        "upd1-src",
        undefined,
        tx,
      );
      source.set(0);

      const allActions: Action[] = [];
      for (let c = 0; c < 20; c++) {
        // deno-lint-ignore no-explicit-any
        const cells: any[] = [source];
        for (let i = 1; i <= 10; i++) {
          const cell = runtime.getCell<number>(
            space,
            `upd1-${c}-${i}`,
            undefined,
            tx,
          );
          cell.set(0);
          cells.push(cell);
        }

        for (let i = 0; i < 10; i++) {
          const input = cells[i];
          const output = cells[i + 1];
          const isLast = i === 9;
          const action: Action = (atx) => {
            const val = input.withTx(atx).get() ?? 0;
            output.withTx(atx).send(val + 1);
          };
          allActions.push(action);

          runtime.scheduler.subscribe(
            action,
            {
              reads: [input.getAsNormalizedFullLink()],
              writes: [output.getAsNormalizedFullLink()],
            },
            { isEffect: pull && isLast && c === 0 },
          );
        }
      }

      // Initial execution to establish dependencies
      await runtime.idle();

      // Measure update propagation
      source.send(42);
      await runtime.idle();

      for (const a of allActions) runtime.scheduler.unsubscribe(a);
      await cleanup(runtime, storageManager, tx);
    },
  );
}

// ---------------------------------------------------------------------------
// Steady-state: 20 chains (depth 10), update source, all 20 sinks active
// ---------------------------------------------------------------------------
for (const mode of ["push", "pull"] as const) {
  Deno.bench(
    `${mode} - update: 20 chains (depth 10), 20 active sinks`,
    { group: "update-20-of-20" },
    async () => {
      const pull = mode === "pull";
      const { runtime, storageManager, tx } = setup(pull);

      const source = runtime.getCell<number>(
        space,
        "upd20-src",
        undefined,
        tx,
      );
      source.set(0);

      const allActions: Action[] = [];
      for (let c = 0; c < 20; c++) {
        // deno-lint-ignore no-explicit-any
        const cells: any[] = [source];
        for (let i = 1; i <= 10; i++) {
          const cell = runtime.getCell<number>(
            space,
            `upd20-${c}-${i}`,
            undefined,
            tx,
          );
          cell.set(0);
          cells.push(cell);
        }

        for (let i = 0; i < 10; i++) {
          const input = cells[i];
          const output = cells[i + 1];
          const isLast = i === 9;
          const action: Action = (atx) => {
            const val = input.withTx(atx).get() ?? 0;
            output.withTx(atx).send(val + 1);
          };
          allActions.push(action);

          runtime.scheduler.subscribe(
            action,
            {
              reads: [input.getAsNormalizedFullLink()],
              writes: [output.getAsNormalizedFullLink()],
            },
            { isEffect: pull && isLast },
          );
        }
      }

      await runtime.idle();

      source.send(42);
      await runtime.idle();

      for (const a of allActions) runtime.scheduler.unsubscribe(a);
      await cleanup(runtime, storageManager, tx);
    },
  );
}

// ===========================================================================
// ORIGINAL BENCHMARKS (baseline comparisons)
// ===========================================================================

// ---------------------------------------------------------------------------
// Deep chain (50 levels)
// ---------------------------------------------------------------------------
for (const mode of ["push", "pull"] as const) {
  Deno.bench(
    `${mode} - deep chain (50 levels)`,
    { group: "deep-chain" },
    async () => {
      const pull = mode === "pull";
      const { runtime, storageManager, tx } = setup(pull);

      const chain = buildChain(runtime, tx, "chain50", 49, {
        markSinkAsEffect: pull,
      });

      await runtime.idle();

      for (const a of chain.actions) runtime.scheduler.unsubscribe(a);
      await cleanup(runtime, storageManager, tx);
    },
  );
}

// ---------------------------------------------------------------------------
// Diamond pattern (10 diamonds: A→B, A→C, B+C→D)
// ---------------------------------------------------------------------------
for (const mode of ["push", "pull"] as const) {
  Deno.bench(
    `${mode} - diamond pattern (10 diamonds)`,
    { group: "diamond" },
    async () => {
      const pull = mode === "pull";
      const { runtime, storageManager, tx } = setup(pull);

      const actions: Action[] = [];

      for (let d = 0; d < 10; d++) {
        const a = runtime.getCell<number>(
          space,
          `d-${d}-a`,
          undefined,
          tx,
        );
        const b = runtime.getCell<number>(
          space,
          `d-${d}-b`,
          undefined,
          tx,
        );
        const c = runtime.getCell<number>(
          space,
          `d-${d}-c`,
          undefined,
          tx,
        );
        const result = runtime.getCell<number>(
          space,
          `d-${d}-d`,
          undefined,
          tx,
        );
        a.set(d);
        b.set(0);
        c.set(0);
        result.set(0);

        const actionAB: Action = (atx) => {
          b.withTx(atx).send((a.withTx(atx).get() ?? 0) * 2);
        };
        actions.push(actionAB);
        runtime.scheduler.subscribe(
          actionAB,
          {
            reads: [a.getAsNormalizedFullLink()],
            writes: [b.getAsNormalizedFullLink()],
          },
          {},
        );

        const actionAC: Action = (atx) => {
          c.withTx(atx).send((a.withTx(atx).get() ?? 0) * 3);
        };
        actions.push(actionAC);
        runtime.scheduler.subscribe(
          actionAC,
          {
            reads: [a.getAsNormalizedFullLink()],
            writes: [c.getAsNormalizedFullLink()],
          },
          {},
        );

        const actionBCD: Action = (atx) => {
          result.withTx(atx).send(
            (b.withTx(atx).get() ?? 0) + (c.withTx(atx).get() ?? 0),
          );
        };
        actions.push(actionBCD);
        runtime.scheduler.subscribe(
          actionBCD,
          {
            reads: [
              b.getAsNormalizedFullLink(),
              c.getAsNormalizedFullLink(),
            ],
            writes: [result.getAsNormalizedFullLink()],
          },
          { isEffect: pull },
        );
      }

      await runtime.idle();

      for (const a of actions) runtime.scheduler.unsubscribe(a);
      await cleanup(runtime, storageManager, tx);
    },
  );
}

// ---------------------------------------------------------------------------
// Setup/teardown overhead
// ---------------------------------------------------------------------------
for (const mode of ["push", "pull"] as const) {
  Deno.bench(
    `${mode} - setup/teardown overhead`,
    { group: "overhead" },
    async () => {
      const { runtime, storageManager, tx } = setup(mode === "pull");
      await cleanup(runtime, storageManager, tx);
    },
  );
}

// ---------------------------------------------------------------------------
// runtime.idle() with no work
// ---------------------------------------------------------------------------
for (const mode of ["push", "pull"] as const) {
  Deno.bench(
    `${mode} - idle() empty`,
    { group: "idle-empty" },
    async () => {
      const { runtime, storageManager, tx } = setup(mode === "pull");
      await runtime.idle();
      await cleanup(runtime, storageManager, tx);
    },
  );
}
