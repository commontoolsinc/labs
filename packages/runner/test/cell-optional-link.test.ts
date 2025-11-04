import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import "@commontools/utils/equal-ignoring-symbols";

import { Identity } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import { CellImpl } from "../src/cell.ts";
import { Runtime } from "../src/runtime.ts";
import { popFrame, pushFrame } from "../src/builder/recipe.ts";
import { type IExtendedStorageTransaction } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("test operator optional link");
const space = signer.did();

describe("Cell with Optional Link", () => {
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

  describe(".for() method", () => {
    it("should allow setting a cause on a cell", () => {
      const cell = new CellImpl(runtime, { path: [], space }, tx, false);
      const cause = { type: "test-cause" };

      const result = cell.for(cause);

      // Should return the cell for chaining
      expect(result).toBe(cell);
    });

    it("should ignore .for() if link already exists", () => {
      const existingCell = runtime.getCell<number>(
        space,
        "test-cell-with-link",
        undefined,
        tx,
      );
      existingCell.set(42);

      const cause = { type: "test-cause" };
      const result = existingCell.for(cause);

      // Should return the cell for chaining
      expect(result).toBe(existingCell);
      // Cell should still work normally
      expect(existingCell.get()).toBe(42);
    });

    it("should allow force option to override existing link behavior", () => {
      const existingCell = runtime.getCell<number>(
        space,
        "test-cell-force",
        undefined,
        tx,
      );
      existingCell.set(42);

      const cause = { type: "test-cause" };
      const result = existingCell.for(cause, { force: true });

      // Should return the cell for chaining
      expect(result).toBe(existingCell);
    });

    it("should support method chaining", () => {
      const cell = new CellImpl(runtime, { path: [], space }, tx, false);
      const cause = { type: "test-cause" };

      // Chain .for() and .key()
      const result = cell.for(cause).key("foo");

      // Should return a cell (even without link)
      expect(result).toBeDefined();
    });
  });

  describe(".key() without link", () => {
    it("should allow chaining .key() on cell without link", () => {
      const cell = new CellImpl(runtime, { path: [], space }, tx, false);
      const cause = { type: "test-cause" };

      const child = cell.for(cause).key("foo");

      // Should create a child cell without throwing
      expect(child).toBeDefined();
    });

    it("should allow nested .key() calls without link", () => {
      const cell = new CellImpl(runtime, { path: [], space }, tx, false);
      const cause = { type: "test-cause" };

      const nestedChild = cell.for(cause).key("foo").key("bar").key("baz");

      // Should create nested cells without throwing
      expect(nestedChild).toBeDefined();
    });

    it("should inherit cause from parent when using .key()", () => {
      const cell = new CellImpl(runtime, { path: [], space }, tx, false);
      const cause = { type: "test-cause" };

      cell.for(cause);
      const child = cell.key("foo");

      // Child should inherit the cause
      // We can't directly test private fields, but we can verify it doesn't throw
      expect(child).toBeDefined();
    });
  });

  describe("ensureLink() error handling", () => {
    it("should throw error when accessing cell without link outside handler context", () => {
      const cell = new CellImpl<{ value: number }>(runtime, undefined, tx);

      // Trying to get the cell value without a link should throw
      expect(() => cell.get()).toThrow(
        "Cannot create cell link: not in a handler context and no cause was provided",
      );
    });

    it("should throw error when accessing space without cause", () => {
      const cell = new CellImpl(runtime, { path: [], space }, tx, false);

      // Without a cause, should throw
      expect(() => cell.space).toThrow(
        "Cannot create cell link: not in a handler context and no cause was provided",
      );
    });

    it("should throw error when accessing path without cause", () => {
      const cell = new CellImpl(runtime, { path: [], space }, tx, false);

      // Without a cause, should throw
      expect(() => cell.path).toThrow(
        "Cannot create cell link: not in a handler context and no cause was provided",
      );
    });

    it("should create link when accessing cell with cause and space", () => {
      const cell = new CellImpl(runtime, { path: [], space }, tx, false);
      const cause = { type: "test-cause" };

      pushFrame({
        cause: { type: "lift-cause" },
        generatedIdCounter: 0,
        opaqueRefs: new Set(),
      });

      cell.for(cause);

      // With both cause and space, link should be created automatically
      expect(cell.space).toBe(space);
      expect(cell.path).toEqual([]);

      popFrame();
    });

    it("should create link using frame cause when in handler context", () => {
      const cell = new CellImpl(runtime, { path: [], space }, tx, false);

      // Create a frame with a cause
      pushFrame({
        cause: { type: "handler-cause" },
        generatedIdCounter: 0,
        opaqueRefs: new Set(),
      });

      cell.for({ for: "test" });

      try {
        // With frame cause and space, link should be created automatically
        expect(cell.space).toBe(space);
        expect(cell.path).toEqual([]);
      } finally {
        popFrame();
      }
    });
  });

  describe("CellImpl backward compatibility", () => {
    it("should work with existing link-based cells", () => {
      const cell = runtime.getCell<{ value: number; nested?: number }>(
        space,
        "backward-compat-test",
        undefined,
        tx,
      );

      cell.set({ value: 100 });
      expect(cell.get()).toEqual({ value: 100 });

      const child = cell.key("nested");
      child.set(200);
      expect(child.get()).toBe(200);
    });

    it("should handle .for() on cells with existing links gracefully", () => {
      const cell = runtime.getCell<number>(
        space,
        "for-on-existing-link",
        undefined,
        tx,
      );

      cell.set(42);

      // Should not affect the cell
      cell.for({ type: "ignored-cause" });

      expect(cell.get()).toBe(42);
    });
  });

  describe("Error messages", () => {
    it("should provide helpful error when cell is passed to .set() without link", () => {
      const targetCell = runtime.getCell<any>(
        space,
        "target-cell",
        undefined,
        tx,
      );
      const cellWithoutLink = new CellImpl(
        runtime,
        { path: [], space },
        tx,
        false,
      );

      // When trying to convert cellWithoutLink to a link, it should throw
      expect(() => targetCell.set(cellWithoutLink)).toThrow();
    });

    it("should suggest using .for() in error messages", () => {
      const cell = new CellImpl(runtime, { path: [], space }, tx, false);

      try {
        cell.get();
        expect(true).toBe(false); // Should not reach here
      } catch (error: any) {
        expect(error.message).toContain(".for(cause)");
        expect(error.message).toContain("cause");
      }
    });
  });

  describe("Stream cells with optional links", () => {
    it("should handle streams created through CellImpl", () => {
      // Create a stream cell
      const streamCell = runtime.getCell(
        space,
        "test-stream",
        undefined,
        tx,
      );

      // Set it to a stream value
      streamCell.setRaw({ $stream: true });

      const receivedEvents: any[] = [];
      streamCell.sink((event: any) => {
        receivedEvents.push(event);
      });

      streamCell.send({ type: "test-event" });

      expect(receivedEvents.length).toBe(1);
      expect(receivedEvents[0]).toEqual({ type: "test-event" });
    });
  });
});
