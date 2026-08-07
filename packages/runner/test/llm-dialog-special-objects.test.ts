// The two walks in `llm-dialog.ts` that carry a `FabricValue` give the two
// special-object kinds opposite treatment, and neither is the object branch. A
// `FabricPrimitive` is a leaf and stands whole, where a walk that rebuilt it
// from its entries would hand the model a bare `{}`. A `FabricInstance` is a
// container reached by its codec contents, which neither walk can do, so each
// refuses rather than flattening one.

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import {
  FabricBytes,
  FabricEpochNsec,
} from "@commonfabric/data-model/fabric-primitives";
import { FabricError } from "@commonfabric/data-model/fabric-instances";

import { llmDialogTestHelpers } from "../src/builtins/llm-dialog.ts";

const { serializeForLLMObservation, traverseAndCellify } = llmDialogTestHelpers;

/** A runtime stand-in: neither walk should ask it for a cell here. */
const noCellRuntime = {
  getCellFromLink() {
    throw new Error("should not be called for a special object");
  },
};

describe("llm-dialog-special-objects", () => {
  describe("serializeForLLMObservation", () => {
    it("returns a `FabricBytes` whole rather than as an empty record", () => {
      const bytes = new FabricBytes(new Uint8Array([1, 2, 3]));
      const result = serializeForLLMObservation({ value: { payload: bytes } });

      // `toBeInstanceOf` is the assertion that can fail here: a flattened `{}`
      // is `toEqual`-equal to a `FabricBytes`, which has no enumerable members,
      // so that matcher alone would pass against the very bug this pins.
      const { payload } = result.value as { payload: unknown };
      expect(payload).toBeInstanceOf(FabricBytes);
      expect((payload as FabricBytes).slice()).toEqual(
        new Uint8Array([1, 2, 3]),
      );
    });

    it("returns a `FabricEpochNsec` whole from inside an array", () => {
      // The array branch reaches the same leaf, by a different route than the
      // record branch above.
      const when = new FabricEpochNsec(1_000_000_000n);
      const result = serializeForLLMObservation({ value: [when] });

      const [element] = result.value as unknown[];
      expect(element).toBeInstanceOf(FabricEpochNsec);
      expect((element as FabricEpochNsec).value).toBe(1_000_000_000n);
    });

    it("throws for a `FabricInstance` rather than flattening one", () => {
      const instance = FabricError.fromNativeError(new Error("boom"));

      expect(() => serializeForLLMObservation({ value: { failure: instance } }))
        .toThrow(
          "Cannot yet handle `FabricError` (a `FabricInstance`) when " +
            "serializing a value for a language model.",
        );
    });
  });

  describe("traverseAndCellify", () => {
    it("returns a `FabricBytes` whole rather than as an empty record", () => {
      const bytes = new FabricBytes(new Uint8Array([1, 2, 3]));

      const result = traverseAndCellify(
        noCellRuntime as never,
        "did:test:cellify",
        { payload: bytes },
      ) as { payload: unknown };

      expect(result.payload).toBeInstanceOf(FabricBytes);
      expect((result.payload as FabricBytes).slice()).toEqual(
        new Uint8Array([1, 2, 3]),
      );
    });

    it("throws for a `FabricInstance` rather than flattening one", () => {
      const instance = FabricError.fromNativeError(new Error("boom"));

      expect(() =>
        traverseAndCellify(
          noCellRuntime as never,
          "did:test:cellify",
          { failure: instance },
        )
      ).toThrow(
        "Cannot yet handle `FabricError` (a `FabricInstance`) when " +
          "converting a language model's response to cells.",
      );
    });
  });
});
