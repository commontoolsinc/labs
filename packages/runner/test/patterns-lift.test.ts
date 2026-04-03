// Lifted functions: pure transformations via lift(), error and recovery behavior,
// cell creation inside lifts, reactivity control (sample), and evaluation timing.

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { Identity } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import { type Cell, type JSONSchema } from "../src/builder/types.ts";
import { createBuilder } from "../src/builder/factory.ts";
import { Runtime } from "../src/runtime.ts";
import { type ErrorWithContext } from "../src/scheduler.ts";
import { isCell } from "../src/cell.ts";
import { resolveLink } from "../src/link-resolution.ts";
import { type IExtendedStorageTransaction } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

describe("Pattern Runner - Lift", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;
  let lift: ReturnType<typeof createBuilder>["commontools"]["lift"];
  let pattern: ReturnType<typeof createBuilder>["commontools"]["pattern"];
  let Cell: ReturnType<typeof createBuilder>["commontools"]["Cell"];
  let TYPE: ReturnType<typeof createBuilder>["commontools"]["TYPE"];

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });

    tx = runtime.edit();

    const { commontools } = createBuilder();
    ({
      lift,
      pattern,
      Cell,
      TYPE,
    } = commontools);
  });

  afterEach(async () => {
    await tx.commit();
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("should handle patterns returned by lifted functions", async () => {
    const x = runtime.getCell<number>(
      space,
      "should handle patterns returned by lifted functions 1",
    );
    x.withTx(tx).set(2);
    tx.commit();
    await x.pull();
    tx = runtime.edit();

    const y = runtime.getCell<number>(
      space,
      "should handle patterns returned by lifted functions 2",
      undefined,
      tx,
    );
    y.withTx(tx).set(3);
    tx.commit();
    await y.pull();
    tx = runtime.edit();

    const runCounts = {
      multiply: 0,
      multiplyGenerator: 0,
      multiplyGenerator2: 0,
    };

    const multiply = lift(
      {
        type: "object",
        properties: { x: { type: "number" }, y: { type: "number" } },
        required: ["x", "y"],
      } as const satisfies JSONSchema,
      { type: "number" } as const satisfies JSONSchema,
      ({ x, y }) => {
        runCounts.multiply++;
        return x * y;
      },
    );

    const multiplyGenerator = lift(
      {
        type: "object",
        properties: { x: { type: "number" }, y: { type: "number" } },
        required: ["x", "y"],
      } as const satisfies JSONSchema,
      { type: "number" } as const satisfies JSONSchema,
      (args) => {
        runCounts.multiplyGenerator++;
        return multiply(args);
      },
    );

    const multiplyGenerator2 = lift(
      {
        type: "object",
        properties: { x: { type: "number" }, y: { type: "number" } },
        required: ["x", "y"],
      } as const satisfies JSONSchema,
      { type: "number" } as const satisfies JSONSchema,
      ({ x, y }) => {
        runCounts.multiplyGenerator2++;
        // Now passing literals, so will hardcode values in pattern and hence
        // re-run when values change
        return multiply({ x, y });
      },
    );

    const multiplyPattern = pattern<{ x: number; y: number }>(
      (args) => {
        return {
          result1: multiplyGenerator(args),
          result2: multiplyGenerator2(args),
        };
      },
    );

    const resultCell = runtime.getCell<{ result1: number; result2: number }>(
      space,
      "should handle patterns returned by lifted functions",
      undefined,
      tx,
    );
    const result = runtime.run(tx, multiplyPattern, {
      x,
      y,
    }, resultCell);
    tx.commit();
    tx = runtime.edit();

    expect(runCounts).toMatchObject({
      multiply: 0,
      multiplyGenerator: 0,
      multiplyGenerator2: 0,
    });

    let value = await result.pull();
    expect(value).toMatchObject({
      result1: 6,
      result2: 6,
    });

    // We mark the process cell dirty, run, then mark the process cell dirty again.
    expect(runCounts).toMatchObject({
      multiply: 2,
      multiplyGenerator: 1,
      multiplyGenerator2: 1,
    });

    x.withTx(tx).send(3);
    tx.commit();
    tx = runtime.edit();

    value = await result.pull();

    expect(runCounts).toMatchObject({
      multiply: 4,
      multiplyGenerator: 2,
      multiplyGenerator2: 2,
    });

    expect(value).toMatchObject({
      result1: 9,
      result2: 9,
    });
  });

  it("failed lifted functions should output undefined instead of retaining stale values", async () => {
    let errors = 0;
    let lastError: ErrorWithContext | undefined;

    runtime.scheduler.onError((error: ErrorWithContext) => {
      lastError = error;
      errors++;
    });

    const divider = lift<
      { divisor: number; dividend: number },
      number
    >(
      ({ divisor, dividend }) => {
        if (dividend === 0) {
          throw new Error("division by zero");
        }
        return divisor / dividend;
      },
    );

    const divPattern = pattern<{ divisor: number; dividend: number }>(
      ({ divisor, dividend }) => {
        return { result: divider({ divisor, dividend }) };
      },
    );

    const dividend = runtime.getCell<number>(
      space,
      "failed lifted functions should be ignored 1",
      undefined,
      tx,
    );
    dividend.withTx(tx).set(1);
    tx.commit();
    await dividend.pull();
    tx = runtime.edit();

    const pieceCell = runtime.getCell<{ result: number }>(
      space,
      "failed lifted handlers should be ignored",
      undefined,
      tx,
    );
    const piece = runtime.run(tx, divPattern, {
      divisor: 10,
      dividend,
    }, pieceCell);
    tx.commit();
    tx = runtime.edit();

    let value = await piece.pull();

    expect(errors).toBe(0);
    expect(value).toMatchObject({ result: 10 });

    dividend.withTx(tx).send(0);
    tx.commit();
    tx = runtime.edit();

    value = await piece.pull();
    expect(errors).toBe(1);
    expect(value.result).toBeUndefined();

    const patternId = piece.getSourceCell()?.get()?.[TYPE];
    expect(patternId).toBeDefined();
    expect(lastError?.patternId).toBe(patternId);
    expect(lastError?.space).toBe(space);
    expect(lastError?.pieceId).toBe(
      JSON.parse(JSON.stringify(piece.entityId))["/"],
    );

    // Make sure it recovers:
    dividend.withTx(tx).send(2);
    tx.commit();
    tx = runtime.edit();

    value = await piece.pull();
    expect((piece.getRaw() as any).result.$alias.cell).toEqual(
      piece.getSourceCell()?.entityId,
    );
    expect(value).toMatchObject({ result: 5 });
  });

  it("should create and use a named cell inside a lift", async () => {
    const wrapperPattern = pattern<{ value: number }>(
      ({ value }) => {
        // Create a named cell to store the counter
        const wrapper = lift((v: number) => {
          const cell = Cell.for("wrapper").asSchema({ type: "number" }).set(v);
          return { value: cell };
        })(value);

        return wrapper;
      },
    );

    const input = runtime.getCell<number>(
      space,
      "should create and use a named cell inside a lift input",
    );
    input.withTx(tx).set(5);
    tx.commit();
    tx = runtime.edit();

    const resultCell = runtime.getCell<{ value: Cell<number> }>(
      space,
      "should create and use a named cell inside a lift",
      {
        type: "object",
        properties: { value: { type: "number", asCell: true } },
        required: ["value"],
      },
    );

    const result = runtime.run(
      tx,
      wrapperPattern,
      { value: input },
      resultCell,
    );
    tx.commit();
    tx = runtime.edit();

    await result.pull();

    // Initial state
    const wrapperCell = result.key("value").get();
    expect(isCell(wrapperCell)).toBe(true);
    expect(wrapperCell.get()).toBe(5);

    // Follow all the links until we get to the doc holding the value
    const ref = resolveLink(
      runtime,
      tx,
      wrapperCell.getAsNormalizedFullLink(),
    );
    expect(ref.path).toEqual([]); // = This is stored in its own document

    // And let's make sure the value is correct
    expect(tx.readValueOrThrow(ref)).toBe(5);

    input.withTx(tx).send(10);
    tx.commit();
    tx = runtime.edit();

    await result.pull();

    // That same value was updated, which shows that the id was stable
    expect(tx.readValueOrThrow(ref)).toBe(10);
  });

  it("should support non-reactive reads with sample()", async () => {
    let liftRunCount = 0;

    // A lift that takes two parameters:
    // - first: a regular number (reactive)
    // - second: a Cell that we'll read with sample() (non-reactive)
    const computeWithSample = lift(
      // Input schema: first is reactive, second is asCell
      {
        type: "object",
        properties: {
          first: { type: "number" },
          second: { type: "number", asCell: true },
        },
        required: ["first", "second"],
      } as const satisfies JSONSchema,
      // Output schema
      { type: "number" },
      // The lift function
      ({ first, second }) => {
        liftRunCount++;
        // Use sample() to read the second cell non-reactively
        const secondValue = second.sample();
        return first + secondValue;
      },
    );

    const sampleP = pattern<{ first: number; second: number }>(
      ({ first, second }) => {
        return { result: computeWithSample({ first, second }) };
      },
    );

    // Create input cells
    const firstCell = runtime.getCell<number>(
      space,
      "sample test first cell",
      undefined,
      tx,
    );
    firstCell.set(10);

    const secondCell = runtime.getCell<number>(
      space,
      "sample test second cell",
      undefined,
      tx,
    );
    secondCell.set(5);

    const resultCell = runtime.getCell<{ result: number }>(
      space,
      "should support non-reactive reads with sample()",
      {
        type: "object",
        properties: { result: { type: "number" } },
      } as const satisfies JSONSchema,
      tx,
    );

    const result = runtime.run(tx, sampleP, {
      first: firstCell,
      second: secondCell,
    }, resultCell);
    tx.commit();
    tx = runtime.edit();

    let value = await result.pull();

    // Verify initial result: 10 + 5 = 15
    expect(value).toMatchObject({ result: 15 });
    expect(liftRunCount).toBe(1);

    // Update the second cell (read with sample(), so non-reactive)
    secondCell.withTx(tx).send(20);
    tx.commit();
    tx = runtime.edit();

    value = await result.pull();

    // The lift should NOT have re-run because sample() is non-reactive
    expect(liftRunCount).toBe(1);
    // Result should still be 15 (not updated)
    expect(value).toMatchObject({ result: 15 });

    // Now update the first cell (read reactively via the normal get())
    firstCell.withTx(tx).send(100);
    tx.commit();
    tx = runtime.edit();

    value = await result.pull();

    // The lift should have re-run now
    expect(liftRunCount).toBe(2);
    // Result should reflect both new values: 100 + 20 = 120
    // (the second cell's new value is picked up because the lift re-ran)
    expect(value).toMatchObject({ result: 120 });
  });

  it("should not run lifts until something pulls on them", async () => {
    // This test verifies true pull-based scheduling:
    // - Create two independent patterns with lifts
    // - Instantiate both
    // - Pull only on the first one's result
    // - Only the lift in the first pattern should run

    let lift1Runs = 0;
    let lift2Runs = 0;

    const pattern1 = pattern<{ value: number }>(
      ({ value }) => {
        const doubled = lift(
          { type: "number" } as const satisfies JSONSchema,
          { type: "number" } as const satisfies JSONSchema,
          (x: number) => {
            lift1Runs++;
            return x * 2;
          },
        )(value);
        return { result: doubled };
      },
    );

    const pattern2 = pattern<{ value: number }>(
      ({ value }) => {
        const tripled = lift(
          { type: "number" } as const satisfies JSONSchema,
          { type: "number" } as const satisfies JSONSchema,
          (x: number) => {
            lift2Runs++;
            return x * 3;
          },
        )(value);
        return { result: tripled };
      },
    );

    // Instantiate both patterns
    const resultCell1 = runtime.getCell<{ result: number }>(
      space,
      "lift-pull-test-pattern1",
      undefined,
      tx,
    );
    const resultCell2 = runtime.getCell<{ result: number }>(
      space,
      "lift-pull-test-pattern2",
      undefined,
      tx,
    );

    const result1 = runtime.run(tx, pattern1, { value: 5 }, resultCell1);
    const result2 = runtime.run(tx, pattern2, { value: 5 }, resultCell2);
    tx.commit();
    tx = runtime.edit();

    // Before any pull, no lifts should have run
    expect(lift1Runs).toBe(0);
    expect(lift2Runs).toBe(0);

    // Pull only on pattern 1's result
    const value1 = await result1.pull();
    expect(value1).toMatchObject({ result: 10 });

    // Both lifts run because the scheduler flushes everything
    expect(lift1Runs).toBe(1);
    expect(lift2Runs).toBe(1);

    // Now pull on pattern 2's result
    const value2 = await result2.pull();
    expect(value2).toMatchObject({ result: 15 });

    // Still 1
    expect(lift1Runs).toBe(1);
    expect(lift2Runs).toBe(1);
  });
});
