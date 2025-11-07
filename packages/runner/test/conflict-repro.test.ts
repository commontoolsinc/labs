import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { Identity } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import { type Cell } from "../src/builder/types.ts";
import { createBuilder } from "../src/builder/factory.ts";
import { Runtime } from "../src/runtime.ts";
import { type IExtendedStorageTransaction } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("test conflict");
const space = signer.did();

interface Item {
  id?: string;
}

describe("Conflict Reproduction", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;
  let lift: ReturnType<typeof createBuilder>["commontools"]["lift"];
  let recipe: ReturnType<typeof createBuilder>["commontools"]["recipe"];
  let cell: ReturnType<typeof createBuilder>["commontools"]["cell"];
  let handler: ReturnType<typeof createBuilder>["commontools"]["handler"];

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });

    tx = runtime.edit();

    const { commontools } = createBuilder(runtime);
    ({ lift, recipe, cell, handler } = commontools);
  });

  afterEach(async () => {
    await tx.commit();
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("should reproduce conflict with minimal handler", async () => {
    const action = handler<
      undefined,
      { items: Cell<Item[]>; sequence: Cell<number> }
    >({}, {
      type: "object",
      properties: {
        items: {
          type: "array",
          items: { type: "object", properties: { id: { type: "string" } } },
          asCell: true,
        },
        sequence: { type: "number", asCell: true },
      },
      required: ["items", "sequence"],
    }, (_event, context) => {
      // Minimal repro: Removing either of these removes the conflict
      context.items.set([]);
      context.sequence.set(context.sequence.get() + 1);
    });

    const conflictRepro = recipe<{ items: Item[] }>(
      "Conflict Repro",
      ({ items }) => {
        const sequence = cell(0);

        // Minimal repro: Removing the lift and the map removes the conflict
        lift((item: Item[]) => item.map((_) => ({})))(items);

        return {
          action: action({
            items,
            sequence,
          }),
        };
      },
    );

    const resultCell = runtime.getCell<{ action: any }>(
      space,
      "should reproduce conflict with minimal handler",
      undefined,
      tx,
    );
    const result = runtime.run(tx, conflictRepro, {
      items: [{ id: "test" }],
    }, resultCell);
    tx.commit();

    await runtime.idle();

    // Trigger the handler
    result.key("action").send({});
    await runtime.idle();

    expect(result.get()).toMatchObject({ action: expect.anything() });
  });
});
