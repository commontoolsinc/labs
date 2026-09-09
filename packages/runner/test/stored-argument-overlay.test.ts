/** Checks shared-link validation work and preservation of each defaulted view. */

import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { spy } from "@std/testing/mock";

import { Identity } from "@commonfabric/identity";

import type { JSONSchema, Pattern } from "../src/builder/types.ts";
import type { Cell } from "../src/cell.ts";
import { rawMetaWriteAuthorization } from "../src/meta-seam.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";

const signer = await Identity.fromPassphrase("stored-argument-overlay");

/** Supplies the candidate contract to validation without executing a graph. */
function candidate(argumentSchema: JSONSchema): Pattern {
  return { argumentSchema, resultSchema: true, result: {}, nodes: [] };
}

describe("runner", () => {
  let runtime: Runtime;
  let storage: ReturnType<typeof StorageManager.emulate>;

  beforeEach(() => {
    storage = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL("http://toolshed.test"),
      storageManager: storage,
    });
  });

  afterEach(async () => {
    await runtime.idle();
    await storage.synced();
    await runtime.dispose();
    await storage.close();
  });

  it("bounds shared-graph reads while refusing a readable invalid argument", async () => {
    const graphIds = new Set<string>();
    const argument = runtime.getCell(signer.did(), "argument");
    const piece = runtime.getCell(signer.did(), "piece");
    const { error } = await runtime.editWithRetry((tx) => {
      let next: Cell<unknown> = runtime.getCell(
        signer.did(),
        "leaf",
        undefined,
        tx,
      );
      next.set({ label: "leaf" });
      graphIds.add(next.getAsNormalizedFullLink().id);
      for (let depth = 0; depth < 12; depth++) {
        const node = runtime.getCell(
          signer.did(),
          `node-${depth}`,
          undefined,
          tx,
        );
        node.set({ left: next, right: next });
        graphIds.add(node.getAsNormalizedFullLink().id);
        next = node;
      }
      argument.withTx(tx).set({ count: "wrong", graph: next });
      piece.withTx(tx).setMetaRaw(
        "argument",
        argument.getAsLink(),
        rawMetaWriteAuthorization,
      );
    });
    expect(error).toBeUndefined();
    const schema = candidate({
      type: "object",
      properties: { count: { type: "number" } },
      required: ["count"],
    });
    const tx = runtime.readTx();
    using reads = spy(tx, "read");
    expect(() => runtime.runner.validateStoredArgument(tx, piece, schema))
      .toThrow("count: value does not match type number");
    const graphReads = reads.calls.filter((call) =>
      graphIds.has(call.args[0].id)
    );
    expect(graphReads.length).toBeGreaterThan(0);
    expect(graphReads.length).toBeLessThan(100 * graphIds.size);
    expect(argument.getRaw()).toMatchObject({ count: "wrong" });
  });

  it("keeps distinct defaults when two views share an unreadable descendant", async () => {
    const argument = runtime.getCell(signer.did(), "argument");
    const piece = runtime.getCell(signer.did(), "piece");
    const missing = runtime.getCell(signer.did(), "missing");
    const { error } = await runtime.editWithRetry((tx) => {
      const shared = runtime.getCell(signer.did(), "shared", undefined, tx);
      shared.set({ name: missing });
      argument.withTx(tx).set({ left: shared, right: shared });
      piece.withTx(tx).setMetaRaw(
        "argument",
        argument.getAsLink(),
        rawMetaWriteAuthorization,
      );
    });
    expect(error).toBeUndefined();
    const view = (label: string): JSONSchema => ({
      type: "object",
      properties: {
        name: { type: "string" },
        label: { type: "string", const: label, default: label },
      },
      required: ["name", "label"],
    });
    const schema = candidate({
      type: "object",
      properties: { left: view("Glaze"), right: view("Sprinkles") },
      required: ["left", "right"],
    });
    expect(() =>
      runtime.runner.validateStoredArgument(runtime.readTx(), piece, schema)
    ).not.toThrow();

    const { error: invalidWrite } = await runtime.editWithRetry((tx) => {
      missing.withTx(tx).set(42);
    });
    expect(invalidWrite).toBeUndefined();
    expect(() =>
      runtime.runner.validateStoredArgument(runtime.readTx(), piece, schema)
    ).toThrow("name: value does not match type string");
  });
});
