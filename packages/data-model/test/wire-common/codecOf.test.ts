import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { FabricSpecialObject } from "@/interface.ts";
import { CODEC, codecOf } from "@/wire-common/index.ts";
import { FabricError } from "@/fabric-instances/FabricError.ts";
import { FabricBytes } from "@/fabric-primitives/FabricBytes.ts";

describe("codecOf()", () => {
  it("returns the class's `[CODEC]` for a `FabricInstance`", () => {
    const err = FabricError.fromNativeError(new Error("x"));
    expect(codecOf(err)).toBe(FabricError[CODEC]);
  });

  it("returns the class's `[CODEC]` for a `FabricPrimitive`", () => {
    const fb = new FabricBytes(new Uint8Array([1, 2, 3]));
    expect(codecOf(fb)).toBe(FabricBytes[CODEC]);
  });

  it("throws for a `FabricSpecialObject` with no `[CODEC]`", () => {
    class NoCodec extends FabricSpecialObject {}
    expect(() => codecOf(new NoCodec())).toThrow("no `[CODEC]`");
  });
});
