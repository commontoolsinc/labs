// Per-path reads: verify that fine-grained scheduling only triggers the
// lifts that actually read the changed data. A handler mutates one branch
// of internal state; only the lifts downstream of that branch should re-run.

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { Identity } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import type { JSONSchema } from "../src/builder/types.ts";
import { createBuilder } from "../src/builder/factory.ts";
import { Runtime } from "../src/runtime.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

describe("Per-path reads - selective lift triggering", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;
  let lift: ReturnType<typeof createBuilder>["commontools"]["lift"];
  let pattern: ReturnType<typeof createBuilder>["commontools"]["pattern"];
  let handler: ReturnType<typeof createBuilder>["commontools"]["handler"];

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
      handler,
    } = commontools);
  });

  afterEach(async () => {
    await tx.commit();
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("handler changing one field should only re-run downstream lifts", async () => {
    // Track which lifts ran and in what order
    const executionLog: string[] = [];

    // ── Two independent lift chains ──
    //
    //   args.left ──► liftDouble ──► liftFormat ("left: ...")
    //   args.right ──► liftSquare ──► liftLabel ("right: ...")
    //
    //   handler "incLeft" only mutates args.left
    //   handler "incRight" only mutates args.right
    //
    // When incLeft fires, only liftDouble + liftFormat should re-run.
    // When incRight fires, only liftSquare + liftLabel should re-run.

    const liftDouble = lift(
      { type: "number" } as const satisfies JSONSchema,
      { type: "number" } as const satisfies JSONSchema,
      (x: number) => {
        executionLog.push("liftDouble");
        return x * 2;
      },
    );

    const liftFormat = lift(
      { type: "number" } as const satisfies JSONSchema,
      { type: "string" } as const satisfies JSONSchema,
      (x: number) => {
        executionLog.push("liftFormat");
        return `left: ${x}`;
      },
    );

    const liftSquare = lift(
      { type: "number" } as const satisfies JSONSchema,
      { type: "number" } as const satisfies JSONSchema,
      (x: number) => {
        executionLog.push("liftSquare");
        return x * x;
      },
    );

    const liftLabel = lift(
      { type: "number" } as const satisfies JSONSchema,
      { type: "string" } as const satisfies JSONSchema,
      (x: number) => {
        executionLog.push("liftLabel");
        return `right: ${x}`;
      },
    );

    const incLeft = handler<
      Record<string, never>,
      { left: number }
    >(
      (_event, state) => {
        state.left += 1;
      },
      { proxy: true },
    );

    const incRight = handler<
      Record<string, never>,
      { right: number }
    >(
      (_event, state) => {
        state.right += 1;
      },
      { proxy: true },
    );

    const testPattern = pattern<{ left: number; right: number }>(
      ({ left, right }) => {
        const doubled = liftDouble(left);
        const formatted = liftFormat(doubled);
        const squared = liftSquare(right);
        const labeled = liftLabel(squared);
        return {
          left,
          right,
          formatted,
          labeled,
          incLeft: incLeft({ left }),
          incRight: incRight({ right }),
        };
      },
    );

    const resultCell = runtime.getCell<{
      left: number;
      right: number;
      formatted: string;
      labeled: string;
      incLeft: unknown;
      incRight: unknown;
    }>(space, "per-path-selective-test", undefined, tx);

    const result = runtime.run(
      tx,
      testPattern,
      { left: 1, right: 2 },
      resultCell,
    );
    tx.commit();
    tx = runtime.edit();

    // Initial pull – all lifts should run
    let value = await result.pull();
    expect(value).toMatchObject({
      left: 1,
      right: 2,
      formatted: "left: 2",
      labeled: "right: 4",
    });

    // Record which lifts ran on initial setup
    const initialRuns = [...executionLog];
    expect(initialRuns).toContain("liftDouble");
    expect(initialRuns).toContain("liftFormat");
    expect(initialRuns).toContain("liftSquare");
    expect(initialRuns).toContain("liftLabel");

    // ── Trigger incLeft handler ──
    executionLog.length = 0;
    result.key("incLeft").send({});
    value = await result.pull();

    expect(value).toMatchObject({
      left: 2,
      formatted: "left: 4",
      // right side unchanged
      right: 2,
      labeled: "right: 4",
    });

    // Only the left-side chain should have re-run
    expect(executionLog).toContain("liftDouble");
    expect(executionLog).toContain("liftFormat");
    expect(executionLog).not.toContain("liftSquare");
    expect(executionLog).not.toContain("liftLabel");

    // ── Trigger incRight handler ──
    executionLog.length = 0;
    result.key("incRight").send({});
    value = await result.pull();

    expect(value).toMatchObject({
      left: 2,
      formatted: "left: 4",
      right: 3,
      labeled: "right: 9",
    });

    // Only the right-side chain should have re-run
    expect(executionLog).not.toContain("liftDouble");
    expect(executionLog).not.toContain("liftFormat");
    expect(executionLog).toContain("liftSquare");
    expect(executionLog).toContain("liftLabel");
  });

  it("cascade of lifts: only affected chain re-runs", async () => {
    // A deeper cascade: input → stage1 → stage2 → stage3
    // Two parallel cascades share no data.

    const executionLog: string[] = [];

    const addOne = lift(
      { type: "number" } as const satisfies JSONSchema,
      { type: "number" } as const satisfies JSONSchema,
      (x: number) => {
        executionLog.push("addOne");
        return x + 1;
      },
    );

    const timesTwo = lift(
      { type: "number" } as const satisfies JSONSchema,
      { type: "number" } as const satisfies JSONSchema,
      (x: number) => {
        executionLog.push("timesTwo");
        return x * 2;
      },
    );

    const toString = lift(
      { type: "number" } as const satisfies JSONSchema,
      { type: "string" } as const satisfies JSONSchema,
      (x: number) => {
        executionLog.push("toString");
        return String(x);
      },
    );

    const negate = lift(
      { type: "number" } as const satisfies JSONSchema,
      { type: "number" } as const satisfies JSONSchema,
      (x: number) => {
        executionLog.push("negate");
        return -x;
      },
    );

    const abs = lift(
      { type: "number" } as const satisfies JSONSchema,
      { type: "number" } as const satisfies JSONSchema,
      (x: number) => {
        executionLog.push("abs");
        return Math.abs(x);
      },
    );

    const toHex = lift(
      { type: "number" } as const satisfies JSONSchema,
      { type: "string" } as const satisfies JSONSchema,
      (x: number) => {
        executionLog.push("toHex");
        return `0x${x.toString(16)}`;
      },
    );

    const bumpA = handler<
      Record<string, never>,
      { a: number }
    >(
      (_event, state) => {
        state.a += 10;
      },
      { proxy: true },
    );

    const bumpB = handler<
      Record<string, never>,
      { b: number }
    >(
      (_event, state) => {
        state.b += 10;
      },
      { proxy: true },
    );

    // Chain A: a → addOne → timesTwo → toString → resultA
    // Chain B: b → negate → abs → toHex → resultB
    const cascadePattern = pattern<{ a: number; b: number }>(
      ({ a, b }) => {
        const s1a = addOne(a);
        const s2a = timesTwo(s1a);
        const resultA = toString(s2a);

        const s1b = negate(b);
        const s2b = abs(s1b);
        const resultB = toHex(s2b);

        return {
          a,
          b,
          resultA,
          resultB,
          bumpA: bumpA({ a }),
          bumpB: bumpB({ b }),
        };
      },
    );

    const resultCell = runtime.getCell<{
      a: number;
      b: number;
      resultA: string;
      resultB: string;
      bumpA: unknown;
      bumpB: unknown;
    }>(space, "per-path-cascade-test", undefined, tx);

    const result = runtime.run(
      tx,
      cascadePattern,
      { a: 1, b: 5 },
      resultCell,
    );
    tx.commit();
    tx = runtime.edit();

    let value = await result.pull();
    expect(value).toMatchObject({
      a: 1,
      b: 5,
      resultA: "4", // (1+1)*2 = 4
      resultB: "0x5", // abs(-5) = 5
    });

    // ── Bump A ──
    executionLog.length = 0;
    result.key("bumpA").send({});
    value = await result.pull();

    expect(value).toMatchObject({
      a: 11,
      resultA: "24", // (11+1)*2 = 24
      b: 5,
      resultB: "0x5",
    });

    // Chain A lifts ran
    expect(executionLog).toContain("addOne");
    expect(executionLog).toContain("timesTwo");
    expect(executionLog).toContain("toString");
    // Chain B lifts did NOT run
    expect(executionLog).not.toContain("negate");
    expect(executionLog).not.toContain("abs");
    expect(executionLog).not.toContain("toHex");

    // ── Bump B ──
    executionLog.length = 0;
    result.key("bumpB").send({});
    value = await result.pull();

    expect(value).toMatchObject({
      a: 11,
      resultA: "24",
      b: 15,
      resultB: "0xf", // abs(-15) = 15
    });

    // Chain B lifts ran
    expect(executionLog).toContain("negate");
    expect(executionLog).toContain("abs");
    expect(executionLog).toContain("toHex");
    // Chain A lifts did NOT run
    expect(executionLog).not.toContain("addOne");
    expect(executionLog).not.toContain("timesTwo");
    expect(executionLog).not.toContain("toString");
  });

  it("shared lift re-runs only when its specific input changes", async () => {
    // A "summary" lift reads from both branches. It should re-run when
    // either branch changes, but the branch-specific lifts should not
    // cross-contaminate.

    const executionLog: string[] = [];

    const double = lift(
      { type: "number" } as const satisfies JSONSchema,
      { type: "number" } as const satisfies JSONSchema,
      (x: number) => {
        executionLog.push("double");
        return x * 2;
      },
    );

    const triple = lift(
      { type: "number" } as const satisfies JSONSchema,
      { type: "number" } as const satisfies JSONSchema,
      (x: number) => {
        executionLog.push("triple");
        return x * 3;
      },
    );

    const summarize = lift(
      {
        type: "object",
        properties: { a: { type: "number" }, b: { type: "number" } },
        required: ["a", "b"],
      } as const satisfies JSONSchema,
      { type: "string" } as const satisfies JSONSchema,
      ({ a, b }) => {
        executionLog.push("summarize");
        return `${a}+${b}=${a + b}`;
      },
    );

    const incA = handler<
      Record<string, never>,
      { a: number }
    >(
      (_event, state) => {
        state.a += 1;
      },
      { proxy: true },
    );

    const incB = handler<
      Record<string, never>,
      { b: number }
    >(
      (_event, state) => {
        state.b += 1;
      },
      { proxy: true },
    );

    //   a ──► double ──┐
    //                   ├──► summarize
    //   b ──► triple ──┘

    const sharedPattern = pattern<{ a: number; b: number }>(
      ({ a, b }) => {
        const da = double(a);
        const tb = triple(b);
        const summary = summarize({ a: da, b: tb });
        return {
          a,
          b,
          doubled: da,
          tripled: tb,
          summary,
          incA: incA({ a }),
          incB: incB({ b }),
        };
      },
    );

    const resultCell = runtime.getCell<{
      a: number;
      b: number;
      doubled: number;
      tripled: number;
      summary: string;
      incA: unknown;
      incB: unknown;
    }>(space, "per-path-shared-lift-test", undefined, tx);

    const result = runtime.run(
      tx,
      sharedPattern,
      { a: 1, b: 2 },
      resultCell,
    );
    tx.commit();
    tx = runtime.edit();

    let value = await result.pull();
    expect(value).toMatchObject({
      a: 1,
      b: 2,
      doubled: 2,
      tripled: 6,
      summary: "2+6=8",
    });

    // ── inc A ──
    executionLog.length = 0;
    result.key("incA").send({});
    value = await result.pull();

    expect(value).toMatchObject({
      a: 2,
      doubled: 4,
      tripled: 6,
      summary: "4+6=10",
    });

    // double re-ran, triple did NOT
    expect(executionLog).toContain("double");
    expect(executionLog).not.toContain("triple");
    // summarize MUST re-run because its input changed
    expect(executionLog).toContain("summarize");

    // ── inc B ──
    executionLog.length = 0;
    result.key("incB").send({});
    value = await result.pull();

    expect(value).toMatchObject({
      a: 2,
      b: 3,
      doubled: 4,
      tripled: 9,
      summary: "4+9=13",
    });

    // triple re-ran, double did NOT
    expect(executionLog).not.toContain("double");
    expect(executionLog).toContain("triple");
    // summarize MUST re-run because its input changed
    expect(executionLog).toContain("summarize");
  });

  it("array content changes trigger downstream lifts", async () => {
    // Verify that changing array element values (same length) triggers
    // lifts that read the array.

    const executionLog: string[] = [];

    const sumArray = lift(
      {
        type: "array",
        items: { type: "number" },
      } as const satisfies JSONSchema,
      { type: "number" } as const satisfies JSONSchema,
      (arr: number[]) => {
        executionLog.push("sumArray");
        return arr.reduce((a, b) => a + b, 0);
      },
    );

    const countItems = lift(
      {
        type: "array",
        items: { type: "number" },
      } as const satisfies JSONSchema,
      { type: "number" } as const satisfies JSONSchema,
      (arr: number[]) => {
        executionLog.push("countItems");
        return arr.length;
      },
    );

    const setItems = handler<
      { items: number[] },
      { items: number[] }
    >(
      (event, state) => {
        // Replace with new array of potentially same length
        state.items = event.items;
      },
      { proxy: true },
    );

    const arrayPattern = pattern<{ items: number[] }>(
      ({ items }) => {
        return {
          items,
          sum: sumArray(items),
          count: countItems(items),
          setItems: setItems({ items }),
        };
      },
    );

    const resultCell = runtime.getCell<{
      items: number[];
      sum: number;
      count: number;
      setItems: unknown;
    }>(space, "per-path-array-test", undefined, tx);

    const result = runtime.run(
      tx,
      arrayPattern,
      { items: [1, 2, 3] },
      resultCell,
    );
    tx.commit();
    tx = runtime.edit();

    let value = await result.pull();
    expect(value).toMatchObject({ sum: 6, count: 3 });

    // Change array content but keep same length
    executionLog.length = 0;
    result.key("setItems").send({ items: [10, 20, 30] });
    value = await result.pull();

    expect(value).toMatchObject({ sum: 60, count: 3 });
    // Both lifts must re-run because array content changed
    expect(executionLog).toContain("sumArray");
    expect(executionLog).toContain("countItems");
  });
});
