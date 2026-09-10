/**
 * What `formatTree()` does with a `FabricSpecialObject`. Such a value keeps
 * its state in private fields and has zero enumerable own properties, so
 * `JSON.stringify()` renders one as `{}` -- silently, since it does not throw
 * on one and the `catch` around it never fires. Both arms are named instead.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import {
  FabricBytes,
  FabricEpochNsec,
} from "@commonfabric/data-model/fabric-primitives";
import { FabricError } from "@commonfabric/data-model/fabric-instances";

import { formatTree } from "../src/debug.ts";

describe("debug", () => {
  describe("formatTree", () => {
    it("names a `FabricBytes` standing where a node would", () => {
      expect(formatTree(new FabricBytes(new Uint8Array([1, 2, 3]))))
        .toBe("/Bytes(buf[010203])");
    });

    it("names a `FabricError`, the `FabricInstance` arm", () => {
      // A debug renderer names an instance rather than refusing it: the value
      // it was handed is the very thing being debugged. The error is built
      // without a stack, since a real one names this file and a line in it.
      const error = new FabricError({
        type: "Error",
        message: "boom",
        stack: undefined,
        cause: undefined,
      });
      expect(formatTree(error))
        .toBe('/Error(type:"Error",name:null,message:"boom")');
    });

    it("indents a named special object like any other node", () => {
      expect(formatTree(new FabricBytes(new Uint8Array([1])), 2))
        .toBe("    /Bytes(buf[01])");
    });

    it("names a special object held as a render prop", () => {
      const node = {
        name: "div",
        props: { when: new FabricEpochNsec(1_000n) },
      };

      expect(formatTree(node)).toContain("when=/EpochNsec(1000n)");
    });
  });
});
