// Regression tests for specific bug fixes. Each test should reference
// the issue number (e.g. CT-1158). New regressions go here.

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { NAME } from "../src/builder/types.ts";
import { createBuilder } from "../src/builder/factory.ts";
import type { Pattern } from "../src/builder/types.ts";
import { Runtime } from "../src/runtime.ts";
import { type IExtendedStorageTransaction } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

describe("Pattern Runner - Regressions", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;
  let derive: ReturnType<typeof createBuilder>["commonfabric"]["derive"];
  let pattern: ReturnType<typeof createBuilder>["commonfabric"]["pattern"];
  let ifElse: ReturnType<typeof createBuilder>["commonfabric"]["ifElse"];
  let handler: ReturnType<typeof createBuilder>["commonfabric"]["handler"];

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });

    tx = runtime.edit();

    const { commonfabric } = createBuilder();
    ({
      derive,
      pattern,
      ifElse,
      handler,
    } = commonfabric);
  });

  afterEach(async () => {
    if (tx?.status().status === "ready") {
      await tx.commit();
    }
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("should preserve cell references when map truncates with ifElse null values (CT-1158)", async () => {
    // Regression test for CT-1158: Map truncation was losing cell references
    // when ifElse returned null. The bug was in map.ts using .get().slice()
    // which dereferences cells, causing null values to lose their cell refs.
    //
    // Repro: Create a map with ifElse that returns null for some items,
    // then remove an item from the source array. The remaining items should
    // still be accessible (not undefined due to broken cell references).

    const testPattern = pattern<
      { items: Array<{ name: string; visible: boolean }> }
    >(
      ({ items }) => {
        // Map over items, returning item name if visible, null otherwise
        const mapped = items.map((item) =>
          ifElse(
            derive(item, (i) => i.visible),
            derive(item, (i) => i.name),
            null,
          )
        );
        return { items, mapped };
      },
    );

    const resultCell = runtime.getCell<{
      items: Array<{ name: string; visible: boolean }>;
      mapped: Array<string | null>;
    }>(
      space,
      "ct-1158-map-truncation",
      undefined,
      tx,
    );

    // Start with 3 items: A (visible), B (hidden), C (visible)
    const result = runtime.run(tx, testPattern, {
      items: [
        { name: "A", visible: true },
        { name: "B", visible: false },
        { name: "C", visible: true },
      ],
    }, resultCell);
    await tx.commit();

    await result.pull();

    // Verify initial state: ["A", null, "C"]
    const initialMapped = result.key("mapped").get();
    expect(initialMapped).toHaveLength(3);
    expect(initialMapped[0]).toBe("A");
    expect(initialMapped[1]).toBe(null);
    expect(initialMapped[2]).toBe("C");

    // Now remove the LAST item - this triggers map truncation from 3 to 2 items
    // The truncation should preserve cell refs for items[0] and items[1]
    tx = runtime.edit();
    const currentItems = result.withTx(tx).key("items").get();
    result.withTx(tx).key("items").set(currentItems.slice(0, 2)); // Keep first 2
    tx.commit();

    await result.pull();

    // After truncation, mapped should be ["A", null]
    // BUG (before fix): null at index 1 became a broken reference, entire array invalid
    // FIXED: Cell references preserved, mapped correctly shows ["A", null]
    const afterMapped = result.key("mapped").get();
    expect(afterMapped).toHaveLength(2);
    expect(afterMapped[0]).toBe("A"); // A was visible
    expect(afterMapped[1]).toBe(null); // B was hidden, null preserved correctly
  });

  it("keeps Notebook NAME current after createNote without an extra timer turn in v2", async () => {
    await tx.commit();
    await runtime.dispose();
    await storageManager.close();
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

    const notePattern = pattern<{ title: string }>(({ title }) => ({
      title,
      [NAME]: derive(title, (value: string) => `📝 ${value}`),
    }));

    const createNote = handler<
      void,
      { notes: Array<ReturnType<typeof notePattern>> }
    >(
      (_, { notes }) => {
        const newNote = notePattern({ title: "Stream Created Note" });
        notes.push(newNote);
      },
      { proxy: true },
    );

    const notebookLikePattern = pattern<{
      title: string;
      notes: Array<ReturnType<typeof notePattern>>;
    }>(({ title, notes }) => {
      const noteCount = derive(
        notes,
        (items: Array<{ title: string }>) => items.length,
      );
      const displayName = derive(
        { title, noteCount },
        ({ title, noteCount }: { title: string; noteCount: number }) =>
          `📓 ${title} (${noteCount})`,
      );
      return {
        title,
        notes,
        noteCount,
        [NAME]: displayName,
        createNote: createNote({ notes }),
      };
    });

    const resultCell = runtime.getCell<any>(
      space,
      "ct-notebook-name-regression",
      undefined,
      tx,
    );
    const result = runtime.run(tx, notebookLikePattern, {
      title: "Test Notebook",
      notes: [],
    }, resultCell);
    await tx.commit();

    await runtime.idle();
    await storageManager.synced();
    await runtime.idle();

    expect(result.key("noteCount").get()).toBe(0);
    expect(result.key(NAME).get()).toBe("📓 Test Notebook (0)");

    result.key("createNote").send();

    await runtime.idle();
    await storageManager.synced();
    await runtime.idle();

    expect(result.key("noteCount").get()).toBe(1);
    expect(result.key(NAME).get()).toBe("📓 Test Notebook (1)");
  });

  it("clears locally prepared results when a run transaction fails to commit in v2", async () => {
    await tx.commit();
    await runtime.dispose();
    await storageManager.close();

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

    const echoPattern = pattern<{ title: string }>(({ title }) => ({ title }));
    const resultCell = runtime.getCell<{ title: string }>(
      space,
      "ct-locally-prepared-results-rollback",
      undefined,
      tx,
    );

    const runner = runtime.runner as any;
    runner.setupInternal(tx, echoPattern, { title: "draft" }, resultCell);
    const key = runner.getDocKey(resultCell);
    expect(runner.locallyPreparedResults.has(key)).toBe(true);

    const originalCommit = tx.tx.commit.bind(tx.tx);
    (tx.tx as any).commit = () =>
      Promise.resolve({
        error: {
          name: "ConflictError",
          message: "synthetic conflict",
        },
      });

    const result = await tx.commit();
    expect(result.error?.name).toBe("ConflictError");
    expect(runner.locallyPreparedResults.has(key)).toBe(false);

    (tx.tx as any).commit = originalCommit;
    tx = runtime.edit();
  });

  it("normalizes nested toJSON values before raw runner writes in v2", async () => {
    await tx.commit();
    await runtime.dispose();
    await storageManager.close();

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

    const initialRecipe = Object.assign(() => {}, {
      toJSON() {
        return { name: "initial recipe" };
      },
    });
    const resultRecipe = Object.assign(() => {}, {
      toJSON() {
        return { name: "result recipe" };
      },
    });

    const rawValuePattern = {
      argumentSchema: {},
      resultSchema: {},
      initial: {
        internal: {
          recipe: initialRecipe as unknown,
        },
      },
      result: {
        internalRecipe: {
          $alias: { path: ["internal", "recipe"] },
        },
        resultRecipe: resultRecipe as unknown,
      },
      nodes: [],
    } as unknown as Pattern;

    const resultCell = runtime.getCell<{
      internalRecipe: { name: string };
      resultRecipe: { name: string };
    }>(
      space,
      "ct-v2-raw-runner-normalization",
      undefined,
      tx,
    );

    const result = runtime.run(tx, rawValuePattern, {}, resultCell);
    await tx.commit();

    const value = await result.pull();
    expect(value).toMatchObject({
      internalRecipe: { name: "initial recipe" },
      resultRecipe: { name: "result recipe" },
    });
  });
});
