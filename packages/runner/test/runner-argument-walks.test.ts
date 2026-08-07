// What the two schema-guided argument walks in `runner.ts` do with a
// `FabricSpecialObject`. Both collect links out of a live action argument, and
// both are security-relevant: what they find becomes scheduler read tracking
// and write-policy input.
//
// Neither walk rebuilds anything -- each INDEXES the value at the position its
// schema names (`currentValue[key]`). So a `FabricPrimitive` standing where the
// schema expects a container yields `undefined` per key and contributes
// nothing, which is the right answer: a leaf holds no link to find.

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { FabricBytes } from "@commonfabric/data-model/fabric-primitives";

import { Runtime } from "../src/runtime.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("test runner argument walks");
const space = signer.did();

/**
 * The two walks are `private` rather than `#private` on `Runner`, so a test can
 * address them through `runtime.runner`. Reaching them through a running action
 * would drag in module setup that has nothing to do with what is pinned here.
 */
type WalkAccess = {
  collectArgumentSchedulerReadLinks(
    argumentSchema: unknown,
    value: unknown,
    resultCell: unknown,
  ): unknown[];
  collectWritableCellArgumentLinks(
    argumentSchema: unknown,
    value: unknown,
    resultCell: unknown,
  ): unknown[];
};

describe("runner-argument-walks", () => {
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

  /**
   * A schema whose `payload` branch declares nested structure, so a walk
   * reaching a `FabricBytes` there tries to index INTO it -- the shape that
   * would expose a walk mistaking a special object for a container.
   */
  const argumentSchema = {
    type: "object",
    properties: {
      payload: {
        type: "object",
        properties: { inner: { type: "object", asCell: ["cell"] } },
      },
      ref: { type: "object", asCell: ["cell"] },
    },
  };

  function fixture() {
    const target = runtime.getCell<unknown>(
      space,
      "walk-target",
      undefined,
      tx,
    );
    target.set({ value: 1 });
    const resultCell = runtime.getCell<unknown>(
      space,
      "walk-result",
      undefined,
      tx,
    );
    return {
      resultCell,
      value: {
        payload: new FabricBytes(new Uint8Array([1, 2, 3])),
        ref: target.key("value").getAsWriteRedirectLink(),
      },
    };
  }

  describe("collectArgumentSchedulerReadLinks", () => {
    it("collects a sibling write-redirect link past a `FabricBytes`", () => {
      // The discriminating shape: the schema tells the walk to descend into
      // `payload`, where a `FabricBytes` stands. The walk must index it, find
      // nothing, and carry on to `ref` -- rather than throwing, or stopping.
      const { resultCell, value } = fixture();

      const links = (runtime.runner as unknown as WalkAccess)
        .collectArgumentSchedulerReadLinks(argumentSchema, value, resultCell);

      expect(links.length).toBe(1);
    });
  });

  describe("collectWritableCellArgumentLinks", () => {
    it("collects a sibling write-redirect link past a `FabricBytes`", () => {
      const { resultCell, value } = fixture();

      const links = (runtime.runner as unknown as WalkAccess)
        .collectWritableCellArgumentLinks(argumentSchema, value, resultCell);

      expect(links.length).toBe(1);
    });
  });
});
