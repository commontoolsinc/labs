import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import type { Cell } from "../src/cell.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";

// start() is single-flight per doc: concurrent calls for the same doc share
// one resolution pipeline and its outcome, while a stop between two calls
// separates them into distinct attempts. These tests drive the runner
// directly through the restart path — a piece that ran, stopped, and is
// started again — because that is the state where start() owns the whole
// pipeline (a fresh run() instantiates without it).

const signer = await Identity.fromPassphrase("start single flight");
const space = signer.did();

describe("start()", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
  });

  afterEach(async () => {
    await runtime.dispose();
    await storageManager.close();
  });

  // A piece that ran and then stopped: durable, locally assembled, and not
  // running — the state from which start() runs its full pipeline.
  async function stoppedPiece(
    name: string,
  ): Promise<Cell<{ doubled: number }>> {
    const { lift, pattern } = createTrustedBuilder(runtime).commonfabric;
    const doubler = pattern<{ source: number }>(({ source }) => ({
      doubled: lift((value: number) => value * 2)(source),
    }));
    const tx = runtime.edit();
    const resultCell = runtime.getCell<{ doubled: number }>(
      space,
      name,
      undefined,
      tx,
    );
    runtime.run(tx, doubler, { source: 3 }, resultCell);
    await tx.commit();
    await runtime.idle();
    runtime.runner.stop(resultCell);
    return resultCell;
  }

  it("returns the in-flight attempt's outcome to a concurrent start of the same doc", async () => {
    const resultCell = await stoppedPiece("single flight join");
    const first = runtime.runner.start(resultCell);
    const second = runtime.runner.start(resultCell);
    expect(second).toBe(first);
    expect(await first).toBe(true);
    expect(await second).toBe(true);
    await resultCell.pull();
    await runtime.idle();
    expect(resultCell.key("doubled").getAsQueryResult()).toBe(6);
  });

  it("runs a fresh attempt for a start issued after a stop of the in-flight one", async () => {
    const resultCell = await stoppedPiece("single flight stop between");
    const doomed = runtime.runner.start(resultCell);
    runtime.runner.stop(resultCell);
    const fresh = runtime.runner.start(resultCell);
    expect(fresh).not.toBe(doomed);
    expect(await doomed).toBe(false);
    expect(await fresh).toBe(true);
    await resultCell.pull();
    await runtime.idle();
    expect(resultCell.key("doubled").getAsQueryResult()).toBe(6);
  });

  it("returns true from a start issued after the previous attempt settled", async () => {
    const resultCell = await stoppedPiece("single flight sequential");
    expect(await runtime.runner.start(resultCell)).toBe(true);
    expect(await runtime.runner.start(resultCell)).toBe(true);
  });

  it("shares a rejection with the joined start", async () => {
    const resultCell = runtime.getCell<unknown>(
      space,
      "single flight no data",
    );
    const first = runtime.runner.start(resultCell);
    const second = runtime.runner.start(resultCell);
    expect(second).toBe(first);
    await expect(first).rejects.toThrow("No data at cell");
  });

  it("does not join an attempt from a previous lifecycle epoch", async () => {
    const resultCell = await stoppedPiece("single flight epoch");
    const previousEpoch = runtime.runner.start(resultCell);
    runtime.runner.stopAll();
    const currentEpoch = runtime.runner.start(resultCell);
    expect(currentEpoch).not.toBe(previousEpoch);
    expect(await previousEpoch).toBe(false);
    expect(await currentEpoch).toBe(true);
  });
});
