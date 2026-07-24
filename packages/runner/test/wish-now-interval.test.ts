import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { createBuilder } from "../src/builder/factory.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";
import { Runtime } from "../src/runtime.ts";

const signer = await Identity.fromPassphrase("wish built-in tests");
const space = signer.did();

// The `#now/N` grid ticks on a recurring wall-clock-boundary timer. These cases
// observe the grid value advancing across a second, driving the beat with
// `clock.tick` and reading the coarsened value before and after. They are split
// out of `wish.test.ts` because the grid's heartbeat and its shared result cell
// carry state across a suite's cases: run alongside the ~30 other `#now` cases,
// the beat fires but the observed value stays frozen. In their own file each
// case starts from a clean grid.
describe("interval #now wish", () => {
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
});
