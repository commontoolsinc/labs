// Cell success callback tests: verifying that onCommit callbacks fire
// correctly after cell writes are committed.

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import "@commontools/utils/equal-ignoring-symbols";

import { Writable } from "@commontools/api";
import { Identity } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import { isCell } from "../src/cell.ts";
import { JSONSchema } from "../src/builder/types.ts";
import { popFrame, pushFrame } from "../src/builder/pattern.ts";
import { Runtime } from "../src/runtime.ts";
import { txToReactivityLog } from "../src/scheduler.ts";
import { type IExtendedStorageTransaction } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

describe("Cell success callbacks", () => {
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
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("should call onCommit callback after Cell.set() commits successfully", async () => {
    const cell = runtime.getCell<number>(
      space,
      "callback-set-test",
      undefined,
      tx,
    );

    let callbackCalled = false;
    let callbackTx: IExtendedStorageTransaction | undefined;

    cell.set(42, (committedTx) => {
      callbackCalled = true;
      callbackTx = committedTx;
    });

    expect(callbackCalled).toBe(false);
    await tx.commit();
    expect(callbackCalled).toBe(true);
    expect(callbackTx).toBe(tx);
    expect(cell.get()).toBe(42);
  });

  it("should call onCommit callback after Cell.send() commits successfully", async () => {
    const cell = runtime.getCell<number>(
      space,
      "callback-send-test",
      undefined,
      tx,
    );
    cell.set(10);

    let callbackCalled = false;
    let callbackTx: IExtendedStorageTransaction | undefined;

    cell.send(20, (committedTx) => {
      callbackCalled = true;
      callbackTx = committedTx;
    });

    expect(callbackCalled).toBe(false);
    await tx.commit();
    expect(callbackCalled).toBe(true);
    expect(callbackTx).toBe(tx);
    expect(cell.get()).toBe(20);
  });

  it("should handle multiple callbacks on same transaction", async () => {
    const cell1 = runtime.getCell<number>(
      space,
      "callback-multiple-1",
      undefined,
      tx,
    );
    const cell2 = runtime.getCell<number>(
      space,
      "callback-multiple-2",
      undefined,
      tx,
    );

    let callback1Called = false;
    let callback2Called = false;
    const callOrder: number[] = [];

    cell1.set(1, () => {
      callback1Called = true;
      callOrder.push(1);
    });

    cell2.set(2, () => {
      callback2Called = true;
      callOrder.push(2);
    });

    expect(callback1Called).toBe(false);
    expect(callback2Called).toBe(false);

    await tx.commit();

    expect(callback1Called).toBe(true);
    expect(callback2Called).toBe(true);
    expect(callOrder).toEqual([1, 2]);
  });

  it("should not call callback if transaction fails", () => {
    const cell = runtime.getCell<number>(
      space,
      "callback-fail-test",
      undefined,
      tx,
    );

    let callbackCalled = false;

    cell.set(42, () => {
      callbackCalled = true;
    });

    // Abort the transaction instead of committing
    tx.abort("test abort");

    expect(callbackCalled).toBe(false);
  });

  it("should handle errors in callback gracefully", async () => {
    const cell = runtime.getCell<number>(
      space,
      "callback-error-test",
      undefined,
      tx,
    );

    let callback1Called = false;
    let callback2Called = false;

    cell.set(1, () => {
      callback1Called = true;
      throw new Error("Callback error");
    });

    cell.set(2, () => {
      callback2Called = true;
    });

    await tx.commit();

    // First callback threw but second should still be called
    expect(callback1Called).toBe(true);
    expect(callback2Called).toBe(true);
  });

  it("should allow cell operations without callback", async () => {
    const cell = runtime.getCell<number>(
      space,
      "callback-optional-test",
      undefined,
      tx,
    );

    // Should work fine without callback (backward compatible)
    cell.set(42);
    await tx.commit();
    expect(cell.get()).toBe(42);
  });

  it("should call onCommit callback even when transaction commit fails", async () => {
    const cell = runtime.getCell<number>(
      space,
      "callback-commit-fail-test",
      undefined,
      tx,
    );

    let callbackCalled = false;
    let receivedTx: IExtendedStorageTransaction | undefined;

    cell.set(42, (committedTx) => {
      callbackCalled = true;
      receivedTx = committedTx;
    });

    // Cause the transaction to fail by aborting it, then commit
    tx.abort("intentional abort for test");
    await tx.commit();

    // Even though aborted, callback should still be called after commit
    expect(callbackCalled).toBe(true);
    expect(receivedTx).toBe(tx);

    // Verify the transaction actually failed
    const status = tx.status();
    expect(status.status).toBe("error");
  });

  describe("set operations with arrays", () => {
    it("should add IDs to objects when setting an array", () => {
      const frame = pushFrame();
      const cell = runtime.getCell<{ name: string; value: number }[]>(
        space,
        "array-set-test",
        { type: "array" },
        tx,
      );

      const objects = [
        { name: "first", value: 1 },
        { name: "second", value: 2 },
      ];

      cell.set(objects);
      popFrame(frame);

      const result = cell.asSchema({
        type: "array",
        items: {
          type: "object",
          properties: { name: { type: "string" }, value: { type: "number" } },
          asCell: true,
        },
      }).get();
      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBe(2);
      expect(isCell(result[0])).toBe(true);
      expect(isCell(result[1])).toBe(true);
      const link0 = result[0].getAsNormalizedFullLink();
      const link1 = result[1].getAsNormalizedFullLink();
      expect(link0.id).not.toBe(link1.id);
      expect(link0.path).toEqual([]);
      expect(link1.path).toEqual([]);
      expect(result[0].get().name).toBe("first");
      expect(result[1].get().name).toBe("second");
    });

    it("should preserve existing IDs when setting an array", () => {
      const initialDataCell = runtime.getCell<{ name: string; value: number }>(
        space,
        "array-set-preserve-id-test-initial",
        {
          type: "object",
          properties: { name: { type: "string" }, value: { type: "number" } },
        },
        tx,
      );
      initialDataCell.set({ name: "first", value: 1 });

      const frame = pushFrame();
      const cell = runtime.getCell<{ name: string; value: number }[]>(
        space,
        "array-set-preserve-id-test",
        { type: "array" },
        tx,
      );

      const objects = [
        initialDataCell,
        { name: "second", value: 2 },
      ];

      cell.set(objects);
      popFrame(frame);

      const result = cell.asSchema({
        type: "array",
        items: {
          type: "object",
          properties: { name: { type: "string" }, value: { type: "number" } },
          asCell: true,
        },
      }).get();
      expect(isCell(result[0])).toBe(true);
      expect(isCell(result[1])).toBe(true);
      const link0 = result[0].getAsNormalizedFullLink();
      const link1 = result[1].getAsNormalizedFullLink();
      expect(link0.id).toBe(initialDataCell.getAsNormalizedFullLink().id);
      expect(link0.id).not.toBe(link1.id);
    });
  });

  describe("push operations with default values", () => {
    it("should use default values from schema when pushing to empty array", () => {
      const frame = pushFrame();
      const cell = runtime.getCell<{ name: string; count: number }[]>(
        space,
        "push-with-defaults-test",
        {
          type: "array",
          default: [{ name: "default", count: 0 }],
        },
        tx,
      );

      cell.push({ name: "new", count: 5 });
      popFrame(frame);

      const result = cell.get();
      expect(result.length).toBe(2);
      expect(result[0].name).toBe("default");
      expect(result[0].count).toBe(0);
      expect(result[1].name).toBe("new");
      expect(result[1].count).toBe(5);
    });

    it("should add IDs to default values from schema", () => {
      const frame = pushFrame();
      const cell = runtime.getCell<{ name: string }[]>(
        space,
        "push-defaults-with-id-test",
        {
          type: "array",
          default: [{ name: "default1" }, { name: "default2" }],
        },
        tx,
      );

      cell.push({ name: "new" });
      popFrame(frame);

      const result = cell.asSchema({
        type: "array",
        items: {
          type: "object",
          properties: { name: { type: "string" } },
          asCell: true,
        },
      }).get();
      expect(result.length).toBe(3);
      expect(isCell(result[0])).toBe(true);
      expect(isCell(result[1])).toBe(true);
      expect(isCell(result[2])).toBe(true);
      const link0 = result[0].getAsNormalizedFullLink();
      const link1 = result[1].getAsNormalizedFullLink();
      const link2 = result[2].getAsNormalizedFullLink();
      expect(link0.id).not.toBe(link1.id);
      expect(link1.id).not.toBe(link2.id);
      expect(link0.id).not.toBe(link2.id);
    });

    it("should push objects with IDs even without schema defaults", () => {
      const frame = pushFrame();
      const cell = runtime.getCell<{ value: number }[]>(
        space,
        "push-no-defaults-test",
        { type: "array" },
        tx,
      );

      cell.push({ value: 1 }, { value: 2 });
      popFrame(frame);

      const result = cell.asSchema({
        type: "array",
        items: {
          type: "object",
          properties: { value: { type: "number" } },
          asCell: true,
        },
      }).get();
      expect(result.length).toBe(2);
      expect(isCell(result[0])).toBe(true);
      expect(isCell(result[1])).toBe(true);
      const link0 = result[0].getAsNormalizedFullLink();
      const link1 = result[1].getAsNormalizedFullLink();
      expect(link0.id).not.toBe(link1.id);
    });
  });

  describe("remove and removeAll operations", () => {
    it("should remove first matching primitive from array", () => {
      const frame = pushFrame();
      const cell = runtime.getCell<number[]>(
        space,
        "remove-primitive-test",
        { type: "array", items: { type: "number" } },
        tx,
      );

      cell.set([1, 2, 3, 2, 4]);
      cell.remove(2);
      popFrame(frame);

      const result = cell.get();
      expect(result).toEqual([1, 3, 2, 4]);
    });

    it("should remove all matching primitives from array", () => {
      const frame = pushFrame();
      const cell = runtime.getCell<number[]>(
        space,
        "removeall-primitive-test",
        { type: "array", items: { type: "number" } },
        tx,
      );

      cell.set([1, 2, 3, 2, 4, 2]);
      cell.removeAll(2);
      popFrame(frame);

      const result = cell.get();
      expect(result).toEqual([1, 3, 4]);
    });

    it("should remove first matching object from array using link comparison", () => {
      const frame = pushFrame();
      const cell = runtime.getCell<{ name: string }[]>(
        space,
        "remove-object-test",
        {
          type: "array",
          items: {
            type: "object",
            properties: { name: { type: "string" } },
            asCell: true,
          },
        },
        tx,
      );

      cell.push({ name: "alice" }, { name: "bob" }, { name: "charlie" });

      // Get the cell reference for bob
      const items = cell.get();
      const bobCell = items[1];

      cell.remove(bobCell);
      popFrame(frame);

      const result = cell.asSchema({
        type: "array",
        items: { type: "object", properties: { name: { type: "string" } } },
      }).get();
      expect(result.length).toBe(2);
      expect(result[0].name).toBe("alice");
      expect(result[1].name).toBe("charlie");
    });

    it("should remove all matching objects from array using link comparison", () => {
      const frame = pushFrame();
      const cell = runtime.getCell<{ name: string }[]>(
        space,
        "removeall-object-test",
        {
          type: "array",
          items: {
            type: "object",
            properties: { name: { type: "string" } },
            asCell: true,
          },
        },
        tx,
      );

      cell.push({ name: "alice" }, { name: "bob" }, { name: "alice-copy" });

      // Get the cell reference for alice
      const items = cell.get();
      const aliceCell = items[0];

      // Remove all instances of alice (should only remove the first one since they're different cells)
      cell.removeAll(aliceCell);
      popFrame(frame);

      const result = cell.asSchema({
        type: "array",
        items: { type: "object", properties: { name: { type: "string" } } },
      }).get();
      expect(result.length).toBe(2);
      expect(result[0].name).toBe("bob");
      expect(result[1].name).toBe("alice-copy");
    });

    it("should do nothing when removing element not in array", () => {
      const frame = pushFrame();
      const cell = runtime.getCell<number[]>(
        space,
        "remove-not-found-test",
        { type: "array", items: { type: "number" } },
        tx,
      );

      cell.set([1, 2, 3]);
      cell.remove(5);
      popFrame(frame);

      const result = cell.get();
      expect(result).toEqual([1, 2, 3]);
    });

    it("should do nothing when removeAll finds no matches", () => {
      const frame = pushFrame();
      const cell = runtime.getCell<number[]>(
        space,
        "removeall-not-found-test",
        { type: "array", items: { type: "number" } },
        tx,
      );

      cell.set([1, 2, 3]);
      cell.removeAll(5);
      popFrame(frame);

      const result = cell.get();
      expect(result).toEqual([1, 2, 3]);
    });

    it("should throw error when removing from non-array", () => {
      const frame = pushFrame();
      const cell = runtime.getCell<{ value: number }>(
        space,
        "remove-non-array-test",
        { type: "object", properties: { value: { type: "number" } } },
        tx,
      );

      cell.set({ value: 42 });

      expect(() => (cell as any).remove(42)).toThrow(
        "Can't remove from non-array value",
      );
      popFrame(frame);
    });

    it("should handle removing null from array", () => {
      const frame = pushFrame();
      const cell = runtime.getCell<(number | null)[]>(
        space,
        "remove-null-test",
        { type: "array" },
        tx,
      );

      cell.set([1, null, 2, 3, null]);
      cell.remove(null);
      popFrame(frame);

      const result = cell.get();
      expect(result).toEqual([1, 2, 3, null]);
    });

    it("should handle removing strings from array", () => {
      const frame = pushFrame();
      const cell = runtime.getCell<string[]>(
        space,
        "remove-string-test",
        { type: "array", items: { type: "string" } },
        tx,
      );

      cell.set(["apple", "banana", "cherry", "banana"]);
      cell.removeAll("banana");
      popFrame(frame);

      const result = cell.get();
      expect(result).toEqual(["apple", "cherry"]);
    });
  });

  describe("resolveAsCell", () => {
    it("should resolve a cell reference to the actual cell", () => {
      const innerCell = runtime.getCell<number>(
        space,
        "inner-cell",
        { type: "number" },
        tx,
      );
      innerCell.set(42);

      const outerCell = runtime.getCell<{ inner: unknown }>(
        space,
        "outer-cell",
        {
          type: "object",
          properties: {
            inner: { type: "number" },
          },
        },
        tx,
      );
      outerCell.set({ inner: innerCell });

      const resolvedCell = outerCell.key("inner").resolveAsCell();

      expect(resolvedCell.equals(innerCell)).toBe(true);
    });

    it("should resolve nested cell link similar to wish().result pattern", () => {
      // This test mimics the wish() result pattern where:
      // - A piece (targetPiece) exists with some data
      // - A wish result wraps it: { result: <link to targetPiece> }
      // - navigateTo receives wish.result which has path ["result"]
      // - We need to resolve to the actual targetPiece (path [])

      // Create the "target piece" - a cell with path []
      const targetPiece = runtime.getCell<{ title: string }>(
        space,
        "target-piece",
        { type: "object", properties: { title: { type: "string" } } },
        tx,
      );
      targetPiece.set({ title: "My Target Piece" });

      // Create the "wish result" that wraps the target piece
      // This mimics what wish() does: { result: cellToPiece }
      const wishResult = runtime.getCell<{ result: unknown }>(
        space,
        "wish-result",
        { type: "object", properties: { result: {} } },
        tx,
      );
      wishResult.set({ result: targetPiece });

      // Get the cell at path ["result"] - this is what navigateTo receives
      const resultCell = wishResult.key("result");

      // Verify the cell has non-empty path
      const link = resultCell.getAsNormalizedFullLink();
      expect(link.path.length).toBeGreaterThan(0);

      // Test: Can resolveAsCell() resolve this to the target piece?
      const resolved = resultCell.resolveAsCell();
      const resolvedLink = resolved.getAsNormalizedFullLink();

      // This is the key test: does resolveAsCell() give us path []?
      expect(resolvedLink.path.length).toBe(0);
      expect(resolved.equals(targetPiece)).toBe(true);
    });

    it("should follow chain of links to root", () => {
      // Test a chain: A.result -> B.result -> C (the final piece)
      // This tests "following links until there are no more links"

      const finalPiece = runtime.getCell<{ title: string }>(
        space,
        "final-piece",
        { type: "object", properties: { title: { type: "string" } } },
        tx,
      );
      finalPiece.set({ title: "Final Piece" });

      const middleCell = runtime.getCell<{ result: unknown }>(
        space,
        "middle-cell",
        { type: "object", properties: { result: {} } },
        tx,
      );
      middleCell.set({ result: finalPiece });

      const outerCell = runtime.getCell<{ result: unknown }>(
        space,
        "outer-cell",
        { type: "object", properties: { result: {} } },
        tx,
      );
      outerCell.set({ result: middleCell.key("result") });

      // Start from outer.result
      const startCell = outerCell.key("result");
      expect(startCell.getAsNormalizedFullLink().path.length).toBeGreaterThan(
        0,
      );

      // Test resolveAsCell
      const resolved = startCell.resolveAsCell();
      const resolvedLink = resolved.getAsNormalizedFullLink();

      // Does it resolve all the way to the final piece?
      expect(resolvedLink.path.length).toBe(0);
      expect(resolved.equals(finalPiece)).toBe(true);
    });

    describe("array elements", () => {
      it("keeps the same link for non-link primitive array elements", () => {
        const arrayCell = runtime.getCell<number[]>(
          space,
          "resolve-array-non-link",
          { type: "array", items: { type: "number" } },
          tx,
        );
        arrayCell.set([10, 20, 30]);

        const itemCell = arrayCell.key(1);
        const itemLink = itemCell.getAsNormalizedFullLink();
        const resolved = itemCell.resolveAsCell();

        expect(resolved.getAsNormalizedFullLink()).toEqual(itemLink);
        expect(resolved.get()).toBe(20);
      });

      it("resolves non-link object array elements to data URI cells", () => {
        const arrayCell = runtime.getCell<Array<{ name: string }>>(
          space,
          "resolve-array-non-link-object",
          {
            type: "array",
            items: {
              type: "object",
              properties: { name: { type: "string" } },
            },
          },
          tx,
        );
        arrayCell.setRaw([{ name: "first" }, { name: "second" }]);

        const itemCell = arrayCell.key(0);
        const itemLink = itemCell.getAsNormalizedFullLink();
        expect(itemLink.path).toEqual(["0"]);

        const resolved = itemCell.resolveAsCell();
        const resolvedLink = resolved.getAsNormalizedFullLink();

        expect(resolvedLink.id.startsWith("data:application/json,")).toBe(true);
        expect(resolvedLink.path).toEqual([]);
        expect(resolved.get()).toEqualIgnoringSymbols({ name: "first" });
      });

      it("resolves array element links to the target cell", () => {
        const target = runtime.getCell<{ value: number }>(
          space,
          "resolve-array-target",
          { type: "object", properties: { value: { type: "number" } } },
          tx,
        );
        target.set({ value: 42 });

        const arrayCell = runtime.getCell<unknown[]>(
          space,
          "resolve-array-link",
          { type: "array", items: {} },
          tx,
        );
        arrayCell.set([target]);

        const itemCell = arrayCell.key(0);
        expect(itemCell.getAsNormalizedFullLink().path).toEqual(["0"]);

        const resolved = itemCell.resolveAsCell();
        const resolvedLink = resolved.getAsNormalizedFullLink();

        expect(resolvedLink.path.length).toBe(0);
        expect(resolved.equals(target)).toBe(true);
      });

      it("resolves array element chains of links to the final target", () => {
        const finalTarget = runtime.getCell<{ label: string }>(
          space,
          "resolve-array-chain-final",
          { type: "object", properties: { label: { type: "string" } } },
          tx,
        );
        finalTarget.set({ label: "final" });

        const middle = runtime.getCell<{ result: unknown }>(
          space,
          "resolve-array-chain-middle",
          { type: "object", properties: { result: {} } },
          tx,
        );
        middle.set({ result: finalTarget });

        const arrayCell = runtime.getCell<unknown[]>(
          space,
          "resolve-array-chain-start",
          { type: "array", items: {} },
          tx,
        );
        arrayCell.set([middle.key("result")]);

        const resolved = arrayCell.key(0).resolveAsCell();
        const resolvedLink = resolved.getAsNormalizedFullLink();

        expect(resolvedLink.path.length).toBe(0);
        expect(resolved.equals(finalTarget)).toBe(true);
      });

      it("resolves asCell array item to data URI when item is inline data", () => {
        const schema = {
          type: "array",
          items: {
            type: "object",
            properties: { foo: { type: "number" } },
            asCell: true,
          },
        } as const satisfies JSONSchema;

        const arrayCell = runtime.getCell<{ foo: number }[]>(
          space,
          "resolve-array-ascell-inline",
          schema,
          tx,
        );
        arrayCell.setRaw([{ foo: 1 }, { foo: 2 }]);

        const result = arrayCell.get();
        expect(Array.isArray(result)).toBe(true);

        const first = result[0] as unknown as Writable<{ foo: number }>;
        expect(isCell(first)).toBe(true);
        expect(first.getAsNormalizedFullLink().path).toEqual(["0"]);

        const resolved = first.resolveAsCell();
        expect(
          resolved.getAsNormalizedFullLink().id.startsWith(
            "data:application/json,",
          ),
        ).toBe(true);
        expect(resolved.getAsNormalizedFullLink().path).toEqual([]);
        expect(resolved.get()).toEqualIgnoringSymbols({ foo: 1 });
      });

      it("resolves asCell array item when item value is a link", () => {
        const schema = {
          type: "array",
          items: {
            type: "object",
            properties: { foo: { type: "number" } },
            asCell: true,
          },
        } as const satisfies JSONSchema;

        const target = runtime.getCell<{ foo: number }>(
          space,
          "resolve-array-ascell-link-target",
          { type: "object", properties: { foo: { type: "number" } } },
          tx,
        );
        target.set({ foo: 99 });

        const arrayCell = runtime.getCell<{ foo: number }[]>(
          space,
          "resolve-array-ascell-link",
          schema,
          tx,
        );
        arrayCell.setRawUntyped([target.getAsLink()]);

        const result = arrayCell.get();
        const first = result[0] as unknown as Writable<{ foo: number }>;
        expect(isCell(first)).toBe(true);

        const resolved = first.resolveAsCell();
        const resolvedLink = resolved.getAsNormalizedFullLink();

        expect(resolvedLink.path.length).toBe(0);
        expect(resolved.equals(target)).toBe(true);
      });
    });
  });

  describe("cell.equals() instance method", () => {
    it("should return true when comparing a cell to itself", () => {
      const cell = runtime.getCell<number>(
        space,
        "self-compare",
        undefined,
        tx,
      );
      cell.set(42);
      expect(cell.equals(cell)).toBe(true);
    });

    it("should return false when comparing different cells", () => {
      const cell1 = runtime.getCell<number>(space, "cell1", undefined, tx);
      const cell2 = runtime.getCell<number>(space, "cell2", undefined, tx);
      cell1.set(42);
      cell2.set(42);
      expect(cell1.equals(cell2)).toBe(false);
    });

    it("should return true for cells pointing to the same location", () => {
      const cell1 = runtime.getCell<number>(
        space,
        "same-location",
        undefined,
        tx,
      );
      const cell2 = runtime.getCell<number>(
        space,
        "same-location",
        undefined,
        tx,
      );
      expect(cell1.equals(cell2)).toBe(true);
    });

    it("should resolve links before comparing", () => {
      const targetCell = runtime.getCell<number>(
        space,
        "target",
        undefined,
        tx,
      );
      targetCell.set(100);

      const linkingCell = runtime.getCell<number>(
        space,
        "linking",
        undefined,
        tx,
      );
      linkingCell.set(targetCell);

      // After resolving, linkingCell should equal targetCell
      expect(linkingCell.equals(targetCell)).toBe(true);
    });

    it("should handle chains of links when resolving", () => {
      const cell3 = runtime.getCell<number>(space, "final", undefined, tx);
      cell3.set(999);

      const cell2 = runtime.getCell<number>(space, "middle", undefined, tx);
      cell2.set(cell3);

      const cell1 = runtime.getCell<number>(space, "first", undefined, tx);
      cell1.set(cell2);

      // All should resolve to the same final location
      expect(cell1.equals(cell3)).toBe(true);
      expect(cell2.equals(cell3)).toBe(true);
      expect(cell1.equals(cell2)).toBe(true);
    });

    it("should return false when comparing with plain objects", () => {
      const cell = runtime.getCell<number>(space, "test", undefined, tx);
      cell.set(42);
      expect(cell.equals({ value: 42 })).toBe(false);
    });

    it("should handle null and undefined comparisons", () => {
      const cell = runtime.getCell<number>(space, "test", undefined, tx);
      expect(cell.equals(null as any)).toBe(false);
      expect(cell.equals(undefined as any)).toBe(false);
    });

    it("should work with nested cell structures", () => {
      const innerCell = runtime.getCell<number>(space, "inner", undefined, tx);
      innerCell.set(42);

      const outerCell = runtime.getCell<{ value: any }>(
        space,
        "outer",
        undefined,
        tx,
      );
      outerCell.set({ value: innerCell });

      const resolvedInner = outerCell.key("value").resolveAsCell();
      expect(resolvedInner.equals(innerCell)).toBe(true);
    });
  });

  describe("cell.equalLinks() instance method", () => {
    it("should return true when comparing a cell to itself", () => {
      const cell = runtime.getCell<number>(
        space,
        "self-compare",
        undefined,
        tx,
      );
      cell.set(42);
      expect(cell.equalLinks(cell)).toBe(true);
    });

    it("should return false when comparing different cells", () => {
      const cell1 = runtime.getCell<number>(space, "cell1-link", undefined, tx);
      const cell2 = runtime.getCell<number>(space, "cell2-link", undefined, tx);
      cell1.set(42);
      cell2.set(42);
      expect(cell1.equalLinks(cell2)).toBe(false);
    });

    it("should return true for cells pointing to the same location", () => {
      const cell1 = runtime.getCell<number>(space, "same-loc", undefined, tx);
      const cell2 = runtime.getCell<number>(space, "same-loc", undefined, tx);
      expect(cell1.equalLinks(cell2)).toBe(true);
    });

    it("should NOT resolve links before comparing", () => {
      const targetCell = runtime.getCell<number>(
        space,
        "target-link",
        undefined,
        tx,
      );
      targetCell.set(100);

      const linkingCell = runtime.getCell<number>(
        space,
        "linking-link",
        undefined,
        tx,
      );
      linkingCell.set(targetCell);

      // Without resolving, these should be different
      expect(linkingCell.equalLinks(targetCell)).toBe(false);
    });

    it("should return false when both cells link to the same target but are different cells", () => {
      const targetCell = runtime.getCell<number>(
        space,
        "shared-target",
        undefined,
        tx,
      );
      targetCell.set(42);

      const link1 = runtime.getCell<number>(space, "link-a", undefined, tx);
      link1.set(targetCell);

      const link2 = runtime.getCell<number>(space, "link-b", undefined, tx);
      link2.set(targetCell);

      // link1 and link2 are different cells, so they're not equal
      expect(link1.equalLinks(link2)).toBe(false);
    });

    it("should handle chains of links without resolving", () => {
      const cell3 = runtime.getCell<number>(
        space,
        "chain-final",
        undefined,
        tx,
      );
      cell3.set(999);

      const cell2 = runtime.getCell<number>(
        space,
        "chain-middle",
        undefined,
        tx,
      );
      cell2.set(cell3);

      const cell1 = runtime.getCell<number>(
        space,
        "chain-first",
        undefined,
        tx,
      );
      cell1.set(cell2);

      // Without resolving, these should all be different
      expect(cell1.equalLinks(cell3)).toBe(false);
      expect(cell2.equalLinks(cell3)).toBe(false);
      expect(cell1.equalLinks(cell2)).toBe(false);
    });

    it("should return false when comparing with plain objects", () => {
      const cell = runtime.getCell<number>(space, "test-link", undefined, tx);
      cell.set(42);
      expect(cell.equalLinks({ value: 42 })).toBe(false);
    });

    it("should handle null and undefined comparisons", () => {
      const cell = runtime.getCell<number>(space, "test-null", undefined, tx);
      expect(cell.equalLinks(null as any)).toBe(false);
      expect(cell.equalLinks(undefined as any)).toBe(false);
    });

    it("should distinguish between direct value and linked value", () => {
      const valueCell = runtime.getCell<number>(
        space,
        "has-value",
        undefined,
        tx,
      );
      valueCell.set(42);

      const linkCell = runtime.getCell<number>(
        space,
        "has-link",
        undefined,
        tx,
      );
      linkCell.set(valueCell);

      // One has a value, one has a link - they're different
      expect(valueCell.equalLinks(linkCell)).toBe(false);
      expect(linkCell.equalLinks(valueCell)).toBe(false);
    });
  });

  describe("equals() vs equalLinks() comparison", () => {
    it("should show difference between equals and equalLinks with single link", () => {
      const target = runtime.getCell<number>(
        space,
        "compare-target",
        undefined,
        tx,
      );
      target.set(100);

      const linker = runtime.getCell<number>(
        space,
        "compare-linker",
        undefined,
        tx,
      );
      linker.set(target);

      // equals resolves, so they're equal
      expect(linker.equals(target)).toBe(true);
      // equalLinks doesn't resolve, so they're different
      expect(linker.equalLinks(target)).toBe(false);
    });

    it("should show difference with link chains", () => {
      const final = runtime.getCell<number>(space, "chain-end", undefined, tx);
      final.set(42);

      const middle = runtime.getCell<number>(space, "chain-mid", undefined, tx);
      middle.set(final);

      const start = runtime.getCell<number>(
        space,
        "chain-start",
        undefined,
        tx,
      );
      start.set(middle);

      // equals resolves all links
      expect(start.equals(final)).toBe(true);
      expect(middle.equals(final)).toBe(true);

      // equalLinks doesn't resolve
      expect(start.equalLinks(final)).toBe(false);
      expect(middle.equalLinks(final)).toBe(false);
    });

    it("should behave the same for cells without links", () => {
      const cell1 = runtime.getCell<number>(space, "no-link-1", undefined, tx);
      const cell2 = runtime.getCell<number>(space, "no-link-2", undefined, tx);

      cell1.set(42);
      cell2.set(42);

      // Both should return false since cells are different
      expect(cell1.equals(cell2)).toBe(false);
      expect(cell1.equalLinks(cell2)).toBe(false);
    });

    it("should behave the same for same cell references", () => {
      const cell = runtime.getCell<number>(space, "same-ref", undefined, tx);
      cell.set(42);

      // Both should return true for same reference
      expect(cell.equals(cell)).toBe(true);
      expect(cell.equalLinks(cell)).toBe(true);
    });
  });

  describe("asSchemaFromLinks", () => {
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
      await runtime?.dispose();
      await storageManager?.close();
    });

    it("should return schema if present on the cell", () => {
      const schema: JSONSchema = { type: "string" };
      const c = runtime.getCell(space, "cell-with-schema", schema, tx);
      const schemaCell = c.asSchemaFromLinks();
      expect(schemaCell.schema).toEqual(schema);
    });

    it("should return schema from pattern resultRef if not present on cell", () => {
      // 1. Create the target cell (no schema initially)
      const targetCell = runtime.getCell(space, "target-cell", undefined, tx);

      // 2. Create the pattern cell
      const patternCell = runtime.getCell(space, "pattern-cell", undefined, tx);

      // 3. Set patternCell as the source of targetCell
      targetCell.setSourceCell(patternCell);

      // 4. Create a link to targetCell that includes the desired schema
      const schemaWeWant: JSONSchema = {
        type: "object",
        properties: {
          output: { type: "number" },
        },
      };
      const linkWithSchema = targetCell
        .asSchema(schemaWeWant)
        .getAsLink({ includeSchema: true });

      // 5. Set patternCell's resultRef to point to targetCell using the link with schema
      patternCell.set({ resultRef: linkWithSchema });

      // 6. Verify asSchemaFromLinks picks up the schema from the resultRef link
      const schemaCell = targetCell.asSchemaFromLinks();

      expect(schemaCell.schema).toEqual(schemaWeWant);
    });

    it("should return undefined schema if neither present nor in pattern", () => {
      const c = runtime.getCell(space, "no-schema", undefined, tx);
      const schemaCell = c.asSchemaFromLinks();
      expect(schemaCell.schema).toBeUndefined();
    });
  });

  describe("pull()", () => {
    it("should return the cell value in push mode", async () => {
      const c = runtime.getCell<number>(space, "pull-test-1", undefined, tx);
      c.set(42);
      await tx.commit();
      tx = runtime.edit();

      const value = await c.pull();
      expect(value).toBe(42);
    });

    it("should wait for dependent computations in push mode", async () => {
      // Create a source cell
      const source = runtime.getCell<number>(
        space,
        "pull-source",
        undefined,
        tx,
      );
      source.set(5);
      await tx.commit();
      tx = runtime.edit();

      // Create a computation that depends on source
      const computed = runtime.getCell<number>(
        space,
        "pull-computed",
        undefined,
        tx,
      );

      const action = (actionTx: IExtendedStorageTransaction) => {
        const val = source.withTx(actionTx).get();
        computed.withTx(actionTx).set(val * 2);
      };

      // Run once to set up initial value and log reads
      const setupTx = runtime.edit();
      action(setupTx);
      const log = txToReactivityLog(setupTx);
      await setupTx.commit();

      // Subscribe the computation
      runtime.scheduler.subscribe(action, log, {});

      // Pull should wait for the computation to run
      const value = await computed.pull();
      expect(value).toBe(10);
    });

    it("should work in pull mode", async () => {
      runtime.scheduler.enablePullMode();

      // In pull mode, pull() works the same way - it registers as an effect
      // and waits for the scheduler. The key difference is that pull() ensures
      // the effect mechanism is used, which triggers pull-based execution.
      const c = runtime.getCell<number>(space, "pull-mode-cell", undefined, tx);
      c.set(42);
      await tx.commit();
      tx = runtime.edit();

      const value = await c.pull();
      expect(value).toBe(42);

      // Verify we can pull after updates
      const tx2 = runtime.edit();
      c.withTx(tx2).set(100);
      await tx2.commit();

      const value2 = await c.pull();
      expect(value2).toBe(100);

      runtime.scheduler.disablePullMode();
    });

    it("should handle multiple sequential pulls", async () => {
      const c = runtime.getCell<number>(space, "pull-multi", undefined, tx);
      c.set(1);
      await tx.commit();

      expect(await c.pull()).toBe(1);

      const tx2 = runtime.edit();
      c.withTx(tx2).set(2);
      await tx2.commit();

      expect(await c.pull()).toBe(2);

      const tx3 = runtime.edit();
      c.withTx(tx3).set(3);
      await tx3.commit();

      expect(await c.pull()).toBe(3);
    });

    it("should pull nested cell values", async () => {
      const c = runtime.getCell<{ a: { b: number } }>(
        space,
        "pull-nested",
        undefined,
        tx,
      );
      c.set({ a: { b: 99 } });
      await tx.commit();
      tx = runtime.edit();

      const nested = c.key("a").key("b");
      const value = await nested.pull();
      expect(value).toBe(99);
    });

    it("should not create a persistent effect after pull completes", async () => {
      runtime.scheduler.enablePullMode();

      // Create source and computed cells
      const source = runtime.getCell<number>(
        space,
        "pull-no-persist-source",
        undefined,
        tx,
      );
      source.set(5);
      const computed = runtime.getCell<number>(
        space,
        "pull-no-persist-computed",
        undefined,
        tx,
      );
      computed.set(0);
      await tx.commit();

      // Track how many times the computation runs
      let runCount = 0;

      // Create a computation that multiplies source by 2
      const action = (actionTx: IExtendedStorageTransaction) => {
        runCount++;
        const val = source.withTx(actionTx).get();
        computed.withTx(actionTx).set(val * 2);
      };

      // Run once to set up initial value and capture dependencies
      const setupTx = runtime.edit();
      action(setupTx);
      const log = txToReactivityLog(setupTx);
      await setupTx.commit();

      // Subscribe the computation (as a computation, NOT an effect)
      // In pull mode, computations only run when pulled by effects
      runtime.scheduler.subscribe(action, log, { isEffect: false });

      // Change source to mark the computation as dirty
      const tx1 = runtime.edit();
      source.withTx(tx1).set(6); // Change from 5 to 6 to trigger dirtiness
      await tx1.commit();

      // Reset run count after marking dirty
      runCount = 0;

      // First pull - should trigger the computation because pull() creates
      // a temporary effect that pulls dirty dependencies
      const value1 = await computed.pull();
      expect(value1).toBe(12); // 6 * 2 = 12
      const runsAfterFirstPull = runCount;
      expect(runsAfterFirstPull).toBeGreaterThan(0);

      // Now change the source AFTER pull completed
      const tx2 = runtime.edit();
      source.withTx(tx2).set(7);
      await tx2.commit();

      // Wait for any scheduled work to complete
      await runtime.scheduler.idle();

      // The computation should NOT have run again because:
      // 1. pull() cancelled its temporary effect after completing
      // 2. There are no other effects subscribed
      // 3. In pull mode, computations only run when pulled by effects
      const runsAfterSourceChange = runCount;

      // If pull() created a persistent effect, the computation would run
      // again when source changes. With correct cleanup, it should NOT run.
      expect(runsAfterSourceChange).toBe(runsAfterFirstPull);

      runtime.scheduler.disablePullMode();
    });
  });
});
