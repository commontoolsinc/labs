import { afterEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import {
  trustedFlowPrecisionSchemaForBuiltin,
} from "../src/cfc/flow-precision.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";

const signer = await Identity.fromPassphrase("runner-cfc-flow-precision");
const space = signer.did();

const flowPrecisionClaim = {
  concept: "https://commonfabric.org/cfc/concepts/flow-taint-precision",
  claims: [
    { type: "PointwisePresencePreserved" },
    { type: "PointwiseWriteDependency" },
  ],
};

const elementLocalFlowPrecisionClaim = {
  concept: "https://commonfabric.org/cfc/concepts/flow-taint-precision",
  claims: [
    { type: "ElementLocalExpansion" },
    { type: "StableRelativeOrder" },
  ],
};

describe("CFC flow precision claims", () => {
  it("keeps untrusted collection precision claims conservative", () => {
    expect(trustedFlowPrecisionSchemaForBuiltin(undefined, "map"))
      .toBeUndefined();
    expect(
      trustedFlowPrecisionSchemaForBuiltin(
        { kind: "unsupported", className: "eval", reason: "test" },
        "map",
      ),
    ).toBeUndefined();
  });

  let storageManager: ReturnType<typeof StorageManager.emulate> | undefined;
  let runtime: Runtime | undefined;

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
    runtime = undefined;
    storageManager = undefined;
  });

  it("attaches trusted collection flow-precision claims to builtin outputs", async () => {
    storageManager = StorageManager.emulate({
      as: signer,
      memoryVersion: "v2",
    });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      memoryVersion: "v2",
      cfcEnforcementMode: "observe",
    });

    const { commonfabric } = createTrustedBuilder(runtime);
    const { pattern } = commonfabric;
    let mappedRef: any;
    let filteredRef: any;
    let flattenedRef: any;
    let reducedRef: any;

    const tx = runtime.edit();
    const valuesCell = runtime.getCell(
      space,
      "cfc-flow-precision-values",
      {
        type: "array",
        items: { type: "number" },
      },
      tx,
    );
    valuesCell.set([]);

    const collectionPattern = pattern<{ values: number[] }>(({ values }) => {
      mappedRef = values.map((value: number) => value);
      filteredRef = values.filter((value: number) => true);
      flattenedRef = values.flatMap((value: number) => [value]);
      reducedRef = values.reduce(
        (acc: number, value: number) => acc + value,
        0,
      );
      return {
        mapped: mappedRef,
        filtered: filteredRef,
        flattened: flattenedRef,
        reduced: reducedRef,
      };
    });

    const resultCell = runtime.getCell(
      space,
      "cfc-flow-precision-result",
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

    expect(mappedRef.export().schema?.ifc?.flowPrecisionClaim).toEqual(
      flowPrecisionClaim,
    );
    expect(filteredRef.export().schema?.ifc?.flowPrecisionClaim).toEqual(
      elementLocalFlowPrecisionClaim,
    );
    expect(flattenedRef.export().schema?.ifc?.flowPrecisionClaim).toEqual(
      elementLocalFlowPrecisionClaim,
    );
    expect(reducedRef.export().schema?.ifc?.flowPrecisionClaim).toBeUndefined();
  });
});
