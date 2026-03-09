// Diagnosis tests: inline idempotency check mode for detecting
// non-deterministic computations.

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { type IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { Runtime } from "../src/runtime.ts";
import { type Action } from "../src/scheduler.ts";
import { Identity } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

describe("inline idempotency check mode", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    // No pull mode — matches production test-runner behavior
    tx = runtime.edit();
  });

  afterEach(async () => {
    await tx.commit();
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("detects non-idempotent via inline mode", async () => {
    // Enable inline mode before subscribing
    runtime.scheduler.enableIdempotencyCheck();

    // An accumulator: each run appends to the array
    const log = runtime.getCell<string[]>(
      space,
      "inline-idempotency-accumulator",
      undefined,
      tx,
    );
    log.set([]);
    await tx.commit();
    tx = runtime.edit();

    const accumulator: Action = (tx) => {
      const current = log.withTx(tx).get() ?? [];
      log.withTx(tx).send([...current, "entry"]);
    };
    runtime.scheduler.subscribe(
      accumulator,
      { reads: [], writes: [] },
      {},
    );
    await runtime.scheduler.idle();

    const violations = runtime.scheduler.getIdempotencyViolations();
    expect(violations.length).toBeGreaterThan(0);
  });

  it("does not flag idempotent computations in inline mode", async () => {
    runtime.scheduler.enableIdempotencyCheck();

    const input = runtime.getCell<number>(
      space,
      "inline-idempotent-input",
      undefined,
      tx,
    );
    input.set(5);
    const output = runtime.getCell<number>(
      space,
      "inline-idempotent-output",
      undefined,
      tx,
    );
    output.set(0);
    await tx.commit();
    tx = runtime.edit();

    const doubler: Action = (tx) => {
      output.withTx(tx).send(input.withTx(tx).get() * 2);
    };
    runtime.scheduler.subscribe(doubler, { reads: [], writes: [] }, {});
    await runtime.scheduler.idle();

    // Filter for our specific action
    const violations = runtime.scheduler.getIdempotencyViolations()
      .filter((r) =>
        r.runs.some((run) =>
          Object.keys(run.writes).some((k) => k.includes("inline-idempotent"))
        )
      );
    expect(violations.length).toBe(0);
  });
});
