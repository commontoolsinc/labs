// Conditional logic: ifElse branching, interaction with lifted values, and
// patterns where control flow determines which values propagate.

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { type JSONSchema, type Schema } from "../src/builder/types.ts";
import { createBuilder } from "../src/builder/factory.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";
import { Runtime } from "../src/runtime.ts";
import { isCell, isStream } from "../src/cell.ts";
import { type IExtendedStorageTransaction } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

describe("Pattern Runner - ifElse", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;
  let lift: ReturnType<typeof createBuilder>["commonfabric"]["lift"];
  let pattern: ReturnType<typeof createBuilder>["commonfabric"]["pattern"];
  let handler: ReturnType<typeof createBuilder>["commonfabric"]["handler"];
  let ifElse: ReturnType<typeof createBuilder>["commonfabric"]["ifElse"];

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });

    tx = runtime.edit();

    const { commonfabric } = createTrustedBuilder(runtime);
    ({
      lift,
      pattern,
      handler,
      ifElse,
    } = commonfabric);
  });

  afterEach(async () => {
    await tx.commit();
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("correctly handles the ifElse values with nested lifts", async () => {
    const InputSchema = {
      "type": "object",
      "properties": {
        "expandChat": { "type": "boolean" },
      },
    } as const satisfies JSONSchema;

    const StateSchema = {
      "type": "object",
      "properties": {
        "expandChat": { "type": "boolean" },
        "text": { "type": "string" },
      },
      "asCell": ["cell"],
    } as const satisfies JSONSchema;
    const expandHandler = handler(
      InputSchema,
      StateSchema,
      ({ expandChat }, state) => {
        state.key("expandChat").set(expandChat);
      },
    );

    const ifElsePattern = pattern<{ expandChat: boolean }>(
      ({ expandChat }) => {
        const optionA = lift((t: boolean) => t ? "A" : "a")(expandChat);
        const optionB = lift((t: boolean) => t ? "B" : "b")(expandChat);

        return {
          expandChat,
          text: ifElse(
            expandChat,
            optionA,
            optionB,
          ),
          stream: expandHandler({ expandChat }),
        };
      },
    );

    const pieceCell = runtime.getCell<
      { expandChat: boolean; text: string; stream: any }
    >(
      space,
      "ifElse should work",
      ifElsePattern.resultSchema,
      tx,
    );

    const piece = runtime.run(
      tx,
      ifElsePattern,
      { expandChat: true },
      pieceCell,
    );

    tx.commit();

    await piece.pull();

    // Toggle
    piece.key("stream").send({ expandChat: true });
    await piece.pull();

    expect(piece.key("text").get()).toEqual("A");

    piece.key("stream").send({ expandChat: false });
    await piece.pull();

    expect(piece.key("text").get()).toEqual("b");
  });

  it("ifElse selects the correct branch based on condition", async () => {
    // This test verifies that ifElse correctly selects between branches
    // Note: Both branches may run initially as they both depend on the condition input,
    // but only the selected branch's value is used in the result.

    const ifElsePattern = pattern<
      { condition: boolean; trueValue: string; falseValue: string }
    >(
      ({ condition, trueValue, falseValue }) => {
        // Use separate inputs for each branch to make dependencies clearer
        return {
          condition,
          trueValue,
          falseValue,
          text: ifElse(condition, trueValue, falseValue),
        };
      },
    );

    const pieceCell = runtime.getCell<
      {
        condition: boolean;
        trueValue: string;
        falseValue: string;
        text: string;
      }
    >(
      space,
      "ifElse selection test",
      ifElsePattern.resultSchema,
      tx,
    );

    // Start with condition = true
    const piece = runtime.run(
      tx,
      ifElsePattern,
      { condition: true, trueValue: "A", falseValue: "B" },
      pieceCell,
    );

    tx.commit();
    await piece.pull();

    // With condition=true, ifElse should select trueValue
    expect(piece.key("text").get()).toEqual("A");

    // Now switch condition to false
    tx = runtime.edit();
    piece.withTx(tx).key("condition").set(false);
    tx.commit();
    await piece.pull();

    // With condition=false, ifElse should select falseValue
    expect(piece.key("text").get()).toEqual("B");

    // Change the falseValue and verify it updates
    tx = runtime.edit();
    piece.withTx(tx).key("falseValue").set("C");
    tx.commit();
    await piece.pull();

    expect(piece.key("text").get()).toEqual("C");
  });

  it("should allow Cell<Array>.push of newly created pieces", async () => {
    const InnerSchema = {
      type: "object",
      properties: {
        text: { type: "string" },
      },
      required: ["text"],
    } as const satisfies JSONSchema;

    const OuterSchema = {
      type: "object",
      properties: {
        list: {
          type: "array",
          items: InnerSchema,
          default: [],
          asCell: ["cell"],
        },
      },
      required: ["list"],
    } as const satisfies JSONSchema;

    const HandlerState = {
      type: "object",
      properties: {
        list: {
          type: "array",
          items: InnerSchema,
          default: [],
          asCell: ["cell"],
        },
      },
      required: ["list"],
    } as const satisfies JSONSchema;

    const OutputWithHandler = {
      type: "object",
      properties: {
        list: { type: "array", items: InnerSchema, asCell: ["cell"] },
        add: { ...InnerSchema, asCell: ["stream"] },
      },
      required: ["add", "list"],
    } as const satisfies JSONSchema;

    const pieceCell = runtime.getCell<Schema<typeof OutputWithHandler>>(
      space,
      "should allow Cell<Array>.push of newly created pieces",
      OutputWithHandler,
      tx,
    );

    const innerPattern = pattern(
      ({ text }) => {
        return { text };
      },
      InnerSchema,
      InnerSchema,
    );

    const add = handler(
      InnerSchema,
      HandlerState,
      ({ text }, { list }) => {
        const inner = innerPattern({ text });
        list.push(inner);
      },
    );

    const outerPattern = pattern(
      ({ list }) => {
        return { list, add: add({ list }) };
      },
      OuterSchema,
      OutputWithHandler,
    );

    runtime.run(tx, outerPattern, {}, pieceCell);
    tx.commit();

    await pieceCell.pull();

    tx = runtime.edit();

    const result = pieceCell.withTx(tx).get();
    expect(isCell(result.list)).toBe(true);
    expect(result.list.get()).toEqual([]);
    expect(isStream(result.add)).toBe(true);

    result.add.withTx(tx).send({ text: "hello" });
    tx.commit();

    await pieceCell.pull();

    tx = runtime.edit();
    const result2 = pieceCell.withTx(tx).get();
    expect(result2.list.get()).toEqual([{ text: "hello" }]);
  });

  it("names raw ifElse actions from the builtin ref", async () => {
    const subscribedActions: Array<{ name?: string; src?: string }> = [];
    const originalSubscribe = runtime.scheduler.subscribe.bind(
      runtime.scheduler,
    );
    (
      runtime.scheduler as unknown as {
        subscribe: typeof originalSubscribe;
      }
    ).subscribe = ((action, ...rest) => {
      subscribedActions.push({
        name: action.name,
        src: (action as { src?: string }).src,
      });
      return originalSubscribe(action, ...rest);
    }) as typeof originalSubscribe;

    const ifElsePattern = pattern<{ condition: boolean }>(({ condition }) => ({
      value: ifElse(condition, "A", "B"),
    }));

    const resultCell = runtime.getCell(
      space,
      "ifElse action naming",
      ifElsePattern.resultSchema,
      tx,
    );

    runtime.run(tx, ifElsePattern, { condition: true }, resultCell);
    await tx.commit();

    expect(subscribedActions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: expect.stringMatching(/^raw:ifElse:/),
          src: expect.stringMatching(/^raw:ifElse:/),
        }),
      ]),
    );
  });

  it("only writes the branch reference once when re-triggered with the " +
    "same value", async () => {
    // Record every reactive link-write, grouped by trigger phase, by
    // instrumenting the transactions the scheduler creates via
    // `runtime.edit()`. For each write we capture both the doc written and, for
    // link writes, the doc the link points at.
    const linkTarget = (value: unknown): string | undefined => {
      if (!value || typeof value !== "object") return undefined;
      const sigil = (value as Record<string, unknown>)["/"];
      if (!sigil || typeof sigil !== "object") return undefined;
      const inner = Object.values(sigil as Record<string, unknown>)[0] as
        | { id?: string }
        | undefined;
      return inner?.id;
    };
    const writesByPhase: Record<
      string,
      Array<{ id: string; target?: string }>
    > = {};
    let phase = "init";
    const origEdit = runtime.edit.bind(runtime);
    (runtime as unknown as { edit: typeof origEdit }).edit = ((opts?: any) => {
      const t = origEdit(opts);
      const origWrite = t.writeValueOrThrow.bind(t);
      (t as unknown as { writeValueOrThrow: typeof origWrite })
        .writeValueOrThrow = ((address: any, value: any, options?: any) => {
          (writesByPhase[phase] ??= []).push({
            id: String(address.id),
            target: linkTarget(value),
          });
          return origWrite(address, value, options);
        }) as typeof origWrite;
      return t;
    }) as typeof origEdit;

    // `n` is a truthy number rather than a boolean: changing it from 1 to 2
    // re-triggers ifElse while still selecting the same (`ifTrue`) branch. The
    // branches are stable input cells (not inline literals, which would be
    // re-materialized with new ids when `n` changes), so the branch reference
    // ifElse would write is identical to what is already stored.
    const ifElsePattern = pattern<{ n: number; a: string; b: string }>(
      ({ n, a, b }) => ({
        n,
        a,
        b,
        text: ifElse(n, a, b),
      }),
    );

    const pieceCell = runtime.getCell<
      { n: number; a: string; b: string; text: string }
    >(
      space,
      "ifElse only writes once for same value",
      ifElsePattern.resultSchema,
      tx,
    );
    const piece = runtime.run(
      tx,
      ifElsePattern,
      { n: 1, a: "A", b: "B" },
      pieceCell,
    );
    tx.commit();

    phase = "first";
    await piece.pull();
    expect(piece.key("text").get()).toEqual("A");

    // ifElse writes a redirect into its own result doc that points at the
    // selected branch input. The other redirect written when wiring the result
    // (the output binding) points at the result doc itself, so the ifElse
    // result doc is the link-write whose target is NOT itself a link-write doc.
    const firstWrites = writesByPhase["first"] ?? [];
    const writtenIds = new Set(firstWrites.map((w) => w.id));
    const resultDocs = new Set(
      firstWrites
        .filter((w) => w.target !== undefined && !writtenIds.has(w.target))
        .map((w) => w.id),
    );
    expect(resultDocs.size).toEqual(1);
    const ifElseResultId = [...resultDocs][0];
    // It was written exactly once on the first trigger.
    expect(firstWrites.filter((w) => w.id === ifElseResultId).length)
      .toEqual(1);

    // Re-trigger with a different-but-still-truthy condition. ifElse re-runs and
    // selects the same branch, so the reference it would write is unchanged.
    phase = "second";
    tx = runtime.edit();
    piece.withTx(tx).key("n").set(2);
    tx.commit();
    await piece.pull();
    expect(piece.key("text").get()).toEqual("A");

    // The selected branch is unchanged, so ifElse must not write its result
    // again — the redundant write is what `onlyIfDifferent` suppresses.
    expect(
      (writesByPhase["second"] ?? []).filter((w) => w.id === ifElseResultId)
        .length,
    ).toEqual(0);
  });
});
