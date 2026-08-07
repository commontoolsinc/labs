// What the CFC output-labelling walk does with a `FabricSpecialObject`. Such a
// value has zero enumerable own properties, so the walk's `Object.entries()`
// descent ends at it -- which costs a `FabricPrimitive` nothing, since a leaf
// holds no cell to label.

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { FabricBytes } from "@commonfabric/data-model/fabric-primitives";

import { Runtime } from "../src/runtime.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { popFrame, pushFrame } from "../src/builder/pattern.ts";
import { applyInputIfcToOutput } from "../src/builder/node-utils.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";

const signer = await Identity.fromPassphrase("test node utils");
const space = signer.did();

describe("node-utils", () => {
  let runtime: Runtime;
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let tx: IExtendedStorageTransaction;
  let Cell: ReturnType<typeof createTrustedBuilder>["commonfabric"]["Cell"];

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    tx = runtime.edit();
    ({ commonfabric: { Cell } } = createTrustedBuilder(runtime));
  });

  afterEach(async () => {
    await tx.commit();
    await runtime?.dispose();
    await storageManager?.close();
  });

  function withinHandler<T>(fn: () => T): T {
    pushFrame(
      {
        runtime,
        space,
        tx,
        cause: { test: "node-utils" },
        generatedIdCounter: 0,
        inHandler: true,
        unsafe_binding: { space, tx },
        // deno-lint-ignore no-explicit-any
      } as any,
    );
    try {
      return fn();
    } finally {
      popFrame();
    }
  }

  describe("applyInputIfcToOutput", () => {
    it("labels an output cell sitting beside a `FabricBytes`", () => {
      withinHandler(() => {
        // The discriminating shape. A special object alone would only show
        // that the walk does not crash; a labellable cell BESIDE one shows the
        // walk still reaches its siblings rather than ending at the special
        // object.
        const input = new Cell("classified", {
          type: "string",
          ifc: { confidentiality: ["secret"] },
        });
        const target = new Cell("out", { type: "string" });
        const outputs = {
          bytes: new FabricBytes(new Uint8Array([1, 2, 3])),
          target,
        };

        applyInputIfcToOutput({ input }, outputs);

        // deno-lint-ignore no-explicit-any
        expect((target as any).schema?.ifc?.confidentiality).toContain(
          "secret",
        );
      });
    });

    it("leaves a `FabricBytes` output as the same instance", () => {
      withinHandler(() => {
        const input = new Cell("classified", {
          type: "string",
          ifc: { confidentiality: ["secret"] },
        });
        const bytes = new FabricBytes(new Uint8Array([4, 5]));
        const outputs = { bytes, target: new Cell("out", { type: "string" }) };

        applyInputIfcToOutput({ input }, outputs);

        // This walk labels in place and returns nothing, so the value it was
        // handed must come out untouched -- it is the caller's output tree.
        expect(outputs.bytes).toBe(bytes);
      });
    });
  });
});
