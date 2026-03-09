// CT-1316: derive() callback crashes with message:null when returning
// a recursive pattern instantiation (tail-call).
//
// When a derive() callback returns a pattern instantiation that recursively
// calls itself, the runtime crashes with {type: callback:error, message: null}.
// In the builder path, this manifests as "Too many iterations" in the scheduler
// because the derive action is re-triggered ~100 times per execute cycle, even
// though the actual callback only runs a handful of times (the rest are
// invalid-argument no-ops).

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { Identity } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import { createBuilder } from "../src/builder/factory.ts";
import { Runtime } from "../src/runtime.ts";
import { type IExtendedStorageTransaction } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

describe("Pattern Runner - Derive returning pattern (CT-1316)", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;
  let derive: ReturnType<typeof createBuilder>["commontools"]["derive"];
  let lift: ReturnType<typeof createBuilder>["commontools"]["lift"];
  let pattern: ReturnType<typeof createBuilder>["commontools"]["pattern"];

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });

    tx = runtime.edit();

    const { commontools } = createBuilder();
    ({
      derive,
      lift,
      pattern,
    } = commontools);
  });

  afterEach(async () => {
    await tx.commit();
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("should handle derive returning a non-recursive pattern instantiation", async () => {
    // Baseline: derive returns a different pattern (not self-referential).
    // email-pattern-launcher.tsx uses this mechanism successfully.
    const innerPattern = pattern<{ value: number }>(({ value }) => {
      const doubled = lift((x: number) => x * 2)(value);
      return { result: doubled };
    });

    const outerPattern = pattern<{ value: number }>(({ value }) => {
      return derive({ value }, ({ value: v }) => {
        return innerPattern({ value: v });
      });
    });

    const resultCell = runtime.getCell<{ result: number }>(
      space,
      "derive-return-pattern-basic",
      undefined,
      tx,
    );

    const result = runtime.run(tx, outerPattern, { value: 5 }, resultCell);
    await tx.commit();

    const value = await result.pull();
    expect(value.result).toBe(10);
  });

  it("should handle derive returning a recursive pattern instantiation (tail-call)", async () => {
    // CT-1316: A pattern that conditionally calls itself via derive,
    // simulating tail-call pagination (like FetchContactsPage in
    // google-contacts-importer.tsx).
    //
    // BUG: Even with depth=1, the scheduler hits "Too many iterations: 101"
    // on the derive action. The callback only runs ~7 times (3 recursive
    // levels + base cases + a few reactive re-evaluations), but the action
    // wrapper is re-triggered ~100 times with invalid arguments. This
    // indicates a reactive cycle where each sub-pattern creation dirties
    // the parent action.

    let deriveCallCount = 0;

    const accumulator = pattern<{
      remaining: number;
      accumulated: number[];
      pageSize: number;
    }>(({ remaining, accumulated, pageSize }) => {
      return derive(
        { remaining, accumulated, pageSize },
        ({ remaining: rem, accumulated: acc, pageSize: ps }) => {
          deriveCallCount++;

          // Guard against initial reactive pass with undefined values
          const items = Array.isArray(acc) ? acc : [];
          if (typeof rem !== "number" || rem <= 0) {
            return { items, done: true };
          }

          // Generate items for this "page"
          const newItems = Array.from(
            { length: ps },
            (_, i) => items.length + i + 1,
          );
          const combined = [...items, ...newItems];

          // Tail call: recursively instantiate self with updated state
          return accumulator({
            remaining: rem - 1,
            accumulated: combined,
            pageSize: ps,
          });
        },
      );
    });

    const resultCell = runtime.getCell<{ items: number[]; done: boolean }>(
      space,
      "derive-return-recursive-pattern",
      undefined,
      tx,
    );

    // 3 pages of 2 items each = 6 items total
    const result = runtime.run(
      tx,
      accumulator,
      { remaining: 3, accumulated: [], pageSize: 2 },
      resultCell,
    );
    await tx.commit();

    const value = await result.pull();
    expect(value.done).toBe(true);
    expect(value.items).toEqual([1, 2, 3, 4, 5, 6]);

    // The callback should run a reasonable number of times.
    // 3 recursive levels + base case + a few reactive re-evaluations = ~7.
    // This assertion passes, but the scheduler logs "Too many iterations: 101"
    // because the action WRAPPER (not the callback) runs 101 times — most with
    // invalid arguments that skip the callback.
    expect(deriveCallCount).toBeLessThan(20);
  });

  it("should handle derive conditionally returning plain value or pattern", async () => {
    // Tests the branch where derive sometimes returns a plain value
    // and sometimes returns a pattern instantiation.

    const innerPattern = pattern<{ value: number }>(({ value }) => {
      const tripled = lift((x: number) => x * 3)(value);
      return { result: tripled };
    });

    const conditionalPattern = pattern<{ value: number; usePattern: boolean }>(
      ({ value, usePattern }) => {
        return derive(
          { value, usePattern },
          ({ value: v, usePattern: up }) => {
            if (up) {
              return innerPattern({ value: v });
            }
            return { result: v * 2 };
          },
        );
      },
    );

    // Case 1: usePattern = false → plain value path
    const resultCell1 = runtime.getCell<{ result: number }>(
      space,
      "derive-conditional-plain",
      undefined,
      tx,
    );
    const result1 = runtime.run(
      tx,
      conditionalPattern,
      { value: 5, usePattern: false },
      resultCell1,
    );
    await tx.commit();
    tx = runtime.edit();

    const value1 = await result1.pull();
    expect(value1.result).toBe(10);

    // Case 2: usePattern = true → pattern instantiation path
    const resultCell2 = runtime.getCell<{ result: number }>(
      space,
      "derive-conditional-pattern",
      undefined,
      tx,
    );
    const result2 = runtime.run(
      tx,
      conditionalPattern,
      { value: 5, usePattern: true },
      resultCell2,
    );
    await tx.commit();

    const value2 = await result2.pull();
    expect(value2.result).toBe(15);
  });
});
