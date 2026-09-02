import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import type { Cell } from "../src/cell.ts";
import type { Pattern } from "../src/builder/types.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";

const signer = await Identity.fromPassphrase("resume fenced element start");
const space = signer.did();

describe("run() under awaitSyncBeforeInitialRun", () => {
  // A coordinator's resume batch (map/filter/flatMap) reaches run() with
  // `awaitSyncBeforeInitialRun`. For a piece with durable pattern identity
  // that run must not instantiate synchronously: instantiation reads the
  // piece's execution family (its argument document, its derived internal
  // cells, a handler's `$event` stream marker among them), which a
  // crossing-delivered piece does not carry — so the start is commit-gated
  // and fenced behind the resume pre-sync. A fresh piece has its whole
  // state locally and keeps the synchronous start.

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

  function doublerPattern(): Pattern {
    const { lift, pattern } = createTrustedBuilder(runtime).commonfabric;
    return pattern<{ source: number }>(({ source }) => ({
      doubled: lift((value: number) => value * 2)(source),
    })) as unknown as Pattern;
  }

  // A piece that ran and then stopped: durable pattern identity, locally
  // assembled, and not running — the state a resume batch re-runs.
  async function stoppedPiece(
    name: string,
    doubler: Pattern,
  ): Promise<Cell<{ doubled: number }>> {
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

  it("commit-gates instantiation when resuming a piece with durable identity", async () => {
    const doubler = doublerPattern();
    const resultCell = await stoppedPiece("fenced durable resume", doubler);
    const registrationsBefore = runtime.runner.cancels.size;

    const tx = runtime.edit();
    runtime.runner.run(tx, doubler, undefined, resultCell, {
      awaitSyncBeforeInitialRun: true,
    });
    // Nothing installed synchronously: the start waits for this commit and
    // the resume pre-sync. (Mutation: routing the resume through the
    // synchronous startWithTx arm installs the registration here.)
    expect(runtime.runner.cancels.size).toBe(registrationsBefore);

    await tx.commit();
    // The fence chain is tracked, so `synced()` covers the pre-sync and
    // the deferred start it gates; the registration proves the fenced
    // instantiation ran. (The initial action runs stay under the option's
    // own synced-hold, whose release this harness does not model — the
    // value they produce is the shared-server harnesses' territory.)
    await storageManager.synced();
    await runtime.idle();
    expect(runtime.runner.cancels.size).toBe(registrationsBefore + 1);
  });

  it("starts a fresh piece synchronously under the same option", async () => {
    const doubler = doublerPattern();
    const tx = runtime.edit();
    const resultCell = runtime.getCell<{ doubled: number }>(
      space,
      "fenced fresh start",
      undefined,
      tx,
    );
    const registrationsBefore = runtime.runner.cancels.size;
    runtime.runner.run(tx, doubler, { source: 4 }, resultCell, {
      awaitSyncBeforeInitialRun: true,
    });
    // A fresh creation's state is local; deferring it would only add a
    // commit of latency, so the synchronous start stands.
    expect(runtime.runner.cancels.size).toBe(registrationsBefore + 1);

    await tx.commit();
    await runtime.idle();
  });
});
