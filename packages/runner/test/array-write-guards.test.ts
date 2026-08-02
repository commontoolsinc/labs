import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import { Runtime } from "../src/runtime.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";

/**
 * The three states `Cell.push()` and `Cell.addUnique()` can find the stored
 * value in: absent, an array, or something else. Each method decides between
 * them before it has an array to work with, so all three are covered here for
 * both.
 */
const signer = await Identity.fromPassphrase("array write guards");
const space = signer.did();

describe("array write guards", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    tx = runtime.edit();
  });

  afterEach(async () => {
    await tx.commit();
    await runtime?.dispose();
    await storageManager?.close();
  });

  for (
    const { name, write } of [
      {
        name: "push()",
        write: (cell: ReturnType<Runtime["getCell"]>, v: string) =>
          (cell as unknown as { push(v: string): void }).push(v),
      },
      {
        name: "addUnique()",
        write: (cell: ReturnType<Runtime["getCell"]>, v: string) =>
          (cell as unknown as { addUnique(v: string): void }).addUnique(v),
      },
    ]
  ) {
    describe(name, () => {
      it("creates the array when there is no value yet", () => {
        const cell = runtime.getCell<string[]>(
          space,
          `absent-${name}`,
          undefined,
          tx,
        );

        write(cell, "one");

        expect(cell.get()).toEqual(["one"]);
      });

      it("appends to an existing array", () => {
        const cell = runtime.getCell<string[]>(
          space,
          `existing-${name}`,
          undefined,
          tx,
        );
        cell.set(["one"]);

        write(cell, "two");

        expect(cell.get()).toEqual(["one", "two"]);
      });

      it("throws when the stored value is not an array", () => {
        const cell = runtime.getCell<string[]>(
          space,
          `non-array-${name}`,
          undefined,
          tx,
        );
        // A cell typed as an array whose stored value is not one. Only reachable
        // through a cast, which is the point: the guard is what stands between
        // that state and a silently wrong write.
        cell.set("not an array" as unknown as string[]);

        expect(() => write(cell, "one")).toThrow(
          /requires transaction and array value/,
        );
      });
    });
  }
});
