import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";

import { toMemorySpaceAddress } from "../src/link-utils.ts";
import { Runtime } from "../src/runtime.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";

/**
 * A runtime whose storage manager serves its signer's space when `serving`
 * is set, as a serving runtime's does, and a client runtime otherwise.
 * `holder` holds, at `state`, a link to `state`, a user-scoped document.
 */
async function fixture(name: string, serving: boolean) {
  const signer = await Identity.fromPassphrase(`unproduced instance ${name}`);
  const space = signer.did();
  const storage = EmulatedStorageManager.emulate({
    as: signer,
    ...(serving ? { servingHomeSpace: space } : {}),
  });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager: storage,
    servingPosture: serving,
  });
  const state = runtime.getCell<string>(
    space,
    `unproduced-instance-state-${name}`,
    undefined,
    undefined,
    "user",
  );
  const holder = runtime.getCell<{ state?: unknown }>(
    space,
    `unproduced-instance-holder-${name}`,
  );
  const output = runtime.getCell<string>(
    space,
    `unproduced-instance-output-${name}`,
  );
  const seed = runtime.edit();
  holder.withTx(seed).set({ state: state.getAsLink() });
  output.withTx(seed).set("as it was");
  expect((await seed.commit().settled).error).toBeUndefined();

  let consumerRuns = 0;
  const consumer = (tx: IExtendedStorageTransaction) => {
    consumerRuns++;
    const value = holder.withTx(tx).key("state").get();
    output.withTx(tx).set(
      value === undefined ? "derived from nothing" : `derived from ${value}`,
    );
  };

  return {
    runtime,
    storage,
    state,
    output,
    consumerRuns: () => consumerRuns,

    /**
     * Registers a derivation that declares a write to `state` and never
     * produces it, as one that has not run yet for this principal, or never
     * does, would.
     */
    registerWriter() {
      runtime.scheduler.subscribe(() => {}, {
        reads: [],
        shallowReads: [],
        writes: [toMemorySpaceAddress(state.getAsNormalizedFullLink())],
      });
    },

    /** Starts the consumer, and waits for it to settle. */
    async runConsumer() {
      runtime.scheduler.subscribe(consumer, {
        reads: [],
        shallowReads: [],
        writes: [],
      }, { isEffect: true });
      await runtime.idle();
      await storage.synced();
    },

    async close() {
      await storage.synced();
      await runtime.dispose();
      await storage.close();
    },
  };
}

describe("scheduler-derivation-unproduced-instance", () => {
  it("commits nothing from a served derivation that read a scoped instance a registered derivation has not produced, and commits once it is produced", async () => {
    const f = await fixture("served", true);
    try {
      f.registerWriter();
      await f.runConsumer();

      expect(f.consumerRuns()).toBe(1);
      expect(f.output.get()).toBe("as it was");

      const produce = f.runtime.edit();
      f.state.withTx(produce).set("the instance");
      expect((await produce.commit().settled).error).toBeUndefined();
      await f.runtime.idle();
      await f.storage.synced();

      expect(f.consumerRuns()).toBe(2);
      expect(f.output.get()).toBe("derived from the instance");
    } finally {
      await f.close();
    }
  });

  it("commits nothing from a served derivation whose instance a registered derivation never produces, leaving the earlier value standing", async () => {
    // A writer that never produces this principal's instance holds its
    // readers' served commits back for as long as that lasts.

    const f = await fixture("never", true);
    try {
      f.registerWriter();
      await f.runConsumer();

      expect(f.consumerRuns()).toBe(1);
      expect(f.output.get()).toBe("as it was");
    } finally {
      await f.close();
    }
  });

  it("commits the output of a served derivation that read a missing scoped instance no registered derivation writes", async () => {
    const f = await fixture("authored", true);
    try {
      await f.runConsumer();

      expect(f.consumerRuns()).toBe(1);
      expect(f.output.get()).toBe("derived from nothing");
    } finally {
      await f.close();
    }
  });

  it("commits the output of a client derivation that read a scoped instance a registered derivation has not produced", async () => {
    const f = await fixture("client", false);
    try {
      f.registerWriter();
      await f.runConsumer();

      expect(f.consumerRuns()).toBe(1);
      expect(f.output.get()).toBe("derived from nothing");
    } finally {
      await f.close();
    }
  });
});
