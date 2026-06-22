import { afterEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import { listResultSchema } from "../src/builtins/list-result-schema.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";
import { type FactoryInput, type JSONSchema } from "../src/builder/types.ts";

const signer = await Identity.fromPassphrase("runner-list-result-schema");
const space = signer.did();

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
    let mappedRef: any;
    let filteredRef: any;
    let flattenedRef: any;

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
      mappedRef = (values as any).mapWithPattern(
        pattern(({ element, index, array }: FactoryInput<any>) =>
          (((value: number) => value) as any)(element, index, array)
        ),
        {},
      );
      filteredRef = (values as any).filterWithPattern(
        pattern(({ element, index, array }: FactoryInput<any>) =>
          (((_value: number) => true) as any)(element, index, array)
        ),
        {},
      );
      flattenedRef = (values as any).flatMapWithPattern(
        pattern(({ element, index, array }: FactoryInput<any>) =>
          (((value: number) => [value]) as any)(element, index, array)
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

    for (const ref of [mappedRef, filteredRef, flattenedRef]) {
      const schema = ref.export().schema;
      expect(schema?.type).toBe("array");
      expect(schema?.ifc).toBeUndefined();
    }
  });
});
