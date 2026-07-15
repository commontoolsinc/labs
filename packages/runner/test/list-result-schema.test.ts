import { afterEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import { listResultSchema } from "../src/builtins/list-result-schema.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";
import { type JSONSchema, type PatternFactory } from "../src/builder/types.ts";

const signer = await Identity.fromPassphrase("runner-list-result-schema");
const space = signer.did();

type ListOpInput<T> = {
  element: T;
  index: number;
  array: T[];
};

type JSONSchemaObject = Exclude<JSONSchema, boolean>;

type ListResultRef = {
  export(): { schema?: JSONSchemaObject };
};

type ListSchemaBuiltins<T> = {
  mapWithPattern<R>(
    op: PatternFactory<ListOpInput<T>, R>,
    params: Record<string, unknown>,
  ): ListResultRef;
  filterWithPattern(
    op: PatternFactory<ListOpInput<T>, boolean>,
    params: Record<string, unknown>,
  ): ListResultRef;
  flatMapWithPattern<R>(
    op: PatternFactory<ListOpInput<T>, R[]>,
    params: Record<string, unknown>,
  ): ListResultRef;
};

function listBuiltins<T>(values: unknown): ListSchemaBuiltins<T> {
  return values as ListSchemaBuiltins<T>;
}

function expectListResultRef(ref: ListResultRef | undefined): ListResultRef {
  expect(ref).toBeDefined();
  if (!ref) {
    throw new Error("missing list builtin result reference");
  }
  return ref;
}

function identityElement(value: number, _index: number, _array: number[]) {
  return value;
}

function keepElement(_value: number, _index: number, _array: number[]) {
  return true;
}

function wrapElement(value: number, _index: number, _array: number[]) {
  return [value];
}

describe("listResultSchema", () => {
  it("builds a plain array schema without item schema", () => {
    expect(listResultSchema()).toEqual({ type: "array" });
  });

  it("threads the item schema and hoists its $defs", () => {
    const itemSchema = {
      type: "object",
      properties: { value: { $ref: "#/$defs/v" } },
      $defs: { v: { type: "number" } },
    } as JSONSchema;
    expect(listResultSchema(itemSchema)).toEqual({
      type: "array",
      items: {
        type: "object",
        properties: { value: { $ref: "#/$defs/v" } },
      },
      $defs: { v: { type: "number" } },
    });
  });

  it("supports boolean item schemas", () => {
    expect(listResultSchema(true)).toEqual({ type: "array", items: true });
  });

  let storageManager: ReturnType<typeof StorageManager.emulate> | undefined;
  let runtime: Runtime | undefined;

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
    runtime = undefined;
    storageManager = undefined;
  });

  // Do-not-regress for the flowPrecisionClaim removal: list builtin result
  // containers get plain array schemas with no ifc annotations. Pointwise
  // label precision is structural (per-element ops run in their own
  // transactions reading only their element), not a minted trusted claim.
  it("attaches claim-free array schemas to list builtin outputs", async () => {
    storageManager = StorageManager.emulate({
      as: signer,
    });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      cfcEnforcementMode: "observe",
    });

    const { commonfabric } = createTrustedBuilder(runtime);
    const { pattern } = commonfabric;
    let mappedRef: ListResultRef | undefined;
    let filteredRef: ListResultRef | undefined;
    let flattenedRef: ListResultRef | undefined;

    const tx = runtime.edit();
    const valuesCell = runtime.getCell(
      space,
      "list-result-schema-values",
      {
        type: "array",
        items: { type: "number" },
      },
      tx,
    );
    valuesCell.set([]);

    const collectionPattern = pattern<{ values: number[] }>(({ values }) => {
      mappedRef = listBuiltins<number>(values).mapWithPattern(
        pattern<ListOpInput<number>, number>(({ element, index, array }) =>
          identityElement(element, index, array)
        ),
        {},
      );
      filteredRef = listBuiltins<number>(values).filterWithPattern(
        pattern<ListOpInput<number>, boolean>(({ element, index, array }) =>
          keepElement(element, index, array)
        ),
        {},
      );
      flattenedRef = listBuiltins<number>(values).flatMapWithPattern(
        pattern<ListOpInput<number>, number[]>(({ element, index, array }) =>
          wrapElement(element, index, array)
        ),
        {},
      );
      return {
        mapped: mappedRef,
        filtered: filteredRef,
        flattened: flattenedRef,
      };
    });

    const resultCell = runtime.getCell(
      space,
      "list-result-schema-result",
      undefined,
      tx,
    );
    const result = runtime.run(
      tx,
      collectionPattern,
      { values: valuesCell },
      resultCell,
    );

    await tx.commit();
    await result.pull();

    for (
      const ref of [
        expectListResultRef(mappedRef),
        expectListResultRef(filteredRef),
        expectListResultRef(flattenedRef),
      ]
    ) {
      const schema = ref.export().schema;
      expect(schema?.type).toBe("array");
      expect(schema?.ifc).toBeUndefined();
    }
  });
});
