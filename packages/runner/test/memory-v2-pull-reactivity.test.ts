import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commontools/identity";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import type { Action } from "../src/scheduler.ts";
import * as Fact from "@commontools/memory/fact";
import * as Changes from "@commontools/memory/changes";

const signer = await Identity.fromPassphrase("memory-v2-pull-reactivity");
const space = signer.did();

const waitFor = async (
  predicate: () => boolean,
  timeout = 500,
): Promise<void> => {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeout) {
      throw new Error("Timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

describe("Memory v2 pull reactivity", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;

  beforeEach(() => {
    storageManager = StorageManager.emulate({
      as: signer,
      memoryVersion: "v2",
    });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      memoryVersion: "v2",
    });
    tx = runtime.edit();
  });

  afterEach(async () => {
    const status = tx?.status();
    if (status?.status === "ready") {
      await tx.commit();
    }
    await runtime.dispose();
    await storageManager.close();
    await new Promise((resolve) => setTimeout(resolve, 1));
  });

  it("marks pull-mode computations dirty after remote integrate and recomputes on pull", async () => {
    runtime.scheduler.enablePullMode();

    const source = runtime.getCell<number>(
      space,
      `memory-v2-pull-source-${Date.now()}`,
      undefined,
      tx,
    );
    source.set(1);
    const result = runtime.getCell<number>(
      space,
      `memory-v2-pull-result-${Date.now()}`,
      undefined,
      tx,
    );
    result.set(0);
    await tx.commit();
    tx = runtime.edit();

    await source.sync();
    await runtime.storageManager.synced();

    let computationRuns = 0;
    const computation: Action = (actionTx) => {
      computationRuns++;
      const value = source.withTx(actionTx).get();
      result.withTx(actionTx).send(value * 10);
    };

    runtime.scheduler.subscribe(
      computation,
      {
        reads: [source.getAsNormalizedFullLink()],
        shallowReads: [],
        writes: [result.getAsNormalizedFullLink()],
      },
      {},
    );

    await result.pull();
    expect(result.get()).toBe(10);
    expect(computationRuns).toBe(1);
    expect(runtime.scheduler.isDirty(computation)).toBe(false);

    await storageManager.session().mount(space).transact({
      changes: Changes.from([Fact.assert({
        the: "application/json",
        of: source.getAsNormalizedFullLink().id,
        is: 2,
      })]),
    });

    await waitFor(() => runtime.scheduler.isDirty(computation));
    expect(computationRuns).toBe(1);

    await result.pull();
    expect(result.get()).toBe(20);
    expect(computationRuns).toBe(2);
    expect(runtime.scheduler.isDirty(computation)).toBe(false);
  });
});
