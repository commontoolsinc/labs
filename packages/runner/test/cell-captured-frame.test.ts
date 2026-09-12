/**
 * A cell captures the frame on top of the frame stack when it is constructed,
 * and a runtime keeps a frame there for as long as it is alive. Three things in
 * `cell.ts` rest on that: deriving a cell's link, `export()`, and the value
 * comparison `addUnique()` makes. These cases pin the guarantee and each of the
 * three, with no handler or lift running.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import { getTopFrame } from "../src/builder/pattern.ts";
import { CellImpl } from "../src/cell.ts";
import { Runtime } from "../src/runtime.ts";
import { type JSONSchema } from "../src/builder/types.ts";
import { type IExtendedStorageTransaction } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("test operator captured frame");
const space = signer.did();

const dateListSchema = {
  type: "array",
  items: { type: "object", properties: {} },
} as const satisfies JSONSchema;

describe("cell-captured-frame", () => {
  describe("the frame a runtime keeps on the stack", () => {
    it("is on the stack from the runtime's construction until its disposal", async () => {
      const before = getTopFrame();
      const storageManager = StorageManager.emulate({ as: signer });
      const runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager,
      });

      const frame = getTopFrame();
      expect(frame).not.toBe(before);
      expect(frame?.runtime).toBe(runtime);

      await runtime.dispose();
      await storageManager.close();
      expect(getTopFrame()).toBe(before);
    });

    it("throws when a disposed runtime is asked for a cell", async () => {
      const storageManager = StorageManager.emulate({ as: signer });
      const runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager,
      });
      const tx = runtime.edit();

      await runtime.dispose();
      await storageManager.close();
      expect(getTopFrame()).toBeUndefined();

      expect(() =>
        runtime.getCell<number>(space, "after-dispose", undefined, tx)
      ).toThrow("no frame is on the stack");
    });
  });

  describe("a cell a live runtime hands out", () => {
    let runtime: Runtime;
    let storageManager: ReturnType<typeof StorageManager.emulate>;
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
      await runtime.dispose();
      await storageManager.close();
    });

    it("returns the runtime's own frame from `export()`", () => {
      const cell = runtime.getCell<number>(space, "exported", undefined, tx);

      expect(cell.export().frame).toBe(getTopFrame());
    });

    it("throws naming the missing cause when it has no link to derive", () => {
      const cell = new CellImpl<number>(
        runtime,
        tx,
        { path: [], space },
        false,
      );

      expect(() => cell.get()).toThrow(
        "not in handler context and no cause provided",
      );
    });

    it("drops an `addUnique()` candidate whose stored form already appears in the array", () => {
      // A stored `Date` is a `FabricEpochNsec`, so a candidate `Date` matches it
      // only through the conversion the comparison puts the candidate through.

      const when = new Date("2026-09-11T00:00:00.000Z");
      const list = runtime.getCell<Date[]>(space, "dates", dateListSchema, tx);
      list.set([when]);

      list.addUnique(new Date(when.getTime()));

      expect(list.get().length).toBe(1);
    });

    it("keeps an `addUnique()` candidate whose stored form differs from every element", () => {
      const list = runtime.getCell<Date[]>(
        space,
        "other-dates",
        dateListSchema,
        tx,
      );
      list.set([new Date("2026-09-11T00:00:00.000Z")]);

      list.addUnique(new Date("2026-09-12T00:00:00.000Z"));

      expect(list.get().length).toBe(2);
    });
  });
});
