import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { VERIFIED_BINDING_METADATA_FIELD } from "@commonfabric/utils/sandbox-contract";

import {
  defineAuthoredDebugAccessors,
  getAuthoredDebugSource,
  readAuthoredBindingAnnotation,
  recordAuthoredDebugSource,
} from "../../src/harness/authored-debug-source.ts";

const annotated = (metadata: unknown) => ({
  [VERIFIED_BINDING_METADATA_FIELD]: metadata,
});

describe("authored debug source", () => {
  describe("recordAuthoredDebugSource", () => {
    it("returns the recorded entry for the function it was keyed by", () => {
      const fn = () => 0;
      recordAuthoredDebugSource(fn, {
        src: "cf:module/HASH/main.tsx:4:8",
        bindingName: "doubled",
      });
      expect(getAuthoredDebugSource(fn)).toEqual({
        src: "cf:module/HASH/main.tsx:4:8",
        bindingName: "doubled",
      });
    });

    it("keeps the first entry when the same function is recorded twice", () => {
      // One artifact reaches the provenance walk both as an export and as a
      // `__cfReg` registration; the two must agree on one answer.
      const fn = () => 0;
      recordAuthoredDebugSource(fn, { src: "cf:module/HASH/main.tsx:4:8" });
      recordAuthoredDebugSource(fn, { src: "cf:module/OTHER/main.tsx:99:0" });
      expect(getAuthoredDebugSource(fn)?.src).toBe(
        "cf:module/HASH/main.tsx:4:8",
      );
    });

    it("ignores a non-function key", () => {
      const value = { implementation: "not a function" };
      recordAuthoredDebugSource(value, { src: "cf:module/HASH/main.tsx:1:0" });
      expect(getAuthoredDebugSource(value)).toBeUndefined();
    });

    it("returns undefined for a function that was never recorded", () => {
      expect(getAuthoredDebugSource(() => 0)).toBeUndefined();
    });
  });

  describe("readAuthoredBindingAnnotation", () => {
    it("reads sourceFile, position, and bindingName from a full annotation", () => {
      expect(
        readAuthoredBindingAnnotation(annotated({
          sourceFile: "/main.tsx",
          position: { line: 21, col: 59 },
          bindingName: "saveTitle",
        })),
      ).toEqual({
        sourceFile: "/main.tsx",
        position: { line: 21, col: 59 },
        bindingName: "saveTitle",
      });
    });

    it("reads an annotation that carries no bindingPath", () => {
      // `bindingPath` is present only for trusted bindings, so requiring it
      // would drop the position of every ordinary builder artifact.
      expect(
        readAuthoredBindingAnnotation(annotated({
          sourceFile: "/main.tsx",
          position: { line: 3, col: 0 },
        })),
      ).toEqual({ sourceFile: "/main.tsx", position: { line: 3, col: 0 } });
    });

    it("reads an annotation whose lineage did not recover a position", () => {
      expect(
        readAuthoredBindingAnnotation(annotated({
          sourceFile: "/main.tsx",
          bindingName: "pick",
        })),
      ).toEqual({ sourceFile: "/main.tsx", bindingName: "pick" });
    });

    it("drops a malformed position but keeps the rest of the annotation", () => {
      expect(
        readAuthoredBindingAnnotation(annotated({
          sourceFile: "/main.tsx",
          position: { line: "3", col: 0 },
          bindingName: "pick",
        })),
      ).toEqual({ sourceFile: "/main.tsx", bindingName: "pick" });
    });

    it("drops a non-finite position", () => {
      expect(
        readAuthoredBindingAnnotation(annotated({
          sourceFile: "/main.tsx",
          position: { line: Number.NaN, col: 0 },
        })),
      ).toEqual({ sourceFile: "/main.tsx" });
    });

    it("drops an empty bindingName", () => {
      expect(
        readAuthoredBindingAnnotation(annotated({
          sourceFile: "/main.tsx",
          bindingName: "",
        })),
      ).toEqual({ sourceFile: "/main.tsx" });
    });

    it("returns undefined without a usable sourceFile", () => {
      // The file name is the key the line correction is looked up by, so an
      // annotation missing it addresses nothing.
      expect(
        readAuthoredBindingAnnotation(
          annotated({ position: { line: 1, col: 0 } }),
        ),
      )
        .toBeUndefined();
      expect(readAuthoredBindingAnnotation(annotated({ sourceFile: 7 })))
        .toBeUndefined();
      expect(readAuthoredBindingAnnotation(annotated({ sourceFile: "" })))
        .toBeUndefined();
    });

    it("returns undefined for values carrying no annotation at all", () => {
      expect(readAuthoredBindingAnnotation(undefined)).toBeUndefined();
      expect(readAuthoredBindingAnnotation(null)).toBeUndefined();
      expect(readAuthoredBindingAnnotation("string")).toBeUndefined();
      expect(readAuthoredBindingAnnotation({})).toBeUndefined();
      expect(readAuthoredBindingAnnotation(annotated("not an object")))
        .toBeUndefined();
      expect(readAuthoredBindingAnnotation(annotated(null))).toBeUndefined();
    });

    it("reads an annotation carried by a function-valued artifact", () => {
      const factory = Object.assign(() => 0, {
        [VERIFIED_BINDING_METADATA_FIELD]: {
          sourceFile: "/main.tsx",
          position: { line: 5, col: 2 },
        },
      });
      expect(readAuthoredBindingAnnotation(factory)?.position)
        .toEqual({ line: 5, col: 2 });
    });
  });

  describe("defineAuthoredDebugAccessors", () => {
    it("serves src recorded after the function was frozen", () => {
      const fn = () => 0;
      defineAuthoredDebugAccessors(fn);
      Object.freeze(fn);
      recordAuthoredDebugSource(fn, { src: "cf:module/HASH/main.tsx:2:4" });
      expect((fn as { src?: string }).src).toBe("cf:module/HASH/main.tsx:2:4");
    });

    it("answers undefined for src on a function with no entry", () => {
      const fn = () => 0;
      defineAuthoredDebugAccessors(fn);
      expect((fn as { src?: string }).src).toBeUndefined();
    });

    it("reports the authored binding name in place of the hoisted one", () => {
      const fn = function __cfLift_1() {
        return 0;
      };
      defineAuthoredDebugAccessors(fn);
      recordAuthoredDebugSource(fn, { bindingName: "doubled" });
      expect(fn.name).toBe("doubled");
    });

    it("falls back to the function's own name without an entry", () => {
      const fn = function computeTotal() {
        return 0;
      };
      defineAuthoredDebugAccessors(fn);
      expect(fn.name).toBe("computeTotal");
    });

    it("keeps both accessors off enumeration", () => {
      const fn = () => 0;
      defineAuthoredDebugAccessors(fn);
      recordAuthoredDebugSource(fn, { src: "cf:module/HASH/main.tsx:1:0" });
      expect(Object.keys(fn)).toEqual([]);
    });
  });
});
