import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { createBuilder } from "../src/builder/factory.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";
import { Runtime } from "../src/runtime.ts";
import type { CommitError } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("wish built-in tests");
const space = signer.did();

describe("interval #now wish", () => {
  // The `#now/N` grid ticks on a recurring wall-clock-boundary timer. These
  // cases observe the grid value advancing across a boundary, driving the beat
  // with `clock.tick` and reading the coarsened value before and after. They
  // are split out of `wish.test.ts` because the grid's heartbeat and its shared
  // result cell carry state across a suite's cases: run alongside the ~30 other
  // `#now` cases, the beat fires but the observed value stays frozen. In their
  // own file each case starts from a clean grid.

  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: ReturnType<Runtime["edit"]>;
  let wish: ReturnType<typeof createBuilder>["commonfabric"]["wish"];
  let pattern: ReturnType<typeof createBuilder>["commonfabric"]["pattern"];

  beforeEach(() => {
    // One frozen clock wraps the whole describe; these cases read absolute
    // coarsened time, so start each from logical zero.
    clock.reset();
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
    });

    tx = runtime.edit();

    const { commonfabric } = createTrustedBuilder(runtime);
    ({ wish, pattern } = commonfabric);
  });

  afterEach(async () => {
    await tx.commit();
    await runtime.dispose();
    await storageManager.close();
  });

  it("#now/1 ticks and updates value", async () => {
    const wishPattern = pattern(() => {
      return { nowValue: wish({ query: "#now/1" }) };
    });

    const resultCell = runtime.getCell<{ nowValue?: { result?: number } }>(
      space,
      "ticking now result",
      undefined,
      tx,
    );
    const result = runtime.run(tx, wishPattern, {}, resultCell);
    await tx.commit();
    tx = runtime.edit();

    await result.pull();
    const initial = result.key("nowValue").get()?.result;
    expect(typeof initial).toBe("number");
    expect(initial! % 1000).toBe(0);

    // Advance one second: the interval fires, the value re-coarsens, and the
    // reactive read reflects the next grid instant.
    await clock.tick(1000);
    await result.pull();
    const updated = result.key("nowValue").get()?.result;
    expect(updated).toBeGreaterThan(initial!);
    expect(updated! % 1000).toBe(0);

    runtime.runner.stop(resultCell);
  });

  it("writes the current instant when the grid cell holds a past one", async () => {
    // The grid cell is content-addressed by space and interval, so it outlives
    // the timer that ticks it: a reload, or another tab that has stopped,
    // leaves it holding whatever instant that session last wrote. The wish that
    // acquires the grid next writes the current instant straight away rather
    // than serving the past one until the boundary, which at this interval is
    // a minute off — so the instant the cell takes on names which of the two
    // wrote it.
    const intervalMs = 60_000;
    const current = Math.floor(Date.now() / intervalMs) * intervalMs;
    const stale = current - intervalMs;

    const gridCell = runtime.getCell<number>(
      space,
      { wish: { now: true, interval: intervalMs } },
      undefined,
      tx,
    );
    gridCell.set(stale);
    await tx.commit();
    tx = runtime.edit();

    const { promise: republished, resolve } = Promise.withResolvers<number>();
    const cancelSink = gridCell.sink((value) => {
      if (typeof value === "number" && value !== stale) resolve(value);
    });

    const wishPattern = pattern(() => {
      return { nowValue: wish({ query: "#now/60" }) };
    });

    const resultCell = runtime.getCell<{ nowValue?: { result?: number } }>(
      space,
      "stale grid now result",
      undefined,
      tx,
    );
    const result = runtime.run(tx, wishPattern, {}, resultCell);
    await tx.commit();
    tx = runtime.edit();

    await result.pull();
    expect(await republished).toBe(current);

    cancelSink();
    runtime.runner.stop(resultCell);
    // The acquire's own write is issued outside the action's transaction, so
    // let it reach storage before the case tears that storage down under it.
    // After the stop, never before: while the grid still holds a user its
    // boundary timer re-arms itself, and `settled()` would advance the clock
    // through one interval after another until the runaway ceiling trips.
    await runtime.settled();
  });

  it("reports a failed #now interval tick", async () => {
    const wishPattern = pattern(() => {
      return { nowValue: wish({ query: "#now/1" }) };
    });

    const resultCell = runtime.getCell<{ nowValue?: { result?: number } }>(
      space,
      "failed interval now result",
      undefined,
      tx,
    );
    const result = runtime.run(tx, wishPattern, {}, resultCell);
    await tx.commit();
    tx = runtime.edit();

    await result.pull();

    const failure = {
      name: "StorageTransactionAborted" as const,
      message: "interval tick failed",
      reason: "interval tick failed",
    } satisfies CommitError;
    const reported: unknown[][] = [];
    const originalEditWithRetry = runtime.editWithRetry.bind(runtime);
    const originalConsoleError = console.error;
    runtime.editWithRetry =
      (() =>
        Promise.resolve({ error: failure })) as typeof runtime.editWithRetry;
    console.error = (...args: unknown[]) => {
      if (args[0] === "[wish] #now interval tick failed:") {
        reported.push(args);
      } else {
        originalConsoleError(...args);
      }
    };

    try {
      await clock.tick(1000);
      expect(reported).toEqual([[
        "[wish] #now interval tick failed:",
        failure,
      ]]);
    } finally {
      runtime.editWithRetry = originalEditWithRetry;
      console.error = originalConsoleError;
      runtime.runner.stop(resultCell);
    }
  });

  it("#now interval keeps ticking when other dependencies change", async () => {
    // Regression: re-running the wish action (here via an unrelated cell the
    // pattern reads) must not reset or starve the shared interval timer.
    const triggerCell = runtime.getCell<number>(
      space,
      "tick collision trigger",
      undefined,
      tx,
    );
    triggerCell.set(0);

    const wishPattern = pattern(() => {
      triggerCell.get();
      return { nowValue: wish({ query: "#now/1" }) };
    });

    const resultCell = runtime.getCell<{ nowValue?: { result?: number } }>(
      space,
      "collision now result",
      undefined,
      tx,
    );
    const result = runtime.run(tx, wishPattern, {}, resultCell);
    await tx.commit();
    tx = runtime.edit();

    await result.pull();
    const initial = result.key("nowValue").get()?.result;
    expect(typeof initial).toBe("number");

    // Flip the trigger to re-run the wish action, then advance a second: the
    // shared interval must still fire and update the value regardless of the
    // unrelated re-run.
    triggerCell.withTx(tx).set(1);
    await tx.commit();
    tx = runtime.edit();

    await clock.tick(1000);
    await result.pull();
    const updated = result.key("nowValue").get()?.result;
    expect(updated).toBeGreaterThan(initial!);

    runtime.runner.stop(resultCell);
  });

  it("brings a stale grid cell forward when the timer is re-acquired", async () => {
    // The grid cell outlives the timer that ticks it: the last release stops
    // the timer and drops the registry entry, leaving the cell holding the
    // instant it last ticked. A later acquire therefore visits a cell that is
    // behind the grid once the clock crossed a boundary in between, and the
    // acquire brings it forward at once. A minute grid keeps the next boundary
    // far enough away that the acquire's own write is the only one this case
    // can see.
    const INTERVAL_MS = 60_000;
    const coarsen = (ms: number) => Math.floor(ms / INTERVAL_MS) * INTERVAL_MS;

    const wishPattern = pattern(() => {
      return { nowValue: wish({ query: "#now/60" }) };
    });

    const firstResultCell = runtime.getCell<{ nowValue?: { result?: number } }>(
      space,
      "stale grid first result",
      undefined,
      tx,
    );
    const first = runtime.run(tx, wishPattern, {}, firstResultCell);
    await tx.commit();
    tx = runtime.edit();

    await first.pull();
    const stale = first.key("nowValue").get()?.result;
    expect(stale).toBe(coarsen(Date.now()));

    // Last user gone: the timer stops, so nothing writes the cell across the
    // minute boundary that follows and it falls a grid instant behind.
    runtime.runner.stop(firstResultCell);
    await runtime.idle();
    await clock.tick(INTERVAL_MS);
    const current = coarsen(Date.now());
    expect(current).toBeGreaterThan(stale!);

    // The shared cell, addressed the way the timer addresses it, so that the
    // writes the re-acquire makes can be read in order.
    const gridCell = runtime.getCell<number>(
      space,
      { wish: { now: true, interval: INTERVAL_MS } },
      undefined,
      tx,
    );
    const observed: (number | undefined)[] = [];
    const cancelSink = gridCell.sink((value) => {
      observed.push(value);
    });

    const secondResultCell = runtime.getCell<
      { nowValue?: { result?: number } }
    >(
      space,
      "stale grid second result",
      undefined,
      tx,
    );
    const second = runtime.run(tx, wishPattern, {}, secondResultCell);
    await tx.commit();
    tx = runtime.edit();

    await second.pull();
    cancelSink();

    // Still inside the grid instant the acquire saw, so no boundary timer can
    // have fired: the second write is the acquire's own.
    expect(coarsen(Date.now())).toBe(current);
    expect(observed).toEqual([stale, current]);

    runtime.runner.stop(secondResultCell);
  });
});
