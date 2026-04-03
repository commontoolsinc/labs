// Conditional logic: ifElse branching, interaction with derive, and patterns
// where control flow determines which values propagate.

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { type JSONSchema, type Schema } from "../src/builder/types.ts";
import { createBuilder } from "../src/builder/factory.ts";
import { Runtime } from "../src/runtime.ts";
import { isCell, isStream } from "../src/cell.ts";
import { type IExtendedStorageTransaction } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

describe("Pattern Runner - ifElse", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;
  let derive: ReturnType<typeof createBuilder>["commonfabric"]["derive"];
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

    const { commonfabric } = createBuilder();
    ({
      derive,
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

  it("correctly handles the ifElse values with nested derives", async () => {
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
      "asCell": true,
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
        const optionA = derive(expandChat, (t) => t ? "A" : "a");
        const optionB = derive(expandChat, (t) => t ? "B" : "b");

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
          asCell: true,
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
          asCell: true,
        },
      },
      required: ["list"],
    } as const satisfies JSONSchema;

    const OutputWithHandler = {
      type: "object",
      properties: {
        list: { type: "array", items: InnerSchema, asCell: true },
        add: { ...InnerSchema, asStream: true },
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

    expect(subscribedActions).toContainEqual({
      name: "raw:ifElse",
      src: "raw:ifElse",
    });
  });
});
