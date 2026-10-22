import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import { handler } from "../src/builder/module.ts";
import { pattern } from "../src/builder/pattern.ts";
import type { Cell } from "../src/cell.ts";
import { Runtime } from "../src/runtime.ts";

const signer = await Identity.fromPassphrase("stream send origin transaction");
const space = signer.did();

describe("stream-send-origin-transaction", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let stream: Cell<unknown>;
  let appended: unknown[];

  beforeEach(async () => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    // Explicit schemas: a unit test compiles without the CTS transforms.
    const record = handler(
      true as const,
      { type: "object", properties: {} } as const,
      (_event, _ctx) => {},
    );
    const recorder = pattern<{ value: number }>(({ value }) => ({
      value,
      record: record({}),
    }));
    const tx = runtime.edit();
    const result = runtime.getCell<{ value: number; record: unknown }>(
      space,
      "stream-send-origin-transaction-result",
      undefined,
      tx,
    );
    runtime.run(tx, recorder, { value: 0 }, result);
    await tx.commit().settled;
    await runtime.idle();
    stream = result.key("record");

    // A client under server execution: a fire's durable act is the append.
    appended = [];
    const replica = storageManager.open(space).replica;
    replica.enqueueEventAppend = (entry) => {
      appended.push(entry.payload);
      return Promise.resolve({ delivered: true });
    };
    runtime.experimental.serverExecution = true;
  });

  afterEach(async () => {
    await runtime.dispose();
    await storageManager.close();
  });

  it("appends a fire with no transaction at once", () => {
    stream.send({ n: 1 });
    expect(appended).toEqual([{ n: 1 }]);
  });

  it("appends a fire made inside a transaction once that transaction commits", async () => {
    const tx = runtime.edit();
    stream.withTx(tx).send({ n: 2 });
    expect(appended).toEqual([]);
    await tx.commit().settled;
    await runtime.idle();
    expect(appended).toEqual([{ n: 2 }]);
  });

  it("appends nothing for a fire made inside a transaction that is aborted", async () => {
    const tx = runtime.edit();
    stream.withTx(tx).send({ n: 3 });
    tx.abort("the attempt runs again");
    await runtime.idle();
    expect(appended).toEqual([]);
  });

  it("appends one event when an edit's attempt is aborted and run again", async () => {
    // Stands in for `editWithRetry` running its callback a second time: the
    // first attempt's transaction is aborted, the second commits.
    for (const commit of [false, true]) {
      const tx = runtime.edit();
      stream.withTx(tx).send({ n: 4 });
      if (commit) await tx.commit().settled;
      else tx.abort("absent documents are present; the action re-runs");
    }
    await runtime.idle();
    expect(appended).toEqual([{ n: 4 }]);
  });
});
